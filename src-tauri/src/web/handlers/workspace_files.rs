//! HTTP endpoints for uploading/downloading workspace files.
//!
//! These exist for issue #179 — the web/server build has no native file
//! dialogs, so the file-tree context menu needs network endpoints to move
//! bytes between the operator's browser and the workspace on disk. The
//! Tauri build keeps using the OS file picker, so the routes are gated to
//! web mode in the UI but live in the shared router so the desktop's
//! built-in web service is functional too.
//!
//! All three endpoints share the same base path-safety contract: caller
//! passes a `root_path` (the absolute path of an opened workspace) plus a
//! relative path that must not contain `..` or absolute components, and the
//! handler joins them.
//!
//! Symlinks are then treated differently by direction. **Upload** additionally
//! `canonicalize`s and requires the result to stay under the canonical root
//! (or inside a registered link), because following a stray link would leave
//! files outside the workspace. **Download** applies only the lexical boundary
//! (`folders::ensure_user_navigable_path`): it is the file tree's own
//! context-menu action on a row the user can already open in the editor, and
//! refusing symlinked folders there is what broke issue #430.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::body::{Body, Bytes};
use axum::extract::{Extension, Multipart, Path as AxumPath};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::stream;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::workspace_media::{
    cap_plan, content_range, is_valid_media_token, media_content_type, plan_range, read_span,
    unsatisfied_content_range, RangePlan, MEDIA_ROUTE_PREFIX,
};
use crate::workspace_transfer::{DownloadKind, DownloadTicketIssued, DownloadTicketSpec};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadWorkspaceFileResult {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadWorkspaceParams {
    pub root_path: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTicketRequest {
    pub root_path: String,
    pub path: String,
    pub kind: DownloadKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilityRequest {
    pub root_path: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRevokeRequest {
    pub token: String,
}

/// A minted streaming capability. `url` is the server-relative byte endpoint
/// (web mode loads it directly; the desktop URI scheme forwards to it).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilityIssued {
    pub token: String,
    pub url: String,
    pub filename: String,
    pub size: u64,
    pub content_type: String,
    pub expires_in_secs: u64,
}

// ---------------------------------------------------------------------------
// Path safety helpers
// ---------------------------------------------------------------------------

fn validate_relative_components(rel: &Path) -> Result<(), AppCommandError> {
    if rel.is_absolute() {
        return Err(AppCommandError::invalid_input("Path must be relative"));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppCommandError::invalid_input("Path cannot contain '..'"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppCommandError::invalid_input("Invalid path component"));
            }
        }
    }
    Ok(())
}

fn resolve_relative_path(root: &Path, rel: &str) -> Result<PathBuf, AppCommandError> {
    let rel_path = Path::new(rel);
    validate_relative_components(rel_path)?;
    Ok(root.join(rel_path))
}

/// Strict confinement, for the upload path: a write that resolves outside the
/// root leaves a file there, so an unvetted symlink must never be followed.
fn ensure_inside_root(root: &Path, target: &Path) -> Result<(), AppCommandError> {
    let canonical_root = std::fs::canonicalize(root).map_err(AppCommandError::io)?;
    let canonical_target = std::fs::canonicalize(target).map_err(AppCommandError::io)?;
    if !crate::commands::folders::is_within_workspace(&canonical_root, &canonical_target) {
        return Err(AppCommandError::invalid_input(
            "Resolved path escapes workspace root",
        ));
    }
    Ok(())
}

/// Walk from `root` toward `target` one segment at a time and reject if any
/// already-existing component is a symlink. `target` must be a descendant of
/// `root` (callers compose it via `resolve_relative_path`).
///
/// This runs *before* `create_dir_all`, which would otherwise follow a
/// symlink mid-chain and silently create new directories outside the
/// workspace. The earlier post-hoc `canonicalize` check caught the
/// escape but the side-effect (empty dir at the symlink target) was
/// already on disk.
///
/// The one symlink that *is* followed is a directory the user explicitly linked
/// into this root (see [`crate::folder_links`]) — uploading into a linked
/// project is the point of a multi-folder workspace. The walk continues from
/// the *resolved* target, so a stray symlink inside the linked project is still
/// rejected.
///
/// Returns the link-free equivalent of `target`. Callers must use that path for
/// `create_dir_all` and the commit rather than the one they passed in: re-walking
/// the original would resolve the link a second time, and a link swapped in
/// between the two walks would place directories somewhere this check never saw.
fn resolve_upload_chain(root: &Path, target: &Path) -> Result<PathBuf, AppCommandError> {
    let rel = target
        .strip_prefix(root)
        .map_err(|_| AppCommandError::invalid_input("Target path is not under workspace root"))?;
    let canonical_root = std::fs::canonicalize(root).map_err(AppCommandError::io)?;
    let mut current = root.to_path_buf();
    // Once a component is missing, everything below it is missing too — there is
    // nothing left for `create_dir_all` to follow into, so the remaining
    // segments are appended without stat'ing them.
    let mut reached_missing = false;
    for component in rel.components() {
        let segment = match component {
            Component::Normal(s) => s,
            Component::CurDir => continue,
            _ => {
                return Err(AppCommandError::invalid_input(
                    "Invalid path component while validating upload target",
                ));
            }
        };
        current.push(segment);
        if reached_missing {
            continue;
        }
        match std::fs::symlink_metadata(&current) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    let resolved = std::fs::canonicalize(&current).map_err(AppCommandError::io)?;
                    if !crate::folder_links::is_allowed(&canonical_root, &resolved) {
                        return Err(AppCommandError::invalid_input(
                            "Upload path traverses a symlink; refuse to follow it",
                        ));
                    }
                    // Continue from the real directory so the rest of the chain
                    // is validated against it rather than through the link.
                    current = resolved;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                reached_missing = true;
            }
            Err(e) => return Err(AppCommandError::io(e)),
        }
    }
    Ok(current)
}

