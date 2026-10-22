//! One conversation, one live agent session — inside an agent process.
//!
//! An ACP agent process can hold several sessions at once, and an adapter
//! keeps every session it opened or forked until the client closes it or the
//! process ends. A fork (an edited message, a branch in place) hands the
//! conversation over to a NEW session id in the SAME process. If the session
//! it replaced is not closed there, the agent keeps running it:
//! claude-agent-acp runs one Claude Code process per session, so the replaced
//! conversation lives on as a second, invisible copy, and whatever it starts
//! on its own (a scheduled prompt, a background task that finishes) runs to
//! the end. codeg has dropped its router for that id, so the copy's updates
//! are parked in the ACP runtime's retry queue and never shown, while its
//! `fs/*`, `terminal/*` and permission requests are still answered by the
//! connection-wide handlers.
//!
//! Three pieces keep that from happening:
//!
//! * [`close_retired_session`] closes a replaced session on the agent
//!   (`session/close` when the agent offers it, `session/cancel` otherwise)
//!   and then makes sure the session's own process is gone
//!   ([`end_session_processes`]).
//! * [`SessionLedger`] remembers, per connection, which sessions codeg
//!   retired, and what replaced them.
//! * [`RetiredSessionGuard`] sits at the front of the connection's handler
//!   chain. A retired session's requests are refused and its updates dropped
//!   instead of piling up in the retry queue; if it is still talking once its
//!   close had time to land, that is a duplicate: it is logged with both ids
//!   and closed again.
//!
//! Across agent processes the same rule is kept by the connection manager
//! (`ConnectionManager::close_other_holders`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{CancelNotification, CloseSessionRequest, SessionId};
use agent_client_protocol::{Agent, ConnectionTo, Dispatch, HandleDispatchFrom, Handled};

use crate::acp::agent_session::dispatch_session_id;

/// How long a retired session may keep talking before it counts as a
/// duplicate: the close itself (bounded by [`CLOSE_TIMEOUT`]), plus the turn
/// it cancels and the updates that end that turn.
const QUIET_AFTER_RETIRE: Duration = Duration::from_secs(20);

/// Once the agent confirmed the close: updates that were already in flight.
const QUIET_AFTER_CLOSE: Duration = Duration::from_secs(3);

/// Between two re-closes of a retired session that keeps talking.
const RECLOSE_COOLDOWN: Duration = Duration::from_secs(30);

/// How long `session/close` may take. claude-agent-acp answers once the turns
/// it cancels have ended, which it bounds at 5 s.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a closed session's own process gets to exit before it is ended.
#[cfg_attr(not(unix), allow(dead_code))]
const PROCESS_EXIT_GRACE: Duration = Duration::from_secs(5);

/// Between `SIGTERM` and `SIGKILL` for a process that had to be ended.
#[cfg_attr(not(unix), allow(dead_code))]
const SIGKILL_AFTER: Duration = Duration::from_secs(2);

/// How often the exit of a session's process is re-checked.
#[cfg_attr(not(unix), allow(dead_code))]
const PROCESS_POLL: Duration = Duration::from_millis(250);

/// What [`SessionLedger::sight`] made of a message that names a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Sighting {
    /// Not a session codeg retired: none of this module's business.
    NotRetired,
    /// Retired, and still inside the window its close needs: drop it quietly.
    Expected,
    /// Retired, and still talking after that window: a second live copy.
    Duplicate {
        /// The session that replaced it, when codeg knows.
        replaced_by: Option<String>,
        /// Messages it sent after its quiet window, this one included.
        count: u64,
        /// Whether to close it again now (the first time, then once per
        /// [`RECLOSE_COOLDOWN`]).
        reclose: bool,
    },
}

#[derive(Debug)]
struct Retired {
    replaced_by: Option<String>,
    quiet_until: Instant,
    last_close: Instant,
    duplicates: u64,
}

/// The sessions one connection retired in its agent process. One per
/// `run_connection`, i.e. per agent process: a restarted process starts with
/// none, because it never opened them.
#[derive(Debug)]
pub(crate) struct SessionLedger {
    /// The agent process's pid cell (0 while unknown or reaped).
    agent_pid: Arc<AtomicU32>,
    supports_close: AtomicBool,
    retired: Mutex<HashMap<String, Retired>>,
}

