//! Remote-workspace IPC proxy.
//!
//! When a desktop window is opened against a remote codeg-server, every API
//! call and WebSocket event for that connection is funnelled through Rust
//! commands defined here. The webview never opens an HTTP/WS connection to
//! the remote host directly — that path is blocked by the Tauri webview's
//! secure-context mixed-content rules whenever the remote URL is plain
//! `http://`. Routing through Rust (reqwest + tokio-tungstenite) bypasses
//! those rules and gives us a single place to manage auth, reconnect, and
//! per-window event isolation.
//!
//! ## Isolation contract
//!
//! - Different `connection_id`s use distinct Tauri event channels and
//!   distinct background WS tasks.
//! - Within one `connection_id`, multiple webviews (main + remote-settings
//!   child window, etc.) share **one** underlying WS connection. Each
//!   subscriber label has its own event name (`remote-ws-event-{id}-{label}`)
//!   and target, and the JS transport listens on that name from its own
//!   webview. We never `app.emit(...)` globally, and since no two windows
//!   share an event name, each window receives each frame exactly once.
//! - When the last subscriber for a connection unsubscribes (or its window
//!   is destroyed), the WS task shuts down and the entry is removed from
//!   the proxy state.
//!
//! The whole module is gated to `feature = "tauri-runtime"` via `mod.rs`;
//! the inner-attribute form here would duplicate the predicate.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::{SinkExt, Stream, StreamExt};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioIo;
use sea_orm::DatabaseConnection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, State, WebviewWindow};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch, Mutex, Notify, RwLock};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    error::UrlError,
    handshake::client::{Request, Response},
    http::{HeaderMap, HeaderValue, Uri},
    Error as WsError, Message,
};
use tokio_util::sync::CancellationToken;
use tower_service::Service;

/// Outbound mpsc capacity per remote WS. Bounded so a runaway frontend
/// cannot exhaust memory by piling client-→-server messages, but generous
/// enough to absorb a brief handshake burst (multiple attaches firing at
/// the same moment when the user opens several conversation tabs).
const OUTBOUND_CAPACITY: usize = 64;

/// Maximum time `remote_ws_send_text` will wait for the outbound mpsc to
/// accept a frame before failing. Under sustained backpressure we'd rather
/// surface the failure to the JS side (which can reissue attaches) than
/// silently drop or block the Tauri command worker indefinitely.
const OUTBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(2);

use crate::app_error::{
    AppCommandError, AppErrorCode, UPLOAD_I18N_KEY_NOT_A_FILE, UPLOAD_I18N_KEY_TOO_LARGE,
};
use crate::db::service::remote_workspace_connection_service;
use crate::db::AppDatabase;
use crate::models::{RemoteWorkspaceConnectionInfo, ToHeaderMap};
use crate::workspace_transfer::{
    TransferDirection, TransferState, WorkspaceTransferManager, WorkspaceTransferProgress,
    WORKSPACE_TRANSFER_PROGRESS_EVENT,
};

/// Default HTTP request timeout. Long enough to survive remote ACP prompts
/// (which can stream for a while) but bounded so a hung remote can't lock a
/// webview indefinitely. Matches the JS-side `WEB_CALL_TIMEOUT_MS` ceiling
/// for unannotated requests. Callers that need more (e.g. the 60s ACP
/// `acp_describe_agent_options` probe) pass an explicit `timeout_ms` to
/// `remote_http_call`, which then uses `RequestBuilder::timeout` to override
/// this default for that single request.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound on per-request timeout overrides. Caps how much a caller can
/// extend the default — protects against a buggy / malicious JS caller
/// supplying a huge value and locking a Tauri command worker on a hung
/// remote. 10 minutes is comfortably above every existing override (the
/// longest today is 70s for `describeAgentOptions`).
const HTTP_TIMEOUT_MAX: Duration = Duration::from_secs(600);

/// Bound on writing one frame (an outbound frame, a pong, a close) to the
/// event socket. A socket whose buffer is wedged must not stall the read
/// loop: a write that does not complete in time costs the socket.
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(8);

/// Exponential backoff bounds for WS reconnect: 1 s doubling up to 30 s,
/// each wait spread by jitter (`ws_backoff_delay`).
const WS_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const WS_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Shortest gap between two connect attempts, however often the frontend
/// asks for an early retry (`remote_ws_probe`). Every failed HTTP call used
/// to ask for one, and each skipped the whole backoff: with the server down
/// and the UI's calls failing as fast as they were made, the task retried
/// about ten times a second.
const WS_MIN_RETRY_GAP: Duration = Duration::from_secs(2);

/// Most idle connections the proxy's HTTP pool keeps per remote. HTTP/1.1
/// carries one request at a time per connection and reqwest sets no
/// per-host cap, so a window's startup burst opens one connection for every
/// request in flight — about 70 against the box after an app restart. With
/// no cap on the idle pool they all stayed open until its idle timeout, and
/// any the client lost meanwhile (sleep, a network change) stayed open on
/// the server for good. Past this many, a connection is closed as soon as
/// its request is done.
const HTTP_POOL_MAX_IDLE_PER_HOST: usize = 8;
/// An idle pooled connection is closed by this side well before the
/// server's own idle timeout (120 s, `web::serve`), so a request never
/// races the server closing the very connection it picked.
const HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// TCP keepalive on the proxy's connections, for a long call whose answer
/// has not started: the server vanishing is noticed by the probes.
const HTTP_TCP_KEEPALIVE: Duration = Duration::from_secs(60);
/// A remote that does not even answer the TCP handshake (asleep, off the
/// tailnet) fails a call fast instead of after the whole request timeout.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Heartbeat for the proxied WS. A socket that died while the laptop slept
/// (lid closed) never produces a read error or a close frame by itself:
/// the kernel only learns the peer is gone when something is written and
/// the retransmits time out, and this task writes nothing unless the
/// frontend sends a frame. So it would sit in the read loop indefinitely
/// while the remote server streams a whole turn into the void — the
/// "stale transcript after wake" bug. The heartbeat pings after
/// `WS_HEARTBEAT_INTERVAL` of silence (any inbound frame is proof of life,
/// so a busy stream never pays for it) and gives the pong an adaptive
/// deadline whose floor is `WS_PONG_TIMEOUT`; a pong past it costs the
/// socket only once a health probe also fails (see `Heartbeat`): leave the
/// read loop, emit `__disconnected__`, reconnect. The remote axum server
/// answers protocol-level pings on its own.
const WS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const WS_PONG_TIMEOUT: Duration = Duration::from_secs(10);
/// The same pair while a turn streams on screen in a subscribed window
/// (`remote_ws_set_streaming`): silence mid-turn is suspicious sooner.
const WS_STREAM_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const WS_STREAM_PONG_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound of the adaptive pong deadline.
const WS_PONG_CEILING: Duration = Duration::from_secs(30);
/// Floors and ceiling of the health probe's adaptive timeout (idle, and
/// while streaming), and the slack after which a probe that never settled
/// is given up on regardless.
const WS_HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const WS_HEALTH_PROBE_STREAM_TIMEOUT: Duration = Duration::from_secs(5);
const WS_HEALTH_PROBE_CEILING: Duration = Duration::from_secs(20);
const WS_HEALTH_PROBE_SLACK: Duration = Duration::from_secs(1);
/// Deadline extensions one ping may earn from successful health probes.
const WS_MAX_DEADLINE_EXTENSIONS: u32 = 2;
/// Round-trip samples the heartbeat keeps.
const WS_RTT_SAMPLES: usize = 16;
/// Pong deadline for a frontend-requested probe (`remote_ws_probe`, sent on
/// tab-visible / lid-open). Tight on purpose: the user is looking at the
/// screen, and a false positive only costs one reconnect + re-attach.
const WS_PROBE_PONG_TIMEOUT: Duration = Duration::from_secs(4);
/// Bound on one handshake attempt (TCP + TLS + upgrade). A connect toward a
/// host that silently drops packets — a laptop that just woke, a VPN still
/// re-establishing — otherwise waits out the OS's own connect timeout, which
/// can take minutes, before the reconnect loop gets to try again. Timing out
/// is a transient failure like any other network error.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on writing a heartbeat ping. A dead socket normally accepts the
/// write into the kernel buffer (the missing pong is what catches it), but a
/// socket whose buffer is wedged must not stall the read loop either.
const WS_PING_SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// MUST match the values in `src/web/auth.rs` (this crate) and
/// `src/lib/transport/ws-auth.ts`. The server's auth middleware reads the
/// `sec-websocket-protocol` header looking for `codeg-token.{base64url}`.
const WS_EVENT_PROTOCOL: &str = "codeg-events";
const WS_TOKEN_PROTOCOL_PREFIX: &str = "codeg-token.";
const WS_EVENTS_PATH: &str = "/ws/events";

/// Internal Tauri-event channels emitted by this proxy. The frontend
/// `RemoteDesktopTransport` reserves these names. MUST match the
/// equivalents in `src/lib/transport/constants.ts` and the
/// `__disconnected__` / `__unauthorized__` literals in
/// `src/lib/transport/remote-desktop-transport.ts`.
const WS_READY_CHANNEL: &str = "__ready__";
const WS_DISCONNECTED_CHANNEL: &str = "__disconnected__";
const WS_UNAUTHORIZED_CHANNEL: &str = "__unauthorized__";

/// One entry per active remote `connection_id` with at least one webview
/// subscribed.
struct WsTaskEntry {
    /// subscription_id (opaque string generated by the JS transport) →
    /// subscriber metadata. Using an opaque ID as the key means two concurrent
    /// transports for the same label never collide: each has its own key, so a
    /// stale unsubscribe from an old transport only removes its own entry and
    /// cannot affect a new transport that reused the same label.
    /// Fan-out deduplicates labels so a label shared by two subscriptions
    /// (shouldn't happen in practice) still receives only one copy per frame.
    subscribers: Mutex<HashMap<String, WsSubscriber>>,
    /// True only after the current underlying WebSocket has emitted `__ready__`.
    ready: RwLock<bool>,
    /// Signals the background WS task to exit.
    shutdown_tx: watch::Sender<bool>,
    /// Outbound text messages to forward over the WS to the remote server.
    /// Used by the attach protocol (Phase 4a) so a Tauri frontend can send
    /// `attach`/`detach`/`ping` frames through the proxy without owning the
    /// WS itself. Frames are dropped (with a warning log) when the WS is
    /// not currently OPEN — the JS-side `RemoteEventStream` re-issues
    /// attach frames on every `__ready__` so a transient WS gap is recovered
    /// automatically.
    outbound_tx: mpsc::Sender<String>,
    /// Wake-time liveness probe requested by the frontend
    /// (`remote_ws_probe`): the WS task pings at once under the short
    /// `WS_PROBE_PONG_TIMEOUT` instead of waiting for the next quiet
    /// interval — or, while it is between reconnect attempts, skips the rest
    /// of the backoff wait. A `Notify` so a request landing between two loop
    /// iterations is kept as a permit, not lost.
    probe: Notify,
    /// Subscriptions whose window has a turn streaming on screen
    /// (`remote_ws_set_streaming`). While any does, the heartbeat watches the
    /// socket more closely; `streaming_changed` tells the read loop.
    streaming: std::sync::Mutex<HashSet<String>>,
    streaming_changed: Notify,
}

impl WsTaskEntry {
    fn is_streaming(&self) -> bool {
        self.streaming
            .lock()
            .map(|subs| !subs.is_empty())
            .unwrap_or(false)
    }

    fn set_subscription_streaming(&self, subscription_id: &str, streaming: bool) {
        let changed = match self.streaming.lock() {
            Ok(mut subs) if streaming => subs.insert(subscription_id.to_string()),
            Ok(mut subs) => subs.remove(subscription_id),
            Err(_) => false,
        };
        if changed {
            self.streaming_changed.notify_one();
        }
    }

    /// Drop the streaming flags of subscriptions that are gone.
    fn forget_streaming<'a>(&self, subscription_ids: impl IntoIterator<Item = &'a String>) {
        let mut changed = false;
        if let Ok(mut subs) = self.streaming.lock() {
            // Every id is removed: no short-circuit.
            for id in subscription_ids {
                changed |= subs.remove(id);
            }
        }
        if changed {
            self.streaming_changed.notify_one();
        }
    }
}

#[derive(Clone)]
struct WsSubscriber {
    label: String,
    window_instance_id: String,
}

/// Matches `reqwest`'s own default redirect bound.
const MAX_REMOTE_REDIRECTS: usize = 10;

/// Two URLs reach the same server over the same kind of channel.
///
/// Scheme, host and port — a true origin, one notch stricter than the host-and-
/// port test `reqwest` uses to decide whether to strip `Authorization`. The
/// extra notch is the point: on a connection configured as `https://box:8443`,
/// a hop to `http://box:8443` keeps reqwest's host and port identical, so its
/// rule would allow it and put the connection's credentials on the wire in
/// plaintext. Refusing a scheme change costs only the `http` → `https` upgrade
/// on an identical explicit port, which is a URL the user can simply configure.
fn same_remote_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// `host:port` for an error message. The port is not decoration: two ports on
/// one host are two origins here, and "refused a redirect off 127.0.0.1 to
/// 127.0.0.1" would read as a bug.
fn origin_label(url: &reqwest::Url) -> String {
    match (url.host_str(), url.port_or_known_default()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => url.as_str().to_string(),
    }
}

/// Redirect policy for every request that carries a connection's credentials.
///
/// `reqwest` already drops `Authorization` once a redirect crosses to another
/// host, so such a hop could only ever have come back 401 anyway. What it does
/// not know to drop is the connection's custom headers, which are credentials
/// of exactly the same kind — a Cloudflare Access service token, a proxy
/// secret. Refusing the hop keeps them on the host the user configured, and
/// turns what would have been a confusing 401 into a message that names the
/// problem. Same-host redirects still follow, under reqwest's own bound.
pub(crate) fn connection_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let Some(previous) = attempt.previous().last() else {
            return attempt.follow();
        };
        if !same_remote_origin(previous, attempt.url()) {
            let message = format!(
                "refused a redirect off {} to {}: it would hand the connection's \
                 custom headers to another host",
                origin_label(previous),
                origin_label(attempt.url()),
            );
            return attempt.error(message);
        }
        // `>` not `>=`, to land on the same count `Policy::limited` allows.
        if attempt.previous().len() > MAX_REMOTE_REDIRECTS {
            return attempt.error(format!("more than {MAX_REMOTE_REDIRECTS} redirects"));
        }
        attempt.follow()
    })
}

/// Flatten a failed request into a detail string worth showing.
///
/// `reqwest`'s own `Display` stops at the outermost layer — "error following
/// redirect for url (…)", "error sending request for url (…)" — which is
/// precisely the layer that carries no reason. Everything worth reading is in
/// the source chain: the redirect refusal above, the connect error, the TLS
/// failure. Without this the host-pinning error reaches the user as a bare
/// "error following redirect" and looks like a bug rather than a decision.
pub(crate) fn request_error_detail(err: &reqwest::Error) -> String {
    let mut detail = err.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    detail
}

/// Tauri-managed singleton.
pub struct RemoteProxyState {
    tasks: Mutex<HashMap<i32, Arc<WsTaskEntry>>>,
    destroyed_window_instances: Mutex<HashSet<String>>,
    http: reqwest::Client,
    workspace_http: reqwest::Client,
}

/// The builder both of the proxy's long-lived HTTP clients start from: one
/// shared pool per client, bounded (see `HTTP_POOL_MAX_IDLE_PER_HOST`).
fn proxy_http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(connection_redirect_policy())
        .pool_max_idle_per_host(HTTP_POOL_MAX_IDLE_PER_HOST)
        .pool_idle_timeout(HTTP_POOL_IDLE_TIMEOUT)
        .tcp_keepalive(HTTP_TCP_KEEPALIVE)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
}

impl RemoteProxyState {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            destroyed_window_instances: Mutex::new(HashSet::new()),
            http: proxy_http_client_builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .expect("failed to build reqwest client for remote proxy"),
            workspace_http: proxy_http_client_builder()
                .build()
                .expect("failed to build reqwest workspace client for remote proxy"),
        }
    }

    /// The untimed client used for workspace transfers — also the video
    /// preview's range forwarder (`commands::workspace_media`), which sets a
    /// per-request timeout of its own.
    pub(crate) fn workspace_http(&self) -> &reqwest::Client {
        &self.workspace_http
    }

    /// Register a forced-close cleanup hook for a concrete Tauri webview
    /// instance. This runs from window creation time, before frontend code can
    /// issue `remote_ws_subscribe`, so even a window destroyed while the
    /// subscribe invoke is still queued gets a tombstone before any late
    /// subscription insert can land.
    pub fn register_window_instance_cleanup(
        self: &Arc<Self>,
        window: &WebviewWindow,
        window_instance_id: String,
    ) {
        let proxy = self.clone();
        let label = window.label().to_string();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let proxy = proxy.clone();
            let label = label.clone();
            let window_instance_id = window_instance_id.clone();
            tauri::async_runtime::spawn(async move {
                proxy
                    .mark_window_instance_destroyed(&label, &window_instance_id)
                    .await;
            });
        });
    }

    /// Remove one subscription by its opaque ID. Shuts down the WS task if
    /// no subscribers remain. A stale unsubscribe from a destroyed transport
    /// only removes its own ID and cannot affect any other transport.
    async fn remove_subscription(self: &Arc<Self>, connection_id: i32, subscription_id: &str) {
        let shutdown_tx = {
            let mut tasks = self.tasks.lock().await;
            let entry = match tasks.get(&connection_id) {
                Some(e) => e.clone(),
                None => return,
            };
            let mut subs = entry.subscribers.lock().await;
            subs.remove(subscription_id);
            entry.forget_streaming([&subscription_id.to_string()]);
            if subs.is_empty() {
                tasks.remove(&connection_id);
                Some(entry.shutdown_tx.clone())
            } else {
                None
            }
        };
        if let Some(tx) = shutdown_tx {
            let _ = tx.send(true);
        }
    }

    /// Remove all subscriptions owned by the destroyed window instance. This
    /// is the forced-close fallback when the JS transport cannot call
    /// `remote_ws_unsubscribe`. The instance ID is generated before the window
    /// loads and carried through the URL, so a new window that reuses the same
    /// label has a different ID and is never touched by stale cleanup.
    async fn mark_window_instance_destroyed(
        self: &Arc<Self>,
        label: &str,
        window_instance_id: &str,
    ) {
        let shutdown_txs = {
            let mut destroyed = self.destroyed_window_instances.lock().await;
            destroyed.insert(window_instance_id.to_string());
            let mut tasks = self.tasks.lock().await;
            let connection_ids: Vec<i32> = tasks.keys().copied().collect();
            let mut shutdown_txs = Vec::new();

            for connection_id in connection_ids {
                let entry = match tasks.get(&connection_id) {
                    Some(e) => e.clone(),
                    None => continue,
                };
                let mut subs = entry.subscribers.lock().await;
                let gone: Vec<String> = subs
                    .iter()
                    .filter(|(_, sub)| {
                        sub.label == label && sub.window_instance_id == window_instance_id
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in &gone {
                    subs.remove(id);
                }
                entry.forget_streaming(&gone);
                let is_empty = subs.is_empty();
                drop(subs);
                if is_empty {
                    if let Some(stored) = tasks.get(&connection_id) {
                        if Arc::ptr_eq(stored, &entry) {
                            tasks.remove(&connection_id);
                            shutdown_txs.push(entry.shutdown_tx.clone());
                        }
                    }
                }
            }
            shutdown_txs
        };
        for tx in shutdown_txs {
            let _ = tx.send(true);
        }
    }
}

impl Default for RemoteProxyState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── HTTP proxy command ────────────────────────────────────────────────

/// Forward an HTTP API call to the remote codeg-server identified by
/// `connection_id`. The frontend's `RemoteDesktopTransport.call(cmd, args)`
/// delegates to this; it never opens a fetch from the webview. Errors are
/// mapped as `send_remote_api_call` describes.
#[tauri::command]
pub async fn remote_http_call(
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    command: String,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, AppCommandError> {
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let url = format!(
        "{}/api/{}",
        conn.base_url.trim_end_matches('/'),
        command.trim_start_matches('/')
    );

    let body = args.unwrap_or(Value::Object(serde_json::Map::new()));
    // Per-request override beats the client-wide 30s default. Used by the
    // ACP probe path (`describeAgentOptions`) whose backend deadline is
    // longer than 30s — without this override, reqwest would abort here
    // before the backend can return its structured `ProbeTimedOut`.
    let timeout = timeout_ms.map(|ms| Duration::from_millis(ms).min(HTTP_TIMEOUT_MAX));

    send_remote_api_call(&command, || {
        let request = proxy
            .http
            .post(&url)
            .bearer_auth(conn.token.trim())
            .headers(conn.headers.to_header_map())
            .json(&body);
        match timeout {
            Some(timeout) => request.timeout(timeout),
            None => request,
        }
    })
    .await
}

/// `message` of a remote call whose answer stopped arriving part-way: the
/// server sent its status and headers, then the body was cut off (the server
/// restarted, the link dropped) or stalled past the request's deadline. It is
/// a link failure like a failed send, and the frontend treats the two alike
/// (`isRemoteUnreachable` in `src/lib/transport/remote-desktop-transport.ts`
/// matches this text — keep them in sync).
const REMOTE_RESPONSE_INTERRUPTED: &str = "Remote response was interrupted";

/// Remote API commands that only read, so sending one twice changes nothing.
/// Every `list_*` / `get_*` handler on codeg-server is a plain read; anything
/// else may change state and is never resent.
fn is_read_only_command(command: &str) -> bool {
    let name = command.trim_start_matches('/');
    name.starts_with("list_") || name.starts_with("get_")
}

/// The error for a response body that could not be read to its end.
///
/// reqwest reports every such failure, a timeout and a connection closed
/// mid-body alike, as the bare "error decoding response body": the reason is
/// only in the source chain, so it goes into `detail` whole.
fn body_read_error(err: &reqwest::Error) -> AppCommandError {
    AppCommandError::network(REMOTE_RESPONSE_INTERRUPTED).with_detail(request_error_detail(err))
}

/// Parse a body that arrived whole. Failing here means the remote sent
/// something that is not the JSON it should have, not that the link broke.
fn parse_json_body<T: serde::de::DeserializeOwned>(
    body: &[u8],
    message: &str,
) -> Result<T, AppCommandError> {
    serde_json::from_slice(body).map_err(|e| {
        AppCommandError::network(message).with_detail(format!("{e} ({} bytes)", body.len()))
    })
}

/// Send one remote API call and read its JSON answer. `build` makes the
/// request; a read-only command (`is_read_only_command`) whose body is cut off
/// mid-read gets ONE fresh resend, so a blip during a server restart does not
/// surface as an error. A body that timed out is not resent: the deadline
/// already spent is the caller's to spend, not ours to double.
///
/// Error mapping:
///
/// - HTTP 401 → `AppErrorCode::AuthenticationFailed` ("token expired"). The
///   frontend recognises this code and surfaces the connection-expired UI
///   in just the calling window — by design we don't broadcast to siblings.
/// - Other non-2xx with a structured `AppCommandError` body → forwarded
///   verbatim so the original `code` / `message` / `i18n_key` /
///   `i18n_params` reach the caller intact. This preserves the i18n
///   pipeline across the proxy boundary.
/// - Other non-2xx without a structured body → wrapped as
///   `NetworkError` with the raw body in `detail`.
/// - Connect / send errors → `NetworkError` "Remote HTTP request failed";
///   a body cut off or stalled → `NetworkError` `REMOTE_RESPONSE_INTERRUPTED`;
///   both with the full cause chain in `detail`.
async fn send_remote_api_call<F>(command: &str, build: F) -> Result<Value, AppCommandError>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let resend_cut_body = is_read_only_command(command);
    let mut resent = false;
    loop {
        let response = build().send().await.map_err(|e| {
            AppCommandError::network("Remote HTTP request failed")
                .with_detail(request_error_detail(&e))
        })?;

        let status = response.status();

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppCommandError::authentication_failed(
                "Remote Workspace token is invalid",
            ));
        }

        if !status.is_success() {
            let raw_body = response.text().await.unwrap_or_default();
            // The remote codeg-server always returns `Json(AppCommandError)`
            // on errors (see `web/handlers/error.rs::IntoResponse`). Try to
            // deserialize so the caller sees the original code + i18n hint.
            if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
                return Err(structured);
            }
            return Err(
                AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
                    if raw_body.is_empty() {
                        status.canonical_reason().unwrap_or("error").to_string()
                    } else {
                        raw_body
                    },
                ),
            );
        }

        match response.bytes().await {
            Ok(body) => return parse_json_body(&body, "Failed to parse remote response"),
            Err(e) if resend_cut_body && !resent && !e.is_timeout() => {
                tracing::warn!(
                    "[RemoteProxy] {command}: response cut off ({}); sending it again",
                    request_error_detail(&e)
                );
                resent = true;
            }
            Err(e) => return Err(body_read_error(&e)),
        }
    }
}