/// Strip cross-platform-hostile characters from a single path segment.
/// Empty / all-dots input collapses to `"file"` so the rename can succeed
/// even when the browser hands us a degenerate name.
fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned
        .trim_matches(|c: char| c.is_whitespace())
        .trim_end_matches('.');
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_relative_subpath(raw: &str) -> Result<String, AppCommandError> {
    let raw_parts: Vec<&str> = raw
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if raw_parts.is_empty() {
        return Err(AppCommandError::invalid_input("Invalid upload path"));
    }
    // Reject parent-dir traversal *before* `sanitize_segment` collapses
    // it to "file" — otherwise the check would never fire and a request
    // for `../escape` would silently rewrite to `file/escape`, hiding the
    // operator's intent (and surprising whoever audits the resulting
    // path on disk).
    if raw_parts.contains(&"..") {
        return Err(AppCommandError::invalid_input("Path cannot contain '..'"));
    }
    let parts: Vec<String> = raw_parts.iter().map(|s| sanitize_segment(s)).collect();
    Ok(parts.join("/"))
}

fn header_safe_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_control() || c == '"' || c == '\\' {
                '_'
            } else if c.is_ascii() {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn attachment_header(name: &str) -> Option<HeaderValue> {
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        header_safe_filename(name),
        urlencoding::encode(name)
    ))
    .ok()
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// Stream a single file from the operator's browser into the workspace.
///
/// Expected multipart fields (order matters — text fields must precede
/// `file` so the handler can resolve the destination before any bytes
/// land on disk):
///   * `root_path` — absolute path of the opened workspace folder
///   * `target_path` — relative directory under `root_path` to upload
///     into. Empty / missing means workspace root.
///   * `relative_path` — optional relative path *including filename*
///     used for folder uploads to preserve directory structure. When
///     present, the browser's filename is ignored.
///   * `file` — the file payload.
pub async fn upload_workspace_file(
    Extension(state): Extension<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<UploadWorkspaceFileResult>, AppCommandError> {
    let _permit = state
        .workspace_transfer
        .workspace_upload_semaphore
        .acquire()
        .await
        .map_err(|_| {
            AppCommandError::task_execution_failed("Workspace upload semaphore is closed")
        })?;

    let mut root_path: Option<String> = None;
    let mut target_path: Option<String> = None;
    let mut relative_path: Option<String> = None;
    let mut result: Option<UploadWorkspaceFileResult> = None;

    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        AppCommandError::io_error("Invalid multipart upload").with_detail(e.to_string())
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "root_path" | "rootPath" => {
                root_path = Some(field.text().await.map_err(|e| {
                    AppCommandError::io_error("Failed to read root_path field")
                        .with_detail(e.to_string())
                })?);
            }
            "target_path" | "targetPath" => {
                target_path = Some(field.text().await.map_err(|e| {
                    AppCommandError::io_error("Failed to read target_path field")
                        .with_detail(e.to_string())
                })?);
            }
            "relative_path" | "relativePath" => {
                relative_path = Some(field.text().await.map_err(|e| {
                    AppCommandError::io_error("Failed to read relative_path field")
                        .with_detail(e.to_string())
                })?);
            }
            "file" => {
                if result.is_some() {
                    return Err(AppCommandError::invalid_input(
                        "Multiple `file` fields are not supported per request",
                    ));
                }
                let root_str = root_path.as_deref().ok_or_else(|| {
                    AppCommandError::invalid_input(
                        "root_path field must appear before the file field",
                    )
                })?;
                let root = PathBuf::from(root_str);
                if !root.exists() || !root.is_dir() {
                    return Err(AppCommandError::not_found(
                        "Workspace folder does not exist",
                    ));
                }
                let canonical_root = std::fs::canonicalize(&root).map_err(AppCommandError::io)?;

                let file_name_hint = field
                    .file_name()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "file".to_string());

                let final_rel = compute_final_rel(
                    target_path.as_deref().unwrap_or(""),
                    relative_path.as_deref().unwrap_or(""),
                    &file_name_hint,
                )?;
                let mut final_abs = resolve_relative_path(&root, &final_rel)?;

                if let Some(parent) = final_abs.parent() {
                    // Reject *before* touching the filesystem if any existing
                    // component along the path is a symlink the user did not
                    // authorize — otherwise `create_dir_all` would follow the
                    // link and create directories outside the workspace before
                    // the canonical check below could fire. The resolved parent
                    // replaces the original: everything downstream then operates
                    // on real directories, so a link swapped in afterwards can't
                    // redirect the write.
                    let resolved_parent = resolve_upload_chain(&root, parent)?;
                    tokio::fs::create_dir_all(&resolved_parent)
                        .await
                        .map_err(|e| {
                            AppCommandError::io_error("Failed to create upload directory")
                                .with_detail(e.to_string())
                        })?;
                    let canonical_parent =
                        std::fs::canonicalize(&resolved_parent).map_err(AppCommandError::io)?;
                    if !crate::commands::folders::is_within_workspace(
                        &canonical_root,
                        &canonical_parent,
                    ) {
                        return Err(AppCommandError::invalid_input(
                            "Resolved path escapes workspace root",
                        ));
                    }
                    if let Some(file_name) = final_abs.file_name() {
                        final_abs = canonical_parent.join(file_name);
                    }
                }

                if final_abs.is_dir() {
                    return Err(AppCommandError::invalid_input(
                        "Refusing to overwrite an existing directory with a file",
                    ));
                }
                if final_abs.exists() {
                    return Err(AppCommandError::already_exists(
                        "A file with this name already exists",
                    ));
                }

                let staging_name = format!(".codeg-upload-{}.part", uuid::Uuid::new_v4().simple());
                let staging_path = final_abs
                    .parent()
                    .map(|p| p.join(&staging_name))
                    .ok_or_else(|| {
                        AppCommandError::invalid_input("Cannot determine parent directory")
                    })?;

                let mut out = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&staging_path)
                    .await
                    .map_err(|e| {
                        AppCommandError::io_error("Failed to create staging file")
                            .with_detail(e.to_string())
                    })?;

                let mut written: u64 = 0;
                let stream_result: Result<(), AppCommandError> = async {
                    while let Some(chunk) = field.chunk().await.map_err(|e| {
                        AppCommandError::io_error("Failed to read upload chunk")
                            .with_detail(e.to_string())
                    })? {
                        let new_total = written.saturating_add(chunk.len() as u64);
                        out.write_all(&chunk).await.map_err(|e| {
                            AppCommandError::io_error("Failed to write chunk")
                                .with_detail(e.to_string())
                        })?;
                        written = new_total;
                    }
                    out.flush().await.map_err(|e| {
                        AppCommandError::io_error("Failed to flush staging file")
                            .with_detail(e.to_string())
                    })?;
                    Ok(())
                }
                .await;
                drop(out);

                if let Err(err) = stream_result {
                    let _ = tokio::fs::remove_file(&staging_path).await;
                    return Err(err);
                }

                // Empty files are valid in a workspace (`.gitkeep`,
                // `__init__.py`, placeholder configs) — only chat
                // attachments need the "must contain bytes" guard, since
                // those feed an LLM. Don't reject here.

                // Commit the staging file onto the final name atomically.
                // `hard_link` errors with `AlreadyExists` instead of
                // silently overwriting, which closes the TOCTOU window
                // that a bare `rename` leaves open on Unix (rename(2)
                // replaces an existing destination). On filesystems that
                // don't support hard links (Windows FAT32, cross-device,
                // some FUSE mounts) we fall back to `rename` — that path
                // still has the narrow race but it's the best we can do
                // there, and the user is uploading into their own
                // workspace so the race window has no security impact.
                let commit_method: &str;
                match tokio::fs::hard_link(&staging_path, &final_abs).await {
                    Ok(()) => {
                        commit_method = "hard_link";
                        let _ = tokio::fs::remove_file(&staging_path).await;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        let _ = tokio::fs::remove_file(&staging_path).await;
                        return Err(AppCommandError::already_exists(
                            "A file with this name already exists",
                        ));
                    }
                    Err(hard_link_err) => {
                        if let Err(e) = tokio::fs::rename(&staging_path, &final_abs).await {
                            let _ = tokio::fs::remove_file(&staging_path).await;
                            return Err(AppCommandError::io_error("Failed to commit upload")
                                .with_detail(format!(
                                    "hard_link_err={hard_link_err} rename_err={e}"
                                )));
                        }
                        commit_method = "rename";
                    }
                }

                // Defense in depth: re-check that the committed path is
                // inside the root. If a symlink got swapped under us, undo.
                if let Err(err) = ensure_inside_root(&root, &final_abs) {
                    let _ = tokio::fs::remove_file(&final_abs).await;
                    return Err(err);
                }

                // Sanity verification: the API has been observed to
                // return success while leaving nothing on disk. Stat the
                // final path BEFORE responding so a regression surfaces
                // as an error here instead of as a phantom file in the
                // tree that delete/edit can't touch. Use symlink_metadata
                // (NOT exists()) so a dangling link is detected too.
                match tokio::fs::symlink_metadata(&final_abs).await {
                    Ok(_) => {}
                    Err(err) => {
                        tracing::error!(
                            "[workspace_files] upload commit verification FAILED: \
                             final_abs={} commit_method={} written={} err={}",
                            final_abs.display(),
                            commit_method,
                            written,
                            err
                        );
                        return Err(AppCommandError::io_error(
                            "Upload appeared to succeed but the file is missing",
                        )
                        .with_detail(format!(
                            "final_abs={} commit_method={} err={}",
                            final_abs.display(),
                            commit_method,
                            err
                        )));
                    }
                }

                let name = final_abs
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("file")
                    .to_string();

                result = Some(UploadWorkspaceFileResult {
                    path: final_rel,
                    name,
                    size: written,
                });
            }
            _ => {
                // Drain unknown fields to keep the parser moving.
                let _ = field.bytes().await;
            }
        }
    }

    result
        .ok_or_else(|| AppCommandError::invalid_input("Missing `file` field"))
        .map(Json)
}