impl SessionLedger {
    pub(crate) fn new(agent_pid: Arc<AtomicU32>) -> Arc<Self> {
        Arc::new(Self {
            agent_pid,
            supports_close: AtomicBool::new(false),
            retired: Mutex::new(HashMap::new()),
        })
    }

    /// Record what `initialize` said: does the agent offer `session/close`?
    pub(crate) fn set_supports_close(&self, supported: bool) {
        self.supports_close.store(supported, Ordering::SeqCst);
    }

    pub(crate) fn supports_close(&self) -> bool {
        self.supports_close.load(Ordering::SeqCst)
    }

    fn agent_pid(&self) -> u32 {
        self.agent_pid.load(Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Retired>> {
        self.retired
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// codeg stops using `session_id` on this connection (`replaced_by` took
    /// over the conversation). From now on every message it sends is claimed
    /// by [`RetiredSessionGuard`].
    pub(crate) fn retire(&self, session_id: &str, replaced_by: Option<&str>, now: Instant) {
        self.lock().insert(
            session_id.to_string(),
            Retired {
                replaced_by: replaced_by.map(str::to_string),
                quiet_until: now + QUIET_AFTER_RETIRE,
                last_close: now,
                duplicates: 0,
            },
        );
    }

    /// The agent confirmed the close: whatever it still sends after the
    /// in-flight tail is a duplicate.
    fn note_closed(&self, session_id: &str, now: Instant) {
        if let Some(entry) = self.lock().get_mut(session_id) {
            entry.quiet_until = entry.quiet_until.min(now + QUIET_AFTER_CLOSE);
        }
    }

    #[cfg(test)]
    pub(crate) fn is_retired(&self, session_id: &str) -> bool {
        self.lock().contains_key(session_id)
    }

    /// Classify a message from `session_id` arriving at `now`.
    pub(crate) fn sight(&self, session_id: &str, now: Instant) -> Sighting {
        let mut retired = self.lock();
        let Some(entry) = retired.get_mut(session_id) else {
            return Sighting::NotRetired;
        };
        if now < entry.quiet_until {
            return Sighting::Expected;
        }
        entry.duplicates += 1;
        let reclose = entry.duplicates == 1 || now >= entry.last_close + RECLOSE_COOLDOWN;
        if reclose {
            entry.last_close = now;
        }
        Sighting::Duplicate {
            replaced_by: entry.replaced_by.clone(),
            count: entry.duplicates,
            reclose,
        }
    }
}

/// First-but-one in the connection's handler chain (after
/// `ClaimNullSessionIds`): it claims every message from a session codeg
/// retired on this connection, so none of them reaches a handler that would
/// act on it, and none is parked for a router that will never come.
pub(crate) struct RetiredSessionGuard {
    ledger: Arc<SessionLedger>,
    conn_id: String,
}

impl RetiredSessionGuard {
    pub(crate) fn new(ledger: Arc<SessionLedger>, conn_id: String) -> Self {
        Self { ledger, conn_id }
    }
}

impl HandleDispatchFrom<Agent> for RetiredSessionGuard {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        connection: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        let Some(session_id) = dispatch_session_id(&message).map(str::to_string) else {
            return Ok(Handled::No {
                message,
                retry: false,
            });
        };
        let sighting = self.ledger.sight(&session_id, Instant::now());
        if sighting == Sighting::NotRetired {
            return Ok(Handled::No {
                message,
                retry: false,
            });
        }
        if let Sighting::Duplicate {
            replaced_by,
            count,
            reclose,
        } = sighting
        {
            if reclose {
                tracing::warn!(
                    "[ACP] duplicate session: conn={} — the agent process is still running \
                     session {session_id} next to session {}, which replaced it ({count} \
                     message(s) since it was closed, latest {}); closing it again",
                    self.conn_id,
                    replaced_by.as_deref().unwrap_or("?"),
                    message_method(&message),
                );
                let cx = connection.clone();
                let ledger = Arc::clone(&self.ledger);
                let conn_id = self.conn_id.clone();
                let sid = session_id.clone();
                if let Err(e) = connection.spawn(async move {
                    close_retired_session(&cx, &ledger, &conn_id, &sid, replaced_by.as_deref())
                        .await;
                    Ok(())
                }) {
                    tracing::debug!("[ACP] could not schedule the re-close of {session_id}: {e}");
                }
            } else {
                tracing::debug!(
                    "[ACP] dropped {} from retired session {session_id} (conn={})",
                    message_method(&message),
                    self.conn_id
                );
            }
        }
        if let Dispatch::Request(request, responder) = message {
            // Never served: a closed session has no business reading files,
            // running commands or asking the user anything.
            if let Err(e) = responder.respond_with_error(
                agent_client_protocol::Error::invalid_params().data(format!(
                    "session {session_id} was closed by the client ({} refused)",
                    request.method()
                )),
            ) {
                tracing::debug!("[ACP] could not refuse a retired session's request: {e}");
            }
        }
        Ok(Handled::Yes)
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "RetiredSessionGuard"
    }
}

fn message_method(message: &Dispatch) -> &str {
    match message {
        Dispatch::Request(m, _) | Dispatch::Notification(m) => m.method(),
        Dispatch::Response(..) => "response",
    }
}

/// How the agent was told to stop a retired session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseOutcome {
    /// `session/close` answered: the agent tore the session down.
    Closed,
    /// `session/close` errored; a `session/cancel` was sent instead.
    CloseFailed,
    /// `session/close` did not answer in time; a `session/cancel` was sent.
    CloseTimedOut,
    /// The agent offers no `session/close`; only `session/cancel` was sent.
    CancelOnly,
}

impl CloseOutcome {
    fn describe(self) -> &'static str {
        match self {
            Self::Closed => "session/close",
            Self::CloseFailed => "session/close failed, sent session/cancel",
            Self::CloseTimedOut => "session/close timed out, sent session/cancel",
            Self::CancelOnly => "session/cancel (the agent offers no session/close)",
        }
    }
}