/// Cache a previously issued forge image locally. The image URL is a narrow,
/// capability-bearing resource path, never a caller-supplied host or file.
#[tauri::command]
pub async fn remote_cache_forge_image(
    db: State<'_, AppDatabase>,
    connection_id: i32,
    url: String,
) -> Result<crate::forge::ForgeImage, AppCommandError> {
    use crate::forge::{image_cache, ForgeError};

    if !image_cache::valid_image_url(&url) {
        return Err(AppCommandError::invalid_input("Invalid cached forge image URL"));
    }
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found("Remote connection not found"))?;
    let endpoint = format!("{}{}", conn.base_url.trim_end_matches('/'), url);
    let key = image_cache::cache_key(&[
        "codeg-server", &connection_id.to_string(), &conn.base_url, &conn.token, &url,
    ]);
    let client = crate::forge::http_client()?;
    let image = image_cache::get_or_download(
        &crate::paths::codeg_forge_images_root(),
        key,
        image_cache::IMAGE_MAX_BYTES,
        || async {
            let response = client.get(endpoint)
                .bearer_auth(conn.token.trim())
                .headers(conn.headers.to_header_map())
                .header("X-Requested-With", "XMLHttpRequest")
                .send().await
                .map_err(|error| ForgeError::Network(request_error_detail(&error.without_url())))?;
            match response.status().as_u16() {
                200 => Ok(response),
                401 => Err(ForgeError::Auth("Remote workspace token was rejected".into())),
                status => Err(ForgeError::Api { status, message: "Remote image download failed".into() }),
            }
        },
    ).await.map_err(|error| match error {
        ForgeError::Auth(message) => AppCommandError::authentication_failed(message),
        error => error.into(),
    })?;
    Ok(image_cache::local_image_url(image).await?)
}

// ─── Multipart upload proxy ───────────────────────────────────────────

/// Hard ceiling for `read_local_file_for_upload`. Mirrors the server-side
/// `UPLOAD_MAX_BYTES` in `web/handlers/files.rs`; kept here as a local
/// constant so this command can reject oversize reads *before* incurring
/// the file I/O cost — the remote `/api/upload_attachment` enforces the
/// same cap regardless, but a 100 MB read followed by a base64 encode and
/// an IPC trip would be a noticeable waste compared to early rejection.
const UPLOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Maximum tolerated base64 payload length, pre-decode. Exactly
/// `ceil(UPLOAD_MAX_BYTES / 3) * 4` — that formula already accounts for
/// padding to the nearest 4-byte boundary, so a legitimate envelope of
/// exactly `UPLOAD_MAX_BYTES` raw bytes always fits. The current
/// frontend encoders (`btoa` for Web, `STANDARD.encode` for the Rust
/// `read_local_file_for_upload` side) emit clean base64 with no embedded
/// whitespace, so in practice the formula is exact. The `+ 4` slack is
/// one extra padded quad of headroom for a hypothetical future encoder
/// that appends a trailing `=`/`\n` (RFC 4648 explicitly permits
/// optional trailing CRLF). It is *not* load-bearing for any current
/// caller — the post-decode `bytes.len() > UPLOAD_MAX_BYTES` check
/// downstream is the authoritative guard, this constant only exists to
/// reject obviously oversized envelopes before allocating a `Vec<u8>`
/// the size of the base64 string. Used as a fast guard before
/// `STANDARD.decode` allocates.
const REMOTE_UPLOAD_MAX_BASE64_LEN: usize = {
    let raw = UPLOAD_MAX_BYTES as usize;
    raw.div_ceil(3) * 4 + 4
};

fn upload_i18n_params<const N: usize>(pairs: [(&str, String); N]) -> BTreeMap<String, String> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// Strip multipart-hostile bytes from a filename before handing it to
/// `reqwest::multipart::Part::file_name`. reqwest does not sanitize, and
/// a name containing CR/LF/`"`/`\` can inject extra `Content-Disposition`
/// headers (or simply corrupt the part boundary). Mirrors the server-side
/// `sanitize_upload_filename` in spirit but stays defensive — the server
/// will sanitize again when it stores the bytes, this layer just keeps
/// our outgoing multipart frame well-formed.
fn sanitize_upload_file_name(raw: &str) -> String {
    // Order matters: filter control chars first (which already covers
    // NUL, CR, LF, tab and the C1 range), then map the remaining
    // multipart-hostile punctuation. The mapped set is intentionally
    // small — we want to preserve user-visible filename content while
    // keeping the multipart frame parseable.
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '"' | '\\' | '/' => '_',
            other => other,
        })
        .collect();
    let trimmed: String = cleaned.trim_matches(|c: char| c.is_whitespace()).into();
    let limited: String = trimmed.chars().take(255).collect();
    if limited.is_empty() {
        "file".to_string()
    } else {
        limited
    }
}

/// Stream a local file into a base64-wrapped JSON envelope ready to be
/// passed to `remote_upload_attachment`. Two callers need this today: the
/// Tauri-native drag-drop path (which receives OS paths from the webview
/// drag handler) and a future "attach this local path" command palette.
///
/// Rejects anything larger than `UPLOAD_MAX_BYTES` with a structured
/// `IoError` carrying the limit in `detail` so the frontend can format an
/// `attachUploadTooLarge` toast without round-tripping through the actual
/// upload endpoint.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileForUpload {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub size: u64,
    pub data_base64: String,
}

#[tauri::command]
pub async fn read_local_file_for_upload(
    path: String,
) -> Result<LocalFileForUpload, AppCommandError> {
    let path_buf = std::path::PathBuf::from(&path);
    // Use symlink_metadata + explicit `is_file()` so a webview-driven
    // invoke can't follow a `/tmp/symlink → /etc/shadow` into reading
    // anything outside the user's intent. The same guard rejects FIFOs
    // and device nodes — `tokio::fs::read` would otherwise block on a
    // FIFO until the writing side closes, hanging this command (and the
    // calling webview's drag-drop handler) indefinitely.
    let metadata = tokio::fs::symlink_metadata(&path_buf).await.map_err(|e| {
        AppCommandError::io_error("Failed to stat local file for upload")
            .with_detail(format!("{}: {e}", path_buf.display()))
    })?;
    if !metadata.file_type().is_file() {
        return Err(AppCommandError::io_error("Not a regular file")
            .with_detail(path_buf.display().to_string())
            .with_i18n(UPLOAD_I18N_KEY_NOT_A_FILE, BTreeMap::new()));
    }
    let size = metadata.len();
    if size > UPLOAD_MAX_BYTES {
        return Err(
            AppCommandError::io_error("Local file exceeds the upload size limit")
                .with_detail(format!("size={size} limit={UPLOAD_MAX_BYTES}"))
                .with_i18n(
                    UPLOAD_I18N_KEY_TOO_LARGE,
                    upload_i18n_params([
                        ("size", size.to_string()),
                        ("limit", UPLOAD_MAX_BYTES.to_string()),
                    ]),
                ),
        );
    }
    let bytes = tokio::fs::read(&path_buf).await.map_err(|e| {
        AppCommandError::io_error("Failed to read local file for upload")
            .with_detail(format!("{}: {e}", path_buf.display()))
    })?;
    let file_name = path_buf
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let mime_type = guess_mime_from_path(&path_buf);
    Ok(LocalFileForUpload {
        file_name: sanitize_upload_file_name(&file_name),
        mime_type,
        size,
        data_base64: STANDARD.encode(&bytes),
    })
}

/// Forward a multipart upload (file bytes + optional session bucket) to the
/// remote codeg-server identified by `connection_id`. Sibling of
/// `remote_http_call`, but multipart-shaped — the JSON proxy can't carry
/// binary bodies, and webview `fetch` to a plain `http://` remote is
/// blocked by mixed-content rules, so we cannot have the frontend hit
/// `/api/upload_attachment` directly when running inside a Tauri webview.
///
/// Error mapping mirrors `remote_http_call`: 401 → `AuthenticationFailed`,
/// other non-2xx prefers a structured `AppCommandError` body (preserving
/// `i18n_key` for the user toast), else wraps in `NetworkError`.
#[tauri::command]
pub async fn remote_upload_attachment(
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    file_name: String,
    mime_type: Option<String>,
    session_id: Option<String>,
    data_base64: String,
) -> Result<Value, AppCommandError> {
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    // Reject oversized payloads BEFORE allocating. The remote server
    // enforces the same cap on the decoded bytes, but a malicious /
    // buggy webview hitting this command directly would otherwise force
    // a `Vec<u8>` allocation roughly equal to the base64 length before
    // the cap fires server-side. Cap at `ceil(UPLOAD_MAX_BYTES * 4/3) +
    // padding slack` so a legitimate maximum-sized file (which encodes
    // to exactly `ceil(UPLOAD_MAX_BYTES / 3) * 4` bytes) always passes.
    if data_base64.len() > REMOTE_UPLOAD_MAX_BASE64_LEN {
        return Err(
            AppCommandError::io_error("Upload payload exceeds the size limit")
                .with_detail(format!(
                    "size={} limit={REMOTE_UPLOAD_MAX_BASE64_LEN}",
                    data_base64.len()
                ))
                .with_i18n(
                    UPLOAD_I18N_KEY_TOO_LARGE,
                    upload_i18n_params([
                        ("size", data_base64.len().to_string()),
                        ("limit", UPLOAD_MAX_BYTES.to_string()),
                    ]),
                ),
        );
    }
    let bytes = STANDARD.decode(data_base64.as_bytes()).map_err(|e| {
        AppCommandError::io_error("Failed to decode upload payload").with_detail(e.to_string())
    })?;
    // Belt-and-suspenders: decoded length must still respect the cap.
    // The base64 check above is a fast pre-filter; this guarantees that
    // any padding quirks can't squeeze through.
    if bytes.len() as u64 > UPLOAD_MAX_BYTES {
        return Err(
            AppCommandError::io_error("Upload payload exceeds the size limit")
                .with_detail(format!("size={} limit={UPLOAD_MAX_BYTES}", bytes.len()))
                .with_i18n(
                    UPLOAD_I18N_KEY_TOO_LARGE,
                    upload_i18n_params([
                        ("size", bytes.len().to_string()),
                        ("limit", UPLOAD_MAX_BYTES.to_string()),
                    ]),
                ),
        );
    }

    let mime = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    // `reqwest::multipart::Part::file_name` does NOT strip CR/LF or
    // quote-escape — a name like `bad\r\nX-Auth: leak.txt` would inject
    // additional headers into the `Content-Disposition` line. Sanitize
    // ourselves before handing the value to reqwest. (The MIME string
    // goes through `mime_str`, which already rejects non-token chars.)
    //
    // Defense-in-depth: this is deliberately a second sanitize pass.
    // `read_local_file_for_upload` already sanitized `file_name` before
    // it returned, but this command is reachable from other JS callers
    // (e.g. the web `uploadAttachment` path packs an arbitrary
    // `file.name` straight through). Re-running the filter here means
    // every multipart frame leaving this process is uniformly clean,
    // regardless of upstream — and the extra cost is a single pass over
    // ≤255 chars, which is negligible compared to the upload itself.
    let safe_name = sanitize_upload_file_name(&file_name);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(safe_name)
        .mime_str(&mime)
        .map_err(|e| {
            AppCommandError::io_error("Invalid MIME type for upload").with_detail(e.to_string())
        })?;
    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(sid) = session_id {
        if !sid.is_empty() {
            form = form.text("session_id", sid);
        }
    }

    let url = format!(
        "{}/api/upload_attachment",
        conn.base_url.trim_end_matches('/'),
    );
    let response = proxy
        .http
        .post(&url)
        .bearer_auth(conn.token.trim())
        .headers(conn.headers.to_header_map())
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Remote upload request failed")
                .with_detail(request_error_detail(&e))
        })?;

    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }

    if !status.is_success() {
        let raw_body = response.text().await.unwrap_or_default();
        if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
            return Err(structured);
        }
        return Err(
            AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
                if raw_body.is_empty() {
                    status.canonical_reason().unwrap_or("error").to_string()
                } else {
                    raw_body
                },
            ),
        );
    }

    // Not resent when cut off, unlike `send_remote_api_call`'s reads: the
    // upload may already have landed.
    let body = response.bytes().await.map_err(|e| body_read_error(&e))?;
    parse_json_body(&body, "Failed to parse remote upload response")
}

/// Best-effort MIME guess by extension. Mirrors the frontend's
/// `MIME_BY_EXT` so a file uploaded via the desktop drag-drop path carries
/// the same `content-type` it would have if picked through the browser
/// `<input type=file>`. Falls back to `None` so the upload caller can
/// substitute `application/octet-stream`.
fn guess_mime_from_path(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" => "text/typescript",
        "tsx" => "text/tsx",
        "jsx" => "text/jsx",
        "py" => "text/x-python",
        "rs" => "text/rust",
        "go" => "text/x-go",
        "java" => "text/x-java-source",
        "xml" => "application/xml",
        "toml" => "application/toml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    Some(mime.to_string())
}