fn compute_final_rel(
    target_dir: &str,
    relative_path: &str,
    file_name_hint: &str,
) -> Result<String, AppCommandError> {
    let target_dir_clean = target_dir.trim().trim_end_matches(['/', '\\']);
    let body = if !relative_path.trim().is_empty() {
        sanitize_relative_subpath(relative_path)?
    } else {
        let last = file_name_hint
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(file_name_hint);
        sanitize_segment(last)
    };
    let combined = if target_dir_clean.is_empty() {
        body
    } else {
        let dir = sanitize_relative_subpath(target_dir_clean)?;
        format!("{dir}/{body}")
    };
    // Final sanity check — re-validate the joined path as relative
    // components only.
    validate_relative_components(Path::new(&combined))?;
    Ok(combined)
}

// ---------------------------------------------------------------------------
// Download tickets
// ---------------------------------------------------------------------------

pub async fn create_download_ticket(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DownloadTicketRequest>,
) -> Result<Json<DownloadTicketIssued>, AppCommandError> {
    let issued = create_download_ticket_core(
        state.workspace_transfer.clone(),
        params,
        "/api/workspace_download".to_string(),
    )
    .await?;
    Ok(Json(issued))
}

async fn create_download_ticket_core(
    manager: Arc<crate::workspace_transfer::WorkspaceTransferManager>,
    params: DownloadTicketRequest,
    base_url: String,
) -> Result<DownloadTicketIssued, AppCommandError> {
    let (root_path, target_path, filename) = match params.kind {
        DownloadKind::File => {
            let root = PathBuf::from(&params.root_path);
            let target = resolve_download_file_target(&params.root_path, &params.path)?;
            let filename = target
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("download")
                .to_string();
            (root, target, filename)
        }
        DownloadKind::Dir => {
            let root = PathBuf::from(&params.root_path);
            let (target, dir_name) = resolve_download_dir_target(&params.root_path, &params.path)?;
            (root, target, format!("{dir_name}.zip"))
        }
    };

    let ticket = manager
        .issue_download_ticket(DownloadTicketSpec {
            root_path,
            target_path,
            relative_path: params.path,
            kind: params.kind,
            filename,
        })
        .await;

    let url_base = base_url.trim_end_matches('/');
    Ok(DownloadTicketIssued {
        url: format!("{url_base}/{}", ticket.ticket),
        ..ticket
    })
}

