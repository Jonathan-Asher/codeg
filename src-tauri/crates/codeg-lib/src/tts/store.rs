//! Downloads the model pack into the data dir, checks every file against its
//! sha256, and deletes it again on request.
//!
//! Each file streams into `<name>.part`, hashed as it arrives, and is renamed
//! into place only once its checksum matches, so a file under its real name is
//! always a verified one. An interrupted download resumes from the `.part`
//! with an HTTP range request (or starts the file over when the server ignores
//! the range). When every file is in place a `.complete` marker records which
//! catalog it satisfies; `is_installed` needs that marker and every file at
//! its expected size, so it costs a few `stat`s rather than 575 MB of hashing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use reqwest::header::RANGE;
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::catalog::ModelFile;

const MARKER: &str = ".complete";
/// Tries per file; every retry resumes from what is already on disk.
const ATTEMPTS: u32 = 3;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("downloading {path} failed: {message}")]
    Network { path: String, message: String },
    #[error("{path}: the server answered HTTP {status}")]
    Http { path: String, status: u16 },
    #[error("{path} did not match its checksum; the partial file was removed")]
    Checksum { path: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("the download was cancelled")]
    Cancelled,
}

impl StoreError {
    /// Worth another attempt from where the file left off.
    fn is_transient(&self) -> bool {
        match self {
            StoreError::Network { .. } => true,
            StoreError::Http { status, .. } => *status >= 500 || *status == 429,
            _ => false,
        }
    }
}

/// Bytes on disk of the whole pack (finished files plus the file in flight).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    pub bytes_done: u64,
    pub bytes_total: u64,
}

pub struct ModelStore {
    dir: PathBuf,
    files: Vec<ModelFile>,
}

impl ModelStore {
    pub fn new(dir: PathBuf, files: Vec<ModelFile>) -> Self {
        Self { dir, files }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn files(&self) -> &[ModelFile] {
        &self.files
    }

    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    fn final_path(&self, file: &ModelFile) -> PathBuf {
        self.dir.join(&file.path)
    }

    fn part_path(&self, file: &ModelFile) -> PathBuf {
        self.dir.join(format!("{}.part", file.path))
    }

    /// Which catalog the `.complete` marker vouches for.
    fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        for f in &self.files {
            hasher.update(format!("{}\t{}\t{}\n", f.path, f.sha256, f.size));
        }
        format!("{:x}", hasher.finalize())
    }

    fn has_final(&self, file: &ModelFile) -> bool {
        std::fs::metadata(self.final_path(file))
            .map(|m| m.is_file() && m.len() == file.size)
            .unwrap_or(false)
    }

    /// Every file present at its size, and the marker for this catalog.
    pub fn is_installed(&self) -> bool {
        let marker = std::fs::read_to_string(self.dir.join(MARKER)).unwrap_or_default();
        marker.trim() == self.fingerprint() && self.files.iter().all(|f| self.has_final(f))
    }

    /// What is already on disk, for a download that picks up where it was.
    pub fn bytes_on_disk(&self) -> u64 {
        self.files
            .iter()
            .map(|f| {
                if self.has_final(f) {
                    f.size
                } else {
                    std::fs::metadata(self.part_path(f))
                        .map(|m| m.len().min(f.size))
                        .unwrap_or(0)
                }
            })
            .sum()
    }

