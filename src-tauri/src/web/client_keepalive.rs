//! TCP keepalive on the web service's client connections.
//!
//! A remote client that goes away without closing its connections (a laptop
//! that sleeps, or changes network under Tailscale) leaves them ESTABLISHED
//! here indefinitely. Nothing notices on its own: an idle HTTP/1.1 keep-alive
//! connection is never written to, and the server sets no idle timeout. Each
//! one pins a file descriptor. One desktop, two days after a restart: 176
//! established sockets from a single remote Mac that itself had 11 open,
//! against macOS's default limit of 256 descriptors per app, at which point
//! accepts and the import scan started failing with `EMFILE`.
//!
//! Keepalive probes let the kernel find the dead ones and close them. A live
//! but idle client answers the probes and is not affected.

use std::time::Duration;

use axum::serve::{ListenerExt, TapIo};
use tokio::net::{TcpListener, TcpStream};

/// Silence after which the kernel starts probing a connection.
pub const KEEPALIVE_IDLE: Duration = Duration::from_secs(120);
/// Gap between unanswered probes.
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// Unanswered probes before the kernel drops the connection: a dead peer is
/// reaped about four minutes after it last spoke.
pub const KEEPALIVE_RETRIES: u32 = 4;

/// Turn keepalive on for one accepted connection. Best effort: a socket that
/// refuses it is still served.
pub fn enable(stream: &mut TcpStream) {
    let params = socket2::TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL)
        .with_retries(KEEPALIVE_RETRIES);
    if let Err(err) = socket2::SockRef::from(&*stream).set_tcp_keepalive(&params) {
        tracing::debug!("[WEB] could not enable TCP keepalive on a client connection: {err}");
    }
}

/// `listener`, with [`enable`] applied to every connection it accepts. Hand
/// this to `axum::serve` in place of the bare listener.
pub fn listener(listener: TcpListener) -> TapIo<TcpListener, fn(&mut TcpStream)> {
    listener.tap_io(enable as fn(&mut TcpStream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::serve::Listener;

    #[tokio::test]
    async fn accepted_connections_have_keepalive_on() {
        let bound = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = bound.local_addr().unwrap();
        let mut listener = listener(bound);

        let client = tokio::spawn(async move { TcpStream::connect(addr).await.unwrap() });
        let (accepted, _) = listener.accept().await;
        let _client = client.await.unwrap();

        let sock = socket2::SockRef::from(&accepted);
        assert!(sock.keepalive().unwrap(), "SO_KEEPALIVE is set");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            assert_eq!(sock.tcp_keepalive_time().unwrap(), KEEPALIVE_IDLE);
            assert_eq!(sock.tcp_keepalive_interval().unwrap(), KEEPALIVE_INTERVAL);
            assert_eq!(sock.tcp_keepalive_retries().unwrap(), KEEPALIVE_RETRIES);
        }
    }
}