// ─── Workspace file upload / download proxy ───────────────────────────
//
// Issue #179 follow-up: a Tauri client bound to a remote codeg-server
// previously had no path to upload/download workspace files. The web
// build hits `/api/upload_workspace_file` etc. directly, but a webview
// against a plain `http://` remote is blocked by mixed-content rules
// (same reason `remote_upload_attachment` exists). These three commands
// proxy the workspace endpoints over reqwest.
//
// Workspace file transfers intentionally have no application-level size
// limit. These bytes move between the user's own machine/browser and their
// workspace; OS disk space, network throughput, and the remote server are
// the natural boundaries.

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUploadPathEntry {
    pub local_path: String,
    pub relative_path: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUploadPathResult {
    pub transfer_id: String,
    pub files: Vec<RemoteWorkspaceUploadedFile>,
    pub bytes: u64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUploadedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDownloadTicket {
    url: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceDownloadResult {
    pub transfer_id: String,
    pub bytes: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_upload_workspace_paths(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    root_path: String,
    target_path: String,
    entries: Vec<RemoteWorkspaceUploadPathEntry>,
) -> Result<RemoteWorkspaceUploadPathResult, AppCommandError> {
    if entries.is_empty() {
        return Err(AppCommandError::invalid_input(
            "No local paths were provided for upload",
        ));
    }

    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let custom_headers = conn.headers.to_header_map();
    let (transfer_id, cancel_token) = transfers.register_transfer().await;
    let result = async {
        let _permit = transfers
            .remote_upload_semaphore
            .acquire()
            .await
            .map_err(|_| {
                AppCommandError::task_execution_failed(
                    "Remote workspace upload semaphore is closed",
                )
            })?;

        let mut uploaded = Vec::new();
        let mut total_bytes = 0u64;

        for entry in entries {
            if cancel_token.is_cancelled() {
                return Err(workspace_transfer_cancelled());
            }
            let local_path = PathBuf::from(&entry.local_path);
            let metadata = tokio::fs::symlink_metadata(&local_path)
                .await
                .map_err(|e| {
                    AppCommandError::io_error("Failed to stat local upload path")
                        .with_detail(format!("{}: {e}", local_path.display()))
                })?;
            if metadata.file_type().is_symlink() {
                return Err(AppCommandError::invalid_input(
                    "Local upload path is a symlink; refuse to follow it",
                ));
            }
            if metadata.is_dir() {
                let base_prefix = entry
                    .relative_path
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        local_path
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                    })
                    .unwrap_or_default();
                for walked in walkdir::WalkDir::new(&local_path).follow_links(false) {
                    if cancel_token.is_cancelled() {
                        return Err(workspace_transfer_cancelled());
                    }
                    let walked = walked.map_err(|e| {
                        AppCommandError::io_error("Failed to walk local upload directory")
                            .with_detail(e.to_string())
                    })?;
                    if walked.file_type().is_symlink() || !walked.file_type().is_file() {
                        continue;
                    }
                    let nested = walked.path().strip_prefix(&local_path).map_err(|_| {
                        AppCommandError::io_error("Failed to calculate local relative path")
                    })?;
                    let relative_path = join_upload_relative(&base_prefix, nested);
                    let file_result = upload_one_workspace_path(
                        &app,
                        &proxy,
                        &conn.base_url,
                        conn.token.trim(),
                        &custom_headers,
                        &transfer_id,
                        cancel_token.clone(),
                        &root_path,
                        &target_path,
                        walked.path(),
                        Some(relative_path),
                    )
                    .await?;
                    total_bytes = total_bytes.saturating_add(file_result.size);
                    uploaded.push(file_result);
                }
            } else if metadata.is_file() {
                let file_result = upload_one_workspace_path(
                    &app,
                    &proxy,
                    &conn.base_url,
                    conn.token.trim(),
                    &custom_headers,
                    &transfer_id,
                    cancel_token.clone(),
                    &root_path,
                    &target_path,
                    &local_path,
                    entry.relative_path.filter(|s| !s.is_empty()),
                )
                .await?;
                total_bytes = total_bytes.saturating_add(file_result.size);
                uploaded.push(file_result);
            } else {
                return Err(AppCommandError::invalid_input(
                    "Local upload path is not a regular file or directory",
                ));
            }
        }

        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Upload,
                loaded: total_bytes,
                total: Some(total_bytes),
                state: TransferState::Done,
                path: None,
                error: None,
            },
        );

        Ok(RemoteWorkspaceUploadPathResult {
            transfer_id: transfer_id.clone(),
            files: uploaded,
            bytes: total_bytes,
        })
    }
    .await;

    if let Err(err) = &result {
        let state = if cancel_token.is_cancelled() {
            TransferState::Cancelled
        } else {
            TransferState::Error
        };
        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Upload,
                loaded: 0,
                total: None,
                state,
                path: None,
                error: Some(err.message.clone()),
            },
        );
    }
    transfers.finish_transfer(&transfer_id).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload_one_workspace_path(
    app: &AppHandle,
    proxy: &RemoteProxyState,
    base_url: &str,
    token: &str,
    custom_headers: &HeaderMap,
    transfer_id: &str,
    cancel_token: CancellationToken,
    root_path: &str,
    target_path: &str,
    local_path: &Path,
    relative_path: Option<String>,
) -> Result<RemoteWorkspaceUploadedFile, AppCommandError> {
    let metadata = tokio::fs::symlink_metadata(local_path)
        .await
        .map_err(AppCommandError::io)?;
    if !metadata.file_type().is_file() {
        return Err(AppCommandError::invalid_input(
            "Local upload path is not a regular file",
        ));
    }
    let size = metadata.len();
    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(AppCommandError::io)?;
    let file_name = local_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let safe_name = sanitize_upload_file_name(&file_name);
    let display_path = relative_path.clone().unwrap_or_else(|| safe_name.clone());

    emit_workspace_transfer_progress(
        app,
        WorkspaceTransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: TransferDirection::Upload,
            loaded: 0,
            total: Some(size),
            state: TransferState::Running,
            path: Some(display_path.clone()),
            error: None,
        },
    );

    let stream = file_upload_stream(
        app.clone(),
        transfer_id.to_string(),
        cancel_token.clone(),
        file,
        size,
        display_path.clone(),
    );
    let body = reqwest::Body::wrap_stream(stream);
    let part = reqwest::multipart::Part::stream_with_length(body, size).file_name(safe_name);
    let mut form = reqwest::multipart::Form::new()
        .text("root_path", root_path.to_string())
        .text("target_path", target_path.to_string());
    if let Some(rp) = relative_path {
        form = form.text("relative_path", rp);
    }
    form = form.part("file", part);

    let url = format!(
        "{}/api/upload_workspace_file",
        base_url.trim_end_matches('/'),
    );
    let response = proxy
        .workspace_http
        .post(&url)
        .bearer_auth(token)
        .headers(custom_headers.clone())
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            if cancel_token.is_cancelled() {
                return workspace_transfer_cancelled();
            }
            AppCommandError::network("Remote workspace upload failed")
                .with_detail(request_error_detail(&e))
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }
    if !status.is_success() {
        let raw_body = response.text().await.unwrap_or_default();
        if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
            return Err(structured);
        }
        return Err(
            AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
                if raw_body.is_empty() {
                    status.canonical_reason().unwrap_or("error").to_string()
                } else {
                    raw_body
                },
            ),
        );
    }

    let body = response.bytes().await.map_err(|e| body_read_error(&e))?;
    let uploaded: RemoteWorkspaceUploadedFile =
        parse_json_body(&body, "Failed to parse remote upload response")?;
    emit_workspace_transfer_progress(
        app,
        WorkspaceTransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: TransferDirection::Upload,
            loaded: size,
            total: Some(size),
            state: TransferState::Running,
            path: Some(display_path),
            error: None,
        },
    );
    Ok(uploaded)
}

fn file_upload_stream(
    app: AppHandle,
    transfer_id: String,
    cancel_token: CancellationToken,
    file: tokio::fs::File,
    total: u64,
    path: String,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::try_unfold((file, 0u64), move |(mut file, loaded)| {
        let app = app.clone();
        let transfer_id = transfer_id.clone();
        let cancel_token = cancel_token.clone();
        let path = path.clone();
        async move {
            if cancel_token.is_cancelled() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "Workspace transfer cancelled",
                ));
            }
            let mut buf = vec![0u8; 64 * 1024];
            use tokio::io::AsyncReadExt;
            let n = file.read(&mut buf).await?;
            if n == 0 {
                return Ok(None);
            }
            buf.truncate(n);
            let loaded = loaded.saturating_add(n as u64);
            emit_workspace_transfer_progress(
                &app,
                WorkspaceTransferProgress {
                    transfer_id,
                    direction: TransferDirection::Upload,
                    loaded,
                    total: Some(total),
                    state: TransferState::Running,
                    path: Some(path),
                    error: None,
                },
            );
            Ok(Some((Bytes::from(buf), (file, loaded))))
        }
    })
}

fn join_upload_relative(base: &str, nested: &Path) -> String {
    let nested = nested.to_string_lossy().replace('\\', "/");
    if base.is_empty() {
        nested
    } else if nested.is_empty() {
        base.to_string()
    } else {
        format!("{}/{nested}", base.trim_end_matches('/'))
    }
}

fn workspace_transfer_cancelled() -> AppCommandError {
    AppCommandError::task_execution_failed("Workspace transfer cancelled")
}

fn emit_workspace_transfer_progress(app: &AppHandle, progress: WorkspaceTransferProgress) {
    let _ = app.emit(WORKSPACE_TRANSFER_PROGRESS_EVENT, progress);
}

#[tauri::command]
pub async fn remote_cancel_workspace_transfer(
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    transfer_id: String,
) -> Result<bool, AppCommandError> {
    Ok(transfers.cancel(&transfer_id).await)
}

/// `transfer_id` is optional and client-chosen: the frontend registers its
/// progress row under it before invoking, so the row (and its Cancel button)
/// exist from the first moment rather than from the first progress event.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_download_workspace_file(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    root_path: String,
    path: String,
    save_path: String,
    transfer_id: Option<String>,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    remote_workspace_download_stream(
        app,
        db,
        proxy,
        transfers,
        connection_id,
        "file",
        root_path,
        path,
        save_path,
        transfer_id,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_download_workspace_dir(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    root_path: String,
    path: String,
    save_path: String,
    transfer_id: Option<String>,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    remote_workspace_download_stream(
        app,
        db,
        proxy,
        transfers,
        connection_id,
        "dir",
        root_path,
        path,
        save_path,
        transfer_id,
    )
    .await
}

/// Minimum spacing between two `Running` progress events for one download.
/// Chunks arrive every few KiB, and a multi-GB file would otherwise cross the
/// IPC bridge hundreds of thousands of times for a bar that repaints ~5×/s.
const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Resolve `fut` unless the transfer is cancelled first. Only for the phases
/// before bytes hit the disk — the write loop watches the token itself so it
/// can remove its partial file.
async fn unless_cancelled<T>(
    cancel: &CancellationToken,
    fut: impl std::future::Future<Output = Result<T, AppCommandError>>,
) -> Result<T, AppCommandError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(workspace_transfer_cancelled()),
        result = fut => result,
    }
}

#[allow(clippy::too_many_arguments)]
async fn remote_workspace_download_stream(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    kind: &str,
    root_path: String,
    path: String,
    save_path: String,
    requested_transfer_id: Option<String>,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let custom_headers = conn.headers.to_header_map();
    let (transfer_id, cancel_token) = transfers
        .register_transfer_with_id(requested_transfer_id)
        .await;
    let idle_timeout = transfers.idle_timeout;
    let result = async {
        let _permit = unless_cancelled(&cancel_token, async {
            transfers
                .remote_download_semaphore
                .acquire()
                .await
                .map_err(|_| {
                    AppCommandError::task_execution_failed(
                        "Remote workspace download semaphore is closed",
                    )
                })
        })
        .await?;

        let ticket_url = format!(
            "{}/api/workspace_download_ticket",
            conn.base_url.trim_end_matches('/')
        );
        let ticket_response = unless_cancelled(&cancel_token, async {
            proxy
                .workspace_http
                .post(ticket_url)
                .bearer_auth(conn.token.trim())
                .headers(custom_headers.clone())
                .timeout(HTTP_TIMEOUT)
                .json(&serde_json::json!({
                    "rootPath": root_path,
                    "path": path,
                    "kind": kind,
                }))
                .send()
                .await
                .map_err(|e| {
                    AppCommandError::network("Remote workspace download ticket failed")
                        .with_detail(request_error_detail(&e))
                })
        })
        .await?;
        let status = ticket_response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppCommandError::authentication_failed(
                "Remote Workspace token is invalid",
            ));
        }
        if !status.is_success() {
            return remote_error_from_response(status, ticket_response).await;
        }
        let ticket = ticket_response
            .json::<WorkspaceDownloadTicket>()
            .await
            .map_err(|e| {
                AppCommandError::network("Failed to parse remote download ticket")
                    .with_detail(e.to_string())
            })?;
        let download_url = absolute_remote_ticket_url(&conn.base_url, &ticket.url)?;
        let response = unless_cancelled(&cancel_token, async {
            proxy
                .workspace_http
                .get(download_url)
                .headers(custom_headers.clone())
                .send()
                .await
                .map_err(|e| {
                    AppCommandError::network("Remote workspace download failed")
                        .with_detail(request_error_detail(&e))
                })
        })
        .await?;

        let status = response.status();
        if !status.is_success() {
            return remote_error_from_response(status, response).await;
        }
        let total = response.content_length();
        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Download,
                loaded: 0,
                total,
                state: TransferState::Running,
                path: Some(save_path.clone()),
                error: None,
            },
        );
        let stream = response.bytes_stream().map(|chunk| {
            chunk.map_err(|e| {
                AppCommandError::network("Failed to read remote download stream")
                    .with_detail(e.to_string())
            })
        });
        let mut last_emit = Instant::now();
        let bytes = write_response_stream_to_partial(
            stream,
            &save_path,
            &transfer_id,
            cancel_token.clone(),
            idle_timeout,
            |loaded| {
                let now = Instant::now();
                if now.duration_since(last_emit) < DOWNLOAD_PROGRESS_INTERVAL {
                    return;
                }
                last_emit = now;
                emit_workspace_transfer_progress(
                    &app,
                    WorkspaceTransferProgress {
                        transfer_id: transfer_id.clone(),
                        direction: TransferDirection::Download,
                        loaded,
                        total,
                        state: TransferState::Running,
                        path: Some(save_path.clone()),
                        error: None,
                    },
                );
            },
        )
        .await?;

        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Download,
                loaded: bytes,
                total,
                state: TransferState::Done,
                path: Some(save_path.clone()),
                error: None,
            },
        );
        Ok(RemoteWorkspaceDownloadResult {
            transfer_id: transfer_id.clone(),
            bytes,
        })
    }
    .await;

    if let Err(err) = &result {
        let state = if cancel_token.is_cancelled() {
            TransferState::Cancelled
        } else {
            TransferState::Error
        };
        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Download,
                loaded: 0,
                total: None,
                state,
                path: Some(save_path),
                error: Some(err.message.clone()),
            },
        );
    }
    transfers.finish_transfer(&transfer_id).await;
    result
}

async fn remote_error_from_response(
    status: reqwest::StatusCode,
    response: reqwest::Response,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    let raw_body = response.text().await.unwrap_or_default();
    if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
        return Err(structured);
    }
    Err(
        AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
            if raw_body.is_empty() {
                status.canonical_reason().unwrap_or("error").to_string()
            } else {
                raw_body
            },
        ),
    )
}

/// Resolve the download URL the remote handed back, and refuse one that leaves
/// the connection's origin.
///
/// `codeg-server` always answers with a path (`create_download_ticket` builds
/// `/api/workspace_download/<ticket>`), so the absolute branch only ever fires
/// for a remote that went off-script. It matters because this is the one
/// request that carries the connection's custom headers with no bearer token
/// gating them: a remote free to name any host is a remote free to choose who
/// receives those credentials.
fn absolute_remote_ticket_url(base_url: &str, ticket_url: &str) -> Result<String, AppCommandError> {
    let resolved = if ticket_url.starts_with("http://") || ticket_url.starts_with("https://") {
        ticket_url.to_string()
    } else if ticket_url.starts_with('/') {
        format!("{}{}", base_url.trim_end_matches('/'), ticket_url)
    } else {
        format!("{}/{}", base_url.trim_end_matches('/'), ticket_url)
    };
    let same_origin = match (
        reqwest::Url::parse(base_url),
        reqwest::Url::parse(&resolved),
    ) {
        (Ok(base), Ok(target)) => same_remote_origin(&base, &target),
        _ => false,
    };
    if !same_origin {
        return Err(AppCommandError::network(
            "Remote download ticket points outside the connection",
        )
        .with_detail(format!("ticket url: {ticket_url}")));
    }
    Ok(resolved)
}

fn partial_download_path(save_path: &str, transfer_id: &str) -> String {
    format!("{save_path}.codeg-download-{transfer_id}.part")
}

/// Stream a download into a sibling `.part` file and rename it into place once
/// complete. `idle_timeout` bounds the wait for any single chunk, so a remote
/// that stops sending mid-file surfaces as an error instead of a progress bar
/// frozen forever.
async fn write_response_stream_to_partial<S, F>(
    mut stream: S,
    save_path: &str,
    transfer_id: &str,
    cancel: CancellationToken,
    idle_timeout: Duration,
    mut on_progress: F,
) -> Result<u64, AppCommandError>
where
    S: Stream<Item = Result<Bytes, AppCommandError>> + Unpin,
    F: FnMut(u64),
{
    use tokio::io::AsyncWriteExt;

    let partial_path = partial_download_path(save_path, transfer_id);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial_path)
        .await
        .map_err(|e| {
            AppCommandError::io_error("Failed to create local download file")
                .with_detail(format!("{partial_path}: {e}"))
        })?;

    let result: Result<u64, AppCommandError> = async {
        let mut total: u64 = 0;
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(workspace_transfer_cancelled()),
                next = tokio::time::timeout(idle_timeout, stream.next()) => match next {
                    Ok(next) => next,
                    Err(_) => {
                        return Err(AppCommandError::network(format!(
                            "Remote download stalled: no data received for {}s",
                            idle_timeout.as_secs()
                        )))
                    }
                },
            };
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk?;
            total = total.saturating_add(chunk.len() as u64);
            file.write_all(&chunk).await.map_err(|e| {
                AppCommandError::io_error("Failed to write download to disk")
                    .with_detail(e.to_string())
            })?;
            on_progress(total);
        }
        file.flush().await.map_err(|e| {
            AppCommandError::io_error("Failed to flush downloaded file").with_detail(e.to_string())
        })?;
        file.sync_all().await.map_err(|e| {
            AppCommandError::io_error("Failed to sync downloaded file").with_detail(e.to_string())
        })?;
        Ok(total)
    }
    .await;

    drop(file);
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return result;
    }

    if tokio::fs::try_exists(save_path).await.unwrap_or(false) {
        if let Err(e) = tokio::fs::remove_file(save_path).await {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err(
                AppCommandError::io_error("Failed to replace existing download")
                    .with_detail(format!("{save_path}: {e}")),
            );
        }
    }
    tokio::fs::rename(&partial_path, save_path)
        .await
        .map_err(|e| {
            let _ = std::fs::remove_file(&partial_path);
            AppCommandError::io_error("Failed to finalize download")
                .with_detail(format!("{partial_path} -> {save_path}: {e}"))
        })?;

    result
}

// ─── WebSocket proxy commands ─────────────────────────────────────────

/// Subscribe the calling webview to the remote server's WS event stream.
/// `subscription_id` is an opaque string generated by the JS transport
/// (UUID). Using a caller-supplied ID means the JS side can issue an
/// unsubscribe even if the subscribe invoke hasn't returned yet — it already
/// knows the ID. Two concurrent transports for the same window label never
/// collide because each has a distinct subscription_id.
#[tauri::command]
pub async fn remote_ws_subscribe(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    window: WebviewWindow,
    connection_id: i32,
    subscription_id: String,
    window_instance_id: String,
) -> Result<(), AppCommandError> {
    let label = window.label().to_string();
    let proxy_arc: Arc<RemoteProxyState> = (*proxy).clone();
    let subscriber = WsSubscriber {
        label: label.clone(),
        window_instance_id,
    };

    // Fast path: existing entry — insert this subscription_id.
    // Hold the destroyed-instance lock while inserting into `subscribers`, in
    // the same lock order as `mark_window_instance_destroyed`. This prevents a
    // window destroy event from slipping between the tombstone check and the
    // subscription insert.
    let existing_entry = {
        let destroyed = proxy_arc.destroyed_window_instances.lock().await;
        if destroyed.contains(&subscriber.window_instance_id) {
            return Ok(());
        }
        let tasks = proxy_arc.tasks.lock().await;
        match tasks.get(&connection_id) {
            Some(entry) => {
                let mut subs = entry.subscribers.lock().await;
                subs.insert(subscription_id.clone(), subscriber.clone());
                drop(subs);
                Some(entry.clone())
            }
            None => None,
        }
    };

    if let Some(entry) = existing_entry {
        acknowledge_ready_subscriber(&app, &entry, connection_id, &label).await;
        return Ok(());
    }

    // Slow path: load credentials, create entry, spawn WS task.
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (outbound_tx, outbound_rx) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let entry = Arc::new(WsTaskEntry {
        subscribers: Mutex::new({
            let mut map = HashMap::new();
            map.insert(subscription_id.clone(), subscriber.clone());
            map
        }),
        ready: RwLock::new(false),
        shutdown_tx,
        outbound_tx,
        probe: Notify::new(),
        streaming: std::sync::Mutex::new(HashSet::new()),
        streaming_changed: Notify::new(),
    });

    // Insert under the proxy lock. If a concurrent subscribe raced us, fold
    // our subscription into the existing entry and abort our task spawn.
    let raced_entry = {
        let destroyed = proxy_arc.destroyed_window_instances.lock().await;
        if destroyed.contains(&subscriber.window_instance_id) {
            return Ok(());
        }
        let mut tasks = proxy_arc.tasks.lock().await;
        if let Some(existing) = tasks.get(&connection_id) {
            existing
                .subscribers
                .lock()
                .await
                .insert(subscription_id, subscriber);
            Some(existing.clone())
        } else {
            tasks.insert(connection_id, entry.clone());
            None
        }
    };
    if let Some(existing) = raced_entry {
        acknowledge_ready_subscriber(&app, &existing, connection_id, &label).await;
        return Ok(());
    }

    let task_app = app.clone();
    let task_proxy = proxy_arc.clone();
    let task_db = db.conn.clone();
    let target = WsTarget::of(&conn);
    let task_entry = entry.clone();

    tauri::async_runtime::spawn(async move {
        run_ws_task(
            task_app,
            task_proxy,
            task_db,
            connection_id,
            target,
            task_entry,
            shutdown_rx,
            outbound_rx,
        )
        .await;
    });

    Ok(())
}

/// Send an arbitrary text frame over the existing WS to the remote server.
/// Used by the JS-side `RemoteEventStream` to forward `attach` / `detach` /
/// `ping` messages without owning the WS itself.
///
/// Returns `Err(NetworkError)` when the proxy has no entry for this
/// `connection_id`, when the outbound channel is closed, or when the queue
/// stays full for `OUTBOUND_SEND_TIMEOUT`. The JS side uses the failure
/// as a signal to reissue active attach frames; previously we returned
/// `Ok(())` on drop and the stream could stick on a missing snapshot until
/// the next reconnect.
///
/// The Tauri command is a thin wrapper around `remote_ws_send_text_core`
/// so the failure-mode logic is unit-testable without a Tauri runtime.
#[tauri::command]
pub async fn remote_ws_send_text(
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    text: String,
) -> Result<(), AppCommandError> {
    let proxy_arc: Arc<RemoteProxyState> = (*proxy).clone();
    remote_ws_send_text_core(&proxy_arc, connection_id, text).await
}

