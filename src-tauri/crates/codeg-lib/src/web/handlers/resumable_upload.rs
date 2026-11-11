//! Resumable attachment upload.
//!
//! `upload_attachment` takes a file in one multipart request, so a dropped
//! connection starts it over from zero: fine for a screenshot, not for a
//! phone video on a cellular link. This is the same upload in pieces, into
//! the same session buckets and under the same caps:
//!
//! 1. `POST /api/upload_attachment_create`
//!    `{fileName, size, mimeType?, sessionId?}` checks `size` against the
//!    per-type cap and the total quota (reserving it), stages an empty file
//!    and answers an [`UploadSessionInfo`] with `uploadId` and `offset: 0`.
//! 2. `PUT /api/upload_attachment_chunk?uploadId=…&offset=N`, raw bytes as the
//!    body (`POST` works too). `offset` must equal the bytes the server holds;
//!    the body may be any length up to what remains. Bytes are written as
//!    they arrive, so a request cut off midway still advances the offset by
//!    what landed. Answers the new offset.
//! 3. `POST /api/upload_attachment_status` `{uploadId}`: the offset to resume
//!    from after a drop.
//! 4. `POST /api/upload_attachment_complete` `{uploadId}` once
//!    `offset == size`: the same answer as `upload_attachment`.
//! 5. `POST /api/upload_attachment_cancel` `{uploadId}` drops it and its file.
//!
//! A new chunk (or complete) request supersedes one still in flight for the
//! same upload: the phone's old connection can linger half-open for minutes,
//! and a resumed upload must not wait on it.
//!
//! State is in memory and the staging files live in `<uploads_root>/.tmp/`,
//! which startup purges: an upload survives a dropped connection, not a
//! server restart. One idle for [`RESUMABLE_IDLE_TTL`] is dropped with its
//! file and its quota reservation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::Query;
use axum::Json;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::app_error::AppCommandError;

use super::files::{
    finalize_staged_upload, new_staging_name, prepare_staging_dir, sanitize_session_bucket,
    too_large_error, QuotaReservation, UploadAttachmentResult, UploadEnv,
};
use super::upload_jail;

/// An upload with no request for this long is dropped.
pub const RESUMABLE_IDLE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Uploads in progress at once (per process).
pub const RESUMABLE_MAX_ACTIVE: usize = 32;
/// Suggested chunk size for clients. Any size works.
pub const RESUMABLE_CHUNK_BYTES_HINT: u64 = 8 * 1024 * 1024;
/// A chunk request that sends nothing for this long is ended, keeping what
/// arrived.
const RESUMABLE_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Bytes gathered before each positioned write.
const RESUMABLE_WRITE_BATCH_BYTES: usize = 1024 * 1024;

const I18N_NOT_FOUND: &str = "errors.upload.notFound";
const I18N_OFFSET_MISMATCH: &str = "errors.upload.offsetMismatch";
const I18N_SUPERSEDED: &str = "errors.upload.superseded";
const I18N_INCOMPLETE: &str = "errors.upload.incomplete";
const I18N_TOO_MANY: &str = "errors.upload.tooManyInProgress";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// The resumable half of `upload_limits`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableLimitsInfo {
    pub chunk_bytes_hint: u64,
    pub idle_timeout_secs: u64,
    pub max_active: usize,
}