pub async fn consume_download_ticket(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath(ticket): AxumPath<String>,
) -> Result<Response, AppCommandError> {
    let Some(ticket) = state
        .workspace_transfer
        .consume_download_ticket(&ticket)
        .await
    else {
        return Err(AppCommandError::not_found(
            "Download ticket is invalid or expired",
        ));
    };

    match ticket.kind {
        DownloadKind::File => {
            let target = resolve_download_file_target(
                &ticket.root_path.to_string_lossy(),
                &ticket.relative_path,
            )?;
            stream_file_response(&target, &ticket.filename).await
        }
        DownloadKind::Dir => {
            let (target, _) = resolve_download_dir_target(
                &ticket.root_path.to_string_lossy(),
                &ticket.relative_path,
            )?;
            stream_zip_response(state.workspace_transfer.clone(), target, ticket.filename).await
        }
    }
}

fn ensure_workspace_root(root: &Path) -> Result<(), AppCommandError> {
    if !root.exists() || !root.is_dir() {
        return Err(AppCommandError::not_found(
            "Workspace folder does not exist",
        ));
    }
    Ok(())
}

pub(crate) fn resolve_download_file_target(
    root_path: &str,
    rel_path: &str,
) -> Result<PathBuf, AppCommandError> {
    let root = PathBuf::from(root_path);
    ensure_workspace_root(&root)?;
    let target = resolve_relative_path(&root, rel_path)?;
    if !target.exists() {
        return Err(AppCommandError::not_found("File does not exist"));
    }
    if !target.is_file() {
        return Err(AppCommandError::invalid_input("Path is not a file"));
    }
    // Downloading is the tree's own context-menu action, so it uses the same
    // boundary as opening the file in the editor: a symlink living inside the
    // workspace is part of it. (Uploads keep the strict rule above.)
    crate::commands::folders::ensure_user_navigable_path(&root, &target)?;
    Ok(target)
}

fn resolve_download_dir_target(
    root_path: &str,
    rel_path: &str,
) -> Result<(PathBuf, String), AppCommandError> {
    let root = PathBuf::from(root_path);
    ensure_workspace_root(&root)?;
    if rel_path.is_empty() {
        let name = root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workspace")
            .to_string();
        return Ok((root, name));
    }

    let resolved = resolve_relative_path(&root, rel_path)?;
    if !resolved.exists() {
        return Err(AppCommandError::not_found("Directory does not exist"));
    }
    if !resolved.is_dir() {
        return Err(AppCommandError::invalid_input("Path is not a directory"));
    }
    crate::commands::folders::ensure_user_navigable_path(&root, &resolved)?;
    let name = resolved
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("folder")
        .to_string();
    Ok((resolved, name))
}

// ---------------------------------------------------------------------------
// Download (single file)
// ---------------------------------------------------------------------------

pub async fn download_workspace_file(
    Json(params): Json<DownloadWorkspaceParams>,
) -> Result<Response, AppCommandError> {
    let target = resolve_download_file_target(&params.root_path, &params.path)?;
    let name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    stream_file_response(&target, &name).await
}

pub(crate) async fn stream_file_response(
    target: &Path,
    name: &str,
) -> Result<Response, AppCommandError> {
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(AppCommandError::io)?;
    let size = metadata.len();
    let file = tokio::fs::File::open(&target)
        .await
        .map_err(AppCommandError::io)?;

    let body_stream = stream::unfold(file, |mut file| async move {
        let mut buf = vec![0u8; 64 * 1024];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                let bytes: Bytes = buf.into();
                Some((Ok::<_, std::io::Error>(bytes), file))
            }
            Err(e) => Some((Err(e), file)),
        }
    });
    let body = Body::from_stream(body_stream);

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(v) = HeaderValue::from_str(&size.to_string()) {
        headers.insert(header::CONTENT_LENGTH, v);
    }
    if let Some(v) = attachment_header(name) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }

    Ok((StatusCode::OK, headers, body).into_response())
}

// ---------------------------------------------------------------------------
// Media streaming (video preview)
// ---------------------------------------------------------------------------

const MEDIA_LINK_EXPIRED: &str = "Media link is invalid or expired";

fn inline_header(name: &str) -> Option<HeaderValue> {
    HeaderValue::from_str(&format!(
        "inline; filename=\"{}\"; filename*=UTF-8''{}",
        header_safe_filename(name),
        urlencoding::encode(name)
    ))
    .ok()
}

/// Mint a streaming capability for one media file. Same path rules as a
/// single-file download (relative, no `..`, lexically inside the root), and
/// only for a video extension — the byte endpoint answers with the type the
/// extension implies, so it must never be handed an HTML file.
pub(crate) async fn issue_media_capability_core(
    manager: &crate::workspace_transfer::WorkspaceTransferManager,
    params: MediaCapabilityRequest,
) -> Result<MediaCapabilityIssued, AppCommandError> {
    let target = resolve_download_file_target(&params.root_path, &params.path)?;
    let filename = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();
    let content_type = media_content_type(&filename).ok_or_else(|| {
        AppCommandError::invalid_input("Only video files can be streamed for preview")
    })?;
    let size = tokio::fs::metadata(&target)
        .await
        .map_err(AppCommandError::io)?
        .len();
    let token = manager
        .issue_media_capability(
            PathBuf::from(&params.root_path),
            params.path,
            filename.clone(),
        )
        .await;
    Ok(MediaCapabilityIssued {
        url: format!(
            "{MEDIA_ROUTE_PREFIX}/{token}/{}",
            urlencoding::encode(&filename)
        ),
        token,
        filename,
        size,
        content_type: content_type.to_string(),
        expires_in_secs: manager.media_idle_ttl_secs(),
    })
}

pub async fn create_media_capability(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MediaCapabilityRequest>,
) -> Result<Json<MediaCapabilityIssued>, AppCommandError> {
    Ok(Json(
        issue_media_capability_core(&state.workspace_transfer, params).await?,
    ))
}

pub async fn revoke_media_capability(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MediaRevokeRequest>,
) -> Json<bool> {
    Json(
        state
            .workspace_transfer
            .revoke_media_capability(&params.token)
            .await,
    )
}

