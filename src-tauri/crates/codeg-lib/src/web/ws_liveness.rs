//! Server-side liveness for the WebSockets codeg serves.
//!
//! A WebSocket whose client vanished (a laptop that slept, a phone that
//! suspended the app, a network that changed under it) does not end on its
//! own: the server only learns the peer is gone when a write fails, and an
//! idle socket is never written to. Each one pins a descriptor, a broadcast
//! receiver and, for `/ws/events`, its attach subscriptions — forever.
//!
//! So the server pings every [`PING_INTERVAL`] and closes a socket from
//! which nothing at all has arrived for [`SILENCE_LIMIT`], two intervals:
//! a live peer has answered one ping by then, however long its own pings
//! are apart. Every client answers pings on its own — browsers and WebKit
//! in the network stack (a background tab's throttled timers don't matter),
//! the desktop's proxy and the iOS app's URLSession in theirs — and the
//! clients that ping themselves (the iOS app every 20 s, the web transport
//! after 15 s of quiet, the desktop proxy after 15 s) count as alive by
//! those frames too.
//!
//! [`SEND_TIMEOUT`] bounds a single write: a socket whose peer stopped
//! reading fills its send buffer, and a send that never completes would
//! otherwise stall the connection's loop, heartbeat included.

use std::time::Duration;

use tokio::time::{Instant, Interval, MissedTickBehavior};

/// Gap between the server's pings.
pub const PING_INTERVAL: Duration = Duration::from_secs(30);
/// Nothing received for this long — pongs, pings, data — and the peer is
/// taken for gone.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(2 * PING_INTERVAL.as_secs());
/// Longest one frame may take to be handed to the kernel.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(60);

/// What to do when the ping ticker fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    /// The peer spoke recently enough: ping it.
    Ping,
    /// Silent past the limit: close the socket.
    Dead,
}

/// When the peer last said anything. Free of I/O so the rule is testable.
#[derive(Debug, Clone, Copy)]
pub struct PeerLiveness {
    last_inbound: Instant,
    silence_limit: Duration,
}

impl PeerLiveness {
    pub fn new(now: Instant) -> Self {
        Self::with_limit(now, SILENCE_LIMIT)
    }

    pub fn with_limit(now: Instant, silence_limit: Duration) -> Self {
        Self {
            last_inbound: now,
            silence_limit,
        }
    }

    /// Any frame from the peer, control frames included.
    pub fn on_inbound(&mut self, now: Instant) {
        self.last_inbound = now;
    }

    pub fn on_tick(&self, now: Instant) -> Tick {
        if now.saturating_duration_since(self.last_inbound) >= self.silence_limit {
            Tick::Dead
        } else {
            Tick::Ping
        }
    }

    /// How long the peer has been silent, for the log.
    pub fn silent_for(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_inbound)
    }
}

/// The ping ticker: first tick one interval from now (the handshake itself
/// is proof of life), and a late tick is not made up with a burst.
pub fn ping_ticker() -> Interval {
    ping_ticker_every(PING_INTERVAL)
}

pub fn ping_ticker_every(interval: Duration) -> Interval {
    let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker
}

/// A write that failed, or did not complete within [`SEND_TIMEOUT`]: the
/// socket is not usable any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendFailed;

/// `send`, bounded by [`SEND_TIMEOUT`].
pub async fn send_bounded<F, E>(send: F) -> Result<(), SendFailed>
where
    F: std::future::Future<Output = Result<(), E>>,
{
    match tokio::time::timeout(SEND_TIMEOUT, send).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) | Err(_) => Err(SendFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_limit_is_two_ping_intervals() {
        assert_eq!(SILENCE_LIMIT, PING_INTERVAL * 2);
        assert!(SEND_TIMEOUT >= PING_INTERVAL);
    }

    #[test]
    fn a_peer_is_pinged_until_it_has_been_silent_for_the_limit() {
        let start = Instant::now();
        let mut peer = PeerLiveness::new(start);
        assert_eq!(peer.on_tick(start + PING_INTERVAL), Tick::Ping);
        assert_eq!(
            peer.on_tick(start + SILENCE_LIMIT - Duration::from_millis(1)),
            Tick::Ping
        );
        assert_eq!(peer.on_tick(start + SILENCE_LIMIT), Tick::Dead);

        // A pong (or anything else) resets the clock.
        peer.on_inbound(start + PING_INTERVAL + Duration::from_millis(40));
        assert_eq!(peer.on_tick(start + SILENCE_LIMIT), Tick::Ping);
        assert_eq!(
            peer.on_tick(start + PING_INTERVAL + SILENCE_LIMIT + Duration::from_millis(40)),
            Tick::Dead
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_ticker_fires_one_interval_after_the_handshake_and_then_every_interval() {
        let start = Instant::now();
        let mut ticker = ping_ticker();
        ticker.tick().await;
        assert_eq!(start.elapsed(), PING_INTERVAL);
        ticker.tick().await;
        assert_eq!(start.elapsed(), PING_INTERVAL * 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_send_that_never_completes_fails_after_the_timeout() {
        let start = Instant::now();
        let stuck = std::future::pending::<Result<(), ()>>();
        assert_eq!(send_bounded(stuck).await, Err(SendFailed));
        assert_eq!(start.elapsed(), SEND_TIMEOUT);
        assert_eq!(send_bounded(async { Ok::<(), ()>(()) }).await, Ok(()));
        assert_eq!(
            send_bounded(async { Err::<(), &str>("closed") }).await,
            Err(SendFailed)
        );
    }
}
