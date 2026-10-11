//! The accept loop of codeg's web listeners.
//!
//! `axum::serve` runs every connection on hyper's defaults and offers no way
//! to change them. Those defaults have no timer, so no timeout applies to a
//! connection that is waiting for its next request: an HTTP/1.1 keep-alive
//! connection a client never uses again stays open for as long as the
//! client's end does — and when that end disappears without a word (a laptop
//! that sleeps or changes network, an app that quits while its link is down)
//! it stays open forever. A desktop serving a remote Mac collected about 160
//! of them in a day; at macOS's default limit of 256 descriptors its accepts
//! then failed with `EMFILE` once a second and every client timed out.
//!
//! This is `axum::serve` with the timeouts it leaves out:
//!
//! - a new connection must start its first request within
//!   [`ConnectionTimeouts::first_byte`] — hyper's protocol sniffing, which
//!   runs before any HTTP/1 timeout applies, would otherwise wait forever on
//!   a client that sends nothing;
//! - HTTP/1: every request head must arrive within
//!   [`ConnectionTimeouts::idle`] of the connection starting to wait for it,
//!   which is also how long an idle keep-alive connection stays open;
//! - HTTP/2: keepalive pings, so a peer that vanished is noticed;
//! - TCP keepalive on every accepted socket (`client_keepalive`), the
//!   backstop for a connection that is quiet in the middle of a request.
//!
//! None of these touches a request in progress: a long call or a streamed
//! response is not waiting for a request head, a request body being
//! uploaded is past it, and a WebSocket leaves hyper altogether once it is
//! upgraded (its liveness is the WebSocket heartbeat's job, `web::ws`).

use std::future::Future;
use std::time::Duration;

use axum::serve::Listener;
use axum::Router;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::client_keepalive;

/// How long each phase of an HTTP connection may stay silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionTimeouts {
    /// A freshly accepted connection must send its first byte within this.
    pub first_byte: Duration,
    /// HTTP/1: from the moment a connection waits for a request — right
    /// after it is accepted, or after the previous response went out — to
    /// that request's complete head. In practice the idle timeout of a
    /// keep-alive connection. Longer than the 90 s reqwest's connection pool
    /// keeps an idle connection by default, so a client like that, the
    /// remote desktop's proxy included, closes its idle connections itself
    /// before this ever has to race it.
    pub idle: Duration,
    /// HTTP/2: interval of the keepalive ping, and how long its answer may
    /// take before the connection is closed.
    pub h2_ping_interval: Duration,
    pub h2_ping_timeout: Duration,
}

impl ConnectionTimeouts {
    pub const DEFAULT: Self = Self {
        first_byte: Duration::from_secs(30),
        idle: Duration::from_secs(120),
        h2_ping_interval: Duration::from_secs(30),
        h2_ping_timeout: Duration::from_secs(20),
    };

    fn builder(&self) -> Builder<TokioExecutor> {
        let mut builder = Builder::new(TokioExecutor::new());
        builder
            .http1()
            .timer(TokioTimer::new())
            .header_read_timeout(self.idle);
        builder
            .http2()
            .timer(TokioTimer::new())
            .keep_alive_interval(self.h2_ping_interval)
            .keep_alive_timeout(self.h2_ping_timeout)
            // As `axum::serve` does: WebSockets over HTTP/2.
            .enable_connect_protocol();
        builder
    }
}

impl Default for ConnectionTimeouts {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Serve `router` on `listener` until `shutdown` resolves, with
/// [`ConnectionTimeouts::DEFAULT`]. Then stop accepting, let every open
/// connection finish the request it is serving, and return once they have
/// all closed — what `axum::serve(..).with_graceful_shutdown(..)` does.
pub async fn serve<F>(listener: TcpListener, router: Router, shutdown: F)
where
    F: Future<Output = ()> + Send,
{
    serve_with(listener, router, shutdown, ConnectionTimeouts::DEFAULT).await
}

/// [`serve`] with explicit timeouts.
pub async fn serve_with<F>(
    listener: TcpListener,
    router: Router,
    shutdown: F,
    timeouts: ConnectionTimeouts,
) where
    F: Future<Output = ()> + Send,
{
    // Accept errors (`EMFILE` included) are logged and retried after a
    // second by axum's `Listener` implementation, as under `axum::serve`.
    let mut listener = client_keepalive::listener(listener);
    let builder = timeouts.builder();
    // Dropping the sender tells every connection to wind down.
    let (stop_tx, stop_rx) = watch::channel(());
    // Every connection holds a receiver; `closed()` resolves when all are gone.
    let (done_tx, done_rx) = watch::channel(());
    let mut shutdown = std::pin::pin!(shutdown);

    loop {
        let (stream, _peer) = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut shutdown => break,
        };
        let service = TowerToHyperService::new(router.clone());
        let builder = builder.clone();
        let stop = stop_rx.clone();
        let done = done_rx.clone();
        tokio::spawn(async move {
            serve_connection(stream, service, &builder, timeouts.first_byte, stop).await;
            drop(done);
        });
    }

    drop(listener);
    drop(stop_rx);
    drop(done_rx);
    drop(stop_tx);
    done_tx.closed().await;
}

