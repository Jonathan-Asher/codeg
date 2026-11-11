//! Drives an interactive sign-in CLI through a pseudo-terminal, for the flows
//! a remote user finishes by pasting.
//!
//! The shape is the same for every CLI this serves (`claude auth login`,
//! `maxpool login`): the CLI prints a link, waits on its terminal for a code
//! (or the address the browser was sent back to), then exchanges it and says
//! whether that worked. The person signing in is often not at the machine the
//! CLI runs on, so codeg runs it here, shows the link in its own UI, and types
//! the pasted answer into the CLI's terminal for them.
//!
//! A real terminal rather than pipes, because some of these CLIs only offer
//! the paste prompt when their stdin is a TTY (`maxpool login` races the
//! paste against its loopback callback only then).
//!
//! # Secrets
//!
//! A terminal echoes what is typed, so the CLI's output holds the pasted code
//! once it is sent, and a CLI may print anything else it likes. The output is
//! therefore only ever matched against, here: it is never logged, returned to
//! a client or kept past the flow. Callers get the link they asked for and a
//! verdict, nothing else.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::Notify;

/// Output kept per flow. A sign-in CLI prints a few lines; anything past this
/// is a CLI gone wrong, and the link it printed first is all that matters.
const OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// How often a waiter re-checks whether the child exited. The reader thread
/// wakes it on output; an exit without output needs the poll.
const EXIT_POLL: Duration = Duration::from_millis(100);

/// Longest single line a paste may be. A code, or a redirect address with its
/// query string, fits several times over.
pub const PASTE_MAX_CHARS: usize = 4096;

/// What to run.
#[derive(Debug, Clone, Default)]
pub struct FlowSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Set on top of codeg's own environment.
    pub env: Vec<(String, String)>,
    /// Removed from it.
    pub env_remove: Vec<String>,
    pub cwd: Option<PathBuf>,
}

struct OutputState {
    raw: Vec<u8>,
    eof: bool,
}

struct Output {
    state: StdMutex<OutputState>,
    changed: Notify,
}

impl Output {
    fn snapshot(&self) -> (String, bool) {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (
            strip_terminal_codes(&String::from_utf8_lossy(&state.raw)),
            state.eof,
        )
    }
}

/// How a wait ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Waited<T> {
    Found(T),
    /// The CLI exited (or closed its terminal) without producing it.
    Exited(Option<u32>),
    TimedOut,
}

/// One running CLI on its own terminal.
pub struct PtyFlow {
    child: Box<dyn Child + Send + Sync>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    writer: Box<dyn Write + Send>,
    output: Arc<Output>,
    exit: Option<u32>,
    // Held so the terminal stays open for the child's lifetime: dropping the
    // master hangs the terminal up, which ends the CLI.
    _master: Box<dyn MasterPty + Send>,
}

impl std::fmt::Debug for PtyFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyFlow")
            .field("pid", &self.child.process_id())
            .field("exit", &self.exit)
            .finish()
    }
}