/// Retire `old` in favour of `new` on this connection and close it on the
/// agent, in the background so the conversation's new session is not held up.
/// The handover point of every path that moves a connection to another session
/// id while the agent process stays (today: a fork in place).
pub(crate) fn hand_over(
    cx: &ConnectionTo<Agent>,
    ledger: &Arc<SessionLedger>,
    conn_id: &str,
    old: &str,
    new: &str,
) {
    if old == new {
        return;
    }
    ledger.retire(old, Some(new), Instant::now());
    let cx = cx.clone();
    let ledger = Arc::clone(ledger);
    let conn_id = conn_id.to_string();
    let old = old.to_string();
    let new = new.to_string();
    tokio::spawn(async move {
        close_retired_session(&cx, &ledger, &conn_id, &old, Some(new.as_str())).await;
    });
}

/// Close `session_id` on the agent and make sure its own process is gone.
/// Logs one line saying what it took.
pub(crate) async fn close_retired_session(
    cx: &ConnectionTo<Agent>,
    ledger: &SessionLedger,
    conn_id: &str,
    session_id: &str,
    live_session_id: Option<&str>,
) -> CloseOutcome {
    let outcome = if ledger.supports_close() {
        let request = CloseSessionRequest::new(SessionId::new(session_id.to_string()));
        match tokio::time::timeout(
            CLOSE_TIMEOUT,
            cx.send_request_to(Agent, request).block_task(),
        )
        .await
        {
            Ok(Ok(_)) => CloseOutcome::Closed,
            Ok(Err(e)) => {
                tracing::debug!("[ACP] session/close {session_id} failed: {e}");
                CloseOutcome::CloseFailed
            }
            Err(_) => CloseOutcome::CloseTimedOut,
        }
    } else {
        CloseOutcome::CancelOnly
    };
    if outcome == CloseOutcome::Closed {
        ledger.note_closed(session_id, Instant::now());
    } else if let Err(e) = cx.send_notification_to(
        Agent,
        CancelNotification::new(SessionId::new(session_id.to_string())),
    ) {
        tracing::debug!("[ACP] session/cancel {session_id} failed: {e}");
    }
    let ended = end_session_processes(ledger.agent_pid(), session_id, live_session_id).await;
    let replaced = live_session_id
        .map(|live| format!(", replaced by {live}"))
        .unwrap_or_default();
    if ended.is_empty() {
        tracing::info!(
            "[ACP] one session per conversation: closed session {session_id}{replaced} in the \
             agent process of conn={conn_id} ({})",
            outcome.describe()
        );
    } else {
        tracing::warn!(
            "[ACP] one session per conversation: closed session {session_id}{replaced} in the \
             agent process of conn={conn_id} ({}); its own process did not exit, ended pid(s) \
             {ended:?}",
            outcome.describe()
        );
    }
    outcome
}