async fn serve_connection(
    stream: TcpStream,
    service: TowerToHyperService<Router>,
    builder: &Builder<TokioExecutor>,
    first_byte: Duration,
    mut stop: watch::Receiver<()>,
) {
    // Before hyper sees the connection: its HTTP/1-or-2 sniffing reads the
    // first bytes with no deadline at all.
    tokio::select! {
        ready = tokio::time::timeout(first_byte, stream.readable()) => {
            if !matches!(ready, Ok(Ok(()))) {
                return;
            }
        }
        _ = stop.changed() => return,
    }

    let mut conn =
        std::pin::pin!(builder.serve_connection_with_upgrades(TokioIo::new(stream), service));
    tokio::select! {
        result = conn.as_mut() => {
            // Timeouts and resets end up here; they are routine.
            if let Err(err) = result {
                tracing::trace!("[WEB] connection ended: {err}");
            }
            return;
        }
        _ = stop.changed() => conn.as_mut().graceful_shutdown(),
    }
    if let Err(err) = conn.await {
        tracing::trace!("[WEB] connection ended during shutdown: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::time::Instant;

    use axum::extract::ws::{Message, WebSocketUpgrade};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    const FAST: ConnectionTimeouts = ConnectionTimeouts {
        first_byte: Duration::from_millis(300),
        idle: Duration::from_millis(600),
        h2_ping_interval: Duration::from_secs(30),
        h2_ping_timeout: Duration::from_secs(20),
    };

    async fn echo_ws(ws: WebSocketUpgrade) -> impl IntoResponse {
        ws.on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                if let Message::Text(text) = message {
                    if socket.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
            }
        })
    }

    fn router() -> Router {
        Router::new()
            .route("/ok", get(|| async { "ok" }))
            .route(
                "/slow",
                get(|| async {
                    // Three idle timeouts: a response being prepared is not
                    // an idle connection.
                    tokio::time::sleep(FAST.idle * 3).await;
                    "slow"
                }),
            )
            .route("/ws", get(echo_ws))
    }

    async fn start() -> (SocketAddr, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = oneshot::channel::<()>();
        let task = tokio::spawn(serve_with(
            listener,
            router(),
            async move {
                let _ = rx.await;
            },
            FAST,
        ));
        (addr, tx, task)
    }

    /// Read until the peer closes; returns everything read and when it closed.
    async fn read_until_closed(stream: &mut TcpStream, limit: Duration) -> (String, Instant) {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match tokio::time::timeout(limit, stream.read(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => {
                    return (String::from_utf8_lossy(&out).into(), Instant::now())
                }
                Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
                Err(_) => panic!(
                    "connection still open after {limit:?}; read so far: {:?}",
                    String::from_utf8_lossy(&out)
                ),
            }
        }
    }

    /// Read one complete response to `GET /ok` (a 2-byte body).
    async fn read_ok_response(stream: &mut TcpStream) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while !out.ends_with(b"\r\n\r\nok") {
            let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
                .await
                .expect("response in time")
                .unwrap();
            assert!(n > 0, "closed before the response was complete");
            out.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&out).into()
    }

    const GET_OK: &[u8] = b"GET /ok HTTP/1.1\r\nHost: test\r\n\r\n";

    #[tokio::test]
    async fn a_connection_that_never_sends_is_closed_after_the_first_byte_timeout() {
        let (addr, _stop, _task) = start().await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let opened = Instant::now();
        let (read, closed) = read_until_closed(&mut stream, Duration::from_secs(5)).await;
        assert!(read.is_empty());
        let open_for = closed - opened;
        assert!(
            open_for >= FAST.first_byte - Duration::from_millis(50),
            "{open_for:?}"
        );
        assert!(
            open_for < FAST.first_byte + Duration::from_secs(2),
            "{open_for:?}"
        );
    }

    #[tokio::test]
    async fn an_idle_keep_alive_connection_is_closed_after_the_idle_timeout() {
        let (addr, _stop, _task) = start().await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(GET_OK).await.unwrap();
        let response = read_ok_response(&mut stream).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let idle_since = Instant::now();
        let (rest, closed) = read_until_closed(&mut stream, Duration::from_secs(5)).await;
        assert!(rest.is_empty(), "{rest}");
        let idle_for = closed - idle_since;
        assert!(
            idle_for >= FAST.idle - Duration::from_millis(50),
            "{idle_for:?}"
        );
        assert!(
            idle_for < FAST.idle + Duration::from_secs(2),
            "{idle_for:?}"
        );
    }

    #[tokio::test]
    async fn a_keep_alive_connection_used_within_the_timeout_keeps_serving() {
        let (addr, _stop, _task) = start().await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        for _ in 0..3 {
            stream.write_all(GET_OK).await.unwrap();
            let response = read_ok_response(&mut stream).await;
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
            tokio::time::sleep(FAST.idle / 2).await;
        }
    }

    #[tokio::test]
    async fn a_slow_response_is_not_cut_by_the_idle_timeout() {
        let (addr, _stop, _task) = start().await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /slow HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let (response, _) = read_until_closed(&mut stream, Duration::from_secs(10)).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("slow"), "{response}");
    }

    #[tokio::test]
    async fn a_websocket_outlives_the_http_timeouts() {
        let (addr, _stop, _task) = start().await;
        let stream = TcpStream::connect(addr).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::client_async(format!("ws://{addr}/ws"), stream)
            .await
            .unwrap();
        tokio::time::sleep(FAST.idle * 2 + FAST.first_byte).await;
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                "still here".into(),
            ))
            .await
            .unwrap();
        let echoed = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("echo in time")
            .expect("socket open")
            .unwrap();
        assert_eq!(echoed.into_text().unwrap().as_str(), "still here");
    }

    #[tokio::test]
    async fn shutdown_stops_accepting_and_returns_once_connections_are_done() {
        let (addr, stop, task) = start().await;
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(GET_OK).await.unwrap();
        read_ok_response(&mut stream).await;

        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("serve returns after shutdown")
            .unwrap();
        // The idle connection was closed by the shutdown, not left behind.
        let (rest, _) = read_until_closed(&mut stream, Duration::from_secs(1)).await;
        assert!(rest.is_empty());
        assert!(TcpStream::connect(addr).await.is_err(), "still accepting");
    }
}