async fn remote_ws_send_text_core(
    proxy: &Arc<RemoteProxyState>,
    connection_id: i32,
    text: String,
) -> Result<(), AppCommandError> {
    let entry = {
        let tasks = proxy.tasks.lock().await;
        tasks.get(&connection_id).cloned()
    };
    let Some(entry) = entry else {
        return Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!("remote ws task not active for connection {connection_id}"),
        ));
    };
    // Bounded backpressure: prefer waiting briefly for the outbound queue
    // to drain over silently dropping. Control frames (attach/detach) MUST
    // surface failure so the JS side can reissue, and input frames benefit
    // from backpressure too. The 2s ceiling protects the Tauri command
    // worker from a permanently stuck WS.
    match tokio::time::timeout(OUTBOUND_SEND_TIMEOUT, entry.outbound_tx.send(text)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!("remote ws outbound channel closed for connection {connection_id}"),
        )),
        Err(_) => Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!(
                "remote ws send timed out after {}s for connection {connection_id} (outbound queue full)",
                OUTBOUND_SEND_TIMEOUT.as_secs()
            ),
        )),
    }
}

/// Unsubscribe one subscription by its opaque ID. Only removes the entry
/// matching `subscription_id`; a stale call from a destroyed transport is
/// always a safe no-op for any other transport.
#[tauri::command]
pub async fn remote_ws_unsubscribe(
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    subscription_id: String,
) -> Result<(), AppCommandError> {
    let proxy_arc: Arc<RemoteProxyState> = (*proxy).clone();
    proxy_arc
        .remove_subscription(connection_id, &subscription_id)
        .await;
    Ok(())
}

/// Ask the WS task for `connection_id` to verify its socket is alive right
/// now (see `Heartbeat::on_probe`), or — while it is waiting to reconnect —
/// to retry at once. The frontend calls this on wake-up signals (tab
/// visible, lid open, network back) and from the "Reconnect now" button, so
/// a socket that died during sleep is replaced within seconds instead of at
/// the next quiet-interval ping or the end of a 30 s backoff. No entry
/// (nothing subscribed, or already torn down) is not an error: there is no
/// socket to check.
#[tauri::command]
pub async fn remote_ws_probe(
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
) -> Result<(), AppCommandError> {
    let entry = {
        let tasks = proxy.tasks.lock().await;
        tasks.get(&connection_id).cloned()
    };
    if let Some(entry) = entry {
        entry.probe.notify_one();
    }
    Ok(())
}

/// Tell the WS task for `connection_id` whether a turn streams on screen in
/// the window behind `subscription_id`. While any subscribed window has one,
/// the heartbeat pings after `WS_STREAM_HEARTBEAT_INTERVAL` of silence with a
/// `WS_STREAM_PONG_TIMEOUT` floor (see `Heartbeat`), so a link that died
/// mid-turn is noticed in seconds — behind the same health-probe guard, so a
/// slow server is not mistaken for a dead link. No entry: nothing to watch.
#[tauri::command]
pub async fn remote_ws_set_streaming(
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    subscription_id: String,
    streaming: bool,
) -> Result<(), AppCommandError> {
    let entry = {
        let tasks = proxy.tasks.lock().await;
        tasks.get(&connection_id).cloned()
    };
    if let Some(entry) = entry {
        entry.set_subscription_streaming(&subscription_id, streaming);
    }
    Ok(())
}

// ─── Heartbeat ────────────────────────────────────────────────────────

/// What the heartbeat wants done when its deadline fires.
#[derive(Debug, PartialEq, Eq)]
enum HeartbeatAction {
    /// Quiet for a full interval: send a ping.
    Ping,
    /// The outstanding ping's pong is overdue: ask the server over HTTP
    /// whether it is there at all before giving up on the socket.
    Probe,
    /// The socket is dead.
    Dead,
    /// Deadline moved (a frame arrived meanwhile); keep waiting.
    Wait,
}

/// What a health probe (`probe_remote_health`) found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeOutcome {
    /// Answered 2xx: the server is up.
    Alive,
    /// A network error or a non-2xx answer (a 401 included: the reconnect's
    /// handshake is what classifies a rejected token).
    Unreachable,
    /// No answer within the probe's timeout.
    TimedOut,
}

/// What the heartbeat makes of a probe's outcome.
#[derive(Debug, PartialEq, Eq)]
enum ProbeVerdict {
    /// The server answered: keep the socket, ping it again (a write is what
    /// makes a connection that died quietly fail fast) and wait out the
    /// extended deadline.
    Extend,
    /// The link is down: drop the socket and reconnect.
    Dead,
    /// The ping was settled while the probe ran.
    Ignored,
}

/// Rolling window of round-trip samples, newest last: pong delays and
/// health-probe durations. Kept across reconnects, so a socket that replaces
/// one lost to a slow server starts out patient with it.
#[derive(Debug, Default)]
struct RttWindow {
    samples: std::collections::VecDeque<Duration>,
}

impl RttWindow {
    fn add(&mut self, sample: Duration) {
        self.samples.push_back(sample);
        while self.samples.len() > WS_RTT_SAMPLES {
            self.samples.pop_front();
        }
    }

    /// 95th percentile by nearest rank, or `None` with no samples yet.
    fn p95(&self) -> Option<Duration> {
        if self.samples.is_empty() {
            return None;
        }
        let mut sorted: Vec<Duration> = self.samples.iter().copied().collect();
        sorted.sort();
        let rank = (sorted.len() * 95).div_ceil(100).max(1) - 1;
        Some(sorted[rank])
    }
}

/// `clamp(3 × p95, floor, ceiling)`; the floor alone with no samples.
fn adaptive_deadline(p95: Option<Duration>, floor: Duration, ceiling: Duration) -> Duration {
    match p95 {
        None => floor,
        Some(p95) => p95.saturating_mul(3).clamp(floor, ceiling.max(floor)),
    }
}

/// The ping waiting for its pong.
#[derive(Debug)]
struct PendingPing {
    sent_at: Instant,
    due: Instant,
    /// When the health probe for this ping started, while it runs.
    probe_started: Option<Instant>,
    probe_timeout: Duration,
    /// Deadline extensions granted by successful probes so far.
    extensions: u32,
}

/// Pure liveness state machine for the proxied socket, with the same rules
/// as the web client's `LivenessMonitor` (`src/lib/transport/liveness.ts`):
///
/// - ping after `WS_HEARTBEAT_INTERVAL` of silence (`WS_STREAM_HEARTBEAT_INTERVAL`
///   while a turn streams on screen in a subscribed window); any inbound
///   frame is proof of life, so a busy stream never pays for it;
/// - the pong deadline adapts to the measured round trip:
///   `clamp(3 × p95, floor, WS_PONG_CEILING)`, the floor being
///   `WS_PONG_TIMEOUT` (idle), `WS_STREAM_PONG_TIMEOUT` (streaming) or
///   `WS_PROBE_PONG_TIMEOUT` (a frontend wake probe);
/// - a pong past its deadline triggers a health probe over plain HTTP: if
///   the server answers, it is alive but slow, and the socket is kept with
///   an extended deadline (at most `WS_MAX_DEADLINE_EXTENSIONS` times); if
///   not, the socket is dead. A timed-out probe counts as a sample of its
///   own length, so the next socket waits longer instead of looping through
///   reconnects against a slow server.
///
/// Free of I/O so the timing rules are unit-testable; `run_ws_task` feeds it
/// `Instant`s and acts on what it returns.
#[derive(Debug)]
struct Heartbeat {
    last_inbound: Instant,
    ping: Option<PendingPing>,
    rtt: RttWindow,
    streaming: bool,
}

impl Heartbeat {
    fn new(now: Instant) -> Self {
        Self {
            last_inbound: now,
            ping: None,
            rtt: RttWindow::default(),
            streaming: false,
        }
    }

    /// A fresh socket: restart the clock, keep the round-trip history.
    fn reset(&mut self, now: Instant) {
        self.last_inbound = now;
        self.ping = None;
    }

    fn set_streaming(&mut self, streaming: bool) {
        self.streaming = streaming;
    }

    fn quiet_interval(&self) -> Duration {
        if self.streaming {
            WS_STREAM_HEARTBEAT_INTERVAL
        } else {
            WS_HEARTBEAT_INTERVAL
        }
    }

    fn deadline_floor(&self) -> Duration {
        if self.streaming {
            WS_STREAM_PONG_TIMEOUT
        } else {
            WS_PONG_TIMEOUT
        }
    }

    fn pong_deadline(&self, floor: Duration) -> Duration {
        adaptive_deadline(self.rtt.p95(), floor, WS_PONG_CEILING)
    }

    /// How long the next health probe may take.
    fn probe_timeout(&self) -> Duration {
        let floor = if self.streaming {
            WS_HEALTH_PROBE_STREAM_TIMEOUT
        } else {
            WS_HEALTH_PROBE_TIMEOUT
        };
        adaptive_deadline(self.rtt.p95(), floor, WS_HEALTH_PROBE_CEILING)
    }

    fn new_ping(&self, now: Instant, floor: Duration) -> PendingPing {
        PendingPing {
            sent_at: now,
            due: now + self.pong_deadline(floor),
            probe_started: None,
            probe_timeout: Duration::ZERO,
            extensions: 0,
        }
    }

    /// Any inbound frame — text, pong, even a ping from the server — proves
    /// the link is alive and settles an outstanding ping. A pong is also a
    /// round-trip sample.
    fn on_inbound(&mut self, now: Instant, is_pong: bool) {
        if is_pong {
            if let Some(ping) = &self.ping {
                self.rtt.add(now.saturating_duration_since(ping.sent_at));
            }
        }
        self.last_inbound = now;
        self.ping = None;
    }

    /// The next moment `on_deadline` should be consulted.
    fn next_deadline(&self) -> Instant {
        match &self.ping {
            None => self.last_inbound + self.quiet_interval(),
            Some(ping) => match ping.probe_started {
                Some(started) => started + ping.probe_timeout + WS_HEALTH_PROBE_SLACK,
                None => ping.due,
            },
        }
    }

    fn on_deadline(&mut self, now: Instant) -> HeartbeatAction {
        let probe_timeout = self.probe_timeout();
        if let Some(ping) = &mut self.ping {
            if let Some(started) = ping.probe_started {
                // The probe has its own timeout; this only catches one that
                // never settled at all.
                return if now >= started + ping.probe_timeout + WS_HEALTH_PROBE_SLACK {
                    HeartbeatAction::Dead
                } else {
                    HeartbeatAction::Wait
                };
            }
            if now < ping.due {
                return HeartbeatAction::Wait;
            }
            if ping.extensions >= WS_MAX_DEADLINE_EXTENSIONS {
                return HeartbeatAction::Dead;
            }
            ping.probe_started = Some(now);
            ping.probe_timeout = probe_timeout;
            return HeartbeatAction::Probe;
        }
        if now >= self.last_inbound + self.quiet_interval() {
            self.ping = Some(self.new_ping(now, self.deadline_floor()));
            HeartbeatAction::Ping
        } else {
            HeartbeatAction::Wait
        }
    }

    /// The health probe for the outstanding ping settled after `elapsed`.
    fn on_probe_result(
        &mut self,
        now: Instant,
        outcome: ProbeOutcome,
        elapsed: Duration,
    ) -> ProbeVerdict {
        match self.ping.as_mut() {
            Some(ping) if ping.probe_started.is_some() => ping.probe_started = None,
            _ => return ProbeVerdict::Ignored,
        }
        match outcome {
            ProbeOutcome::Alive => {
                self.rtt.add(elapsed);
                let deadline = self.pong_deadline(self.deadline_floor());
                if let Some(ping) = self.ping.as_mut() {
                    ping.extensions += 1;
                    ping.due = now + deadline;
                }
                ProbeVerdict::Extend
            }
            ProbeOutcome::TimedOut => {
                self.rtt.add(elapsed);
                ProbeVerdict::Dead
            }
            ProbeOutcome::Unreachable => ProbeVerdict::Dead,
        }
    }

    /// Frontend-requested probe (tab visible, lid open, network back): answer
    /// within the wake deadline (`WS_PROBE_PONG_TIMEOUT` floor) or go through
    /// the health check. Returns whether a ping must go out. A recent
    /// outstanding ping is not resent, its deadline is just pulled in (never
    /// pushed out); one older than the wake deadline — sent before a sleep —
    /// is replaced, since a write is what makes a dead connection fail fast.
    /// A probe already in flight is left to decide.
    fn on_probe(&mut self, now: Instant) -> bool {
        let deadline = self.pong_deadline(WS_PROBE_PONG_TIMEOUT);
        if let Some(ping) = &mut self.ping {
            if ping.probe_started.is_some() {
                return false;
            }
            if now.saturating_duration_since(ping.sent_at) < deadline {
                ping.due = ping.due.min(now + deadline);
                return false;
            }
        }
        self.ping = Some(self.new_ping(now, WS_PROBE_PONG_TIMEOUT));
        true
    }
}

/// A health probe in flight: its outcome and how long it took.
type HealthProbe =
    std::pin::Pin<Box<dyn std::future::Future<Output = (ProbeOutcome, Duration)> + Send>>;

/// Ask the remote over plain HTTP whether it is up: `POST /api/health`,
/// authenticated like every proxied call, bounded by `timeout`.
async fn probe_remote_health(
    client: reqwest::Client,
    base_url: String,
    token: String,
    headers: HeaderMap,
    timeout: Duration,
) -> ProbeOutcome {
    let url = format!("{}/api/health", base_url.trim_end_matches('/'));
    let request = client
        .post(&url)
        .bearer_auth(token.trim())
        .headers(headers)
        .json(&serde_json::json!({}))
        .timeout(timeout);
    match request.send().await {
        Ok(response) if response.status().is_success() => ProbeOutcome::Alive,
        Ok(_) => ProbeOutcome::Unreachable,
        Err(err) if err.is_timeout() => ProbeOutcome::TimedOut,
        Err(_) => ProbeOutcome::Unreachable,
    }
}

/// Resolves with the probe's outcome; never, while there is none, so it can
/// sit in a `select!` unconditionally.
async fn await_health_probe(probe: &mut Option<HealthProbe>) -> (ProbeOutcome, Duration) {
    match probe {
        Some(fut) => fut.await,
        None => std::future::pending().await,
    }
}

/// Send a protocol-level ping, bounded by `WS_PING_SEND_TIMEOUT`. Any
/// failure means the socket is unusable: the caller leaves the read loop and
/// reconnects.
async fn send_heartbeat_ping(socket: &mut RemoteWsSocket) -> Result<(), String> {
    match tokio::time::timeout(
        WS_PING_SEND_TIMEOUT,
        socket.send(Message::Ping(Bytes::new())),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Err(format!(
            "send did not complete within {}s",
            WS_PING_SEND_TIMEOUT.as_secs()
        )),
    }
}

// ─── WS background task ───────────────────────────────────────────────

/// Long-running task that maintains one WebSocket per `connection_id`.
/// Lifecycle:
///   1. Connect (with subprotocol-auth header).
///   2. Forward the server's `__ready__` once its receiver is subscribed.
///   3. Forward legacy envelopes and attach-protocol snapshot/replay/events,
///      each frame to every subscribed window once.
///   4. On network failure — a refused or timed-out handshake, a remote
///      close, a read error, or a heartbeat that went unanswered (the socket
///      died during sleep) — emit `__disconnected__` and keep retrying with
///      capped, jittered backoff, each retry dialing the connection as it is
///      stored then. A drop says nothing about the token: only an HTTP 401
///      on the handshake emits `__unauthorized__` and exits; so does a
///      deleted connection, quietly.
///   5. The heartbeat (`Heartbeat`) recovers half-open sockets after sleep
///      or lost packets, and a frontend probe (`remote_ws_probe`) checks the
///      socket at once or cuts a backoff wait short.
///   6. Shutdown cancels both connection attempts and backoff.
///
/// On exit (any path), the task removes its entry from `proxy.tasks` —
/// but only if the entry still matches its own `Arc`, so a racy
/// resubscribe that already replaced the entry isn't clobbered.
// `app`/`proxy`/`db`/`connection_id`/`target`/`entry`/`shutdown_rx`/
// `outbound_rx` are all distinct concerns the task needs; bundling into a
// single struct would just spread the field definitions to a different
// place without improving readability.
#[allow(clippy::too_many_arguments)]
async fn run_ws_task(
    app: AppHandle,
    proxy: Arc<RemoteProxyState>,
    db: DatabaseConnection,
    connection_id: i32,
    target: WsTarget,
    entry: Arc<WsTaskEntry>,
    mut shutdown_rx: watch::Receiver<bool>,
    mut outbound_rx: mpsc::Receiver<String>,
) {
    let probe_client = proxy.http.clone();
    run_ws_connection(
        target,
        |last_known| stored_ws_target(db.clone(), connection_id, last_known),
        &entry,
        &probe_client,
        &mut shutdown_rx,
        &mut outbound_rx,
        |frame| {
            // The server's pending list, for the menu-bar icon and the Dock
            // badge: fresher than their poll while this window is open.
            crate::attention_tray::observe_remote_frame(connection_id, &frame);
            forward_frame(&app, &entry, connection_id, frame)
        },
    )
    .await;

    *entry.ready.write().await = false;

    // A stale task must not remove a newer subscription's replacement entry.
    let mut tasks = proxy.tasks.lock().await;
    if tasks
        .get(&connection_id)
        .is_some_and(|stored| Arc::ptr_eq(stored, &entry))
    {
        tasks.remove(&connection_id);
    }
}

/// Where the event WebSocket connects, and the credentials it presents.
#[derive(Clone)]
struct WsTarget {
    url: String,
    /// The connection's HTTP base URL: where the heartbeat's health probe
    /// asks whether the server is up (`probe_remote_health`).
    base_url: String,
    token: String,
    headers: HeaderMap,
}

impl WsTarget {
    fn of(connection: &RemoteWorkspaceConnectionInfo) -> Self {
        Self {
            url: http_url_to_ws_url(&connection.base_url, WS_EVENTS_PATH),
            base_url: connection.base_url.clone(),
            token: connection.token.clone(),
            headers: connection.headers.to_header_map(),
        }
    }
}

/// The target a retry dials: the connection as stored now. HTTP calls read
/// the connection per request, so an edited address or token reaches them at
/// once; without this, a socket retrying an address that has since been
/// edited away would retry it until its window closed. `None` once the
/// connection has been deleted. A failed lookup keeps `last_known`.
async fn stored_ws_target(
    db: DatabaseConnection,
    connection_id: i32,
    last_known: WsTarget,
) -> Option<WsTarget> {
    match remote_workspace_connection_service::get(&db, connection_id).await {
        Ok(Some(connection)) => Some(WsTarget::of(&connection)),
        Ok(None) => {
            tracing::info!(
                "[RemoteProxy] remote connection {connection_id} was deleted; its event socket stops"
            );
            None
        }
        Err(err) => {
            tracing::warn!(
                "[RemoteProxy] could not reload remote connection {connection_id}, retrying its last address: {err}"
            );
            Some(last_known)
        }
    }
}