/// `GET /api/workspace_media/{token}` — public: the capability in the path is
/// the credential (a `<video src>` cannot send a Bearer header).
pub async fn serve_media(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    serve_media_with_headers(&state.workspace_transfer, &token, &headers).await
}

/// `GET /api/workspace_media/{token}/{name}` — same as [`serve_media`]; the
/// trailing file name only gives players (and "open in new tab") a URL that
/// ends in the real extension.
pub async fn serve_named_media(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath((token, _name)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    serve_media_with_headers(&state.workspace_transfer, &token, &headers).await
}

async fn serve_media_with_headers(
    manager: &crate::workspace_transfer::WorkspaceTransferManager,
    token: &str,
    headers: &HeaderMap,
) -> Response {
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match stream_media_response(manager, token, range).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

/// Resolve a capability to the file it names, re-applying the download path
/// rules — the file may have been moved or replaced since the mint.
pub(crate) async fn resolve_media_target(
    manager: &crate::workspace_transfer::WorkspaceTransferManager,
    token: &str,
) -> Result<(PathBuf, String), AppCommandError> {
    let invalid = || AppCommandError::not_found(MEDIA_LINK_EXPIRED);
    if !is_valid_media_token(token) {
        return Err(invalid());
    }
    let cap = manager
        .resolve_media_capability(token)
        .await
        .ok_or_else(invalid)?;
    let target =
        resolve_download_file_target(&cap.root_path.to_string_lossy(), &cap.relative_path)?;
    Ok((target, cap.filename))
}

/// Headers every media answer carries, whatever its status.
pub(crate) fn media_response_headers(filename: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(
            media_content_type(filename).unwrap_or("application/octet-stream"),
        ),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Some(v) = inline_header(filename) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    headers
}

fn header_value(value: impl ToString) -> HeaderValue {
    HeaderValue::from_str(&value.to_string()).unwrap_or_else(|_| HeaderValue::from_static("0"))
}

/// Serve a capability's file straight from disk, honouring `Range`. The body
/// streams in 64 KiB reads, so a multi-GB file costs no more memory than a
/// small one, and a seek is just a new request at a new offset.
async fn stream_media_response(
    manager: &crate::workspace_transfer::WorkspaceTransferManager,
    token: &str,
    range: Option<&str>,
) -> Result<Response, AppCommandError> {
    use tokio::io::AsyncSeekExt;

    let (target, filename) = resolve_media_target(manager, token).await?;
    let len = tokio::fs::metadata(&target)
        .await
        .map_err(AppCommandError::io)?
        .len();
    let mut headers = media_response_headers(&filename);

    let (status, start, count) = match plan_range(range, len) {
        RangePlan::Unsatisfiable => {
            headers.insert(
                header::CONTENT_RANGE,
                header_value(unsatisfied_content_range(len)),
            );
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response());
        }
        RangePlan::Full => (StatusCode::OK, 0, len),
        RangePlan::Partial { start, end } => {
            headers.insert(
                header::CONTENT_RANGE,
                header_value(content_range(start, end, len)),
            );
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
    };
    headers.insert(header::CONTENT_LENGTH, header_value(count));

    let mut file = tokio::fs::File::open(&target)
        .await
        .map_err(AppCommandError::io)?;
    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(AppCommandError::io)?;
    }
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(count), 64 * 1024));
    Ok((status, headers, body).into_response())
}

