//! Periodic sweeper that disconnects ACP connections idle past a deadline.
//!
//! Connections accumulate when frontends close their window/tab without
//! triggering an explicit disconnect — common in web mode (browser tab
//! close has no server-side hook), and possible on desktop after panics.
//! The sweep prevents long-lived processes from leaking ACP child
//! processes, file handles, and memory.
//!
//! The few sessions the user looked at most recently are kept warm for longer
//! (see [`WarmPolicy`]): reopening one of them is then instant instead of a
//! fresh agent spawn plus `session/resume`.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::acp::manager::ConnectionManager;

/// Default idle threshold (3 minutes). Override at startup via
/// `CODEG_ACP_IDLE_TIMEOUT_SECS`. The sweep only runs against
/// connections in `Connected` state with no `pending_permission`, and
/// `last_activity_at` is bumped on every emit and on every frontend
/// keepalive touch (~30s cadence for open tabs), so an actively-used
/// or visible connection never qualifies.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 180;
/// Sweep cadence — runs once per minute. Each tick is a brief lock on the
/// connections map plus per-state `try_read`s, so a 1-minute interval is
/// trivially cheap relative to the wall-clock idle threshold.
pub const SWEEP_INTERVAL_SECS: u64 = 60;

/// Read the idle timeout from `CODEG_ACP_IDLE_TIMEOUT_SECS`, falling back
/// to `DEFAULT_IDLE_TIMEOUT_SECS`. A `0` value disables the sweep
/// (returns `None`); any unparseable value is treated as "use default".
pub fn idle_timeout_from_env() -> Option<Duration> {
    let secs = match std::env::var("CODEG_ACP_IDLE_TIMEOUT_SECS") {
        Ok(raw) => raw.parse::<u64>().unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS),
        Err(_) => DEFAULT_IDLE_TIMEOUT_SECS,
    };
    if secs == 0 {
        return None;
    }
    Some(Duration::from_secs(secs))
}

/// How many of the most recently viewed sessions stay warm, by default.
pub const DEFAULT_WARM_SESSIONS: usize = 3;
/// How long a warm session may sit idle before it is reclaimed, by default
/// (20 minutes).
pub const DEFAULT_WARM_IDLE_TIMEOUT_SECS: u64 = 20 * 60;

/// Longer idle allowance for the sessions the user viewed most recently.
///
/// The `slots` connections with the most recent `last_viewed_at` (a UI opened
/// or showed them) are reclaimed only after `idle_timeout`; every other idle
/// connection keeps the normal threshold. A connection nobody ever viewed (a
/// speculative pre-connect, a delegation child, an automation) is never warm.
///
/// The price is memory: each warm Claude Code session holds its node adapter,
/// the `claude` CLI and that CLI's MCP server children.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WarmPolicy {
    pub slots: usize,
    pub idle_timeout: Duration,
}

impl WarmPolicy {
    /// No warm set: every connection gets the normal idle threshold.
    pub const fn disabled() -> Self {
        Self {
            slots: 0,
            idle_timeout: Duration::ZERO,
        }
    }