/// The processes that belong to agent session `session_id` under the agent
/// process `root`, from a `ps -Ao pid=,ppid=,args=` listing: every descendant
/// of `root` whose command line names the session (claude-agent-acp starts
/// one Claude Code process per session, `--resume=<id>`), unless it also names
/// `live` — a process that names both is the live session's — plus everything
/// below each of them (their MCP servers, shells). Never `root` itself.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn session_process_pids(
    ps_output: &str,
    root: u32,
    session_id: &str,
    live: Option<&str>,
) -> Vec<u32> {
    if root == 0 || session_id.is_empty() {
        return Vec::new();
    }
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut args: HashMap<u32, &str> = HashMap::new();
    for line in ps_output.lines() {
        let line = line.trim_start();
        let Some((pid, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let rest = rest.trim_start();
        let (ppid, command) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
        args.insert(pid, command.trim());
    }
    let below = |start: u32| -> Vec<u32> {
        let mut seen = HashSet::new();
        let mut queue: VecDeque<u32> = children.get(&start).cloned().unwrap_or_default().into();
        let mut out = Vec::new();
        while let Some(pid) = queue.pop_front() {
            if pid == start || !seen.insert(pid) {
                continue;
            }
            out.push(pid);
            if let Some(next) = children.get(&pid) {
                queue.extend(next.iter().copied());
            }
        }
        out
    };
    let mut picked = HashSet::new();
    for pid in below(root) {
        let command = args.get(&pid).copied().unwrap_or("");
        let names_session = command.contains(session_id);
        let names_live = live.is_some_and(|l| !l.is_empty() && command.contains(l));
        if names_session && !names_live {
            picked.insert(pid);
            picked.extend(below(pid));
        }
    }
    picked.remove(&root);
    let mut out: Vec<u32> = picked.into_iter().collect();
    out.sort_unstable();
    out
}

#[cfg(unix)]
async fn session_processes_now(root: u32, session_id: &str, live: Option<&str>) -> Vec<u32> {
    let session_id = session_id.to_string();
    let live = live.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("ps")
            .args(["-Ao", "pid=,ppid=,args="])
            .output();
        match output {
            Ok(out) if out.status.success() => session_process_pids(
                &String::from_utf8_lossy(&out.stdout),
                root,
                &session_id,
                live.as_deref(),
            ),
            Ok(out) => {
                tracing::debug!("[ACP] ps exited with {}", out.status);
                Vec::new()
            }
            Err(e) => {
                tracing::debug!("[ACP] could not list processes: {e}");
                Vec::new()
            }
        }
    })
    .await
    .unwrap_or_default()
}

/// Wait up to [`PROCESS_EXIT_GRACE`] for agent session `session_id`'s own
/// processes under `root` to exit, and end the ones that do not (`SIGTERM`,
/// then `SIGKILL`). Returns the pids it had to end.
#[cfg(unix)]
pub(crate) async fn end_session_processes(
    root: u32,
    session_id: &str,
    live: Option<&str>,
) -> Vec<u32> {
    end_session_processes_within(root, session_id, live, PROCESS_EXIT_GRACE, SIGKILL_AFTER).await
}

#[cfg(unix)]
async fn end_session_processes_within(
    root: u32,
    session_id: &str,
    live: Option<&str>,
    grace: Duration,
    sigkill_after: Duration,
) -> Vec<u32> {
    if root == 0 {
        return Vec::new();
    }
    let deadline = Instant::now() + grace;
    let mut left = session_processes_now(root, session_id, live).await;
    while !left.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(PROCESS_POLL).await;
        left = session_processes_now(root, session_id, live).await;
    }
    if left.is_empty() {
        return left;
    }
    signal_all(&left, libc::SIGTERM);
    let deadline = Instant::now() + sigkill_after;
    let mut alive = left.clone();
    while Instant::now() < deadline {
        alive.retain(|pid| pid_alive(*pid));
        if alive.is_empty() {
            return left;
        }
        tokio::time::sleep(PROCESS_POLL).await;
    }
    alive.retain(|pid| pid_alive(*pid));
    signal_all(&alive, libc::SIGKILL);
    left
}