impl PtyFlow {
    /// Start `spec` on a new terminal.
    pub fn spawn(spec: &FlowSpec) -> Result<Self, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 40,
                // Wide, so a long sign-in link is printed on one line rather
                // than wrapped by a CLI that formats for the terminal width.
                cols: 1000,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("could not open a terminal: {e}"))?;
        let mut cmd = CommandBuilder::new(&spec.program);
        for arg in &spec.args {
            cmd.arg(arg);
        }
        for key in &spec.env_remove {
            cmd.env_remove(key);
        }
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        // Plain output: no color, no progress animation to match through.
        cmd.env("NO_COLOR", "1");
        cmd.env("TERM", "dumb");
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {}: {e}", spec.program.display()))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("could not write to the terminal: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("could not read the terminal: {e}"))?;
        let output = Arc::new(Output {
            state: StdMutex::new(OutputState {
                raw: Vec::new(),
                eof: false,
            }),
            changed: Notify::new(),
        });
        let sink = Arc::clone(&output);
        std::thread::Builder::new()
            .name("pty-flow-reader".to_string())
            .spawn(move || read_into(reader, &sink))
            .map_err(|e| format!("could not start the terminal reader: {e}"))?;
        Ok(Self {
            child,
            killer,
            writer,
            output,
            exit: None,
            _master: pair.master,
        })
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    /// Everything the CLI printed so far, terminal codes removed. Only to be
    /// matched against — see the module docs.
    pub fn output(&self) -> String {
        self.output.snapshot().0
    }

    /// The exit code, once the CLI has exited.
    pub fn try_exit(&mut self) -> Option<u32> {
        if self.exit.is_none() {
            if let Ok(Some(status)) = self.child.try_wait() {
                self.exit = Some(status.exit_code());
            }
        }
        self.exit
    }

    /// Wait until `find` recognizes something in the output, the CLI exits,
    /// or `timeout` passes. `find` is checked once more after an exit, so the
    /// last thing a CLI printed before exiting is never missed.
    pub async fn wait_for<T>(
        &mut self,
        timeout: Duration,
        mut find: impl FnMut(&str) -> Option<T>,
    ) -> Waited<T> {
        let deadline = Instant::now() + timeout;
        // Its own handle, so a pending wait doesn't hold a borrow of `self`.
        let output = Arc::clone(&self.output);
        loop {
            let notified = output.changed.notified();
            let (text, eof) = output.snapshot();
            if let Some(found) = find(&text) {
                return Waited::Found(found);
            }
            if let Some(code) = self.try_exit() {
                // The reader may still be draining what the CLI wrote last.
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Some(found) = find(&output.snapshot().0) {
                    return Waited::Found(found);
                }
                return Waited::Exited(Some(code));
            }
            if eof {
                // Terminal closed: the child is gone or about to be.
                let code = self.wait_exit(Duration::from_millis(500)).await;
                if let Some(found) = find(&output.snapshot().0) {
                    return Waited::Found(found);
                }
                return Waited::Exited(code);
            }
            let now = Instant::now();
            if now >= deadline {
                return Waited::TimedOut;
            }
            let step = (deadline - now).min(EXIT_POLL);
            let _ = tokio::time::timeout(step, notified).await;
        }
    }

    /// Wait for the CLI to exit, up to `timeout`.
    pub async fn wait_exit(&mut self, timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(code) = self.try_exit() {
                return Some(code);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(EXIT_POLL).await;
        }
    }

    /// Type `text` and press Enter.
    pub fn send_line(&mut self, text: &str) -> std::io::Result<()> {
        self.writer.write_all(text.as_bytes())?;
        self.writer.write_all(b"\r")?;
        self.writer.flush()
    }

    /// End the CLI and everything it started.
    pub async fn kill(&mut self) {
        if self.try_exit().is_some() {
            return;
        }
        if let Some(pid) = self.child.process_id() {
            let config = kill_tree::Config {
                signal: "SIGTERM".to_string(),
                include_target: true,
            };
            let _ = kill_tree::tokio::kill_tree_with_config(pid, &config).await;
        }
        let _ = self.killer.kill();
        if self.wait_exit(Duration::from_secs(2)).await.is_none() {
            if let Some(pid) = self.child.process_id() {
                let _ = kill_tree::tokio::kill_tree(pid).await;
            }
        }
    }
}

impl Drop for PtyFlow {
    fn drop(&mut self) {
        // Best effort for a flow dropped without `kill` (an expired or
        // abandoned one): the hang-up from dropping the master does the rest.
        if self.try_exit().is_none() {
            let _ = self.killer.kill();
        }
    }
}

fn read_into(mut reader: Box<dyn Read + Send>, sink: &Output) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                {
                    let mut state = sink.state.lock().unwrap_or_else(|e| e.into_inner());
                    let room = OUTPUT_CAP_BYTES.saturating_sub(state.raw.len());
                    let take = n.min(room);
                    state.raw.extend_from_slice(&buf[..take]);
                }
                sink.changed.notify_waiters();
            }
        }
    }
    sink.state.lock().unwrap_or_else(|e| e.into_inner()).eof = true;
    sink.changed.notify_waiters();
}

/// `raw` with terminal control sequences removed: CSI (`ESC [ … final`), OSC
/// (`ESC ] … BEL` or `ESC ] … ESC \` — an OSC 8 hyperlink keeps its visible
/// text), other two-byte escapes, and carriage returns.
pub fn strip_terminal_codes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    // Parameters and intermediates, then one final byte.
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{07}' {
                            break;
                        }
                        if c == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\r' | '\u{07}' => {}
            c => out.push(c),
        }
    }
    out
}