/// Network lifecycle separated from Tauri delivery so tests exercise actual
/// sockets, failures and recovery without constructing native webviews.
/// `target` is dialed first; every retry dials what `refresh_target` returns
/// for the target before it, and the loop ends when it returns `None`.
/// `probe_client` carries the heartbeat's health probe.
async fn run_ws_connection<R, RFut, F, Fut>(
    mut target: WsTarget,
    mut refresh_target: R,
    entry: &WsTaskEntry,
    probe_client: &reqwest::Client,
    shutdown_rx: &mut watch::Receiver<bool>,
    outbound_rx: &mut mpsc::Receiver<String>,
    mut emit: F,
) where
    R: FnMut(WsTarget) -> RFut,
    RFut: Future<Output = Option<WsTarget>>,
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    // Drives the backoff delay: grows on every failure of any kind, resets
    // on a successful handshake.
    let mut fail_count: u32 = 0;
    // One heartbeat for the loop's life: its round-trip history outlives a
    // socket, so the one that replaces a socket lost to a slow server starts
    // out patient with it.
    let mut heartbeat = Heartbeat::new(Instant::now());

    'reconnect: loop {
        if *shutdown_rx.borrow() {
            break;
        }
        // A retry (any attempt after a failure or a lost socket) dials the
        // connection as it is stored now; the first attempt uses what the
        // subscribe has just read.
        if fail_count > 0 {
            match refresh_target(target.clone()).await {
                Some(current) => target = current,
                None => break,
            }
        }

        // When this connect attempt started (`WS_MIN_RETRY_GAP`).
        let attempt_started = Instant::now();
        let connect_result = tokio::select! {
            biased;
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
                continue;
            }
            res = connect_with_subprotocol_auth(
                &target.url,
                WS_EVENT_PROTOCOL,
                &target.token,
                &target.headers,
            ) => res,
        };

        let mut socket = match connect_result {
            Ok(socket) => socket,
            Err(err) => {
                *entry.ready.write().await = false;
                if matches!(err, WsConnectError::Unauthorized) {
                    emit(lifecycle_frame(WS_UNAUTHORIZED_CHANNEL)).await;
                    break;
                }
                // Diagnostics deliberately exclude handshake headers/body,
                // which can contain echoed tokens or custom credentials.
                tracing::warn!("[RemoteProxy] WS connect failed: {err}");
                emit(lifecycle_frame(WS_DISCONNECTED_CHANNEL)).await;
                fail_count = fail_count.saturating_add(1);
                if backoff_sleep(shutdown_rx, &entry.probe, fail_count, attempt_started).await {
                    break;
                }
                continue;
            }
        };

        // Connect succeeded — reset the failure count. We do not emit
        // `__ready__` here; the remote server emits the real `__ready__` only
        // after it has subscribed to its broadcaster, and that is the
        // readiness contract the frontend relies on.
        fail_count = 0;
        // Frames queued before a disconnect belonged to the old socket. The
        // next ready reissues attaches with the current cursor; stale detach
        // frames must not cancel those renewed subscriptions.
        while outbound_rx.try_recv().is_ok() {}
        heartbeat.reset(Instant::now());
        heartbeat.set_streaming(entry.is_streaming());
        // The health probe in flight for an overdue pong, if any.
        let mut health_probe: Option<HealthProbe> = None;

        // Read loop. Exits on shutdown, error, remote close, or a socket the
        // heartbeat presumes dead.
        loop {
            tokio::select! {
                biased;
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        let _ = send_ws_message(&mut socket, Message::Close(None)).await;
                        break 'reconnect;
                    }
                }
                outbound = outbound_rx.recv() => match outbound {
                    Some(text) => {
                        if !send_ws_message(&mut socket, Message::Text(text.into())).await {
                            tracing::warn!("[RemoteProxy] outbound WS send failed; reconnecting");
                            break;
                        }
                    }
                    None => {
                        // Sender side dropped — only happens at proxy state
                        // teardown; treat as graceful exit.
                        let _ = send_ws_message(&mut socket, Message::Close(None)).await;
                        break 'reconnect;
                    }
                },
                // Polled before the heartbeat branches: a frame that has
                // already arrived must count as proof of life before an
                // overdue deadline is judged.
                msg = socket.next() => {
                    if let Some(Ok(frame)) = &msg {
                        heartbeat.on_inbound(Instant::now(), matches!(frame, Message::Pong(_)));
                        // Whatever a probe in flight would say is moot now.
                        health_probe = None;
                    }
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            match serde_json::from_str::<Value>(&text) {
                                Ok(frame) => {
                                    if frame.get("channel").and_then(Value::as_str)
                                        == Some(WS_READY_CHANNEL)
                                    {
                                        *entry.ready.write().await = true;
                                    }
                                    emit(frame).await;
                                }
                                Err(_) => tracing::warn!("[RemoteProxy] invalid WS JSON frame"),
                            }
                        }
                        Some(Ok(Message::Binary(_))) => {
                            // Server only emits text frames today; ignore binary.
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if !send_ws_message(&mut socket, Message::Pong(payload)).await {
                                break;
                            }
                        }
                        Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(_))) | None => {
                            break;
                        }
                        Some(Err(err)) => {
                            tracing::warn!("[RemoteProxy] WS read error: {err}");
                            break;
                        }
                    }
                }
                // Frontend-requested liveness probe (tab visible / lid open):
                // ping now under the short deadline instead of waiting for
                // the next quiet interval.
                _ = entry.probe.notified() => {
                    if heartbeat.on_probe(Instant::now()) {
                        if let Err(err) = send_heartbeat_ping(&mut socket).await {
                            tracing::warn!("[RemoteProxy] probe ping failed: {err}");
                            break;
                        }
                    }
                }
                _ = entry.streaming_changed.notified() => {
                    heartbeat.set_streaming(entry.is_streaming());
                }
                // The pong is overdue and the health probe answered.
                outcome = await_health_probe(&mut health_probe) => {
                    health_probe = None;
                    match heartbeat.on_probe_result(Instant::now(), outcome.0, outcome.1) {
                        ProbeVerdict::Extend => {
                            tracing::info!(
                                "[RemoteProxy] pong overdue, but the server answered its health \
                                 check in {}ms; keeping the socket",
                                outcome.1.as_millis()
                            );
                            if let Err(err) = send_heartbeat_ping(&mut socket).await {
                                tracing::warn!("[RemoteProxy] heartbeat ping failed: {err}");
                                break;
                            }
                        }
                        ProbeVerdict::Dead => {
                            tracing::warn!(
                                "[RemoteProxy] WS stopped answering pings and its health check \
                                 found {:?} after {}ms; reconnecting",
                                outcome.0,
                                outcome.1.as_millis()
                            );
                            break;
                        }
                        ProbeVerdict::Ignored => {}
                    }
                }
                _ = tokio::time::sleep_until(heartbeat.next_deadline()) => {
                    match heartbeat.on_deadline(Instant::now()) {
                        HeartbeatAction::Ping => {
                            if let Err(err) = send_heartbeat_ping(&mut socket).await {
                                tracing::warn!("[RemoteProxy] heartbeat ping failed: {err}");
                                break;
                            }
                        }
                        HeartbeatAction::Probe => {
                            let probe = probe_remote_health(
                                probe_client.clone(),
                                target.base_url.clone(),
                                target.token.clone(),
                                target.headers.clone(),
                                heartbeat.probe_timeout(),
                            );
                            health_probe = Some(Box::pin(async move {
                                let started = Instant::now();
                                let outcome = probe.await;
                                (outcome, started.elapsed())
                            }));
                        }
                        HeartbeatAction::Dead => {
                            tracing::warn!(
                                "[RemoteProxy] WS stopped answering pings; presuming the socket \
                                 died (sleep/wake?) and reconnecting"
                            );
                            break;
                        }
                        HeartbeatAction::Wait => {}
                    }
                }
            }
        }

        // Disconnected (not via shutdown). Notify and try again. A drop is
        // never evidence the token expired — only the next handshake can
        // tell.
        *entry.ready.write().await = false;
        emit(lifecycle_frame(WS_DISCONNECTED_CHANNEL)).await;
        fail_count = fail_count.saturating_add(1);
        if backoff_sleep(shutdown_rx, &entry.probe, fail_count, attempt_started).await {
            break;
        }
    }

    *entry.ready.write().await = false;
}

type RemoteWsSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Write one frame, bounded by `WS_SEND_TIMEOUT`. `false` means the socket
/// is unusable: the caller leaves the read loop and reconnects.
async fn send_ws_message(socket: &mut RemoteWsSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(WS_SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

/// The wait before reconnect attempt `fail_count` (1-based): 1 s doubling up
/// to `WS_BACKOFF_MAX`, then spread over its upper half by `jitter` (a draw
/// from `[0, 1)`), so every window — and every client — that lost the
/// server together does not knock on its door in the same instant when it
/// comes back.
fn ws_backoff_delay(fail_count: u32, jitter: f64) -> Duration {
    let shift = fail_count.saturating_sub(1).min(16);
    let base = WS_BACKOFF_INITIAL
        .saturating_mul(1u32 << shift)
        .min(WS_BACKOFF_MAX);
    base.mul_f64(0.5 + 0.5 * jitter.clamp(0.0, 1.0))
}

/// Sleep for the backoff before reconnect attempt `fail_count`
/// (`ws_backoff_delay`). Returns `true` if shutdown was requested before or
/// during the wait (or its sender is gone) — caller should exit its loop in
/// that case.
///
/// `wake` (the entry's probe signal) cuts the wait short: a wake-up probe
/// (lid opened, network back) or the user's "Reconnect now" means "try now",
/// not "after the remaining 30 s". A request that landed while a connect
/// attempt was in flight is kept as a `Notify` permit, so the retry after
/// that attempt starts promptly too. Promptly, not at once: the next attempt
/// still starts no sooner than `WS_MIN_RETRY_GAP` after `attempt_started`,
/// so a stream of wake requests cannot turn the backoff into a tight loop.
async fn backoff_sleep(
    shutdown_rx: &mut watch::Receiver<bool>,
    wake: &Notify,
    fail_count: u32,
    attempt_started: Instant,
) -> bool {
    if *shutdown_rx.borrow() {
        return true;
    }
    let delay = ws_backoff_delay(fail_count, rand::random::<f64>());
    let woken = tokio::select! {
        biased;
        changed = shutdown_rx.changed() => return changed.is_err() || *shutdown_rx.borrow(),
        _ = wake.notified() => true,
        _ = tokio::time::sleep(delay) => false,
    };
    if woken {
        let earliest = attempt_started + WS_MIN_RETRY_GAP;
        tokio::select! {
            biased;
            changed = shutdown_rx.changed() => return changed.is_err() || *shutdown_rx.borrow(),
            _ = tokio::time::sleep_until(earliest) => {}
        }
    }
    false
}

/// Forward a text frame from the remote WS to all current subscribers of
/// this connection. The remote codeg-server's `ws.rs` emits frames shaped
/// `{ "channel": "...", "payload": ... }` (see `WebEventBroadcaster`).
/// Re-emit the payload as-is to the subscribed webviews.
async fn forward_frame(
    app: &AppHandle,
    entry: &Arc<WsTaskEntry>,
    connection_id: i32,
    envelope: Value,
) {
    for label in snapshot_subscribers(entry).await {
        emit_frame_to_label(app, connection_id, &label, &envelope);
    }
}

/// Build one of the internal lifecycle envelopes (`__ready__`,
/// `__disconnected__`, `__unauthorized__`).
fn lifecycle_frame(channel: &'static str) -> Value {
    serde_json::json!({ "channel": channel, "payload": Value::Null })
}

/// Tauri event name for one subscriber webview of one connection. Must match
/// the name `RemoteDesktopTransport.startWs` listens on. Webview labels only
/// use characters Tauri also allows in event names, so this is always valid.
///
/// One name per window, not one per connection: Tauri hands a targeted emit
/// to every listener of that name whose own target is `Any`, in every webview
/// (`match_any_or_filter` in tauri's `event/listener.rs`), and evaluates the
/// event script in each webview listening on the name even when the filter
/// leaves it no recipient. With a shared name, N subscribed windows meant a
/// remote terminal printing every byte N times.
fn remote_ws_event_name(connection_id: i32, label: &str) -> String {
    format!("remote-ws-event-{connection_id}-{label}")
}

fn emit_frame_to_label(app: &AppHandle, connection_id: i32, label: &str, envelope: &Value) {
    let event_name = remote_ws_event_name(connection_id, label);
    if let Err(e) = app.emit_to(EventTarget::webview(label), &event_name, envelope) {
        tracing::error!("[RemoteProxy] emit_to {label} for {event_name} failed: {e}");
    }
}

async fn acknowledge_ready_subscriber(
    app: &AppHandle,
    entry: &WsTaskEntry,
    connection_id: i32,
    label: &str,
) {
    // Hold readiness through the acknowledgement so it cannot overtake a
    // disconnect notification. Also used after the slow-path insert race.
    let ready = entry.ready.read().await;
    if *ready {
        emit_frame_to_label(
            app,
            connection_id,
            label,
            &lifecycle_frame(WS_READY_CHANNEL),
        );
    }
}

/// Collect the unique labels to fan-out to. Deduplicates because two
/// subscription IDs could theoretically map to the same label.
async fn snapshot_subscribers(entry: &Arc<WsTaskEntry>) -> Vec<String> {
    let subs = entry.subscribers.lock().await;
    let mut labels: Vec<String> = subs.values().map(|sub| sub.label.clone()).collect();
    labels.sort_unstable();
    labels.dedup();
    labels
}

// ─── Helpers ──────────────────────────────────────────────────────────

/// Connect to a remote WebSocket with subprotocol-based token auth, speaking
/// `protocol` (`codeg-events`, or the browser tunnel's). The remote server's
/// auth middleware (see `web/auth.rs`) accepts either `Authorization: Bearer …`
/// or a subprotocol entry shaped `codeg-token.{base64url(token)}`. The latter
/// is what browser WebSocket clients use because browsers cannot set arbitrary
/// headers on WS handshakes; we follow the same convention here so both
/// transports share one server-side codepath.
async fn connect_with_subprotocol_auth(
    ws_url: &str,
    protocol: &str,
    token: &str,
    custom_headers: &HeaderMap,
) -> Result<RemoteWsSocket, WsConnectError> {
    let request = ws_request_with_subprotocol_auth(ws_url, protocol, token, custom_headers)
        .map_err(|_| WsConnectError::Retryable("invalid WebSocket request".into()))?;
    let (stream, _resp) = tokio::time::timeout(WS_CONNECT_TIMEOUT, connect_remote_ws(request))
        .await
        .map_err(|_| WsConnectError::Retryable("WebSocket connect timed out".into()))?
        .map_err(WsConnectError::from)?;
    Ok(stream)
}

#[derive(Debug, thiserror::Error)]
enum WsConnectError {
    #[error("the remote server refused the token")]
    Unauthorized,
    #[error("{0}")]
    Retryable(String),
}

impl From<WsError> for WsConnectError {
    fn from(err: WsError) -> Self {
        match err {
            WsError::Http(response) if response.status().as_u16() == 401 => Self::Unauthorized,
            WsError::Http(response) => {
                Self::Retryable(format!("remote server answered HTTP {}", response.status()))
            }
            WsError::Io(err) => Self::Retryable(format!("WebSocket I/O error ({})", err.kind())),
            _ => Self::Retryable("WebSocket handshake failed".into()),
        }
    }
}

/// The handshake request `connect_with_subprotocol_auth` sends, for a caller
/// that needs tungstenite's own error back (the HTTP status of a refused
/// upgrade says what the server is).
pub(crate) fn ws_request_with_subprotocol_auth(
    ws_url: &str,
    protocol: &str,
    token: &str,
    custom_headers: &HeaderMap,
) -> Result<Request, String> {
    let mut request: Request = ws_url
        .into_client_request()
        .map_err(|e| format!("invalid WS URL: {e}"))?;

    let encoded_token = URL_SAFE_NO_PAD.encode(token.trim().as_bytes());
    let protocols_value = format!("{protocol}, {WS_TOKEN_PROTOCOL_PREFIX}{encoded_token}");
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&protocols_value)
            .map_err(|e| format!("invalid subprotocol value: {e}"))?,
    );
    request.headers_mut().extend(custom_headers.clone());
    Ok(request)
}

/// Open the WebSocket `request` names on a remote server: the event socket
/// ([`connect_with_subprotocol_auth`]) and the built-in browser's tunnel
/// (`browser::egress`).
///
/// `tokio_tungstenite::connect_async` would dial the host's addresses strictly
/// one after another, so one that never answers keeps the attempt until our
/// connect timeout cancels it, and the next is never tried. Windows resolves
/// `localhost` to `::1` before `127.0.0.1`, and WSL's mirrored networking
/// leaves a SYN from Windows to `::1` unanswered: a connection to a
/// codeg-server in WSL at `http://localhost:…` served every HTTP call while
/// its event socket timed out on every retry (#930). Those HTTP calls, like
/// any browser, give the first address family a head start and then race the
/// other one (Happy Eyeballs), so this dials through the same connector
/// reqwest does, then runs the TLS and handshake `connect_async` would have.
// `result_large_err`: this is `connect_async`'s own result type, tungstenite's
// error included, and the tunnel matches on its `Http` variant.
#[allow(clippy::result_large_err)]
pub(crate) async fn connect_remote_ws(
    request: Request,
) -> Result<(RemoteWsSocket, Response), WsError> {
    connect_remote_ws_via(HttpConnector::new(), request).await
}

/// [`connect_remote_ws`] over a given connector, so a test can choose what the
/// host resolves to.
#[allow(clippy::result_large_err)]
async fn connect_remote_ws_via<C>(
    mut connector: C,
    request: Request,
) -> Result<(RemoteWsSocket, Response), WsError>
where
    C: Service<Uri, Response = TokioIo<TcpStream>>,
    C::Error: std::error::Error,
{
    let uri = request.uri();
    let default_port = match uri.scheme_str() {
        Some("ws") => 80,
        Some("wss") => 443,
        _ => return Err(WsError::Url(UrlError::UnsupportedUrlScheme)),
    };
    let host = uri.host().ok_or(WsError::Url(UrlError::NoHostName))?;
    let port = uri.port_u16().unwrap_or(default_port);
    // `host` keeps an IPv6 literal's brackets, which an authority needs.
    let address: Uri = format!("http://{host}:{port}")
        .parse()
        .map_err(|_| WsError::Url(UrlError::NoHostName))?;
    std::future::poll_fn(|cx| connector.poll_ready(cx))
        .await
        .map_err(dial_error)?;
    let stream = connector
        .call(address)
        .await
        .map_err(dial_error)?
        .into_inner();
    tokio_tungstenite::client_async_tls_with_config(request, stream, None, None).await
}

/// A failed dial as the I/O error `connect_async` would have returned. The
/// connector's own message is just a label ("tcp connect error"); the kind —
/// refused, unreachable, … — is on the error it wraps.
fn dial_error(err: impl std::error::Error) -> WsError {
    let cause = err.source();
    let kind = cause
        .and_then(|cause| cause.downcast_ref::<std::io::Error>())
        .map_or(std::io::ErrorKind::Other, std::io::Error::kind);
    let detail = match cause {
        Some(cause) => format!("{err}: {cause}"),
        None => err.to_string(),
    };
    WsError::Io(std::io::Error::new(kind, detail))
}