    /// Remove the pack, partial files included.
    pub fn delete(&self) -> std::io::Result<()> {
        match std::fs::remove_dir_all(&self.dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    /// Fetch whatever is missing, verify it, and mark the pack complete.
    /// `on_progress` gets the pack-wide byte count as it grows.
    pub async fn download(
        &self,
        client: &reqwest::Client,
        cancel: &CancellationToken,
        on_progress: &(dyn Fn(Progress) + Send + Sync),
    ) -> Result<(), StoreError> {
        tokio::fs::create_dir_all(&self.dir).await?;
        // A marker for an older catalog (or a pack being repaired) goes first,
        // so a crash below can never leave a stale "complete" behind.
        if !self.is_installed() {
            let _ = tokio::fs::remove_file(self.dir.join(MARKER)).await;
        }
        let total = self.total_bytes();
        let mut finished = 0u64;
        for file in &self.files {
            if cancel.is_cancelled() {
                return Err(StoreError::Cancelled);
            }
            if self.has_final(file) {
                finished += file.size;
                on_progress(Progress {
                    bytes_done: finished,
                    bytes_total: total,
                });
                continue;
            }
            let dest = self.final_path(file);
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            // A wrong-sized file under the real name is not ours to trust.
            let _ = tokio::fs::remove_file(&dest).await;
            let base = finished;
            let report = |in_file: u64| {
                on_progress(Progress {
                    bytes_done: base + in_file.min(file.size),
                    bytes_total: total,
                })
            };
            self.fetch_file(client, file, cancel, &report).await?;
            finished += file.size;
        }
        tokio::fs::write(self.dir.join(MARKER), self.fingerprint()).await?;
        Ok(())
    }

    async fn fetch_file(
        &self,
        client: &reqwest::Client,
        file: &ModelFile,
        cancel: &CancellationToken,
        report: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<(), StoreError> {
        let part = self.part_path(file);
        let mut attempt = 0;
        let digest = loop {
            attempt += 1;
            match fetch_into_part(client, file, &part, cancel, report).await {
                Ok(digest) => break digest,
                Err(err) if err.is_transient() && attempt < ATTEMPTS => {
                    tracing::warn!("[TTS] {err}; retrying ({attempt}/{ATTEMPTS})");
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(StoreError::Cancelled),
                        _ = tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))) => {}
                    }
                }
                Err(err) => return Err(err),
            }
        };
        if !digest.eq_ignore_ascii_case(&file.sha256) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(StoreError::Checksum {
                path: file.path.clone(),
            });
        }
        tokio::fs::rename(&part, self.final_path(file)).await?;
        Ok(())
    }
}

#[cfg(test)]
impl ModelStore {
    /// Lay the pack out with placeholder bytes of the right sizes and mark it
    /// complete, for tests that need an "installed" pack but no real models.
    pub(crate) fn install_placeholder_for_tests(&self) {
        for f in &self.files {
            let path = self.final_path(f);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, vec![0u8; f.size as usize]).unwrap();
        }
        std::fs::write(self.dir.join(MARKER), self.fingerprint()).unwrap();
    }
}

fn network(file: &ModelFile, err: impl std::fmt::Display) -> StoreError {
    StoreError::Network {
        path: file.path.clone(),
        message: err.to_string(),
    }
}

/// Hash what is already in `part` (a resumed download).
async fn hash_existing(part: &Path, hasher: &mut Sha256) -> std::io::Result<u64> {
    let mut f = tokio::fs::File::open(part).await?;
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            return Ok(total);
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
}