/// The first `https://` link after `marker` in `text`, up to whitespace.
pub fn https_link_after(text: &str, marker: &str) -> Option<String> {
    let start = text.find(marker)? + marker.len();
    let rest = &text[start..];
    let at = rest.find("https://")?;
    let link: String = rest[at..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    (link.len() > "https://".len()).then_some(link)
}

/// Why a paste was refused before reaching the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteProblem {
    Empty,
    TooLong,
    /// Line breaks or other control characters: one line goes to the CLI, so
    /// a second could answer a prompt nobody has seen.
    Control,
}

/// The paste, trimmed, if it can be typed into a CLI as one line.
pub fn clean_paste(raw: &str) -> Result<String, PasteProblem> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PasteProblem::Empty);
    }
    if trimmed.chars().count() > PASTE_MAX_CHARS {
        return Err(PasteProblem::TooLong);
    }
    if trimmed.chars().any(char::is_control) {
        return Err(PasteProblem::Control);
    }
    Ok(trimmed.to_string())
}

// ─── Pending flows ──────────────────────────────────────────────────────

/// Flows waiting for the user's paste, keyed by an unguessable handle.
///
/// At most `capacity` at once: starting another ends the oldest, so an
/// abandoned sign-in tab can't pile up CLI processes. Each expires after its
/// `ttl`, when the CLI's own wait is about to run out anyway.
///
/// A flow being answered is taken out (so two pastes can't race into one
/// CLI) and marked busy until it is put back or done with, so a client
/// asking after it meanwhile hears "still going", not "gone".
pub struct PendingFlows<M> {
    inner: tokio::sync::Mutex<HashMap<String, Pending<M>>>,
    busy: Arc<StdMutex<HashSet<String>>>,
    capacity: usize,
    ttl: Duration,
}

struct Pending<M> {
    flow: PtyFlow,
    meta: M,
    created: Instant,
}

/// A flow taken out to be answered. Dropping it (instead of
/// [`PendingFlows::put_back`]) ends the busy mark; the flow itself then ends
/// with it unless it was already over.
pub struct Taken<M> {
    pub flow: PtyFlow,
    pub meta: M,
    handle: String,
    created: Instant,
    _answering: Answering,
}

struct Answering {
    busy: Arc<StdMutex<HashSet<String>>>,
    handle: String,
}

impl Drop for Answering {
    fn drop(&mut self) {
        self.busy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.handle);
    }
}

/// What [`PendingFlows::peek`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Peeked<R> {
    /// The flow is parked; here is what the closure made of it.
    Parked(R),
    /// Someone is answering it right now.
    Busy,
    /// No such flow: finished, cancelled, expired, or never was.
    Gone,
}

impl<M> PendingFlows<M> {
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(HashMap::new()),
            busy: Arc::new(StdMutex::new(HashSet::new())),
            capacity: capacity.max(1),
            ttl,
        }
    }

    /// Park `flow` and hand back its handle.
    pub async fn insert(&self, flow: PtyFlow, meta: M) -> String {
        let handle = uuid::Uuid::new_v4().simple().to_string();
        let mut evicted = Vec::new();
        {
            let mut map = self.inner.lock().await;
            evicted.extend(drain_expired(&mut map, self.ttl));
            while map.len() >= self.capacity {
                let Some(oldest) = map
                    .iter()
                    .min_by_key(|(_, p)| p.created)
                    .map(|(k, _)| k.clone())
                else {
                    break;
                };
                if let Some(p) = map.remove(&oldest) {
                    evicted.push(p.flow);
                }
            }
            map.insert(
                handle.clone(),
                Pending {
                    flow,
                    meta,
                    created: Instant::now(),
                },
            );
        }
        for mut flow in evicted {
            flow.kill().await;
        }
        handle
    }

    /// Take the flow out, so only one caller can answer it. `None` for an
    /// unknown or expired handle.
    pub async fn take(&self, handle: &str) -> Option<Taken<M>> {
        let (taken, expired) = {
            let mut map = self.inner.lock().await;
            let expired = drain_expired(&mut map, self.ttl);
            let taken = map.remove(handle);
            if taken.is_some() {
                // Marked under the map lock, so a peek never sees it in
                // neither place.
                self.busy
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(handle.to_string());
            }
            (taken, expired)
        };
        for mut flow in expired {
            flow.kill().await;
        }
        taken.map(|p| Taken {
            flow: p.flow,
            meta: p.meta,
            handle: handle.to_string(),
            created: p.created,
            _answering: Answering {
                busy: Arc::clone(&self.busy),
                handle: handle.to_string(),
            },
        })
    }

    /// Put a flow back after a paste the CLI asked to have again. Keeps its
    /// original start, so a re-parked flow still expires on time.
    pub async fn put_back(&self, taken: Taken<M>) {
        let Taken {
            flow,
            meta,
            handle,
            created,
            _answering,
        } = taken;
        self.inner.lock().await.insert(
            handle,
            Pending {
                flow,
                meta,
                created,
            },
        );
        drop(_answering);
    }

    /// Look at a parked flow without taking it out.
    pub async fn peek<R>(&self, handle: &str, f: impl FnOnce(&mut PtyFlow) -> R) -> Peeked<R> {
        let (found, expired) = {
            let mut map = self.inner.lock().await;
            let expired = drain_expired(&mut map, self.ttl);
            let found = match map.get_mut(handle) {
                Some(pending) => Peeked::Parked(f(&mut pending.flow)),
                None if self
                    .busy
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(handle) =>
                {
                    Peeked::Busy
                }
                None => Peeked::Gone,
            };
            (found, expired)
        };
        for mut flow in expired {
            flow.kill().await;
        }
        found
    }

    /// End a flow. `false` when there was none under `handle`.
    pub async fn cancel(&self, handle: &str) -> bool {
        match self.take(handle).await {
            Some(mut taken) => {
                taken.flow.kill().await;
                true
            }
            None => false,
        }
    }

    #[cfg(test)]
    pub async fn parked_count(&self) -> usize {
        self.inner.lock().await.len()
    }
}