    /// `CODEG_ACP_WARM_SESSIONS` (count, `0` disables) and
    /// `CODEG_ACP_WARM_IDLE_TIMEOUT_SECS` (`0` disables), else the defaults.
    /// Unparseable values fall back to the defaults.
    pub fn from_env() -> Self {
        let slots = std::env::var("CODEG_ACP_WARM_SESSIONS")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(DEFAULT_WARM_SESSIONS);
        let secs = std::env::var("CODEG_ACP_WARM_IDLE_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_WARM_IDLE_TIMEOUT_SECS);
        if slots == 0 || secs == 0 {
            return Self::disabled();
        }
        Self {
            slots,
            idle_timeout: Duration::from_secs(secs),
        }
    }

    /// The process-wide policy, read from the environment once.
    pub fn current() -> Self {
        static POLICY: std::sync::OnceLock<WarmPolicy> = std::sync::OnceLock::new();
        *POLICY.get_or_init(Self::from_env)
    }

    pub fn is_enabled(&self) -> bool {
        self.slots > 0 && !self.idle_timeout.is_zero()
    }

    /// The idle threshold for a connection: the warm allowance when it is in
    /// the warm set, never shorter than the normal one.
    pub fn threshold(&self, base: Duration, is_warm: bool) -> Duration {
        if is_warm && self.is_enabled() {
            base.max(self.idle_timeout)
        } else {
            base
        }
    }

    /// Ids of the `slots` most recently viewed connections. Never more than
    /// `slots`, and a connection that was never viewed is never in it.
    pub fn warm_set<'a, I>(&self, views: I) -> HashSet<String>
    where
        I: IntoIterator<Item = (&'a str, Option<DateTime<Utc>>)>,
    {
        if !self.is_enabled() {
            return HashSet::new();
        }
        let mut viewed: Vec<(&str, DateTime<Utc>)> = views
            .into_iter()
            .filter_map(|(id, at)| at.map(|at| (id, at)))
            .collect();
        // Newest first; the id breaks ties so the choice is deterministic.
        viewed.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        viewed
            .into_iter()
            .take(self.slots)
            .map(|(id, _)| id.to_string())
            .collect()
    }
}

/// Long-running task that calls `ConnectionManager::sweep_idle` on a
/// fixed interval. The caller spawns the returned future onto whichever
/// runtime they manage (`tokio::spawn` from inside an async context,
/// `tauri::async_runtime::spawn` from a Tauri `setup` callback that runs
/// outside the runtime).
///
/// Never exits on its own — the caller drops the spawned handle when
/// shutting down (process exit cleans up everything).
pub async fn idle_sweep_task(
    manager: ConnectionManager,
    idle_timeout: Duration,
    interval: Duration,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First `tick().await` returns immediately. Skip it so we don't
    // sweep at startup before any connections have a chance to settle.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let n = manager.sweep_idle(idle_timeout).await;
        if n > 0 {
            tracing::info!("[ACP] idle sweep disconnected {n} connection(s)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Single test sequences all env-var assertions to avoid the
    /// notorious parallel-test race on shared environment state. Cargo
    /// runs tests in parallel by default; setting `CODEG_ACP_IDLE_TIMEOUT_SECS`
    /// in concurrent tests would interleave with each other.
    fn at(secs_ago: i64) -> Option<DateTime<Utc>> {
        Some(Utc::now() - chrono::Duration::seconds(secs_ago))
    }

    fn policy(slots: usize, secs: u64) -> WarmPolicy {
        WarmPolicy {
            slots,
            idle_timeout: Duration::from_secs(secs),
        }
    }

    #[test]
    fn warm_set_keeps_the_most_recently_viewed() {
        let views = [
            ("a", at(400)),
            ("b", at(10)),
            ("c", at(200)),
            ("d", at(30)),
            ("e", at(100)),
        ];
        let warm = policy(3, 1200).warm_set(views.iter().map(|(id, t)| (*id, *t)));
        let mut ids: Vec<_> = warm.into_iter().collect();
        ids.sort();
        assert_eq!(ids, vec!["b", "d", "e"]);
    }

    #[test]
    fn warm_set_never_holds_a_connection_nobody_viewed() {
        // A speculative pre-connect or a delegation child has no view at all;
        // it must not take a warm slot even when slots are free.
        let views = [("seen", at(50)), ("speculative", None), ("child", None)];
        let warm = policy(3, 1200).warm_set(views.iter().map(|(id, t)| (*id, *t)));
        assert_eq!(warm.len(), 1);
        assert!(warm.contains("seen"));
    }

    #[test]
    fn warm_set_is_empty_when_disabled() {
        let views = [("a", at(1)), ("b", at(2))];
        assert!(WarmPolicy::disabled()
            .warm_set(views.iter().map(|(id, t)| (*id, *t)))
            .is_empty());
        assert!(policy(0, 1200)
            .warm_set(views.iter().map(|(id, t)| (*id, *t)))
            .is_empty());
        assert!(policy(3, 0)
            .warm_set(views.iter().map(|(id, t)| (*id, *t)))
            .is_empty());
    }

    #[test]
    fn threshold_extends_only_warm_connections() {
        let base = Duration::from_secs(180);
        let warm = policy(3, 1200);
        assert_eq!(warm.threshold(base, true), Duration::from_secs(1200));
        assert_eq!(warm.threshold(base, false), base);
        // A warm allowance shorter than the base never shortens it.
        assert_eq!(policy(3, 60).threshold(base, true), base);
        assert_eq!(WarmPolicy::disabled().threshold(base, true), base);
    }

    /// Env parsing in one test, for the same reason as
    /// `idle_timeout_env_parsing`: the variables are process-global.
    #[test]
    fn warm_policy_env_parsing() {
        std::env::remove_var("CODEG_ACP_WARM_SESSIONS");
        std::env::remove_var("CODEG_ACP_WARM_IDLE_TIMEOUT_SECS");
        assert_eq!(
            WarmPolicy::from_env(),
            policy(DEFAULT_WARM_SESSIONS, DEFAULT_WARM_IDLE_TIMEOUT_SECS)
        );

        std::env::set_var("CODEG_ACP_WARM_SESSIONS", "5");
        std::env::set_var("CODEG_ACP_WARM_IDLE_TIMEOUT_SECS", "600");
        assert_eq!(WarmPolicy::from_env(), policy(5, 600));

        std::env::set_var("CODEG_ACP_WARM_SESSIONS", "0");
        assert!(!WarmPolicy::from_env().is_enabled());

        std::env::set_var("CODEG_ACP_WARM_SESSIONS", "2");
        std::env::set_var("CODEG_ACP_WARM_IDLE_TIMEOUT_SECS", "0");
        assert!(!WarmPolicy::from_env().is_enabled());

        std::env::set_var("CODEG_ACP_WARM_SESSIONS", "lots");
        std::env::set_var("CODEG_ACP_WARM_IDLE_TIMEOUT_SECS", "soon");
        assert_eq!(
            WarmPolicy::from_env(),
            policy(DEFAULT_WARM_SESSIONS, DEFAULT_WARM_IDLE_TIMEOUT_SECS)
        );

        std::env::remove_var("CODEG_ACP_WARM_SESSIONS");
        std::env::remove_var("CODEG_ACP_WARM_IDLE_TIMEOUT_SECS");
    }

    #[test]
    fn idle_timeout_env_parsing() {
        // Disabled when zero.
        std::env::set_var("CODEG_ACP_IDLE_TIMEOUT_SECS", "0");
        assert!(idle_timeout_from_env().is_none());

        // Falls back to default when unparseable.
        std::env::set_var("CODEG_ACP_IDLE_TIMEOUT_SECS", "not-a-number");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );

        // Uses provided value when it parses.
        std::env::set_var("CODEG_ACP_IDLE_TIMEOUT_SECS", "120");
        assert_eq!(idle_timeout_from_env().unwrap().as_secs(), 120);

        // Falls back to default when unset.
        std::env::remove_var("CODEG_ACP_IDLE_TIMEOUT_SECS");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
    }
}