impl ResumableLimitsInfo {
    pub fn current() -> Self {
        Self {
            chunk_bytes_hint: RESUMABLE_CHUNK_BYTES_HINT,
            idle_timeout_secs: RESUMABLE_IDLE_TTL.as_secs(),
            max_active: RESUMABLE_MAX_ACTIVE,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUploadRequest {
    #[serde(alias = "file_name")]
    pub file_name: String,
    pub size: u64,
    #[serde(default, alias = "mime_type")]
    pub mime_type: Option<String>,
    /// The bucket, as `upload_attachment`'s `session_id` field.
    #[serde(default, alias = "session_id")]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadIdRequest {
    #[serde(alias = "upload_id")]
    pub upload_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkQuery {
    #[serde(alias = "upload_id")]
    pub upload_id: String,
    pub offset: u64,
}

/// Where an upload stands. The answer to create, chunk and status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSessionInfo {
    pub upload_id: String,
    /// Bytes the server holds; the next chunk starts here.
    pub offset: u64,
    pub size: u64,
    /// `offset == size`: ready for `upload_attachment_complete`.
    pub complete: bool,
    pub file_name: String,
    pub mime_type: Option<String>,
    /// The per-file cap this upload was admitted under.
    pub limit: u64,
    /// Idle time after which the server drops it.
    pub expires_in_secs: u64,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct Progress {
    offset: u64,
    last_activity: Instant,
    /// The request currently allowed to write, by generation.
    writer: Option<(u64, CancellationToken)>,
    next_writer: u64,
}

struct ResumableUpload {
    id: String,
    bucket: Option<String>,
    file_name: String,
    mime_type: Option<String>,
    size: u64,
    limit: u64,
    uploads_root: std::path::PathBuf,
    tmp_dir: std::path::PathBuf,
    staging_name: String,
    file: Arc<std::fs::File>,
    progress: Mutex<Progress>,
    /// Held by whichever request is writing or completing.
    write_lock: tokio::sync::Mutex<()>,
    /// Set once the staging file has been moved into its bucket.
    finalized: AtomicBool,
    /// Released when the upload goes away, whichever way.
    _quota: Option<QuotaReservation>,
}

impl Drop for ResumableUpload {
    fn drop(&mut self) {
        if !self.finalized.load(Ordering::Acquire) {
            upload_jail::remove_staging_detached(
                self.tmp_dir.clone(),
                std::mem::take(&mut self.staging_name),
            );
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ResumableUpload {
    fn offset(&self) -> u64 {
        lock(&self.progress).offset
    }

    fn touch(&self) {
        lock(&self.progress).last_activity = Instant::now();
    }

    fn info(&self, idle_ttl: Duration) -> UploadSessionInfo {
        let offset = self.offset();
        UploadSessionInfo {
            upload_id: self.id.clone(),
            offset,
            size: self.size,
            complete: offset == self.size,
            file_name: self.file_name.clone(),
            mime_type: self.mime_type.clone(),
            limit: self.limit,
            expires_in_secs: idle_ttl.as_secs(),
        }
    }

    /// Become the upload's writer, stopping the previous one.
    fn claim_writer(&self) -> (u64, CancellationToken) {
        let mut progress = lock(&self.progress);
        progress.next_writer += 1;
        let generation = progress.next_writer;
        let token = CancellationToken::new();
        if let Some((_, previous)) = progress.writer.replace((generation, token.clone())) {
            previous.cancel();
        }
        progress.last_activity = Instant::now();
        (generation, token)
    }

    fn release_writer(&self, generation: u64) {
        let mut progress = lock(&self.progress);
        if matches!(progress.writer, Some((g, _)) if g == generation) {
            progress.writer = None;
        }
    }

    fn stop_writer(&self) {
        if let Some((_, token)) = lock(&self.progress).writer.take() {
            token.cancel();
        }
    }

    /// Write `pending` at `*pos` and advance the recorded offset past it.
    async fn flush(&self, pos: &mut u64, pending: &mut Vec<u8>) -> Result<(), AppCommandError> {
        if pending.is_empty() {
            return Ok(());
        }
        let data = Bytes::from(std::mem::take(pending));
        let len = data.len() as u64;
        write_all_at(self.file.clone(), data, *pos)
            .await
            .map_err(|e| {
                AppCommandError::io_error("Failed to write upload chunk").with_detail(e.to_string())
            })?;
        *pos += len;
        let mut progress = lock(&self.progress);
        progress.offset = *pos;
        progress.last_activity = Instant::now();
        Ok(())
    }

    /// Stream one chunk request's body to disk at `offset`.
    async fn receive<S, E>(
        &self,
        token: &CancellationToken,
        offset: u64,
        body: S,
        idle_ttl: Duration,
        body_idle_timeout: Duration,
    ) -> Result<UploadSessionInfo, AppCommandError>
    where
        S: Stream<Item = Result<Bytes, E>>,
        E: std::fmt::Display,
    {
        if token.is_cancelled() {
            return Err(superseded_error());
        }
        let current = self.offset();
        if offset != current {
            return Err(offset_mismatch_error(current, offset));
        }
        let mut body = std::pin::pin!(body);
        let mut pos = offset;
        let mut pending: Vec<u8> = Vec::new();
        let outcome: Result<(), AppCommandError> = loop {
            let next = tokio::select! {
                biased;
                _ = token.cancelled() => break Err(superseded_error()),
                next = tokio::time::timeout(body_idle_timeout, body.next()) => next,
            };
            match next {
                Err(_) => {
                    break Err(AppCommandError::network("Upload chunk stalled")
                        .with_detail(format!("no bytes for {}s", body_idle_timeout.as_secs())))
                }
                Ok(None) => break Ok(()),
                Ok(Some(Err(e))) => {
                    break Err(AppCommandError::io_error("Failed to read upload chunk")
                        .with_detail(e.to_string()))
                }
                Ok(Some(Ok(bytes))) => {
                    let total = pos + pending.len() as u64 + bytes.len() as u64;
                    if total > self.size {
                        break Err(too_large_error(total, self.size));
                    }
                    pending.extend_from_slice(&bytes);
                    if pending.len() >= RESUMABLE_WRITE_BATCH_BYTES {
                        if let Err(e) = self.flush(&mut pos, &mut pending).await {
                            break Err(e);
                        }
                    }
                }
            }
        };
        // Whatever arrived before a cut-off is kept: the offset advances by
        // it and the client resumes from there.
        self.flush(&mut pos, &mut pending).await?;
        outcome?;
        Ok(self.info(idle_ttl))
    }
}

/// `pwrite` the whole buffer, on the blocking pool.
async fn write_all_at(file: Arc<std::fs::File>, data: Bytes, offset: u64) -> std::io::Result<()> {
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            file.write_all_at(&data, offset)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            let mut done = 0usize;
            while done < data.len() {
                let n = file.seek_write(&data[done..], offset + done as u64)?;
                if n == 0 {
                    return Err(std::io::Error::from(std::io::ErrorKind::WriteZero));
                }
                done += n;
            }
            Ok(())
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

fn not_found_error() -> AppCommandError {
    AppCommandError::not_found("Upload not found or expired")
        .with_i18n(I18N_NOT_FOUND, Default::default())
}

fn offset_mismatch_error(current: u64, sent: u64) -> AppCommandError {
    let params = [
        ("offset".to_string(), current.to_string()),
        ("sent".to_string(), sent.to_string()),
    ]
    .into_iter()
    .collect();
    AppCommandError::already_exists("Chunk offset does not match the bytes received")
        .with_detail(format!("offset={current} sent={sent}"))
        .with_i18n(I18N_OFFSET_MISMATCH, params)
}

fn superseded_error() -> AppCommandError {
    AppCommandError::already_exists("A newer request for this upload took over")
        .with_i18n(I18N_SUPERSEDED, Default::default())
}

fn incomplete_error(offset: u64, size: u64) -> AppCommandError {
    let params = [
        ("offset".to_string(), offset.to_string()),
        ("size".to_string(), size.to_string()),
    ]
    .into_iter()
    .collect();
    AppCommandError::already_exists("Upload is not complete yet")
        .with_detail(format!("offset={offset} size={size}"))
        .with_i18n(I18N_INCOMPLETE, params)
}

/// Uploads in progress, keyed by id.
struct ResumableUploads {
    entries: Mutex<HashMap<String, Arc<ResumableUpload>>>,
    idle_ttl: Duration,
    max_active: usize,
    body_idle_timeout: Duration,
}

impl ResumableUploads {
    fn new(idle_ttl: Duration, max_active: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            idle_ttl,
            max_active,
            body_idle_timeout: RESUMABLE_BODY_IDLE_TIMEOUT,
        }
    }

    fn get(&self, upload_id: &str) -> Result<Arc<ResumableUpload>, AppCommandError> {
        lock(&self.entries)
            .get(upload_id)
            .cloned()
            .ok_or_else(not_found_error)
    }

    async fn create(
        &self,
        env: &UploadEnv,
        request: CreateUploadRequest,
    ) -> Result<UploadSessionInfo, AppCommandError> {
        self.sweep_expired(Instant::now());
        let file_name = request.file_name.trim().to_string();
        let mime_type = request
            .mime_type
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        if request.size == 0 {
            return Err(AppCommandError::invalid_input("Uploaded file is empty"));
        }
        let limit = env
            .limits
            .limit_for(mime_type.as_deref(), Some(file_name.as_str()));
        if request.size > limit {
            return Err(too_large_error(request.size, limit));
        }
        if lock(&self.entries).len() >= self.max_active {
            return Err(too_many_error(self.max_active));
        }
        let quota = env.reserve(request.size).await?;
        let tmp_dir = prepare_staging_dir(&env.uploads_root).await?;
        let staging_name = new_staging_name();
        let file = upload_jail::create_staging_file(&tmp_dir, &staging_name)
            .await
            .map_err(|e| {
                AppCommandError::io_error("Failed to create staging file")
                    .with_detail(e.to_string())
            })?
            .into_std()
            .await;
        let bucket = request
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(sanitize_session_bucket);
        // From here on the upload owns the staging file: dropping it (on any
        // early return below) removes the file and releases the quota.
        let upload = Arc::new(ResumableUpload {
            id: uuid::Uuid::new_v4().simple().to_string(),
            bucket,
            file_name,
            mime_type,
            size: request.size,
            limit,
            uploads_root: env.uploads_root.clone(),
            tmp_dir,
            staging_name,
            file: Arc::new(file),
            progress: Mutex::new(Progress {
                offset: 0,
                last_activity: Instant::now(),
                writer: None,
                next_writer: 0,
            }),
            write_lock: tokio::sync::Mutex::new(()),
            finalized: AtomicBool::new(false),
            _quota: quota,
        });
        {
            let mut entries = lock(&self.entries);
            if entries.len() >= self.max_active {
                return Err(too_many_error(self.max_active));
            }
            entries.insert(upload.id.clone(), upload.clone());
        }
        Ok(upload.info(self.idle_ttl))
    }

    async fn write_chunk<S, E>(
        &self,
        upload_id: &str,
        offset: u64,
        body: S,
    ) -> Result<UploadSessionInfo, AppCommandError>
    where
        S: Stream<Item = Result<Bytes, E>>,
        E: std::fmt::Display,
    {
        self.sweep_expired(Instant::now());
        let upload = self.get(upload_id)?;
        let (generation, token) = upload.claim_writer();
        let _writing = upload.write_lock.lock().await;
        let result = upload
            .receive(&token, offset, body, self.idle_ttl, self.body_idle_timeout)
            .await;
        upload.release_writer(generation);
        result
    }

    fn status(&self, upload_id: &str) -> Result<UploadSessionInfo, AppCommandError> {
        self.sweep_expired(Instant::now());
        let upload = self.get(upload_id)?;
        upload.touch();
        Ok(upload.info(self.idle_ttl))
    }

    async fn complete(&self, upload_id: &str) -> Result<UploadAttachmentResult, AppCommandError> {
        let upload = self.get(upload_id)?;
        // A client that says it is done has stopped sending; a request of its
        // still holding the upload is a dead connection, so take over.
        let (generation, _token) = upload.claim_writer();
        let _writing = upload.write_lock.lock().await;
        let result = self.finish(&upload).await;
        upload.release_writer(generation);
        result
    }

    async fn finish(
        &self,
        upload: &Arc<ResumableUpload>,
    ) -> Result<UploadAttachmentResult, AppCommandError> {
        if upload.finalized.load(Ordering::Acquire) {
            return Err(not_found_error());
        }
        let offset = upload.offset();
        if offset != upload.size {
            return Err(incomplete_error(offset, upload.size));
        }
        let file = upload.file.clone();
        let on_disk = tokio::task::spawn_blocking(move || file.metadata().map(|m| m.len()))
            .await
            .map_err(|e| {
                AppCommandError::task_execution_failed("Upload check failed")
                    .with_detail(e.to_string())
            })?
            .map_err(AppCommandError::io)?;
        if on_disk != upload.size {
            return Err(
                AppCommandError::io_error("Staged upload has the wrong size")
                    .with_detail(format!("on_disk={on_disk} size={}", upload.size)),
            );
        }
        let result = finalize_staged_upload(
            &upload.uploads_root,
            &upload.tmp_dir,
            &upload.staging_name,
            upload.bucket.clone(),
            Some(upload.file_name.as_str()),
            upload.size,
            upload.mime_type.clone(),
        )
        .await?;
        upload.finalized.store(true, Ordering::Release);
        lock(&self.entries).remove(&upload.id);
        Ok(result)
    }

    fn cancel(&self, upload_id: &str) -> bool {
        let removed = lock(&self.entries).remove(upload_id);
        match removed {
            Some(upload) => {
                upload.stop_writer();
                true
            }
            None => false,
        }
    }

    /// Drop every upload idle past the TTL and not being written right now.
    fn sweep_expired(&self, now: Instant) {
        let expired: Vec<Arc<ResumableUpload>> = {
            let mut entries = lock(&self.entries);
            let ids: Vec<String> = entries
                .iter()
                .filter(|(_, upload)| {
                    let idle = now.saturating_duration_since(lock(&upload.progress).last_activity);
                    idle >= self.idle_ttl && upload.write_lock.try_lock().is_ok()
                })
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| entries.remove(id)).collect()
        };
        // Dropped outside the lock: each drop schedules its file's removal.
        drop(expired);
    }

    /// Drop every upload (the staging directory is about to be purged).
    fn clear(&self) {
        let all: Vec<Arc<ResumableUpload>> = lock(&self.entries).drain().map(|(_, u)| u).collect();
        for upload in &all {
            upload.stop_writer();
        }
    }
}

fn too_many_error(max: usize) -> AppCommandError {
    let params = [("max".to_string(), max.to_string())].into_iter().collect();
    AppCommandError::invalid_input("Too many uploads are in progress")
        .with_detail(format!("max={max}"))
        .with_i18n(I18N_TOO_MANY, params)
}

static LIVE: LazyLock<ResumableUploads> =
    LazyLock::new(|| ResumableUploads::new(RESUMABLE_IDLE_TTL, RESUMABLE_MAX_ACTIVE));

pub fn sweep_expired_live() {
    LIVE.sweep_expired(Instant::now());
}

pub fn clear_live() {
    LIVE.clear();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn create_upload(
    Json(request): Json<CreateUploadRequest>,
) -> Result<Json<UploadSessionInfo>, AppCommandError> {
    LIVE.create(&UploadEnv::live(), request).await.map(Json)
}

pub async fn upload_chunk(
    Query(query): Query<ChunkQuery>,
    body: Body,
) -> Result<Json<UploadSessionInfo>, AppCommandError> {
    LIVE.write_chunk(&query.upload_id, query.offset, body.into_data_stream())
        .await
        .map(Json)
}

pub async fn upload_status(
    Json(request): Json<UploadIdRequest>,
) -> Result<Json<UploadSessionInfo>, AppCommandError> {
    LIVE.status(&request.upload_id).map(Json)
}

pub async fn complete_upload(
    Json(request): Json<UploadIdRequest>,
) -> Result<Json<UploadAttachmentResult>, AppCommandError> {
    LIVE.complete(&request.upload_id).await.map(Json)
}

pub async fn cancel_upload(Json(request): Json<UploadIdRequest>) -> Json<bool> {
    Json(LIVE.cancel(&request.upload_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::{UPLOAD_I18N_KEY_QUOTA_EXCEEDED, UPLOAD_I18N_KEY_TOO_LARGE};
    use crate::web::handlers::files::UploadLimits;
    use std::sync::atomic::AtomicU64;

    fn env(root: &std::path::Path, quota_cap: Option<u64>) -> UploadEnv {
        UploadEnv {
            uploads_root: root.to_path_buf(),
            limits: UploadLimits {
                file_bytes: 1000,
                media_bytes: 50_000,
            },
            quota_cap,
            in_flight: Box::leak(Box::new(AtomicU64::new(0))),
        }
    }

    fn registry() -> ResumableUploads {
        ResumableUploads::new(RESUMABLE_IDLE_TTL, 4)
    }

    fn video(size: u64) -> CreateUploadRequest {
        CreateUploadRequest {
            file_name: "take (1).mp4".into(),
            size,
            mime_type: Some("video/mp4".into()),
            session_id: Some("ios-abc".into()),
        }
    }

    fn content(size: usize) -> Vec<u8> {
        (0..size).map(|i| (i % 251) as u8).collect()
    }

    fn body(bytes: &[u8]) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
        let chunks: Vec<Result<Bytes, std::io::Error>> = bytes
            .chunks(1500)
            .map(|c| Ok(Bytes::copy_from_slice(c)))
            .collect();
        futures::stream::iter(chunks)
    }

    fn staged(root: &std::path::Path) -> usize {
        std::fs::read_dir(root.join(".tmp"))
            .map(|it| it.count())
            .unwrap_or(0)
    }

    async fn wait_unstaged(root: &std::path::Path) {
        for _ in 0..200 {
            if staged(root) == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("staging file left behind");
    }

    #[tokio::test]
    async fn chunks_land_at_their_offsets_and_complete_into_the_bucket() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let data = content(10_000);

        let created = uploads.create(&env, video(10_000)).await.unwrap();
        assert_eq!(created.offset, 0);
        assert_eq!(created.limit, 50_000, "a video gets the media cap");
        assert!(!created.complete);
        let id = created.upload_id.clone();

        let first = uploads
            .write_chunk(&id, 0, body(&data[..4000]))
            .await
            .unwrap();
        assert_eq!(first.offset, 4000);
        assert_eq!(uploads.status(&id).unwrap().offset, 4000);

        let second = uploads
            .write_chunk(&id, 4000, body(&data[4000..]))
            .await
            .unwrap();
        assert_eq!(second.offset, 10_000);
        assert!(second.complete);

        let done = uploads.complete(&id).await.unwrap();
        assert_eq!(done.size, 10_000);
        assert_eq!(done.name, "take (1).mp4");
        assert_eq!(done.mime_type.as_deref(), Some("video/mp4"));
        let stored = std::fs::read(root.path().join("ios-abc").join("take (1).mp4")).unwrap();
        assert_eq!(stored, data);
        wait_unstaged(root.path()).await;
        assert!(uploads.status(&id).is_err(), "gone once complete");
    }

    #[tokio::test]
    async fn a_wrong_offset_is_refused_with_the_one_to_resume_from() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let data = content(3000);
        let id = uploads.create(&env, video(3000)).await.unwrap().upload_id;
        uploads
            .write_chunk(&id, 0, body(&data[..1000]))
            .await
            .unwrap();

        for sent in [0u64, 500, 2000] {
            let err = uploads
                .write_chunk(&id, sent, body(&data[1000..]))
                .await
                .unwrap_err();
            assert_eq!(err.i18n_key.as_deref(), Some(I18N_OFFSET_MISMATCH));
            let params = err.i18n_params.unwrap();
            assert_eq!(params.get("offset").map(String::as_str), Some("1000"));
        }
        assert_eq!(uploads.status(&id).unwrap().offset, 1000, "unchanged");
    }

    #[tokio::test]
    async fn a_chunk_cut_off_midway_keeps_what_arrived() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let data = content(8000);
        let id = uploads.create(&env, video(8000)).await.unwrap().upload_id;

        // The connection drops after 3000 of the 8000 bytes.
        let broken = futures::stream::iter(vec![
            Ok(Bytes::copy_from_slice(&data[..3000])),
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "cellular hiccup",
            )),
        ]);
        assert!(uploads.write_chunk(&id, 0, broken).await.is_err());
        let resume_at = uploads.status(&id).unwrap().offset;
        assert_eq!(resume_at, 3000);

        uploads
            .write_chunk(&id, resume_at, body(&data[3000..]))
            .await
            .unwrap();
        let done = uploads.complete(&id).await.unwrap();
        let stored = std::fs::read(&done.path).unwrap();
        assert_eq!(stored, data);
    }

    #[tokio::test]
    async fn a_new_chunk_request_takes_over_from_a_stalled_one() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = Arc::new(registry());
        let data = content(6000);
        let id = uploads.create(&env, video(6000)).await.unwrap().upload_id;

        // The old connection delivered 2000 bytes and then went silent.
        let stalled_body = futures::stream::iter(vec![Ok::<_, std::io::Error>(
            Bytes::copy_from_slice(&data[..2000]),
        )])
        .chain(futures::stream::pending());
        let stalled = {
            let uploads = uploads.clone();
            let id = id.clone();
            tokio::spawn(async move { uploads.write_chunk(&id, 0, stalled_body).await })
        };
        // Its bytes are only flushed when it ends, so the offset still reads 0.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(uploads.status(&id).unwrap().offset, 0);

        // The phone reconnects and resumes from what status said (0): the
        // stalled request is told to stop and keeps the bytes it got.
        let err = uploads.write_chunk(&id, 0, body(&data)).await.unwrap_err();
        assert_eq!(err.i18n_key.as_deref(), Some(I18N_OFFSET_MISMATCH));
        let superseded = stalled.await.unwrap().unwrap_err();
        assert_eq!(superseded.i18n_key.as_deref(), Some(I18N_SUPERSEDED));
        let at = uploads.status(&id).unwrap().offset;
        assert_eq!(at, 2000);
        uploads
            .write_chunk(&id, at, body(&data[2000..]))
            .await
            .unwrap();
        let done = uploads.complete(&id).await.unwrap();
        assert_eq!(std::fs::read(&done.path).unwrap(), data);
    }

    #[tokio::test]
    async fn bytes_past_the_declared_size_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let data = content(3000);
        let id = uploads.create(&env, video(2000)).await.unwrap().upload_id;
        let err = uploads.write_chunk(&id, 0, body(&data)).await.unwrap_err();
        assert_eq!(err.i18n_key.as_deref(), Some(UPLOAD_I18N_KEY_TOO_LARGE));
        // The 1500-byte first frame fit and was kept; the second did not.
        assert_eq!(uploads.status(&id).unwrap().offset, 1500);
    }

    #[tokio::test]
    async fn completing_early_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let data = content(3000);
        let id = uploads.create(&env, video(3000)).await.unwrap().upload_id;
        uploads
            .write_chunk(&id, 0, body(&data[..1000]))
            .await
            .unwrap();
        let err = uploads.complete(&id).await.unwrap_err();
        assert_eq!(err.i18n_key.as_deref(), Some(I18N_INCOMPLETE));
        assert_eq!(uploads.status(&id).unwrap().offset, 1000);
    }

    #[tokio::test]
    async fn create_applies_the_per_type_caps() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let too_big_video = uploads.create(&env, video(50_001)).await.unwrap_err();
        assert_eq!(
            too_big_video.i18n_key.as_deref(),
            Some(UPLOAD_I18N_KEY_TOO_LARGE)
        );
        let picture = CreateUploadRequest {
            file_name: "shot.png".into(),
            size: 1001,
            mime_type: Some("image/png".into()),
            session_id: None,
        };
        let err = uploads.create(&env, picture).await.unwrap_err();
        assert_eq!(err.i18n_key.as_deref(), Some(UPLOAD_I18N_KEY_TOO_LARGE));
        assert!(uploads.create(&env, video(0)).await.is_err(), "empty");
        assert_eq!(staged(root.path()), 0);
    }