/// Bring `part` up to the file's full size and return its sha256 (hex).
async fn fetch_into_part(
    client: &reqwest::Client,
    file: &ModelFile,
    part: &Path,
    cancel: &CancellationToken,
    report: &(dyn Fn(u64) + Send + Sync),
) -> Result<String, StoreError> {
    let mut have = tokio::fs::metadata(part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if have > file.size {
        tokio::fs::remove_file(part).await?;
        have = 0;
    }
    let mut hasher = Sha256::new();
    if have > 0 {
        have = hash_existing(part, &mut hasher).await?;
        if have == file.size {
            return Ok(format!("{:x}", hasher.finalize()));
        }
    }

    let mut request = client.get(&file.url);
    if have > 0 {
        request = request.header(RANGE, format!("bytes={have}-"));
    }
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(StoreError::Cancelled),
        r = request.send() => r.map_err(|e| network(file, e))?,
    };
    let status = response.status();
    let mut out = if have > 0 && status == StatusCode::PARTIAL_CONTENT {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(part)
            .await?
    } else if status.is_success() {
        // A full body: the server ignored the range, or there was none.
        have = 0;
        hasher = Sha256::new();
        tokio::fs::File::create(part).await?
    } else if status == StatusCode::RANGE_NOT_SATISFIABLE {
        // The partial file no longer fits what the server has; start over.
        tokio::fs::remove_file(part).await?;
        return Err(network(file, "range not satisfiable; restarting the file"));
    } else {
        return Err(StoreError::Http {
            path: file.path.clone(),
            status: status.as_u16(),
        });
    };
    report(have);

    let mut body = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                out.flush().await?;
                return Err(StoreError::Cancelled);
            }
            next = body.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                out.flush().await?;
                return Err(network(file, e));
            }
        };
        if have + chunk.len() as u64 > file.size {
            drop(out);
            let _ = tokio::fs::remove_file(part).await;
            return Err(StoreError::Checksum {
                path: file.path.clone(),
            });
        }
        out.write_all(&chunk).await?;
        hasher.update(&chunk);
        have += chunk.len() as u64;
        report(have);
    }
    out.flush().await?;
    if have != file.size {
        return Err(network(
            file,
            format!("the connection closed after {have} of {} bytes", file.size),
        ));
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::body::Body;
    use axum::extract::{Path as AxPath, State};
    use axum::http::{HeaderMap, Response, StatusCode as AxStatus};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    /// How the fake server answers.
    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        /// Honours `Range` with 206.
        Ranges,
        /// Always sends the whole file with 200.
        IgnoreRanges,
        /// The first response for each file stops half way.
        CutFirst,
    }

    struct Server {
        files: HashMap<String, Vec<u8>>,
        mode: Mode,
        /// Every request: (file, Range header).
        log: Mutex<Vec<(String, Option<String>)>>,
        served: Mutex<HashMap<String, u32>>,
    }

    async fn serve_file(
        State(server): State<Arc<Server>>,
        AxPath(name): AxPath<String>,
        headers: HeaderMap,
    ) -> Response<Body> {
        let range = headers
            .get("range")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        server
            .log
            .lock()
            .unwrap()
            .push((name.clone(), range.clone()));
        let Some(bytes) = server.files.get(&name).cloned() else {
            return Response::builder()
                .status(AxStatus::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        };
        let count = {
            let mut served = server.served.lock().unwrap();
            let c = served.entry(name.clone()).or_insert(0);
            *c += 1;
            *c
        };
        if server.mode == Mode::CutFirst && count == 1 {
            let half = bytes[..bytes.len() / 2].to_vec();
            return Response::builder()
                .status(AxStatus::OK)
                .body(Body::from(half))
                .unwrap();
        }
        let start = range
            .as_deref()
            .and_then(|r| r.strip_prefix("bytes="))
            .and_then(|r| r.strip_suffix('-'))
            .and_then(|r| r.parse::<usize>().ok());
        match (server.mode, start) {
            (Mode::Ranges | Mode::CutFirst, Some(start)) if start < bytes.len() => {
                Response::builder()
                    .status(AxStatus::PARTIAL_CONTENT)
                    .body(Body::from(bytes[start..].to_vec()))
                    .unwrap()
            }
            _ => Response::builder()
                .status(AxStatus::OK)
                .body(Body::from(bytes))
                .unwrap(),
        }
    }

    async fn start(files: &[(&str, Vec<u8>)], mode: Mode) -> (Arc<Server>, SocketAddr) {
        let server = Arc::new(Server {
            files: files
                .iter()
                .map(|(n, b)| (n.to_string(), b.clone()))
                .collect(),
            mode,
            log: Mutex::new(Vec::new()),
            served: Mutex::new(HashMap::new()),
        });
        let app = Router::new()
            .route("/f/{name}", get(serve_file))
            .with_state(server.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (server, addr)
    }

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn content(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect()
    }

    fn catalog(addr: SocketAddr, files: &[(&str, &str, &[u8])]) -> Vec<ModelFile> {
        files
            .iter()
            .map(|(path, name, bytes)| ModelFile {
                path: path.to_string(),
                url: format!("http://{addr}/f/{name}"),
                size: bytes.len() as u64,
                sha256: sha(bytes),
            })
            .collect()
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn downloads_verifies_and_marks_complete() {
        let a = content(300_000, 1);
        let b = content(70_001, 2);
        let (_server, addr) = start(&[("a", a.clone()), ("b", b.clone())], Mode::Ranges).await;
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(
            dir.path().join("pack"),
            catalog(
                addr,
                &[("bluetts/a.onnx", "a", &a), ("voices/b.json", "b", &b)],
            ),
        );
        assert!(!store.is_installed());

        let seen = Arc::new(Mutex::new(Vec::<Progress>::new()));
        let sink = seen.clone();
        store
            .download(&client(), &CancellationToken::new(), &move |p| {
                sink.lock().unwrap().push(p)
            })
            .await
            .unwrap();

        assert!(store.is_installed());
        assert_eq!(
            std::fs::read(store.dir().join("bluetts/a.onnx")).unwrap(),
            a
        );
        assert_eq!(std::fs::read(store.dir().join("voices/b.json")).unwrap(), b);
        assert!(!store.dir().join("bluetts/a.onnx.part").exists());
        let seen = seen.lock().unwrap();
        assert!(seen.windows(2).all(|w| w[0].bytes_done <= w[1].bytes_done));
        assert_eq!(
            seen.last().copied(),
            Some(Progress {
                bytes_done: store.total_bytes(),
                bytes_total: store.total_bytes()
            })
        );
        assert_eq!(store.bytes_on_disk(), store.total_bytes());
    }

    #[tokio::test]
    async fn checksum_mismatch_removes_the_partial_file() {
        let a = content(50_000, 3);
        let (_server, addr) = start(&[("a", a.clone())], Mode::Ranges).await;
        let dir = tempfile::tempdir().unwrap();
        let mut files = catalog(addr, &[("bluetts/a.onnx", "a", &a)]);
        files[0].sha256 = sha(b"something else");
        let store = ModelStore::new(dir.path().join("pack"), files);

        let err = store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Checksum { ref path } if path == "bluetts/a.onnx"));
        assert!(!store.dir().join("bluetts/a.onnx").exists());
        assert!(!store.dir().join("bluetts/a.onnx.part").exists());
        assert!(!store.is_installed());
    }

    #[tokio::test]
    async fn resumes_a_partial_file_with_a_range_request() {
        let a = content(200_000, 4);
        let (server, addr) = start(&[("a", a.clone())], Mode::Ranges).await;
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(
            dir.path().join("pack"),
            catalog(addr, &[("bluetts/a.onnx", "a", &a)]),
        );
        std::fs::create_dir_all(store.dir().join("bluetts")).unwrap();
        std::fs::write(store.dir().join("bluetts/a.onnx.part"), &a[..80_000]).unwrap();
        assert_eq!(store.bytes_on_disk(), 80_000);

        store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap();

        assert!(store.is_installed());
        assert_eq!(
            std::fs::read(store.dir().join("bluetts/a.onnx")).unwrap(),
            a
        );
        let log = server.log.lock().unwrap().clone();
        assert_eq!(
            log,
            vec![("a".to_string(), Some("bytes=80000-".to_string()))]
        );
    }

    #[tokio::test]
    async fn starts_over_when_the_server_ignores_the_range() {
        let a = content(120_000, 5);
        let (_server, addr) = start(&[("a", a.clone())], Mode::IgnoreRanges).await;
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(
            dir.path().join("pack"),
            catalog(addr, &[("bluetts/a.onnx", "a", &a)]),
        );
        std::fs::create_dir_all(store.dir().join("bluetts")).unwrap();
        std::fs::write(store.dir().join("bluetts/a.onnx.part"), &a[..1000]).unwrap();

        store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(store.dir().join("bluetts/a.onnx")).unwrap(),
            a
        );
    }

    #[tokio::test]
    async fn a_dropped_connection_is_resumed_on_the_next_attempt() {
        let a = content(160_000, 6);
        let (server, addr) = start(&[("a", a.clone())], Mode::CutFirst).await;
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(
            dir.path().join("pack"),
            catalog(addr, &[("bluetts/a.onnx", "a", &a)]),
        );

        store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap();

        assert_eq!(
            std::fs::read(store.dir().join("bluetts/a.onnx")).unwrap(),
            a
        );
        let log = server.log.lock().unwrap().clone();
        assert_eq!(
            log,
            vec![
                ("a".to_string(), None),
                ("a".to_string(), Some("bytes=80000-".to_string()))
            ]
        );
    }

    #[tokio::test]
    async fn finished_files_are_not_fetched_again() {
        let a = content(10_000, 7);
        let b = content(20_000, 8);
        let (server, addr) = start(&[("a", a.clone()), ("b", b.clone())], Mode::Ranges).await;
        let dir = tempfile::tempdir().unwrap();
        let store = ModelStore::new(
            dir.path().join("pack"),
            catalog(addr, &[("x/a", "a", &a), ("x/b", "b", &b)]),
        );
        std::fs::create_dir_all(store.dir().join("x")).unwrap();
        std::fs::write(store.dir().join("x/a"), &a).unwrap();

        store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        let log = server.log.lock().unwrap().clone();
        assert_eq!(log, vec![("b".to_string(), None)]);
        assert!(store.is_installed());
    }

    #[tokio::test]
    async fn http_errors_and_cancel_stop_the_download() {
        let a = content(10_000, 9);
        let (_server, addr) = start(&[("a", a.clone())], Mode::Ranges).await;
        let dir = tempfile::tempdir().unwrap();
        let mut files = catalog(addr, &[("x/a", "a", &a)]);
        files[0].url = format!("http://{addr}/f/missing");
        let store = ModelStore::new(dir.path().join("pack"), files);
        let err = store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Http { status: 404, .. }));

        let store = ModelStore::new(dir.path().join("pack2"), catalog(addr, &[("x/a", "a", &a)]));
        let token = CancellationToken::new();
        token.cancel();
        let err = store
            .download(&client(), &token, &|_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::Cancelled));
        assert!(!store.is_installed());
    }

    #[tokio::test]
    async fn delete_removes_the_pack_and_a_new_catalog_is_not_installed() {
        let a = content(5_000, 10);
        let (_server, addr) = start(&[("a", a.clone())], Mode::Ranges).await;
        let dir = tempfile::tempdir().unwrap();
        let files = catalog(addr, &[("x/a", "a", &a)]);
        let store = ModelStore::new(dir.path().join("pack"), files.clone());
        store
            .download(&client(), &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        assert!(store.is_installed());

        // Same files on disk, but a catalog with another checksum: not ours.
        let mut changed = files.clone();
        changed[0].sha256 = sha(b"v2");
        assert!(!ModelStore::new(dir.path().join("pack"), changed).is_installed());

        // A file that shrank on disk is noticed without hashing.
        std::fs::write(store.dir().join("x/a"), b"short").unwrap();
        assert!(!store.is_installed());

        store.delete().unwrap();
        assert!(!store.dir().exists());
        assert!(!store.is_installed());
        // Deleting twice is fine.
        store.delete().unwrap();
    }

    /// Downloads the real ~575 MB pack. Run by hand on a machine with the
    /// bandwidth: `CODEG_TTS_E2E_DOWNLOAD_DIR=/tmp/x cargo test … -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_pack_downloads_and_verifies() {
        let Some(dir) = std::env::var_os("CODEG_TTS_E2E_DOWNLOAD_DIR") else {
            eprintln!("CODEG_TTS_E2E_DOWNLOAD_DIR not set; skipping");
            return;
        };
        let store = ModelStore::new(PathBuf::from(dir), super::super::catalog::builtin());
        let started = std::time::Instant::now();
        let last = Arc::new(Mutex::new(0u64));
        let sink = last.clone();
        store
            .download(&client(), &CancellationToken::new(), &move |p| {
                let mut l = sink.lock().unwrap();
                if p.bytes_done >= *l + 50_000_000 || p.bytes_done == p.bytes_total {
                    eprintln!("{} / {} bytes", p.bytes_done, p.bytes_total);
                    *l = p.bytes_done;
                }
            })
            .await
            .unwrap();
        assert!(store.is_installed());
        eprintln!(
            "pack ready in {:?}: {} bytes",
            started.elapsed(),
            store.total_bytes()
        );
    }
}