/// Render an error as a whole-body HTTP response, for the URI-scheme
/// transports (same status and JSON body the axum handlers would send).
#[cfg_attr(not(feature = "tauri-runtime"), allow(dead_code))]
pub(crate) fn buffered_error_response(err: AppCommandError) -> axum::http::Response<Vec<u8>> {
    let body = serde_json::to_vec(&err).unwrap_or_default();
    let status = err.into_response().status();
    let mut response = axum::http::Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

/// The same answer as [`stream_media_response`], but held in memory and
/// capped at `max_chunk` bytes — the desktop `codeg-media://` scheme hands its
/// responder a whole body, so each Range request gets one bounded slice.
#[cfg_attr(not(feature = "tauri-runtime"), allow(dead_code))]
pub(crate) async fn buffered_media_response(
    manager: &crate::workspace_transfer::WorkspaceTransferManager,
    token: &str,
    range: Option<&str>,
    max_chunk: u64,
) -> axum::http::Response<Vec<u8>> {
    match buffered_media_inner(manager, token, range, max_chunk).await {
        Ok(response) => response,
        Err(err) => buffered_error_response(err),
    }
}

async fn buffered_media_inner(
    manager: &crate::workspace_transfer::WorkspaceTransferManager,
    token: &str,
    range: Option<&str>,
    max_chunk: u64,
) -> Result<axum::http::Response<Vec<u8>>, AppCommandError> {
    let (target, filename) = resolve_media_target(manager, token).await?;
    let len = tokio::fs::metadata(&target)
        .await
        .map_err(AppCommandError::io)?
        .len();
    let mut headers = media_response_headers(&filename);

    let (status, body) = match cap_plan(plan_range(range, len), len, max_chunk) {
        RangePlan::Unsatisfiable => {
            headers.insert(
                header::CONTENT_RANGE,
                header_value(unsatisfied_content_range(len)),
            );
            (StatusCode::RANGE_NOT_SATISFIABLE, Vec::new())
        }
        RangePlan::Full if len == 0 => (StatusCode::OK, Vec::new()),
        RangePlan::Full => (
            StatusCode::OK,
            read_span(&target, 0, len - 1)
                .await
                .map_err(AppCommandError::io)?,
        ),
        RangePlan::Partial { start, end } => {
            let body = read_span(&target, start, end)
                .await
                .map_err(AppCommandError::io)?;
            // The file may have shrunk since the metadata read; describe the
            // bytes actually sent.
            let sent_end = start + (body.len() as u64).saturating_sub(1);
            headers.insert(
                header::CONTENT_RANGE,
                header_value(content_range(start, sent_end.max(start), len)),
            );
            (StatusCode::PARTIAL_CONTENT, body)
        }
    };
    headers.insert(header::CONTENT_LENGTH, header_value(body.len()));
    let mut response = axum::http::Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

// ---------------------------------------------------------------------------
// Download (directory as ZIP)
// ---------------------------------------------------------------------------

pub async fn download_workspace_dir(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DownloadWorkspaceParams>,
) -> Result<Response, AppCommandError> {
    let (dir_path, dir_name) = resolve_download_dir_target(&params.root_path, &params.path)?;
    stream_zip_response(
        state.workspace_transfer.clone(),
        dir_path,
        format!("{dir_name}.zip"),
    )
    .await
}

async fn stream_zip_response(
    manager: Arc<crate::workspace_transfer::WorkspaceTransferManager>,
    dir_path: PathBuf,
    zip_name: String,
) -> Result<Response, AppCommandError> {
    let body = Body::from_stream(zip_body_stream(manager, dir_path));

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    if let Some(v) = attachment_header(&zip_name) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok((StatusCode::OK, headers, body).into_response())
}

fn zip_body_stream(
    manager: Arc<crate::workspace_transfer::WorkspaceTransferManager>,
    dir_path: PathBuf,
) -> ReaderStream<tokio::io::DuplexStream> {
    let (reader, writer) = tokio::io::duplex(8 * 64 * 1024);
    tokio::spawn(async move {
        let result = write_zip_archive_to_stream(manager, dir_path.clone(), writer).await;
        if let Err(err) = result {
            tracing::error!(
                "[workspace_files] streaming zip failed for {}: {}{}",
                dir_path.display(),
                err.message,
                err.detail
                    .as_deref()
                    .map(|detail| format!(" ({detail})"))
                    .unwrap_or_default()
            );
        }
    });
    ReaderStream::with_capacity(reader, 64 * 1024)
}

async fn write_zip_archive_to_stream(
    manager: Arc<crate::workspace_transfer::WorkspaceTransferManager>,
    dir: PathBuf,
    sink: tokio::io::DuplexStream,
) -> Result<(), AppCommandError> {
    use futures_lite::io::AsyncWriteExt as _;

    let _permit =
        manager.zip_semaphore.acquire().await.map_err(|_| {
            AppCommandError::task_execution_failed("Workspace ZIP semaphore is closed")
        })?;

    let mut writer = ZipFileWriter::with_tokio(sink);
    let mut symlinks_skipped: u64 = 0;

    for entry in walkdir::WalkDir::new(&dir).follow_links(false) {
        let entry = entry.map_err(|e| {
            AppCommandError::io_error("Failed to walk directory").with_detail(e.to_string())
        })?;
        let path = entry.path();
        let rel = match path.strip_prefix(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            symlinks_skipped = symlinks_skipped.saturating_add(1);
            continue;
        }
        if file_type.is_dir() {
            let entry = ZipEntryBuilder::new(format!("{rel_str}/").into(), Compression::Deflate)
                .unix_permissions(0o755);
            writer.write_entry_whole(entry, &[]).await.map_err(|e| {
                AppCommandError::io_error("Failed to add dir to zip").with_detail(e.to_string())
            })?;
        } else if file_type.is_file() {
            let entry =
                ZipEntryBuilder::new(rel_str.into(), Compression::Deflate).unix_permissions(0o644);
            let mut entry_writer = writer.write_entry_stream(entry).await.map_err(|e| {
                AppCommandError::io_error("Failed to start zip entry").with_detail(e.to_string())
            })?;
            let mut f = tokio::fs::File::open(path)
                .await
                .map_err(AppCommandError::io)?;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = f.read(&mut buf).await.map_err(AppCommandError::io)?;
                if n == 0 {
                    break;
                }
                entry_writer.write_all(&buf[..n]).await.map_err(|e| {
                    AppCommandError::io_error("Failed to write zip entry")
                        .with_detail(e.to_string())
                })?;
            }
            entry_writer.close().await.map_err(|e| {
                AppCommandError::io_error("Failed to close zip entry").with_detail(e.to_string())
            })?;
        }
    }
    if symlinks_skipped > 0 {
        tracing::warn!(
            "[workspace_files] download_workspace_dir: skipped {} symlink entries under {}",
            symlinks_skipped,
            dir.display()
        );
    }
    writer.close().await.map_err(|e| {
        AppCommandError::io_error("Failed to finalize zip").with_detail(e.to_string())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt as _;

    #[test]
    fn sanitize_segment_replaces_hostile_chars_and_handles_dots() {
        // sanitize_segment is the *per-segment* sanitizer — it is not
        // expected to extract the basename; that's `sanitize_relative_subpath`'s
        // job. Hostile chars are replaced and degenerate inputs collapse
        // to "file" so the rename succeeds.
        assert_eq!(sanitize_segment("a:b*c?\"d"), "a_b_c__d");
        assert_eq!(sanitize_segment("..."), "file");
        assert_eq!(sanitize_segment(""), "file");
        assert_eq!(sanitize_segment("normal.txt"), "normal.txt");
    }

    #[test]
    fn sanitize_relative_subpath_joins_clean() {
        assert_eq!(sanitize_relative_subpath("a/b/c.txt").unwrap(), "a/b/c.txt");
        assert_eq!(
            sanitize_relative_subpath("a\\b\\c.txt").unwrap(),
            "a/b/c.txt"
        );
        assert_eq!(sanitize_relative_subpath("./a/./b").unwrap(), "a/b");
    }

    #[test]
    fn sanitize_relative_subpath_rejects_empty_and_traversal() {
        assert!(sanitize_relative_subpath("").is_err());
        assert!(sanitize_relative_subpath("/").is_err());
        assert!(sanitize_relative_subpath("../escape").is_err());
    }

    #[test]
    fn compute_final_rel_uses_file_name_when_no_relative() {
        assert_eq!(
            compute_final_rel("dir", "", "report.txt").unwrap(),
            "dir/report.txt"
        );
        assert_eq!(
            compute_final_rel("", "", "report.txt").unwrap(),
            "report.txt"
        );
    }

    #[test]
    fn compute_final_rel_prefers_relative_path() {
        assert_eq!(
            compute_final_rel("dir", "sub/a.txt", "ignored").unwrap(),
            "dir/sub/a.txt"
        );
        assert_eq!(
            compute_final_rel("", "a/b/c.txt", "ignored").unwrap(),
            "a/b/c.txt"
        );
    }

    #[test]
    fn validate_relative_components_rejects_dotdot_and_absolute() {
        assert!(validate_relative_components(Path::new("../escape")).is_err());
        assert!(validate_relative_components(Path::new("/etc/passwd")).is_err());
        assert!(validate_relative_components(Path::new("a/b")).is_ok());
    }

    #[tokio::test]
    async fn create_download_ticket_rejects_path_traversal() {
        let root = tempfile::tempdir().unwrap();
        let manager = std::sync::Arc::new(
            crate::workspace_transfer::WorkspaceTransferManager::new_for_tests(
                std::time::Duration::from_secs(60),
            ),
        );
        let err = create_download_ticket_core(
            manager,
            DownloadTicketRequest {
                root_path: root.path().to_string_lossy().to_string(),
                path: "../escape".to_string(),
                kind: crate::workspace_transfer::DownloadKind::File,
            },
            "/api/workspace_download".to_string(),
        )
        .await
        .unwrap_err();
        assert!(err.message.contains(".."));
    }

    #[tokio::test]
    async fn create_download_ticket_for_file_is_consumed_once() {
        let root = tempfile::tempdir().unwrap();
        let file_path = root.path().join("a.txt");
        tokio::fs::write(&file_path, b"hello").await.unwrap();
        let manager = std::sync::Arc::new(
            crate::workspace_transfer::WorkspaceTransferManager::new_for_tests(
                std::time::Duration::from_secs(60),
            ),
        );
        let issued = create_download_ticket_core(
            manager.clone(),
            DownloadTicketRequest {
                root_path: root.path().to_string_lossy().to_string(),
                path: "a.txt".to_string(),
                kind: crate::workspace_transfer::DownloadKind::File,
            },
            "/api/workspace_download".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(issued.filename, "a.txt");
        assert_eq!(
            issued.url,
            format!("/api/workspace_download/{}", issued.ticket)
        );
        assert!(manager
            .consume_download_ticket(&issued.ticket)
            .await
            .is_some());
        assert!(manager
            .consume_download_ticket(&issued.ticket)
            .await
            .is_none());
    }

    async fn build_zip_bytes_for_test(dir: PathBuf) -> Result<Vec<u8>, AppCommandError> {
        let manager = std::sync::Arc::new(
            crate::workspace_transfer::WorkspaceTransferManager::new_for_tests(
                std::time::Duration::from_secs(60),
            ),
        );
        let mut stream = zip_body_stream(manager, dir);
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(AppCommandError::io)?;
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    #[tokio::test]
    async fn streaming_zip_skips_symlinks_and_includes_regular_files() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(root.path().join("dir"))
            .await
            .unwrap();
        tokio::fs::write(root.path().join("dir").join("a.txt"), b"hello")
            .await
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", root.path().join("dir").join("link")).unwrap();

        let bytes = build_zip_bytes_for_test(root.path().join("dir"))
            .await
            .unwrap();
        let reader = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader).unwrap();
        assert!(archive.by_name("a.txt").is_ok());
        assert!(archive.by_name("link").is_err());
    }

    #[tokio::test]
    async fn streaming_zip_channel_drop_stops_writer() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..128 {
            tokio::fs::write(root.path().join(format!("f{i}.txt")), vec![b'x'; 1024])
                .await
                .unwrap();
        }
        let manager = std::sync::Arc::new(
            crate::workspace_transfer::WorkspaceTransferManager::new_for_tests(
                std::time::Duration::from_secs(60),
            ),
        );
        let stream = zip_body_stream(manager, root.path().to_path_buf());
        drop(stream);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_no_symlink_in_chain_rejects_intermediate_symlink() {
        use std::fs;
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir root");
        let outside = tempfile::tempdir().expect("tempdir outside");

        // root/link -> outside
        symlink(outside.path(), root.path().join("link")).expect("symlink");

        // Target: root/link/sub — does NOT exist, but the intermediate
        // `link` component is a symlink that would carry create_dir_all
        // out of the root.
        let target = root.path().join("link").join("sub");
        let err = resolve_upload_chain(root.path(), &target)
            .expect_err("should reject symlink in chain");
        assert!(
            err.message.contains("symlink"),
            "unexpected error: {}",
            err.message
        );

        // Sanity: no symlink in chain → ok, and the path comes back unchanged.
        fs::create_dir(root.path().join("real")).expect("real dir");
        let ok_target = root.path().join("real").join("nested").join("file.txt");
        assert_eq!(
            resolve_upload_chain(root.path(), &ok_target).expect("no symlinks"),
            ok_target
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_upload_chain_returns_the_link_free_path_for_an_authorized_link() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir root");
        let linked = tempfile::tempdir().expect("tempdir linked");
        symlink(linked.path(), root.path().join("api")).expect("symlink");

        let canonical_root = std::fs::canonicalize(root.path()).expect("canon root");
        let canonical_target = std::fs::canonicalize(linked.path()).expect("canon target");
        crate::folder_links::register(root.path(), &canonical_target);

        // The caller must receive the resolved path: re-walking the original
        // would resolve `api` a second time, so a link swapped in between the
        // check and `create_dir_all` could redirect the write.
        let resolved = resolve_upload_chain(root.path(), &root.path().join("api").join("sub"))
            .expect("authorized link is followed");
        assert_eq!(resolved, canonical_target.join("sub"));
        assert!(!resolved.starts_with(&canonical_root));

        crate::folder_links::unregister(root.path(), &canonical_target);

        // Revoked: the very same path is rejected again.
        assert!(
            resolve_upload_chain(root.path(), &root.path().join("api").join("sub")).is_err(),
            "unlinking must revoke upload access too"
        );
    }

    // ── Media streaming ────────────────────────────────────────────────

    fn media_manager() -> crate::workspace_transfer::WorkspaceTransferManager {
        crate::workspace_transfer::WorkspaceTransferManager::new_for_tests(
            std::time::Duration::from_secs(60),
        )
    }

    async fn mint_clip(
        manager: &crate::workspace_transfer::WorkspaceTransferManager,
    ) -> (tempfile::TempDir, MediaCapabilityIssued) {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(root.path().join("media"))
            .await
            .unwrap();
        tokio::fs::write(root.path().join("media/clip.mp4"), b"0123456789")
            .await
            .unwrap();
        let issued = issue_media_capability_core(
            manager,
            MediaCapabilityRequest {
                root_path: root.path().to_string_lossy().to_string(),
                path: "media/clip.mp4".to_string(),
            },
        )
        .await
        .unwrap();
        (root, issued)
    }

    async fn fetch(
        manager: &crate::workspace_transfer::WorkspaceTransferManager,
        token: &str,
        range: Option<&str>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let response = match stream_media_response(manager, token, range).await {
            Ok(response) => response,
            Err(err) => err.into_response(),
        };
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, headers, body)
    }

    fn header_str(headers: &HeaderMap, name: header::HeaderName) -> &str {
        headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    #[tokio::test]
    async fn media_capability_describes_the_stream() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        assert_eq!(issued.filename, "clip.mp4");
        assert_eq!(issued.size, 10);
        assert_eq!(issued.content_type, "video/mp4");
        assert_eq!(
            issued.url,
            format!("/api/workspace_media/{}/clip.mp4", issued.token)
        );
        assert!(is_valid_media_token(&issued.token));
    }

    #[tokio::test]
    async fn media_without_range_streams_the_whole_file() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        let (status, headers, body) = fetch(&manager, &issued.token, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"0123456789");
        assert_eq!(header_str(&headers, header::CONTENT_LENGTH), "10");
        assert_eq!(header_str(&headers, header::CONTENT_TYPE), "video/mp4");
        assert_eq!(header_str(&headers, header::ACCEPT_RANGES), "bytes");
        assert!(headers.get(header::CONTENT_RANGE).is_none());
    }

    #[tokio::test]
    async fn media_closed_range_is_partial_content() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        let (status, headers, body) = fetch(&manager, &issued.token, Some("bytes=2-5")).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(body, b"2345");
        assert_eq!(header_str(&headers, header::CONTENT_RANGE), "bytes 2-5/10");
        assert_eq!(header_str(&headers, header::CONTENT_LENGTH), "4");
        assert_eq!(header_str(&headers, header::ACCEPT_RANGES), "bytes");
    }

    #[tokio::test]
    async fn media_open_ended_range_runs_to_eof() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        let (status, headers, body) = fetch(&manager, &issued.token, Some("bytes=7-")).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(body, b"789");
        assert_eq!(header_str(&headers, header::CONTENT_RANGE), "bytes 7-9/10");
    }

    #[tokio::test]
    async fn media_suffix_range_serves_the_tail() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        let (status, headers, body) = fetch(&manager, &issued.token, Some("bytes=-3")).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(body, b"789");
        assert_eq!(header_str(&headers, header::CONTENT_RANGE), "bytes 7-9/10");
    }

    #[tokio::test]
    async fn media_unsatisfiable_range_is_416() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        for range in ["bytes=10-", "bytes=50-60", "bytes=6-2", "bytes=x-"] {
            let (status, headers, body) = fetch(&manager, &issued.token, Some(range)).await;
            assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
            assert_eq!(header_str(&headers, header::CONTENT_RANGE), "bytes */10");
            assert!(body.is_empty());
        }
    }

    #[tokio::test]
    async fn media_link_is_refused_when_unknown_malformed_or_revoked() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;
        let (status, _, _) = fetch(&manager, "0123456789abcdef0123456789abcdef", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = fetch(&manager, "../../etc/passwd", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(manager.revoke_media_capability(&issued.token).await);
        let (status, _, _) = fetch(&manager, &issued.token, Some("bytes=0-1")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn media_capability_applies_the_download_path_rules() {
        let manager = media_manager();
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        tokio::fs::write(outside.path().join("secret.mp4"), b"x")
            .await
            .unwrap();
        tokio::fs::write(root.path().join("page.html"), b"<script>")
            .await
            .unwrap();
        let root_path = root.path().to_string_lossy().to_string();
        let mint = |path: String| {
            let root_path = root_path.clone();
            let manager = &manager;
            async move {
                issue_media_capability_core(
                    manager,
                    MediaCapabilityRequest {
                        root_path,
                        path,
                    },
                )
                .await
            }
        };

        // Parent traversal and absolute paths never resolve.
        let escape = format!(
            "../{}/secret.mp4",
            outside.path().file_name().unwrap().to_string_lossy()
        );
        assert!(mint(escape).await.unwrap_err().message.contains(".."));
        let absolute = outside.path().join("secret.mp4").to_string_lossy().to_string();
        assert!(mint(absolute).await.is_err());
        // Missing files and directories are refused.
        assert!(mint("missing.mp4".to_string()).await.is_err());
        // Non-media files are refused, so the endpoint can't serve HTML.
        assert!(mint("page.html".to_string()).await.is_err());
    }

    #[tokio::test]
    async fn buffered_media_caps_each_answer_at_the_chunk_size() {
        let manager = media_manager();
        let (_root, issued) = mint_clip(&manager).await;

        // Open-ended: one 4-byte slice, announced against the real length.
        let response = buffered_media_response(&manager, &issued.token, Some("bytes=3-"), 4).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"3456");
        assert_eq!(
            header_str(response.headers(), header::CONTENT_RANGE),
            "bytes 3-6/10"
        );
        assert_eq!(header_str(response.headers(), header::CONTENT_LENGTH), "4");

        // No Range on a file bigger than the cap: the first slice, as a 206.
        let response = buffered_media_response(&manager, &issued.token, None, 4).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"0123");

        // Small enough: the whole file, as a 200.
        let response = buffered_media_response(&manager, &issued.token, None, 64).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"0123456789");

        let response =
            buffered_media_response(&manager, &issued.token, Some("bytes=10-"), 4).await;
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        let response =
            buffered_media_response(&manager, "0123456789abcdef0123456789abcdef", None, 4).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn media_link_stops_working_once_the_file_is_gone() {
        let manager = media_manager();
        let (root, issued) = mint_clip(&manager).await;
        tokio::fs::remove_file(root.path().join("media/clip.mp4"))
            .await
            .unwrap();
        let (status, _, _) = fetch(&manager, &issued.token, Some("bytes=0-")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