#[cfg(not(unix))]
pub(crate) async fn end_session_processes(
    _root: u32,
    _session_id: &str,
    _live: Option<&str>,
) -> Vec<u32> {
    Vec::new()
}

#[cfg(unix)]
fn signal_all(pids: &[u32], signal: libc::c_int) {
    for &pid in pids {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            continue;
        };
        // SAFETY: `kill(2)` with a pid listed moments ago as a descendant of
        // the agent process; it touches no memory of ours.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only probes for existence; it sends no signal.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::CloseSessionResponse;
    use agent_client_protocol::{Channel, Client, Responder, UntypedMessage};

    fn ledger() -> Arc<SessionLedger> {
        SessionLedger::new(Arc::new(AtomicU32::new(0)))
    }

    #[test]
    fn an_unknown_session_is_not_this_modules_business() {
        let l = ledger();
        assert_eq!(l.sight("live", Instant::now()), Sighting::NotRetired);
    }

    #[test]
    fn a_retired_session_is_quiet_while_its_close_lands_then_a_duplicate() {
        let l = ledger();
        let t0 = Instant::now();
        l.retire("old", Some("new"), t0);
        assert!(l.is_retired("old"));
        assert_eq!(
            l.sight("old", t0 + Duration::from_secs(1)),
            Sighting::Expected
        );

        let late = t0 + QUIET_AFTER_RETIRE + Duration::from_secs(1);
        assert_eq!(
            l.sight("old", late),
            Sighting::Duplicate {
                replaced_by: Some("new".into()),
                count: 1,
                reclose: true
            }
        );
        // Still talking: counted, but not re-closed on every message.
        assert_eq!(
            l.sight("old", late + Duration::from_secs(1)),
            Sighting::Duplicate {
                replaced_by: Some("new".into()),
                count: 2,
                reclose: false
            }
        );
        // Once the cooldown is over it is closed again.
        assert!(matches!(
            l.sight("old", late + RECLOSE_COOLDOWN + Duration::from_secs(1)),
            Sighting::Duplicate {
                reclose: true,
                count: 3,
                ..
            }
        ));
    }

    #[test]
    fn a_confirmed_close_shortens_the_quiet_window() {
        let l = ledger();
        let t0 = Instant::now();
        l.retire("old", Some("new"), t0);
        l.note_closed("old", t0);
        assert_eq!(
            l.sight("old", t0 + Duration::from_secs(1)),
            Sighting::Expected
        );
        assert!(matches!(
            l.sight("old", t0 + QUIET_AFTER_CLOSE + Duration::from_millis(1)),
            Sighting::Duplicate { reclose: true, .. }
        ));
    }

    const PS: &str = "\
    1     0 /sbin/launchd
  100     1 codeg
  200   100 node claude-agent-acp
  210   200 claude --output-format stream-json --resume=old-1111
  211   210 codeg-mcp --stdio
  212   211 sleep 100
  220   200 claude --output-format stream-json --resume=new-2222
  221   220 codeg-mcp --stdio
  230   200 claude --resume new-2222 --fork-session old-1111
  300     1 claude --resume=old-1111
  garbage line
";

    #[test]
    fn the_session_process_is_found_by_its_id_under_the_agent_only() {
        // 210 and everything below it; not 300 (not under the agent), not 220
        // (the live session), not 230 (names the live session too).
        assert_eq!(
            session_process_pids(PS, 200, "old-1111", Some("new-2222")),
            vec![210, 211, 212]
        );
        // Without the live id, the process that names both would be picked.
        assert_eq!(
            session_process_pids(PS, 200, "old-1111", None),
            vec![210, 211, 212, 230]
        );
        // Unknown root, empty id: nothing.
        assert!(session_process_pids(PS, 0, "old-1111", None).is_empty());
        assert!(session_process_pids(PS, 200, "", None).is_empty());
        // The agent process itself is never picked, even if it names the id.
        assert!(
            session_process_pids("5 1 node --resume=old-1111\n", 5, "old-1111", None).is_empty()
        );
    }

    /// The fallback that ends a session's process when the close did not:
    /// a real process tree, the retired session's branch is ended (with its
    /// child), the live session's branch is left alone.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_retired_sessions_process_that_outlives_the_close_is_ended() {
        let mut agent = std::process::Command::new("sh")
            .arg("-c")
            .arg(
                "sh -c 'sleep 60; true' retired-5f1c & \
                 sh -c 'sleep 60; true' live-9a2e & \
                 wait",
            )
            .spawn()
            .expect("spawn the stand-in agent");
        let root = agent.id();
        // Let the stand-in start its two session processes.
        let mut found = Vec::new();
        for _ in 0..50 {
            found = session_processes_now(root, "retired-5f1c", Some("live-9a2e")).await;
            if found.len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            found.len() >= 2,
            "the retired branch and its sleep: {found:?}"
        );
        let live = session_processes_now(root, "live-9a2e", None).await;
        assert!(!live.is_empty());

        let ended = end_session_processes_within(
            root,
            "retired-5f1c",
            Some("live-9a2e"),
            Duration::from_millis(200),
            SIGKILL_AFTER,
        )
        .await;
        assert_eq!(ended, found);
        for pid in &found {
            let mut gone = false;
            for _ in 0..100 {
                if !pid_alive(*pid)
                    || session_processes_now(root, "retired-5f1c", None)
                        .await
                        .is_empty()
                {
                    gone = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(gone, "pid {pid} survived");
        }
        assert_eq!(session_processes_now(root, "live-9a2e", None).await, live);

        let _ = agent.kill();
        let _ = agent.wait();
        signal_all(&live, libc::SIGKILL);
    }

    /// A client connection with the guard in front, over an in-memory pipe,
    /// and an agent that records the `session/close`s it gets.
    async fn run_guarded<T>(
        ledger: Arc<SessionLedger>,
        agent_side: impl AsyncFnOnce(ConnectionTo<Client>) -> Result<T, agent_client_protocol::Error>,
    ) -> (T, Vec<String>) {
        let (client_end, agent_end) = Channel::duplex();
        let closes = Arc::new(Mutex::new(Vec::new()));
        let client = tokio::spawn(
            Client
                .builder()
                .with_handler(RetiredSessionGuard::new(ledger, "conn-test".into()))
                .connect_with(client_end, async |_cx: ConnectionTo<Agent>| {
                    std::future::pending::<Result<(), agent_client_protocol::Error>>().await
                }),
        );
        let recorded = Arc::clone(&closes);
        let out = Agent
            .builder()
            .on_receive_request(
                async move |req: CloseSessionRequest,
                            responder: Responder<CloseSessionResponse>,
                            _cx: ConnectionTo<Client>| {
                    recorded.lock().unwrap().push(req.session_id.0.to_string());
                    responder.respond(CloseSessionResponse::new())
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent_end, agent_side)
            .await
            .expect("agent connection");
        client.abort();
        let closes = closes.lock().unwrap().clone();
        (out, closes)
    }

    fn update(session_id: &str) -> Result<UntypedMessage, agent_client_protocol::Error> {
        UntypedMessage::new(
            "session/update",
            serde_json::json!({
                "sessionId": session_id,
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}
            }),
        )
    }

    /// The incident shape: a session codeg handed over keeps running a prompt
    /// of its own. Its terminal request is refused (never served), and since
    /// its quiet window is over it is closed again on the agent.
    #[tokio::test]
    async fn a_retired_session_that_keeps_working_is_refused_and_closed_again() {
        let l = ledger();
        l.set_supports_close(true);
        l.retire(
            "old",
            Some("new"),
            Instant::now() - QUIET_AFTER_RETIRE - Duration::from_secs(1),
        );
        let (answer, closes) = run_guarded(Arc::clone(&l), async |cx: ConnectionTo<Client>| {
            cx.send_notification_to(Client, update("old")?)?;
            let request = UntypedMessage::new(
                "terminal/create",
                serde_json::json!({"sessionId": "old", "command": "make"}),
            )?;
            let answer = tokio::time::timeout(
                Duration::from_secs(5),
                cx.send_request_to(Client, request).block_task(),
            )
            .await;
            // Give the spawned re-close time to reach us.
            tokio::time::sleep(Duration::from_millis(300)).await;
            Ok(answer)
        })
        .await;
        let error = answer
            .expect("the request is answered, not parked")
            .expect_err("a retired session's request is refused");
        assert!(
            matches!(
                error.code,
                agent_client_protocol::schema::v1::ErrorCode::InvalidParams
            ),
            "{error}"
        );
        assert_eq!(closes, vec!["old".to_string()]);
        assert!(matches!(
            l.sight("old", Instant::now()),
            Sighting::Duplicate { count: 3, .. }
        ));
    }

    /// Messages for any other session pass the guard untouched: the live
    /// session's request reaches the next handler (here none, so the runtime
    /// parks it rather than the guard refusing it).
    #[tokio::test]
    async fn the_live_session_is_untouched() {
        let l = ledger();
        l.set_supports_close(true);
        l.retire("old", Some("new"), Instant::now());
        let (answer, closes) = run_guarded(Arc::clone(&l), async |cx: ConnectionTo<Client>| {
            let request = UntypedMessage::new(
                "terminal/create",
                serde_json::json!({"sessionId": "new", "command": "make"}),
            )?;
            Ok(tokio::time::timeout(
                Duration::from_millis(500),
                cx.send_request_to(Client, request).block_task(),
            )
            .await)
        })
        .await;
        assert!(
            answer.is_err(),
            "the live session's request is not refused by the guard"
        );
        assert!(closes.is_empty());
    }

    /// The handover itself (what a fork in place calls): the replaced session
    /// is retired at once and closed on the agent with `session/close`.
    #[tokio::test]
    async fn a_handover_closes_the_replaced_session_on_the_agent() {
        let l = ledger();
        l.set_supports_close(true);
        let ledger_for_client = Arc::clone(&l);
        let (client_end, agent_end) = Channel::duplex();
        let closes = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&closes);
        let agent = tokio::spawn(
            Agent
                .builder()
                .on_receive_request(
                    async move |req: CloseSessionRequest,
                                responder: Responder<CloseSessionResponse>,
                                _cx: ConnectionTo<Client>| {
                        recorded.lock().unwrap().push(req.session_id.0.to_string());
                        responder.respond(CloseSessionResponse::new())
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_to(agent_end),
        );
        Client
            .builder()
            .with_handler(RetiredSessionGuard::new(Arc::clone(&l), "conn-test".into()))
            .connect_with(client_end, async move |cx: ConnectionTo<Agent>| {
                hand_over(&cx, &ledger_for_client, "conn-test", "parent", "fork");
                for _ in 0..100 {
                    if !closes.lock().unwrap().is_empty() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                assert_eq!(*closes.lock().unwrap(), vec!["parent".to_string()]);
                Ok(())
            })
            .await
            .expect("client connection");
        assert!(l.is_retired("parent"));
        assert!(!l.is_retired("fork"));
        agent.abort();
    }

    /// An agent without `session/close` gets a `session/cancel` instead.
    #[tokio::test]
    async fn without_session_close_the_replaced_session_is_cancelled() {
        let l = ledger();
        let (client_end, agent_end) = Channel::duplex();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let tx = Mutex::new(Some(tx));
        let agent = tokio::spawn(
            Agent
                .builder()
                .on_receive_notification(
                    async move |n: CancelNotification, _cx: ConnectionTo<Client>| {
                        if let Some(tx) = tx.lock().unwrap().take() {
                            let _ = tx.send(n.session_id.0.to_string());
                        }
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_to(agent_end),
        );
        let outcome = Client
            .builder()
            .connect_with(client_end, async |cx: ConnectionTo<Agent>| {
                l.retire("parent", Some("fork"), Instant::now());
                Ok(close_retired_session(&cx, &l, "conn-test", "parent", Some("fork")).await)
            })
            .await
            .expect("client connection");
        assert_eq!(outcome, CloseOutcome::CancelOnly);
        let cancelled = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .expect("the agent got a cancel")
            .expect("cancel sender");
        assert_eq!(cancelled, "parent");
        agent.abort();
    }
}
