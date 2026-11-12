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
//! but idle client answers the probes and is not affected. A peer whose host
//! is up but whose socket is gone (the app restarted, or the OS dropped the
//! connection when its network interface went away) answers the first probe
//! with a reset, so that case is reaped right after the idle time.
//!
//! This is the backstop under `web::serve`'s idle timeout and the WebSocket
//! heartbeats: it also covers a connection that is quiet in the middle of a
//! request (a long call whose response has not started) and every byte
//! stream that has no protocol-level liveness of its own.

use std::time::Duration;

use axum::serve::{ListenerExt, TapIo};
use tokio::net::{TcpListener, TcpStream};

/// Silence after which the kernel starts probing a connection.
pub const KEEPALIVE_IDLE: Duration = Duration::from_secs(60);
/// Gap between unanswered probes.
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// Unanswered probes before the kernel drops the connection: a peer that
/// vanished is reaped about 90 seconds after it last spoke.
pub const KEEPALIVE_RETRIES: u32 = 3;

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

/// `listener`, with [`enable`] applied to every connection it accepts.
/// `web::serve` wraps every listener it is given in this.
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