    #[tokio::test]
    async fn create_reserves_the_whole_size_against_the_quota() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), Some(15_000));
        let uploads = registry();
        let first = uploads.create(&env, video(10_000)).await.unwrap();
        assert_eq!(env.in_flight.load(Ordering::Acquire), 10_000);
        let err = uploads.create(&env, video(10_000)).await.unwrap_err();
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(UPLOAD_I18N_KEY_QUOTA_EXCEEDED)
        );
        assert!(uploads.cancel(&first.upload_id));
        assert_eq!(env.in_flight.load(Ordering::Acquire), 0, "released");
        uploads.create(&env, video(10_000)).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_removes_the_staged_file() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = registry();
        let data = content(2000);
        let id = uploads.create(&env, video(4000)).await.unwrap().upload_id;
        uploads.write_chunk(&id, 0, body(&data)).await.unwrap();
        assert_eq!(staged(root.path()), 1);
        assert!(uploads.cancel(&id));
        assert!(!uploads.cancel(&id));
        wait_unstaged(root.path()).await;
        let err = uploads.status(&id).unwrap_err();
        assert_eq!(err.i18n_key.as_deref(), Some(I18N_NOT_FOUND));
    }

    #[tokio::test]
    async fn an_idle_upload_expires_with_its_file_and_quota() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), Some(100_000));
        let uploads = ResumableUploads::new(Duration::from_secs(60), 4);
        let id = uploads.create(&env, video(4000)).await.unwrap().upload_id;
        uploads.sweep_expired(Instant::now());
        assert!(uploads.status(&id).is_ok(), "fresh uploads stay");
        uploads.sweep_expired(Instant::now() + Duration::from_secs(61));
        assert!(uploads.status(&id).is_err());
        wait_unstaged(root.path()).await;
        assert_eq!(env.in_flight.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn the_number_in_progress_is_capped() {
        let root = tempfile::tempdir().unwrap();
        let env = env(root.path(), None);
        let uploads = ResumableUploads::new(RESUMABLE_IDLE_TTL, 2);
        uploads.create(&env, video(10)).await.unwrap();
        uploads.create(&env, video(10)).await.unwrap();
        let err = uploads.create(&env, video(10)).await.unwrap_err();
        assert_eq!(err.i18n_key.as_deref(), Some(I18N_TOO_MANY));
        assert_eq!(staged(root.path()), 2);
    }

    #[test]
    fn requests_accept_camel_and_snake_case() {
        let camel: CreateUploadRequest = serde_json::from_value(serde_json::json!({
            "fileName": "a.mp4", "size": 5, "mimeType": "video/mp4", "sessionId": "s"
        }))
        .unwrap();
        assert_eq!(camel.session_id.as_deref(), Some("s"));
        let snake: CreateUploadRequest = serde_json::from_value(serde_json::json!({
            "file_name": "a.mp4", "size": 5, "session_id": "s"
        }))
        .unwrap();
        assert_eq!(snake.file_name, "a.mp4");
        let info = UploadSessionInfo {
            upload_id: "u".into(),
            offset: 1,
            size: 2,
            complete: false,
            file_name: "a.mp4".into(),
            mime_type: None,
            limit: 3,
            expires_in_secs: 4,
        };
        let json = serde_json::to_value(info).unwrap();
        assert_eq!(json["uploadId"], "u");
        assert_eq!(json["expiresInSecs"], 4);
    }
}