fn drain_expired<M>(map: &mut HashMap<String, Pending<M>>, ttl: Duration) -> Vec<PtyFlow> {
    let stale: Vec<String> = map
        .iter()
        .filter(|(_, p)| p.created.elapsed() >= ttl)
        .map(|(k, _)| k.clone())
        .collect();
    stale
        .into_iter()
        .filter_map(|k| map.remove(&k).map(|p| p.flow))
        .collect()
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Write an executable `/bin/sh` script into `dir` and return its path.
    pub(crate) fn script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn spec(program: PathBuf) -> FlowSpec {
        FlowSpec {
            program,
            ..FlowSpec::default()
        }
    }

    const LOGIN: &str = r#"printf 'Opening browser to sign in\n'
printf "If the browser didn't open, visit: \033]8;;https://example.test/authorize?code=true&state=s1\007https://example.test/authorize?code=true&state=s1\033]8;;\007\n"
printf 'Paste code here if prompted > '
read code
case "$code" in
  good#s1) printf 'Login successful.\n'; exit 0 ;;
  *) printf 'Login failed: Request failed with status code 400\n' >&2; exit 1 ;;
esac"#;

    #[test]
    fn strips_csi_osc_and_carriage_returns() {
        let raw = "\x1b[1mbold\x1b[0m\r\nvisit: \x1b]8;;https://a.test/x\x07https://a.test/x\x1b]8;;\x07 \x1b]0;title\x1b\\end";
        assert_eq!(
            strip_terminal_codes(raw),
            "bold\nvisit: https://a.test/x end"
        );
    }

    #[test]
    fn finds_the_link_after_its_marker_only() {
        let text = "noise https://wrong.test\nvisit: https://right.test/a?b=c&d=e\nPaste >";
        assert_eq!(
            https_link_after(text, "visit:").as_deref(),
            Some("https://right.test/a?b=c&d=e")
        );
        assert_eq!(https_link_after(text, "absent:"), None);
        assert_eq!(https_link_after("visit: https://", "visit:"), None);
    }

    #[test]
    fn paste_is_one_bounded_line() {
        assert_eq!(clean_paste("  abc#def \n").as_deref(), Ok("abc#def"));
        assert_eq!(clean_paste("   "), Err(PasteProblem::Empty));
        assert_eq!(clean_paste("a\nb"), Err(PasteProblem::Control));
        assert_eq!(clean_paste("a\u{1b}b"), Err(PasteProblem::Control));
        let long = "x".repeat(PASTE_MAX_CHARS + 1);
        assert_eq!(clean_paste(&long), Err(PasteProblem::TooLong));
    }

    #[tokio::test]
    async fn drives_a_login_through_its_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let mut flow = PtyFlow::spawn(&spec(script(dir.path(), "login", LOGIN))).unwrap();
        let link = flow
            .wait_for(Duration::from_secs(10), |t| {
                https_link_after(t, "visit:").filter(|_| t.contains("Paste code here"))
            })
            .await;
        assert_eq!(
            link,
            Waited::Found("https://example.test/authorize?code=true&state=s1".to_string())
        );
        flow.send_line("good#s1").unwrap();
        let verdict = flow
            .wait_for(Duration::from_secs(10), |t| {
                t.contains("Login successful.").then_some(())
            })
            .await;
        assert_eq!(verdict, Waited::Found(()));
        assert_eq!(flow.wait_exit(Duration::from_secs(5)).await, Some(0));
    }

    #[tokio::test]
    async fn a_bad_code_ends_in_a_failed_exit() {
        let dir = tempfile::tempdir().unwrap();
        let mut flow = PtyFlow::spawn(&spec(script(dir.path(), "login", LOGIN))).unwrap();
        let _ = flow
            .wait_for(Duration::from_secs(10), |t| {
                t.contains("Paste code").then_some(())
            })
            .await;
        flow.send_line("bad#s1").unwrap();
        let verdict = flow
            .wait_for(Duration::from_secs(10), |t| {
                t.contains("Login successful.").then_some(())
            })
            .await;
        assert_eq!(verdict, Waited::Exited(Some(1)));
        assert!(flow.output().contains("Login failed"));
    }

    #[tokio::test]
    async fn a_silent_cli_times_out_and_can_be_killed() {
        let dir = tempfile::tempdir().unwrap();
        let mut flow = PtyFlow::spawn(&spec(script(dir.path(), "silent", "sleep 30"))).unwrap();
        let waited = flow
            .wait_for(Duration::from_millis(300), |t| {
                t.contains("never").then_some(())
            })
            .await;
        assert_eq!(waited, Waited::TimedOut);
        flow.kill().await;
        assert!(flow.try_exit().is_some(), "the CLI must be gone after kill");
    }

    #[tokio::test]
    async fn a_cli_that_dies_early_reports_its_exit() {
        let dir = tempfile::tempdir().unwrap();
        let mut flow = PtyFlow::spawn(&spec(script(
            dir.path(),
            "dies",
            "printf 'Error: not configured\\n'; exit 3",
        )))
        .unwrap();
        let waited = flow
            .wait_for(Duration::from_secs(10), |t| {
                t.contains("visit:").then_some(())
            })
            .await;
        assert_eq!(waited, Waited::Exited(Some(3)));
    }

    #[tokio::test]
    async fn pending_flows_answer_once_cancel_and_evict_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(dir.path(), "wait", "sleep 30");
        let pending: PendingFlows<&'static str> = PendingFlows::new(1, Duration::from_secs(60));
        let first = pending
            .insert(PtyFlow::spawn(&spec(program.clone())).unwrap(), "first")
            .await;
        let second = pending
            .insert(PtyFlow::spawn(&spec(program.clone())).unwrap(), "second")
            .await;
        assert_eq!(pending.parked_count().await, 1, "capacity 1 evicts the older flow");
        assert!(pending.take(&first).await.is_none());
        let mut taken = pending.take(&second).await.unwrap();
        assert_eq!(taken.meta, "second");
        assert!(
            pending.take(&second).await.is_none(),
            "a flow is answered once"
        );
        // While it is being answered, a client asking after it hears "busy".
        assert_eq!(pending.peek(&second, |_| ()).await, Peeked::Busy);
        pending.put_back(taken).await;
        assert_eq!(pending.peek(&second, |_| 7).await, Peeked::Parked(7));
        taken = pending.take(&second).await.unwrap();
        taken.flow.kill().await;
        drop(taken);
        assert_eq!(pending.peek(&second, |_| ()).await, Peeked::Gone);

        let third = pending
            .insert(PtyFlow::spawn(&spec(program)).unwrap(), "third")
            .await;
        assert!(pending.cancel(&third).await);
        assert!(!pending.cancel(&third).await);
    }

    #[tokio::test]
    async fn pending_flows_expire() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(dir.path(), "wait", "sleep 30");
        let pending: PendingFlows<()> = PendingFlows::new(4, Duration::from_millis(50));
        let handle = pending
            .insert(PtyFlow::spawn(&spec(program)).unwrap(), ())
            .await;
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(pending.take(&handle).await.is_none());
    }
}
