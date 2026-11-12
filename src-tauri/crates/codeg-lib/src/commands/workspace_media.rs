//! Desktop side of the video preview.
//!
//! * `workspace_media_capability` / `workspace_media_revoke` — the mint and
//!   revoke commands a LOCAL desktop window calls (a remote-workspace window
//!   calls the same-named HTTP endpoints on its server through
//!   `remote_http_call`, like every other command).
//! * the `codeg-media://` URI scheme — what the webview's `<video src>`
//!   actually loads, in both kinds of window:
//!     - `local/<token>/<name>` reads a bounded slice of the file from disk;
//!     - `remote/<connection id>/<token>/<name>` forwards the Range request to
//!       the remote server's `/api/workspace_media/<token>` byte endpoint with
//!       the connection's custom headers and returns the slice it answers
//!       with. The webview never talks to the remote origin itself, so an
//!       `http://` remote (mixed content) or one behind header-based access
//!       control works exactly like a local file.
//!
//! The Tauri responder takes a whole body, so every answer is one capped
//! slice (see `crate::workspace_media`); players simply ask again from the
//! next offset, which is also exactly what a seek is.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

use crate::app_error::AppCommandError;
use crate::commands::remote_proxy::{request_error_detail, RemoteProxyState};
use crate::db::service::remote_workspace_connection_service;
use crate::db::AppDatabase;
use crate::models::ToHeaderMap;
use crate::web::handlers::workspace_files::{
    buffered_error_response, buffered_media_response, issue_media_capability_core,
    MediaCapabilityIssued, MediaCapabilityRequest,
};
use crate::workspace_media::{
    parse_media_scheme_path, upstream_range_header, MediaSchemeRoute, LOCAL_SCHEME_CHUNK_BYTES,
    MEDIA_ROUTE_PREFIX, REMOTE_SCHEME_CHUNK_BYTES,
};
use crate::workspace_transfer::WorkspaceTransferManager;

/// Bound on one forwarded range request (connect + a few MiB of body).
const REMOTE_MEDIA_TIMEOUT: Duration = Duration::from_secs(60);

#[tauri::command]
pub async fn workspace_media_capability(
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    root_path: String,
    path: String,
) -> Result<MediaCapabilityIssued, AppCommandError> {
    issue_media_capability_core(&transfers, MediaCapabilityRequest { root_path, path }).await
}

#[tauri::command]
pub async fn workspace_media_revoke(
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    token: String,
) -> Result<bool, AppCommandError> {
    Ok(transfers.revoke_media_capability(&token).await)
}

/// Entry point registered with `register_asynchronous_uri_scheme_protocol`.
pub fn handle_media_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        responder.respond(media_response(&app, &request).await);
    });
}

async fn media_response<R: Runtime>(
    app: &AppHandle<R>,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    match parse_media_scheme_path(request.uri().path()) {
        Some(MediaSchemeRoute::Local { token }) => {
            let Some(transfers) = app.try_state::<Arc<WorkspaceTransferManager>>() else {
                return buffered_error_response(AppCommandError::not_found(
                    "Media streaming is unavailable",
                ));
            };
            buffered_media_response(&transfers, &token, range, LOCAL_SCHEME_CHUNK_BYTES).await
        }
        Some(MediaSchemeRoute::Remote {
            connection_id,
            token,
        }) => match remote_media_response(app, connection_id, &token, range).await {
            Ok(response) => response,
            Err(err) => buffered_error_response(err),
        },
        None => buffered_error_response(AppCommandError::not_found("Unknown media link")),
    }
}

async fn remote_media_response<R: Runtime>(
    app: &AppHandle<R>,
    connection_id: i32,
    token: &str,
    range: Option<&str>,
) -> Result<Response<Vec<u8>>, AppCommandError> {
    let db = app
        .try_state::<AppDatabase>()
        .ok_or_else(|| AppCommandError::database_error("Database is not ready"))?;
    let proxy = app
        .try_state::<Arc<RemoteProxyState>>()
        .ok_or_else(|| AppCommandError::network("Remote proxy is not ready"))?;
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let url = format!(
        "{}{MEDIA_ROUTE_PREFIX}/{token}",
        conn.base_url.trim_end_matches('/')
    );
    let mut upstream = proxy
        .workspace_http()
        .get(url)
        .headers(conn.headers.to_header_map())
        .timeout(REMOTE_MEDIA_TIMEOUT);
    // Close every range off at the chunk size: the answer is buffered here.
    // An unparseable client range goes through untouched for the server to
    // answer with its own 416.
    if let Some(bounded) =
        upstream_range_header(range, REMOTE_SCHEME_CHUNK_BYTES).or_else(|| range.map(str::to_string))
    {
        upstream = upstream.header(header::RANGE, bounded);
    }
    let response = upstream.send().await.map_err(|e| {
        AppCommandError::network("Remote media request failed").with_detail(request_error_detail(&e))
    })?;

    let status = response.status();
    // Upstream response headers worth passing through to the player.
    let mut headers = http::HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CACHE_CONTROL,
        header::CONTENT_DISPOSITION,
        header::X_CONTENT_TYPE_OPTIONS,
    ] {
        if let Some(value) = response.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }

    // A compliant server never sends more than the bounded range asked for;
    // the limit only guards against one that ignores Range and starts
    // streaming a whole multi-GB file into memory.
    let limit = (REMOTE_SCHEME_CHUNK_BYTES + 64 * 1024) as usize;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            AppCommandError::network("Remote media stream failed").with_detail(e.to_string())
        })?;
        if body.len() + chunk.len() > limit {
            return Err(AppCommandError::network(
                "Remote server ignored the requested byte range",
            ));
        }
        body.extend_from_slice(&chunk);
    }

    if let Ok(len) = HeaderValue::from_str(&body.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, len);
    }
    let mut out = Response::new(body);
    *out.status_mut() = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    *out.headers_mut() = headers;
    Ok(out)
}