/// Convert an `http://…` or `https://…` base URL into the corresponding
/// WebSocket URL ending in `path` (`/ws/events`, …). Anything else is passed
/// through untouched so tungstenite can surface a clean parse error.
pub(crate) fn http_url_to_ws_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}{path}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}{path}")
    } else {
        format!("{trimmed}{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscriber(label: &str, window_instance_id: &str) -> WsSubscriber {
        WsSubscriber {
            label: label.to_string(),
            window_instance_id: window_instance_id.to_string(),
        }
    }

    fn test_entry(subscribers: HashMap<String, WsSubscriber>) -> Arc<WsTaskEntry> {
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        let (outbound_tx, _outbound_rx) = mpsc::channel::<String>(8);
        Arc::new(WsTaskEntry {
            subscribers: Mutex::new(subscribers),
            ready: RwLock::new(false),
            shutdown_tx,
            outbound_tx,
            probe: Notify::new(),
            streaming: std::sync::Mutex::new(HashSet::new()),
            streaming_changed: Notify::new(),
        })
    }

    // ─── Fan-out ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn each_subscribed_window_gets_its_own_event_once() {
        // The workspace window and the hidden Quick Ask window on one
        // connection, the workspace subscribed twice (a reloaded page).
        let entry = test_entry(HashMap::from([
            ("a".to_string(), subscriber("remote-workspace-1", "rw-1")),
            ("b".to_string(), subscriber("remote-workspace-1", "rw-1")),
            ("c".to_string(), subscriber("quick-ask", "rw-q")),
        ]));
        let labels = snapshot_subscribers(&entry).await;
        assert_eq!(labels, ["quick-ask", "remote-workspace-1"]);
        let names: Vec<String> = labels
            .iter()
            .map(|label| remote_ws_event_name(1, label))
            .collect();
        assert_eq!(
            names,
            [
                "remote-ws-event-1-quick-ask",
                "remote-ws-event-1-remote-workspace-1"
            ]
        );
    }

    // ─── Heartbeat (dead-socket detection) ──────────────────────────────

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// Drive a fresh heartbeat to its first ping; returns when it went out.
    fn pinged(hb: &mut Heartbeat, t0: Instant) -> Instant {
        let sent = t0 + hb.quiet_interval();
        assert_eq!(hb.on_deadline(sent), HeartbeatAction::Ping);
        sent
    }

    #[test]
    fn heartbeat_pings_after_a_quiet_interval_then_probes_when_the_pong_is_overdue() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        assert_eq!(hb.next_deadline(), t0 + WS_HEARTBEAT_INTERVAL);
        // Consulted early (spurious wake): nothing to do yet.
        assert_eq!(hb.on_deadline(t0 + secs(1)), HeartbeatAction::Wait);
        let sent = pinged(&mut hb, t0);
        assert_eq!(hb.next_deadline(), sent + WS_PONG_TIMEOUT);
        assert_eq!(hb.on_deadline(sent + secs(1)), HeartbeatAction::Wait);
        // Overdue: ask the server before giving up on the socket.
        assert_eq!(
            hb.on_deadline(sent + WS_PONG_TIMEOUT),
            HeartbeatAction::Probe
        );
        let probe_at = sent + WS_PONG_TIMEOUT;
        assert_eq!(
            hb.next_deadline(),
            probe_at + WS_HEALTH_PROBE_TIMEOUT + WS_HEALTH_PROBE_SLACK
        );
        // Unreachable: the link is down.
        assert_eq!(
            hb.on_probe_result(probe_at + secs(1), ProbeOutcome::Unreachable, secs(1)),
            ProbeVerdict::Dead
        );
    }

    #[test]
    fn heartbeat_keeps_a_socket_whose_server_answers_and_extends_its_deadline() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        let sent = pinged(&mut hb, t0);
        let probe_at = sent + WS_PONG_TIMEOUT;
        assert_eq!(hb.on_deadline(probe_at), HeartbeatAction::Probe);
        let answered = probe_at + Duration::from_millis(40);
        assert_eq!(
            hb.on_probe_result(answered, ProbeOutcome::Alive, Duration::from_millis(40)),
            ProbeVerdict::Extend
        );
        assert_eq!(hb.next_deadline(), answered + WS_PONG_TIMEOUT);
        // The pong finally lands: settled, and its delay is remembered.
        let pong = sent + secs(14);
        hb.on_inbound(pong, true);
        assert_eq!(hb.next_deadline(), pong + WS_HEARTBEAT_INTERVAL);
        // The next ping gets 3 × 14 s, capped at the ceiling.
        let sent2 = pong + WS_HEARTBEAT_INTERVAL;
        assert_eq!(hb.on_deadline(sent2), HeartbeatAction::Ping);
        assert_eq!(hb.next_deadline(), sent2 + WS_PONG_CEILING);
    }

    #[test]
    fn heartbeat_gives_up_after_the_last_extension() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        pinged(&mut hb, t0);
        for _ in 0..WS_MAX_DEADLINE_EXTENSIONS {
            let now = hb.next_deadline();
            assert_eq!(hb.on_deadline(now), HeartbeatAction::Probe);
            assert_eq!(
                hb.on_probe_result(now, ProbeOutcome::Alive, Duration::ZERO),
                ProbeVerdict::Extend
            );
        }
        let now = hb.next_deadline();
        assert_eq!(hb.on_deadline(now), HeartbeatAction::Dead);
    }

    #[test]
    fn heartbeat_counts_a_timed_out_probe_so_the_next_socket_is_more_patient() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        let sent = pinged(&mut hb, t0);
        let probe_at = sent + WS_PONG_TIMEOUT;
        assert_eq!(hb.on_deadline(probe_at), HeartbeatAction::Probe);
        assert_eq!(
            hb.on_probe_result(
                probe_at + WS_HEALTH_PROBE_TIMEOUT,
                ProbeOutcome::TimedOut,
                WS_HEALTH_PROBE_TIMEOUT
            ),
            ProbeVerdict::Dead
        );
        // Reconnected: 3 × 8 s now, for the pong and for the next probe.
        let t1 = probe_at + secs(20);
        hb.reset(t1);
        let sent = pinged(&mut hb, t1);
        assert_eq!(hb.next_deadline(), sent + secs(24));
        assert_eq!(hb.probe_timeout(), WS_HEALTH_PROBE_CEILING);
    }

    #[test]
    fn heartbeat_ignores_a_probe_result_once_a_frame_settled_the_ping() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        let sent = pinged(&mut hb, t0);
        assert_eq!(
            hb.on_deadline(sent + WS_PONG_TIMEOUT),
            HeartbeatAction::Probe
        );
        hb.on_inbound(sent + secs(11), false);
        assert_eq!(
            hb.on_probe_result(sent + secs(12), ProbeOutcome::Unreachable, secs(2)),
            ProbeVerdict::Ignored
        );
        assert_eq!(hb.next_deadline(), sent + secs(11) + WS_HEARTBEAT_INTERVAL);
    }

    #[test]
    fn heartbeat_treats_any_inbound_frame_as_proof_of_life() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        // A busy stream is never pinged: each frame restarts the quiet interval.
        for i in 1..=5 {
            let now = t0 + secs(10 * i);
            hb.on_inbound(now, false);
            assert_eq!(hb.next_deadline(), now + WS_HEARTBEAT_INTERVAL);
            assert_eq!(hb.on_deadline(now + secs(5)), HeartbeatAction::Wait);
        }
        // An outstanding ping is settled by whatever arrives — no pong needed,
        // but only a pong is a round-trip sample.
        let quiet = t0 + secs(50) + WS_HEARTBEAT_INTERVAL;
        assert_eq!(hb.on_deadline(quiet), HeartbeatAction::Ping);
        hb.on_inbound(quiet + secs(9), false);
        assert_eq!(hb.rtt.p95(), None);
        assert_eq!(
            hb.on_deadline(quiet + WS_PONG_TIMEOUT),
            HeartbeatAction::Wait
        );
    }

    #[test]
    fn heartbeat_watches_closer_while_a_turn_streams_on_screen() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        hb.set_streaming(true);
        assert_eq!(hb.next_deadline(), t0 + WS_STREAM_HEARTBEAT_INTERVAL);
        let sent = pinged(&mut hb, t0);
        assert_eq!(sent, t0 + WS_STREAM_HEARTBEAT_INTERVAL);
        assert_eq!(hb.next_deadline(), sent + WS_STREAM_PONG_TIMEOUT);
        let probe_at = sent + WS_STREAM_PONG_TIMEOUT;
        assert_eq!(hb.on_deadline(probe_at), HeartbeatAction::Probe);
        assert_eq!(
            hb.next_deadline(),
            probe_at + WS_HEALTH_PROBE_STREAM_TIMEOUT + WS_HEALTH_PROBE_SLACK
        );
    }

    #[test]
    fn heartbeat_probe_pings_at_once_under_the_short_deadline() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        let now = t0 + secs(3);
        assert!(
            hb.on_probe(now),
            "no ping outstanding: the probe must send one"
        );
        assert_eq!(hb.next_deadline(), now + WS_PROBE_PONG_TIMEOUT);
        assert_eq!(
            hb.on_deadline(now + WS_PROBE_PONG_TIMEOUT),
            HeartbeatAction::Probe
        );
    }

    #[test]
    fn heartbeat_probe_pulls_in_a_recent_ping_and_replaces_a_stale_one() {
        let t0 = Instant::now();
        // Probe 1 s after a ping: 1 s + 4 s beats the ping's own 10 s; no resend.
        let mut hb = Heartbeat::new(t0);
        let sent = pinged(&mut hb, t0);
        let probe_at = sent + secs(1);
        assert!(!hb.on_probe(probe_at));
        assert_eq!(hb.next_deadline(), probe_at + WS_PROBE_PONG_TIMEOUT);
        // A ping older than the wake deadline (sent before a sleep): a fresh
        // one goes out, since a write is what makes a dead socket fail fast.
        let mut hb = Heartbeat::new(t0);
        let sent = pinged(&mut hb, t0);
        let late_probe = sent + secs(9);
        assert!(hb.on_probe(late_probe));
        assert_eq!(hb.next_deadline(), late_probe + WS_PROBE_PONG_TIMEOUT);
        // A probe in flight is left to decide.
        assert_eq!(
            hb.on_deadline(late_probe + WS_PROBE_PONG_TIMEOUT),
            HeartbeatAction::Probe
        );
        assert!(!hb.on_probe(late_probe + secs(5)));
    }

    #[test]
    fn rtt_window_reports_the_nearest_rank_95th_percentile() {
        let mut window = RttWindow::default();
        assert_eq!(window.p95(), None);
        for ms in 1..=20u64 {
            window.add(Duration::from_millis(ms * 10));
        }
        // 16 kept (50..=200 ms); rank ceil(0.95 × 16) = 16 → the largest.
        assert_eq!(window.p95(), Some(Duration::from_millis(200)));
        assert_eq!(adaptive_deadline(None, secs(10), secs(30)), secs(10));
        assert_eq!(
            adaptive_deadline(Some(Duration::from_millis(200)), secs(10), secs(30)),
            secs(10)
        );
        assert_eq!(adaptive_deadline(Some(secs(5)), secs(10), secs(30)), secs(15));
        assert_eq!(adaptive_deadline(Some(secs(20)), secs(10), secs(30)), secs(30));
    }

    /// Accept connections and answer each health probe with `response`, or
    /// never answer when `None` (a server too busy to respond).
    async fn serve_health(listener: tokio::net::TcpListener, response: Option<&'static str>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                match response {
                    Some(text) => {
                        let _ = stream.write_all(text.as_bytes()).await;
                        let _ = stream.flush().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            });
        }
    }

    async fn probe_against(response: Option<&'static str>, timeout: Duration) -> ProbeOutcome {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_health(listener, response));
        let outcome = probe_remote_health(
            proxy_http_client_builder().build().unwrap(),
            format!("http://{addr}/"),
            "token".into(),
            HeaderMap::new(),
            timeout,
        )
        .await;
        server.abort();
        outcome
    }

    #[tokio::test]
    async fn health_probe_tells_a_live_server_from_a_failing_or_silent_one() {
        let ok = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
        let down = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let expired = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        assert_eq!(probe_against(Some(ok), secs(5)).await, ProbeOutcome::Alive);
        assert_eq!(
            probe_against(Some(down), secs(5)).await,
            ProbeOutcome::Unreachable
        );
        assert_eq!(
            probe_against(Some(expired), secs(5)).await,
            ProbeOutcome::Unreachable
        );
        assert_eq!(
            probe_against(None, Duration::from_millis(300)).await,
            ProbeOutcome::TimedOut
        );
        // Nothing listening at all.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = closed.local_addr().unwrap();
        drop(closed);
        let outcome = probe_remote_health(
            proxy_http_client_builder().build().unwrap(),
            format!("http://{addr}"),
            "token".into(),
            HeaderMap::new(),
            secs(5),
        )
        .await;
        assert_eq!(outcome, ProbeOutcome::Unreachable);
    }

    // ─── Handshake failure classification ───────────────────────────────

    #[test]
    fn only_a_401_on_the_upgrade_ends_the_retries() {
        use tokio_tungstenite::tungstenite::{http, Error};
        let http_err =
            |status: u16| Error::Http(http::Response::builder().status(status).body(None).unwrap());
        assert!(matches!(
            WsConnectError::from(http_err(401)),
            WsConnectError::Unauthorized
        ));
        // A refusal that says nothing about this token, a proxy, or a server
        // mid-restart: try again.
        for status in [403, 502, 404] {
            assert!(matches!(
                WsConnectError::from(http_err(status)),
                WsConnectError::Retryable(_)
            ));
        }
        // Below HTTP nothing is known about the token (Wi-Fi still coming
        // back after wake, server down for an upgrade).
        let io = Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        ));
        assert!(matches!(
            WsConnectError::from(io),
            WsConnectError::Retryable(_)
        ));
    }

    #[test]
    fn ws_event_name_is_scoped_to_connection_and_webview() {
        // Same literal the transport tests pin on the listening side.
        assert_eq!(
            remote_ws_event_name(17, "main-webview"),
            "remote-ws-event-17-main-webview"
        );
        assert_ne!(
            remote_ws_event_name(7, "remote-webview-a"),
            remote_ws_event_name(7, "remote-webview-b")
        );
    }

    // ─── Host pinning for credential-carrying requests ──────────────────
    //
    // Both of these guard the same thing from two directions: the custom
    // headers on a remote connection are credentials, and neither the remote
    // nor a redirect it issues gets to choose which host receives them.

    #[test]
    fn ticket_url_resolves_a_path_against_the_connection() {
        // The only shape `codeg-server` actually returns.
        assert_eq!(
            absolute_remote_ticket_url("https://box.example", "/api/workspace_download/t1")
                .unwrap(),
            "https://box.example/api/workspace_download/t1"
        );
        // A base with a path prefix keeps it — this is why the resolution is
        // string concatenation and not `Url::join`, which would drop `/codeg`.
        assert_eq!(
            absolute_remote_ticket_url("https://box.example/codeg", "/api/workspace_download/t1")
                .unwrap(),
            "https://box.example/codeg/api/workspace_download/t1"
        );
        assert_eq!(
            absolute_remote_ticket_url("https://box.example/", "api/workspace_download/t1")
                .unwrap(),
            "https://box.example/api/workspace_download/t1"
        );
        // Absolute, but still the connection's own host: allowed.
        assert_eq!(
            absolute_remote_ticket_url("https://box.example", "https://box.example/dl/t1").unwrap(),
            "https://box.example/dl/t1"
        );
    }

    #[test]
    fn ticket_url_refuses_a_host_the_connection_did_not_name() {
        for ticket in [
            "https://evil.example/dl/t1",
            // Same host, different port — a different server.
            "https://box.example:8443/dl/t1",
            // Same host, downgraded scheme.
            "http://box.example/dl/t1",
        ] {
            let err = absolute_remote_ticket_url("https://box.example", ticket)
                .expect_err("ticket url should be refused: {ticket}");
            assert!(
                err.message.contains("outside the connection"),
                "unexpected message for {ticket}: {}",
                err.message
            );
        }

        // The case a host-and-port test alone would wave through: identical
        // explicit port, scheme downgraded, so the credentials would have gone
        // out in plaintext. `reqwest`'s own strip rule has this blind spot.
        assert!(
            absolute_remote_ticket_url("https://box.example:8443", "http://box.example:8443/dl/t1")
                .is_err(),
            "a plaintext downgrade on the same port must be refused"
        );
    }

    /// Accept `responses.len()` connections in order, answering each with the
    /// matching canned response. Returns the raw request text of each, so a
    /// test can assert on the headers that actually arrived.
    async fn serve_sequence(
        listener: tokio::net::TcpListener,
        responses: Vec<String>,
    ) -> Vec<String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut requests = Vec::with_capacity(responses.len());
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            requests.push(String::from_utf8_lossy(&buf[..n]).to_string());
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
        }
        requests
    }

    fn redirect_to(location: &str) -> String {
        // `Connection: close` so the follow-up hop opens a fresh connection and
        // lands on the next `accept()` rather than being pipelined onto this one.
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\
             Connection: close\r\n\r\n"
        )
    }

    fn ok_response() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
    }

    #[tokio::test]
    async fn redirect_to_another_host_never_delivers_the_custom_header() {
        // Two loopback ports are two origins, so this is the cross-host case.
        let hop = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let elsewhere = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hop_addr = hop.local_addr().unwrap();
        let elsewhere_addr = elsewhere.local_addr().unwrap();

        let hop_task = tokio::spawn(serve_sequence(
            hop,
            vec![redirect_to(&format!("http://{elsewhere_addr}/next"))],
        ));
        let elsewhere_task = tokio::spawn(serve_sequence(elsewhere, vec![ok_response()]));

        let client = reqwest::Client::builder()
            .redirect(connection_redirect_policy())
            // Hermetic: this box has HTTP_PROXY set, and reqwest does not
            // bypass loopback for it. Without this the request reaches the
            // proxy instead of the test server, which answers 502 — an error,
            // so the cross-host case would pass for entirely the wrong reason.
            .no_proxy()
            .build()
            .unwrap();
        let err = client
            .get(format!("http://{hop_addr}/start"))
            .header("X-Access-Secret", "s3cret")
            .send()
            .await
            .expect_err("a redirect off the connection host must not be followed");
        assert!(err.is_redirect(), "expected a redirect error, got: {err}");
        // reqwest's own Display is just "error following redirect for url (…)",
        // so this also pins that the reason survives into what the UI renders.
        let detail = request_error_detail(&err);
        assert!(
            detail.contains("refused a redirect off")
                && detail.contains(&elsewhere_addr.to_string()),
            "the refusal reason must reach the caller: {detail}"
        );

        let hop_request = hop_task.await.unwrap().remove(0);
        assert!(
            hop_request.contains("s3cret"),
            "the configured host should still receive the header: {hop_request}"
        );

        // Nothing ever connected to the second host, so its `accept()` is still
        // pending. That, rather than an assertion on headers it never saw, is
        // the proof the credential stayed put.
        elsewhere_task.abort();
        assert!(
            elsewhere_task.await.unwrap_err().is_cancelled(),
            "the redirect target received a request"
        );
    }

    #[tokio::test]
    async fn redirect_within_the_same_host_still_follows_and_keeps_the_header() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_sequence(
            listener,
            vec![redirect_to("/next"), ok_response()],
        ));

        let client = reqwest::Client::builder()
            .redirect(connection_redirect_policy())
            // Hermetic: this box has HTTP_PROXY set, and reqwest does not
            // bypass loopback for it. Without this the request reaches the
            // proxy instead of the test server, which answers 502 — an error,
            // so the cross-host case would pass for entirely the wrong reason.
            .no_proxy()
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{addr}/start"))
            .header("X-Access-Secret", "s3cret")
            .send()
            .await
            .expect("a same-host redirect should still be followed");
        assert!(response.status().is_success());

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2, "the redirect should have been followed");
        assert!(requests[1].starts_with("GET /next"), "got: {}", requests[1]);
        assert!(
            requests[1].contains("s3cret"),
            "the header must survive a same-host hop: {}",
            requests[1]
        );
    }

    // ─── Remote API calls whose answer is cut off ──────────────────────

    /// Headers promising an 11-byte body, then only five of its bytes before
    /// the connection closes: a server restarting mid-response.
    fn cut_off_response() -> String {
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\
         Connection: close\r\n\r\n{\"ok\""
            .to_string()
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Hermetic: this box has HTTP_PROXY set, and reqwest does not bypass
    /// loopback for it.
    fn loopback_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[test]
    fn only_list_and_get_commands_count_as_reads() {
        assert!(is_read_only_command("list_all_conversations"));
        assert!(is_read_only_command("/get_conversation"));
        assert!(!is_read_only_command("update_conversation_title"));
        assert!(!is_read_only_command("delete_conversation"));
        assert!(!is_read_only_command("acp_prompt"));
        // A prefix has to start the name, not just appear in it.
        assert!(!is_read_only_command("forget_list_cache"));
    }

    #[tokio::test]
    async fn a_cut_off_answer_says_so_and_keeps_the_reason() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // One connection only: a resend would find the port closed and fail
        // with a different message, so the message below also proves that a
        // command that may change state is never sent twice.
        let server = tokio::spawn(serve_sequence(listener, vec![cut_off_response()]));
        let client = loopback_client();
        let url = format!("http://{addr}/api/delete_conversation");

        let err = send_remote_api_call("delete_conversation", || client.get(&url))
            .await
            .expect_err("half a body is not an answer");

        assert_eq!(err.code, AppErrorCode::NetworkError);
        assert_eq!(err.message, REMOTE_RESPONSE_INTERRUPTED);
        // reqwest's own text for this is the bare "error decoding response
        // body"; the cause chain after it is what says what happened.
        let detail = err.detail.expect("a detail");
        assert!(
            detail.starts_with("error decoding response body: ") && detail.len() > 30,
            "the cause chain must reach the caller: {detail}"
        );
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_read_cut_off_mid_answer_is_sent_once_more() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_sequence(
            listener,
            vec![cut_off_response(), json_response("{\"ok\":true}")],
        ));
        let client = loopback_client();
        let url = format!("http://{addr}/api/list_all_conversations");

        let value = send_remote_api_call("list_all_conversations", || client.get(&url))
            .await
            .expect("the second answer arrives whole");

        assert_eq!(value, serde_json::json!({ "ok": true }));
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_read_is_sent_at_most_twice() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Two cut-off answers, then the port closes: a third send would fail
        // to connect and report "Remote HTTP request failed" instead.
        let server = tokio::spawn(serve_sequence(
            listener,
            vec![cut_off_response(), cut_off_response()],
        ));
        let client = loopback_client();
        let url = format!("http://{addr}/api/get_conversation");

        let err = send_remote_api_call("get_conversation", || client.get(&url))
            .await
            .expect_err("both answers were cut off");

        assert_eq!(err.message, REMOTE_RESPONSE_INTERRUPTED);
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_whole_answer_that_is_not_json_is_a_parse_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_sequence(listener, vec![json_response("<html>")]));
        let client = loopback_client();
        let url = format!("http://{addr}/api/list_all_conversations");

        let err = send_remote_api_call("list_all_conversations", || client.get(&url))
            .await
            .expect_err("HTML is not the JSON the call expects");

        // The link worked, so this is not the interrupted case, and it is not
        // resent: the same server would send the same body again.
        assert_eq!(err.code, AppErrorCode::NetworkError);
        assert_eq!(err.message, "Failed to parse remote response");
        let detail = err.detail.expect("a detail");
        assert!(detail.ends_with("(6 bytes)"), "got: {detail}");
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[test]
    fn http_url_to_ws_url_http() {
        assert_eq!(
            http_url_to_ws_url("http://localhost:8080", "/ws/events"),
            "ws://localhost:8080/ws/events"
        );
    }

    #[test]
    fn http_url_to_ws_url_https_trailing_slash() {
        assert_eq!(
            http_url_to_ws_url("https://example.com/", "/ws/events"),
            "wss://example.com/ws/events"
        );
    }

    #[test]
    fn http_url_to_ws_url_unknown_scheme() {
        // tungstenite will reject this, but our helper passes it through.
        assert_eq!(
            http_url_to_ws_url("ftp://example.com", "/ws/events"),
            "ftp://example.com/ws/events"
        );
    }

    #[test]
    fn partial_download_path_is_unique_sibling() {
        let path = partial_download_path("/tmp/out.zip", "abc");
        assert_eq!(path, "/tmp/out.zip.codeg-download-abc.part");
    }

    #[tokio::test]
    async fn write_response_stream_to_partial_removes_partial_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("out.bin");
        let stream = futures::stream::iter([
            Ok(Bytes::from_static(b"partial")),
            Err(AppCommandError::network("simulated stream failure")),
        ]);

        let err = write_response_stream_to_partial(
            stream,
            &save_path.to_string_lossy(),
            "test-transfer",
            CancellationToken::new(),
            Duration::from_secs(30),
            |_| {},
        )
        .await
        .unwrap_err();

        assert!(err.message.contains("simulated"));
        let partial = partial_download_path(&save_path.to_string_lossy(), "test-transfer");
        assert!(!Path::new(&partial).exists());
        assert!(!save_path.exists());
    }

    #[tokio::test]
    async fn write_response_stream_to_partial_reports_progress_and_finalizes() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("out.bin");
        let stream = futures::stream::iter([
            Ok(Bytes::from_static(b"abc")),
            Ok(Bytes::from_static(b"defg")),
        ]);
        let mut seen = Vec::new();
        let bytes = write_response_stream_to_partial(
            stream,
            &save_path.to_string_lossy(),
            "ok-transfer",
            CancellationToken::new(),
            Duration::from_secs(30),
            |loaded| seen.push(loaded),
        )
        .await
        .unwrap();
        assert_eq!(bytes, 7);
        assert_eq!(seen, vec![3, 7]);
        assert_eq!(std::fs::read(&save_path).unwrap(), b"abcdefg");
    }

    #[tokio::test]
    async fn write_response_stream_to_partial_fails_a_stalled_stream() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("out.bin");
        let stream = futures::stream::iter([Ok(Bytes::from_static(b"head"))])
            .chain(futures::stream::pending());
        let err = write_response_stream_to_partial(
            Box::pin(stream),
            &save_path.to_string_lossy(),
            "stalled-transfer",
            CancellationToken::new(),
            Duration::from_millis(50),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("stalled"));
        let partial = partial_download_path(&save_path.to_string_lossy(), "stalled-transfer");
        assert!(!Path::new(&partial).exists());
        assert!(!save_path.exists());
    }

    #[tokio::test]
    async fn write_response_stream_to_partial_stops_on_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("out.bin");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let stream = futures::stream::pending::<Result<Bytes, AppCommandError>>();
        let err = write_response_stream_to_partial(
            Box::pin(stream),
            &save_path.to_string_lossy(),
            "cancelled-transfer",
            cancel,
            Duration::from_secs(30),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.message.contains("cancelled"));
        assert!(!save_path.exists());
    }

    #[tokio::test]
    async fn unless_cancelled_short_circuits_a_pending_phase() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result: Result<(), AppCommandError> =
            unless_cancelled(&cancel, std::future::pending()).await;
        assert!(result.unwrap_err().message.contains("cancelled"));

        let live = CancellationToken::new();
        let value = unless_cancelled(&live, async { Ok::<_, AppCommandError>(5) })
            .await
            .unwrap();
        assert_eq!(value, 5);
    }

    #[tokio::test]
    async fn stale_unsubscribe_only_removes_its_own_subscription() {
        let proxy = Arc::new(RemoteProxyState::new());
        let entry = test_entry(HashMap::from([
            (
                "old-sub".to_string(),
                subscriber("remote-workspace-1", "old"),
            ),
            (
                "new-sub".to_string(),
                subscriber("remote-workspace-1", "new"),
            ),
        ]));
        proxy.tasks.lock().await.insert(1, entry.clone());

        proxy.remove_subscription(1, "old-sub").await;

        let subscribers = entry.subscribers.lock().await;
        assert!(!subscribers.contains_key("old-sub"));
        assert!(subscribers.contains_key("new-sub"));
        drop(subscribers);
        assert!(proxy.tasks.lock().await.contains_key(&1));
    }

    #[tokio::test]
    async fn window_instance_cleanup_preserves_reused_label_with_new_instance() {
        let proxy = Arc::new(RemoteProxyState::new());
        let entry = test_entry(HashMap::from([
            (
                "old-sub".to_string(),
                subscriber("remote-workspace-1", "old"),
            ),
            (
                "new-sub".to_string(),
                subscriber("remote-workspace-1", "new"),
            ),
            (
                "other-label".to_string(),
                subscriber("remote-settings-1", "settings"),
            ),
        ]));
        proxy.tasks.lock().await.insert(1, entry.clone());

        proxy
            .mark_window_instance_destroyed("remote-workspace-1", "old")
            .await;

        let subscribers = entry.subscribers.lock().await;
        assert!(!subscribers.contains_key("old-sub"));
        assert!(subscribers.contains_key("new-sub"));
        assert!(subscribers.contains_key("other-label"));
        drop(subscribers);
        assert!(proxy.tasks.lock().await.contains_key(&1));
    }

    #[tokio::test]
    async fn window_instance_cleanup_tombstones_and_shuts_down_empty_task() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (outbound_tx, _outbound_rx) = mpsc::channel::<String>(8);
        let entry = Arc::new(WsTaskEntry {
            subscribers: Mutex::new(HashMap::from([(
                "sub".to_string(),
                subscriber("remote-workspace-1", "dead"),
            )])),
            ready: RwLock::new(false),
            shutdown_tx,
            outbound_tx,
            probe: Notify::new(),
            streaming: std::sync::Mutex::new(HashSet::new()),
            streaming_changed: Notify::new(),
        });
        proxy.tasks.lock().await.insert(1, entry);

        proxy
            .mark_window_instance_destroyed("remote-workspace-1", "dead")
            .await;

        assert!(proxy
            .destroyed_window_instances
            .lock()
            .await
            .contains("dead"));
        assert!(!proxy.tasks.lock().await.contains_key(&1));
        assert!(*shutdown_rx.borrow());
    }

    // ─── remote_ws_send_text failure surfacing ─────────────────────────
    //
    // Pre-fix, this command silently returned Ok(()) on no-entry / queue-
    // full so a dropped attach frame would leave the JS-side subscription
    // stuck waiting for a snapshot that never came. The tests pin the
    // contract that every drop path now surfaces NetworkError so the JS
    // reattach-on-failure loop can recover.
    //
    // For a description of the user-visible failure mode this protects
    // against, see the comment on `remote_ws_send_text` in this file.
    fn entry_with_outbound(capacity: usize) -> (Arc<WsTaskEntry>, mpsc::Receiver<String>) {
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        let (outbound_tx, outbound_rx) = mpsc::channel::<String>(capacity);
        let entry = Arc::new(WsTaskEntry {
            subscribers: Mutex::new(HashMap::new()),
            ready: RwLock::new(false),
            shutdown_tx,
            outbound_tx,
            probe: Notify::new(),
            streaming: std::sync::Mutex::new(HashSet::new()),
            streaming_changed: Notify::new(),
        });
        (entry, outbound_rx)
    }

    #[tokio::test]
    async fn send_text_no_entry_returns_network_error() {
        let proxy = Arc::new(RemoteProxyState::new());
        let err = remote_ws_send_text_core(&proxy, 42, "hi".to_string())
            .await
            .expect_err("expected Err when no entry exists");
        assert!(matches!(err.code, AppErrorCode::NetworkError));
        assert!(
            err.message.contains("not active"),
            "message should mention 'not active', got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn send_text_happy_path_delivers_to_receiver() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (entry, mut outbound_rx) = entry_with_outbound(8);
        proxy.tasks.lock().await.insert(7, entry);

        remote_ws_send_text_core(&proxy, 7, "hello".to_string())
            .await
            .expect("send should succeed");

        let received = outbound_rx.recv().await.expect("frame should arrive");
        assert_eq!(received, "hello");
    }

    #[tokio::test]
    async fn send_text_closed_channel_returns_network_error() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (entry, outbound_rx) = entry_with_outbound(8);
        proxy.tasks.lock().await.insert(7, entry);
        // Drop the receiver — outbound_tx.send will fail with SendError
        // once try_send / send observes the closed channel.
        drop(outbound_rx);

        let err = remote_ws_send_text_core(&proxy, 7, "hi".to_string())
            .await
            .expect_err("expected Err when channel closed");
        assert!(matches!(err.code, AppErrorCode::NetworkError));
        assert!(
            err.message.contains("closed"),
            "message should mention 'closed', got: {}",
            err.message
        );
    }

    #[tokio::test(start_paused = true)]
    async fn send_text_queue_full_times_out() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (entry, _outbound_rx) = entry_with_outbound(1);
        proxy.tasks.lock().await.insert(7, entry);

        // Fill the single-slot queue so the next send must wait.
        remote_ws_send_text_core(&proxy, 7, "first".to_string())
            .await
            .expect("first send fits the buffer");

        let send_fut = remote_ws_send_text_core(&proxy, 7, "second".to_string());
        // Advance virtual time past OUTBOUND_SEND_TIMEOUT so the inner
        // tokio::time::timeout fires deterministically without the test
        // actually sleeping.
        let advance = OUTBOUND_SEND_TIMEOUT + Duration::from_millis(100);
        let (res, _) = tokio::join!(send_fut, async {
            tokio::time::sleep(advance).await;
        });

        let err = res.expect_err("queue-full second send should time out");
        assert!(matches!(err.code, AppErrorCode::NetworkError));
        assert!(
            err.message.contains("timed out"),
            "message should mention 'timed out', got: {}",
            err.message
        );
    }

    struct TestSocketLoop {
        frames: mpsc::UnboundedReceiver<Value>,
        task: tokio::task::JoinHandle<()>,
        shutdown: watch::Sender<bool>,
        outbound: mpsc::Sender<String>,
    }

    fn test_ws_target(url: String) -> WsTarget {
        WsTarget {
            base_url: test_base_url(&url),
            url,
            token: "private-token-sentinel".into(),
            headers: HeaderMap::new(),
        }
    }

    /// The HTTP base a test socket URL (`ws://{address}/ws/events`) belongs
    /// to: where the heartbeat's health probe goes.
    fn test_base_url(ws_url: &str) -> String {
        ws_url
            .replacen("ws://", "http://", 1)
            .trim_end_matches(WS_EVENTS_PATH)
            .to_string()
    }

    /// A loop whose connection is never edited: every retry dials `url`.
    fn start_test_socket_loop(url: String) -> TestSocketLoop {
        start_test_socket_loop_with(test_ws_target(url), |last| std::future::ready(Some(last)))
    }

    fn start_test_socket_loop_with<R, RFut>(target: WsTarget, refresh_target: R) -> TestSocketLoop
    where
        R: FnMut(WsTarget) -> RFut + Send + 'static,
        RFut: Future<Output = Option<WsTarget>> + Send,
    {
        let (entry, mut outbound_rx) = entry_with_outbound(8);
        let outbound = entry.outbound_tx.clone();
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (tx, frames) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            run_ws_connection(
                target,
                refresh_target,
                &entry,
                &reqwest::Client::new(),
                &mut shutdown_rx,
                &mut outbound_rx,
                |frame| {
                    let _ = tx.send(frame);
                    std::future::ready(())
                },
            )
            .await;
        });
        TestSocketLoop {
            frames,
            task,
            shutdown,
            outbound,
        }
    }

    async fn next_test_frame(frames: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(30), frames.recv())
            .await
            .expect("proxy should deliver a frame")
            .expect("proxy must stay alive")
    }

    // tungstenite fixes the handshake callback's error type to an HTTP response.
    #[allow(clippy::result_large_err)]
    async fn accept_test_socket(
        stream: tokio::net::TcpStream,
    ) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
        tokio_tungstenite::accept_hdr_async(stream, |_: &Request, mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            response.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_static(WS_EVENT_PROTOCOL));
            Ok(response)
        }).await.unwrap()
    }

    async fn read_test_handshake(stream: &mut tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
            assert!(request.len() <= 8192, "test handshake must be bounded");
        }
    }

    #[tokio::test]
    async fn ws_loop_recovers_after_more_than_three_transient_failures() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..5 {
                let (mut stream, _) = listener.accept().await.unwrap();
                if (1..=3).contains(&attempt) {
                    read_test_handshake(&mut stream).await;
                    stream
                        .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                    continue;
                }
                let mut socket = accept_test_socket(stream).await;
                socket
                    .send(Message::Text(
                        lifecycle_frame(WS_READY_CHANNEL).to_string().into(),
                    ))
                    .await
                    .unwrap();
                if attempt == 0 {
                    socket.close(None).await.unwrap();
                    continue;
                }
                // A renewed attach must reach the recovered socket, then
                // snapshots and subsequent conversation events flow again.
                let attach = socket.next().await.unwrap().unwrap();
                assert!(matches!(attach, Message::Text(text) if text.contains("session-1")));
                for frame in [
                    serde_json::json!({"type": "replay", "events": [{"seq": 11}]}),
                    serde_json::json!({"type": "event", "envelope": {"seq": 12}}),
                ] {
                    socket
                        .send(Message::Text(frame.to_string().into()))
                        .await
                        .unwrap();
                }
                // Hold the recovered socket until the test shuts down.
                while socket.next().await.is_some() {}
            }
        });
        let mut client = start_test_socket_loop(format!("ws://{address}/ws/events"));
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_READY_CHANNEL
        );
        let mut disconnects = 0;
        loop {
            let frame = next_test_frame(&mut client.frames).await;
            assert_ne!(frame["channel"], WS_UNAUTHORIZED_CHANNEL);
            if frame["channel"] == WS_READY_CHANNEL {
                break;
            }
            if frame["channel"] == WS_DISCONNECTED_CHANNEL {
                disconnects += 1;
            }
        }
        assert!(
            disconnects >= 4,
            "the proxy must survive the old three-failure cutoff"
        );
        client
            .outbound
            .send(r#"{"action":"attach","connection_id":"session-1","since_seq":10}"#.into())
            .await
            .unwrap();
        assert_eq!(next_test_frame(&mut client.frames).await["type"], "replay");
        assert_eq!(
            next_test_frame(&mut client.frames).await["envelope"]["seq"],
            12
        );
        client.shutdown.send(true).unwrap();
        client.task.await.unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ws_loop_stops_on_401_and_sanitizes_handshake_diagnostics() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_test_handshake(&mut stream).await;
            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nX-Echo: private-token-sentinel\r\n\r\n").await.unwrap();
        });
        let mut client = start_test_socket_loop(format!("ws://{address}/ws/events"));
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_UNAUTHORIZED_CHANNEL
        );
        client.task.await.unwrap();
        server.await.unwrap();
        assert!(client.frames.recv().await.is_none());

        for status in [401, 403, 503] {
            let response = tokio_tungstenite::tungstenite::http::Response::builder()
                .status(status)
                .header("x-echo", "private-token-sentinel")
                .body(Some(b"private-token-sentinel".to_vec()))
                .unwrap();
            let error = WsConnectError::from(WsError::Http(response));
            assert_eq!(matches!(error, WsConnectError::Unauthorized), status == 401);
            assert!(!error.to_string().contains("private-token-sentinel"));
            assert!(!format!("{error:?}").contains("private-token-sentinel"));
        }
    }

    #[tokio::test]
    async fn ws_loop_recovers_a_half_open_socket_and_cancels_backoff_on_shutdown() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_test_socket(stream).await;
            socket
                .send(Message::Text(
                    lifecycle_frame(WS_READY_CHANNEL).to_string().into(),
                ))
                .await
                .unwrap();
            // Keep TCP open while withholding all WS traffic, including pongs.
            std::future::pending::<()>().await;
            drop(socket);
        });
        let mut client = start_test_socket_loop(format!("ws://{address}/ws/events"));
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_READY_CHANNEL
        );
        tokio::time::pause();
        // Past the quiet interval the heartbeat pings. No pong comes back, and
        // the health probe gets no answer either (the server holds its
        // listener without serving it), so the socket is presumed dead.
        tokio::time::advance(WS_HEARTBEAT_INTERVAL).await;
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_DISCONNECTED_CHANNEL
        );
        client.shutdown.send(true).unwrap();
        client.task.await.unwrap();
        server.abort();
    }

    /// The connection is edited to a new address, token and headers while its
    /// socket is down, then deleted: the retry dials the edited connection,
    /// and the deletion ends the loop without claiming the token expired.
    #[tokio::test]
    async fn ws_loop_retries_follow_the_stored_connection_until_it_is_deleted() {
        /// Accept one socket and say ready, as a server that refuses with 401
        /// any dial not carrying `token` and `x-codeg-target: {target}`; refuse
        /// every later dial; close the socket when told to.
        // tungstenite fixes the handshake callback's error type to an HTTP response.
        #[allow(clippy::result_large_err)]
        async fn serve_once(
            listener: tokio::net::TcpListener,
            token: &'static str,
            target: &'static str,
            close: tokio::sync::oneshot::Receiver<()>,
        ) {
            let (stream, _) = listener.accept().await.unwrap();
            drop(listener);
            let offered = format!(
                "{WS_TOKEN_PROTOCOL_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(token)
            );
            let accepted = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &Request,
                      mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    let header = |name: &str| {
                        request
                            .headers()
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned()
                    };
                    if !header("sec-websocket-protocol").contains(&offered)
                        || header("x-codeg-target") != target
                    {
                        return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                            .status(401)
                            .body(None)
                            .unwrap());
                    }
                    response.headers_mut().insert(
                        "sec-websocket-protocol",
                        HeaderValue::from_static(WS_EVENT_PROTOCOL),
                    );
                    Ok(response)
                },
            )
            .await;
            let Ok(mut socket) = accepted else {
                return;
            };
            socket
                .send(Message::Text(
                    lifecycle_frame(WS_READY_CHANNEL).to_string().into(),
                ))
                .await
                .unwrap();
            let _ = close.await;
            socket.close(None).await.unwrap();
        }

        fn stored_target(url: String, token: &str, target: &'static str) -> WsTarget {
            let mut headers = HeaderMap::new();
            headers.insert("x-codeg-target", HeaderValue::from_static(target));
            WsTarget {
                base_url: test_base_url(&url),
                url,
                token: token.into(),
                headers,
            }
        }

        let old = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let new = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let old_url = format!("ws://{}/ws/events", old.local_addr().unwrap());
        let new_url = format!("ws://{}/ws/events", new.local_addr().unwrap());
        let (close_old, close_old_rx) = tokio::sync::oneshot::channel();
        let (close_new, close_new_rx) = tokio::sync::oneshot::channel();
        let old_server = tokio::spawn(serve_once(old, "old-token", "old", close_old_rx));
        let new_server = tokio::spawn(serve_once(new, "new-token", "new", close_new_rx));

        // What the database holds: the loop was spawned on the old connection,
        // and the user has since pointed it at a new address with a new token
        // and headers. A retry carrying any old credential gets a 401.
        let stored = Arc::new(std::sync::Mutex::new(Some(stored_target(
            new_url,
            "new-token",
            "new",
        ))));
        let lookup = stored.clone();
        let mut client =
            start_test_socket_loop_with(stored_target(old_url, "old-token", "old"), move |_| {
                std::future::ready(lookup.lock().unwrap().clone())
            });
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_READY_CHANNEL
        );
        close_old.send(()).unwrap();
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_DISCONNECTED_CHANNEL
        );
        // The old address now refuses, so only the edited one can say ready.
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_READY_CHANNEL
        );

        *stored.lock().unwrap() = None;
        close_new.send(()).unwrap();
        assert_eq!(
            next_test_frame(&mut client.frames).await["channel"],
            WS_DISCONNECTED_CHANNEL
        );
        tokio::time::timeout(Duration::from_secs(30), client.task)
            .await
            .expect("a deleted connection ends the loop")
            .unwrap();
        // Nothing after that disconnect, in particular no `__unauthorized__`.
        assert!(client.frames.recv().await.is_none());
        old_server.await.unwrap();
        new_server.await.unwrap();
    }

    #[tokio::test]
    async fn a_retry_target_is_the_connection_as_stored_now() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let created = remote_workspace_connection_service::create(
            &db.conn,
            "box",
            "http://old.example:3080",
            "old-token",
            &[],
        )
        .await
        .unwrap();
        let initial = WsTarget::of(&created);
        assert_eq!(initial.url, "ws://old.example:3080/ws/events");

        remote_workspace_connection_service::update(
            &db.conn,
            created.id,
            "box",
            "https://new.example",
            "new-token",
            &[],
        )
        .await
        .unwrap();
        let current = stored_ws_target(db.conn.clone(), created.id, initial.clone())
            .await
            .expect("a stored connection has a target");
        assert_eq!(current.url, "wss://new.example/ws/events");
        assert_eq!(current.token, "new-token");

        // A lookup that fails keeps dialing the last address it found.
        let closed = crate::db::test_helpers::fresh_in_memory_db().await;
        closed.conn.close_by_ref().await.unwrap();
        let kept = stored_ws_target(closed.conn.clone(), created.id, current.clone())
            .await
            .expect("a failed lookup keeps the last target");
        assert_eq!(kept.url, current.url);

        remote_workspace_connection_service::delete(&db.conn, created.id)
            .await
            .unwrap();
        assert!(stored_ws_target(db.conn.clone(), created.id, current)
            .await
            .is_none());
    }

    // ─── Dialing the remote host ───────────────────────────────────────

    /// Answers every name with these addresses, in this order: the DNS answer
    /// a test needs, where the system resolver gives this machine's own.
    #[derive(Clone)]
    struct FixedResolver(Vec<std::net::SocketAddr>);

    impl Service<hyper_util::client::legacy::connect::dns::Name> for FixedResolver {
        type Response = std::vec::IntoIter<std::net::SocketAddr>;
        type Error = std::io::Error;
        type Future = std::future::Ready<Result<Self::Response, Self::Error>>;

        fn poll_ready(
            &mut self,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn call(&mut self, _: hyper_util::client::legacy::connect::dns::Name) -> Self::Future {
            std::future::ready(Ok(self.0.clone().into_iter()))
        }
    }

    /// Accepts one event socket, greets it with `__ready__`, holds it open.
    fn serve_ready_socket(listener: tokio::net::TcpListener) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_test_socket(stream).await;
            socket
                .send(Message::Text(
                    lifecycle_frame(WS_READY_CHANNEL).to_string().into(),
                ))
                .await
                .unwrap();
            while socket.next().await.is_some() {}
        })
    }

    async fn expect_ready(socket: &mut RemoteWsSocket) {
        let frame = tokio::time::timeout(Duration::from_secs(30), socket.next())
            .await
            .expect("the server greets the socket")
            .expect("the socket stays open")
            .expect("a frame arrives");
        assert!(matches!(frame, Message::Text(text) if text.contains(WS_READY_CHANNEL)));
    }

    /// Wait for a [`serve_ready_socket`] task once its client has hung up.
    async fn finish(server: tokio::task::JoinHandle<()>) {
        tokio::time::timeout(Duration::from_secs(30), server)
            .await
            .expect("the server sees the client hang up")
            .unwrap();
    }

    /// #930: Windows resolves `localhost` to `::1` first, and WSL's mirrored
    /// networking never answers a SYN from Windows to it. The event socket has
    /// to go on to the address that does answer — as the connection's HTTP
    /// calls always did — instead of spending its whole timeout on the first.
    #[tokio::test]
    async fn an_event_socket_gets_past_an_address_that_never_answers() {
        let Ok(listener) = tokio::net::TcpListener::bind("[::1]:0").await else {
            eprintln!("skipped: no IPv6 loopback to serve the answering address on");
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let server = serve_ready_socket(listener);
        // TEST-NET-1 (RFC 5737) plays `::1`'s part: it is routed nowhere, so a
        // SYN to it normally goes unanswered. A network that rejects it at
        // once lets a dial without the race through as well; this test tells
        // the two apart wherever the SYN is dropped instead.
        let silent = std::net::SocketAddr::from(([192, 0, 2, 1], port));
        let answering = std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port));
        let connector = HttpConnector::new_with_resolver(FixedResolver(vec![silent, answering]));
        let request = ws_request_with_subprotocol_auth(
            &format!("ws://wsl.test:{port}{WS_EVENTS_PATH}"),
            WS_EVENT_PROTOCOL,
            "private-token-sentinel",
            &HeaderMap::new(),
        )
        .unwrap();

        let (mut socket, _) = tokio::time::timeout(
            WS_CONNECT_TIMEOUT,
            connect_remote_ws_via(connector, request),
        )
        .await
        .expect("the dial must not spend its whole timeout on the silent address")
        .expect("the answering address accepts the socket");
        expect_ready(&mut socket).await;
        drop(socket);
        finish(server).await;
    }

    /// The dial takes the host as the URL writes it: a name goes to the system
    /// resolver, and an IPv6 literal keeps the brackets its address needs.
    #[tokio::test]
    async fn an_event_socket_dials_a_host_name_and_an_ipv6_literal() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_ready_socket(listener);
        let mut socket = connect_with_subprotocol_auth(
            &format!("ws://localhost:{port}{WS_EVENTS_PATH}"),
            WS_EVENT_PROTOCOL,
            "private-token-sentinel",
            &HeaderMap::new(),
        )
        .await
        .expect("`localhost` reaches a server on 127.0.0.1");
        expect_ready(&mut socket).await;
        drop(socket);
        finish(server).await;

        let Ok(listener) = tokio::net::TcpListener::bind("[::1]:0").await else {
            eprintln!("skipped the IPv6 literal: no IPv6 loopback");
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let server = serve_ready_socket(listener);
        let mut socket = connect_with_subprotocol_auth(
            &format!("ws://[::1]:{port}{WS_EVENTS_PATH}"),
            WS_EVENT_PROTOCOL,
            "private-token-sentinel",
            &HeaderMap::new(),
        )
        .await
        .expect("a bracketed IPv6 literal is dialed as that address");
        expect_ready(&mut socket).await;
        drop(socket);
        finish(server).await;
    }

    /// The connector only labels a failed dial; the log line still names the
    /// I/O error's kind, as it did when tungstenite dialed.
    #[tokio::test]
    async fn a_refused_event_socket_names_its_io_error_kind() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = connect_with_subprotocol_auth(
            &format!("ws://{address}{WS_EVENTS_PATH}"),
            WS_EVENT_PROTOCOL,
            "private-token-sentinel",
            &HeaderMap::new(),
        )
        .await
        .expect_err("nothing listens there any more");
        assert_eq!(
            error.to_string(),
            "WebSocket I/O error (connection refused)"
        );
    }

    // ─── i18n key wire-format tripwire ─────────────────────────────────
    //
    // The frontend branches on these exact literal strings. If anyone
    // renames the Rust constants without updating the TS side
    // (`UPLOAD_I18N_KEY_*` in `src/lib/api.ts`), the test still passes
    // but runtime degrades silently — that's why we pin the literals
    // here instead of asserting `KEY == KEY`. CI will fail loudly the
    // moment somebody touches one side, forcing the lockstep edit.

    #[test]
    fn upload_i18n_keys_have_expected_values() {
        assert_eq!(UPLOAD_I18N_KEY_TOO_LARGE, "errors.upload.tooLarge");
        assert_eq!(UPLOAD_I18N_KEY_NOT_A_FILE, "errors.upload.notAFile");
    }

    #[test]
    fn app_command_error_with_i18n_roundtrips_through_serde() {
        // Reproduces the end-to-end path: error built in
        // `read_local_file_for_upload` → serialized for IPC → parsed by
        // the frontend's `extractAppCommandError` (which mirrors serde's
        // shape). If serde ever drops `i18n_key` / `i18n_params` from
        // the wire format, the frontend silently demotes to the
        // generic-failure toast — this test pins the contract.
        let err = AppCommandError::io_error("Local file exceeds the upload size limit")
            .with_detail("size=41943040 limit=20971520")
            .with_i18n(
                UPLOAD_I18N_KEY_TOO_LARGE,
                upload_i18n_params([
                    ("size", "41943040".to_string()),
                    ("limit", UPLOAD_MAX_BYTES.to_string()),
                ]),
            );

        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["i18n_key"], "errors.upload.tooLarge");
        assert_eq!(json["i18n_params"]["size"], "41943040");
        assert_eq!(json["i18n_params"]["limit"], UPLOAD_MAX_BYTES.to_string());
        assert_eq!(json["code"], "io_error");

        let parsed: AppCommandError = serde_json::from_value(json).expect("deserialize");
        assert_eq!(parsed.i18n_key.as_deref(), Some("errors.upload.tooLarge"));
        let params = parsed.i18n_params.expect("params");
        assert_eq!(params.get("size").map(String::as_str), Some("41943040"));
        assert_eq!(
            params.get("limit").map(String::as_str),
            Some(UPLOAD_MAX_BYTES.to_string().as_str())
        );
    }

    #[test]
    fn app_command_error_omits_i18n_when_absent() {
        // The `#[serde(skip_serializing_if = "Option::is_none")]`
        // attribute must hold — otherwise the WS proxy and HTTP API
        // would emit noisy `null` fields on every error. Pin it.
        let err = AppCommandError::io_error("plain error");
        let json = serde_json::to_value(&err).expect("serialize");
        assert!(json.get("i18n_key").is_none());
        assert!(json.get("i18n_params").is_none());
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn upload_i18n_params_helper_builds_map() {
        let params = upload_i18n_params([("a", "1".to_string()), ("b", "two".to_string())]);
        assert_eq!(params.get("a").map(String::as_str), Some("1"));
        assert_eq!(params.get("b").map(String::as_str), Some("two"));
        assert_eq!(params.len(), 2);
    }

    // ─── base64 size cap boundary ──────────────────────────────────────

    #[test]
    fn remote_upload_max_base64_len_admits_exact_limit_payload() {
        // A payload of exactly `UPLOAD_MAX_BYTES` raw bytes encodes to
        // a base64 string that MUST pass the pre-decode guard — anything
        // else means we'd reject a legitimate maximum-sized upload.
        let raw = vec![0u8; UPLOAD_MAX_BYTES as usize];
        let encoded = STANDARD.encode(&raw);
        assert!(
            encoded.len() <= REMOTE_UPLOAD_MAX_BASE64_LEN,
            "max-size base64 ({}) exceeds the constant ({})",
            encoded.len(),
            REMOTE_UPLOAD_MAX_BASE64_LEN
        );
    }

    #[test]
    fn remote_upload_max_base64_len_matches_formula() {
        // Lock the formula: any deviation from `ceil(N/3)*4 + 4` will
        // either tighten the cap (false-negative risk) or widen it
        // (defeats the pre-allocation guard). Both warrant a deliberate
        // commit message rather than silent drift.
        let expected = (UPLOAD_MAX_BYTES as usize).div_ceil(3) * 4 + 4;
        assert_eq!(REMOTE_UPLOAD_MAX_BASE64_LEN, expected);
    }

    // ─── filename sanitization ─────────────────────────────────────────

    #[test]
    fn sanitize_upload_file_name_preserves_plain_names() {
        assert_eq!(sanitize_upload_file_name("notes.md"), "notes.md");
        assert_eq!(
            sanitize_upload_file_name("with spaces 中文.pdf"),
            "with spaces 中文.pdf"
        );
    }

    #[test]
    fn sanitize_upload_file_name_strips_header_injection_chars() {
        // `reqwest::multipart::Part::file_name` does not escape these.
        // A CRLF followed by a header name would inject an extra header
        // line into the Content-Disposition. Control chars (CR, LF,
        // tab, NUL, …) are filtered out entirely, while quote, slash
        // and backslash are mapped to `_` so the visible name still
        // makes sense to the user.
        let evil = "leak.txt\r\nX-Auth: bad";
        assert_eq!(sanitize_upload_file_name(evil), "leak.txtX-Auth: bad");

        let punctuation = "foo\"bar\\baz/qux.txt";
        assert_eq!(
            sanitize_upload_file_name(punctuation),
            "foo_bar_baz_qux.txt"
        );

        // NUL is a control char and gets filtered out — *not* replaced
        // with `_`. Either result kills the header-injection vector;
        // pinning the observed behavior so any future change to
        // `is_control()` semantics or the filter ordering is loud.
        let with_nul = "foo\0bar.txt";
        assert_eq!(sanitize_upload_file_name(with_nul), "foobar.txt");
    }

    #[test]
    fn sanitize_upload_file_name_falls_back_when_empty() {
        assert_eq!(sanitize_upload_file_name(""), "file");
        assert_eq!(sanitize_upload_file_name("   "), "file");
        // Entirely control chars: filtered to empty, then fallback.
        assert_eq!(sanitize_upload_file_name("\r\n\t\0"), "file");
    }

    #[test]
    fn sanitize_upload_file_name_caps_length_at_255_chars() {
        let name = "a".repeat(300);
        let result = sanitize_upload_file_name(&name);
        assert_eq!(result.chars().count(), 255);
    }

    // ─── Reconnect backoff ─────────────────────────────────────────────

    #[test]
    fn backoff_doubles_from_one_second_up_to_thirty_with_jitter_in_the_upper_half() {
        let ms = |d: Duration| d.as_millis();
        // No jitter draw at the bottom of the range: half the step.
        assert_eq!(ms(ws_backoff_delay(1, 0.0)), 500);
        assert_eq!(ms(ws_backoff_delay(2, 0.0)), 1_000);
        assert_eq!(ms(ws_backoff_delay(3, 0.0)), 2_000);
        assert_eq!(ms(ws_backoff_delay(5, 0.0)), 8_000);
        // At the top of the range: the whole step.
        assert_eq!(ms(ws_backoff_delay(1, 1.0)), 1_000);
        assert_eq!(ms(ws_backoff_delay(5, 1.0)), 16_000);
        // Capped at 30 s however long the outage, and never below 15 s there.
        for fail_count in [6, 7, 20, u32::MAX] {
            for jitter in [0.0, 0.37, 0.999] {
                let delay = ws_backoff_delay(fail_count, jitter);
                assert!(
                    delay >= WS_BACKOFF_MAX / 2,
                    "{fail_count} {jitter}: {delay:?}"
                );
                assert!(delay <= WS_BACKOFF_MAX, "{fail_count} {jitter}: {delay:?}");
            }
        }
        // The first attempts are not a burst: even the shortest wait is half
        // a second, and a draw outside [0, 1) is clamped.
        assert_eq!(ms(ws_backoff_delay(0, -3.0)), 500);
        assert_eq!(ms(ws_backoff_delay(1, 7.0)), 1_000);
    }

    #[tokio::test(start_paused = true)]
    async fn a_wake_request_cuts_the_backoff_short() {
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let wake = Notify::new();
        // A probe or "Reconnect now" that landed while a connect attempt was
        // still in flight: kept as a permit, so the next wait ends early —
        // right away when the last attempt is already a while back.
        wake.notify_one();
        let attempt_started = Instant::now() - WS_MIN_RETRY_GAP;
        let started = Instant::now();
        let shutdown = backoff_sleep(&mut shutdown_rx, &wake, 6, attempt_started).await;
        assert!(!shutdown);
        assert_eq!(started.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn a_wake_request_never_retries_sooner_than_the_minimum_gap() {
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let wake = Notify::new();
        wake.notify_one();
        // The attempt that just failed started this very moment (a refused
        // connection fails in microseconds).
        let attempt_started = Instant::now();
        let shutdown = backoff_sleep(&mut shutdown_rx, &wake, 6, attempt_started).await;
        assert!(!shutdown);
        assert_eq!(attempt_started.elapsed(), WS_MIN_RETRY_GAP);
    }

    #[tokio::test(start_paused = true)]
    async fn wake_requests_on_every_failed_call_cannot_make_a_tight_reconnect_loop() {
        // The 2026-10-11 loop: the server down, every failed HTTP call asking
        // for an early retry, every connect refused at once. Drive the same
        // shape for a simulated minute and count the attempts.
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let wake = Notify::new();
        let start = Instant::now();
        let mut attempts = 0u32;
        let mut fail_count = 0u32;
        while start.elapsed() < Duration::from_secs(60) {
            let attempt_started = Instant::now();
            attempts += 1;
            fail_count += 1;
            // A failed call's probe lands while the attempt is "in flight".
            wake.notify_one();
            backoff_sleep(&mut shutdown_rx, &wake, fail_count, attempt_started).await;
        }
        let ceiling = (60 / WS_MIN_RETRY_GAP.as_secs()) as u32 + 1;
        assert!(attempts <= ceiling, "{attempts} attempts in a minute");
    }

    #[tokio::test]
    async fn backoff_sleep_reports_a_shutdown() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let wake = Notify::new();
        let (shutdown, _) = tokio::join!(
            backoff_sleep(&mut shutdown_rx, &wake, 6, Instant::now()),
            async {
                shutdown_tx.send(true).unwrap();
            }
        );
        assert!(shutdown);
    }

    #[tokio::test]
    async fn backoff_sleep_reports_a_shutdown_while_holding_the_retry_gap() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let wake = Notify::new();
        wake.notify_one();
        let (shutdown, _) = tokio::join!(
            backoff_sleep(&mut shutdown_rx, &wake, 6, Instant::now()),
            async {
                tokio::task::yield_now().await;
                shutdown_tx.send(true).unwrap();
            }
        );
        assert!(shutdown);
    }

    // ─── Proxy HTTP pool ───────────────────────────────────────────────

    /// A bare HTTP/1.1 server that answers every request on a connection
    /// after `delay`, keeping the connection open. Counts the connections
    /// its clients still hold, and every connection it ever accepted.
    async fn counting_server(
        delay: Duration,
    ) -> (
        std::net::SocketAddr,
        Arc<std::sync::atomic::AtomicUsize>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let open = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = open.clone();
        let total = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                total.fetch_add(1, Ordering::SeqCst);
                let counter = counter.clone();
                tokio::spawn(async move {
                    let mut pending = Vec::new();
                    let mut buf = [0u8; 4096];
                    'conn: loop {
                        // One request: head, then a Content-Length body.
                        let head_end = loop {
                            if let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
                                break end + 4;
                            }
                            match stream.read(&mut buf).await {
                                Ok(0) | Err(_) => break 'conn,
                                Ok(n) => pending.extend_from_slice(&buf[..n]),
                            }
                        };
                        let head = String::from_utf8_lossy(&pending[..head_end]).to_lowercase();
                        let body_len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        while pending.len() < head_end + body_len {
                            match stream.read(&mut buf).await {
                                Ok(0) | Err(_) => break 'conn,
                                Ok(n) => pending.extend_from_slice(&buf[..n]),
                            }
                        }
                        pending.drain(..head_end + body_len);
                        tokio::time::sleep(delay).await;
                        let response = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                                        content-length: 2\r\n\r\n{}";
                        if stream.write_all(response.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    counter.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        (addr, open, accepted)
    }

    #[tokio::test]
    async fn a_request_burst_leaves_no_more_than_the_idle_cap_open() {
        use std::sync::atomic::Ordering;

        let (addr, open, accepted) = counting_server(Duration::from_millis(150)).await;
        // The proxy's own settings, minus the system proxy (see above).
        let client = proxy_http_client_builder().no_proxy().build().unwrap();
        let burst = 40;
        let calls = (0..burst).map(|_| {
            let client = client.clone();
            async move {
                client
                    .post(format!("http://{addr}/api/list_all_conversations"))
                    .json(&serde_json::json!({}))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap()
            }
        });
        futures_util::future::join_all(calls).await;
        // HTTP/1.1: one connection per request in flight.
        assert!(accepted.load(Ordering::SeqCst) > HTTP_POOL_MAX_IDLE_PER_HOST);

        // Once the burst is over, every connection past the idle cap is
        // closed by the client right away, not after the pool's idle timeout.
        let deadline = Instant::now() + Duration::from_secs(5);
        while open.load(Ordering::SeqCst) > HTTP_POOL_MAX_IDLE_PER_HOST {
            assert!(
                Instant::now() < deadline,
                "{} connections still open after the burst",
                open.load(Ordering::SeqCst)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(HTTP_POOL_IDLE_TIMEOUT < crate::web::serve::ConnectionTimeouts::DEFAULT.idle);
    }

    #[tokio::test(start_paused = true)]
    async fn a_handshake_that_never_answers_times_out_as_retryable() {
        // The kernel completes the TCP connect into the listen backlog, but
        // nothing ever answers the upgrade — a host that went quiet mid-way.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws/events", listener.local_addr().unwrap());
        let err = connect_with_subprotocol_auth(&url, WS_EVENT_PROTOCOL, "token", &HeaderMap::new())
            .await
            .unwrap_err();
        assert!(matches!(err, WsConnectError::Retryable(_)), "got {err}");
    }

    // ─── MIME guess ────────────────────────────────────────────────────

    #[test]
    fn guess_mime_from_path_handles_common_extensions() {
        let cases = [
            ("/tmp/foo.json", Some("application/json")),
            ("/tmp/foo.PDF", Some("application/pdf")), // case-insensitive
            ("/tmp/foo.unknown", None),
            ("/tmp/no-extension", None),
        ];
        for (path, expected) in cases {
            assert_eq!(
                guess_mime_from_path(std::path::Path::new(path)),
                expected.map(str::to_string),
                "case: {path}"
            );
        }
    }
}
