//! Pi's background work, read from its own files — best effort.
//!
//! Pi reports neither kind of its background work to codeg live: pi-acp ends
//! the ACP turn when Pi first goes idle and drops the extensions' notices.
//! What it does write is its session transcript, and that is enough to tell
//! what a live Pi session still has running:
//!
//! * **bg-jobs** (`bgj_run`): the launch's result names the job
//!   (`details.id`); the job is over once its completion report lands (a user
//!   message `✅|🛑|❌ Background job … [<id>]`), a `bgj_status` / `bgj_wait` /
//!   `bgj_kill` result shows it ended, or the extension's registry
//!   (`~/.pi/agent/bg-jobs/jobs.json`) records its exit — and only while its
//!   process (the registry's pid, else the launch's) is alive. These jobs are
//!   detached and outlive Pi, but a restart takes away the session that waits
//!   for their reports.
//! * **pi-subagents async runs** (`subagent` with `async: true`): the
//!   launch's result names the run (`details.asyncId`); it is over once a
//!   `subagent-notify` notice mentions it. Its state lives under the
//!   connection's scratch directory, which a restart removes.
//!
//! Only the transcript's tail is read, and only again once it changed.
//! Structured events from pi-acp are planned
//! (`~/.claude/plans/pi-subagents-ux.md`); this is the stop-gap.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{BackgroundSnapshotItem, KIND_PI_JOB, KIND_PI_SUBAGENT};
use crate::acp::manager::ConnectionManager;
use crate::acp::types::ConnectionStatus;
use crate::models::AgentType;
use crate::parsers::detail_cache::FileStamp;

/// The tail of a transcript that is read. A launch further back than this is
/// not seen.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// An async run launched longer ago than this with no notice is taken as
/// lost, not running: nothing else bounds it.
const RUN_MAX_AGE_HOURS: i64 = 12;

/// The report the bg-jobs extension sends the session when a job ends.
const JOB_REPORT_HEADS: [&str; 3] = [
    "✅ Background job",
    "🛑 Background job",
    "❌ Background job",
];

/// The bg-jobs registry: job id → (`exitedAtMs` set, pid).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobsRegistry {
    jobs: HashMap<String, RegistryJob>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegistryJob {
    exited: bool,
    pid: Option<i32>,
}

impl JobsRegistry {
    pub fn parse(raw: &str) -> Self {
        let mut jobs = HashMap::new();
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
            for (id, job) in map {
                let exited = job.get("exitedAtMs").is_some_and(|v| !v.is_null())
                    || job.get("killedBy").is_some_and(|v| !v.is_null());
                let pid = job
                    .get("pid")
                    .and_then(Value::as_i64)
                    .and_then(|p| i32::try_from(p).ok())
                    .filter(|p| *p > 0);
                jobs.insert(id, RegistryJob { exited, pid });
            }
        }
        Self { jobs }
    }

    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(raw) => Self::parse(&raw),
            Err(_) => Self::default(),
        }
    }

    /// Whether job `id` may still run: the registry has not recorded its end,
    /// and its process — the registry's pid, else the one its launch reported
    /// — is alive (`alive` answers for a pid). Every Pi process rewrites the
    /// registry from its own copy, so a job missing from it says nothing; its
    /// process still does.
    fn may_run(&self, id: &str, launch_pid: Option<i32>, alive: &dyn Fn(i32) -> bool) -> bool {
        let job = self.jobs.get(id);
        if job.is_some_and(|j| j.exited) {
            return false;
        }
        match job.and_then(|j| j.pid).or(launch_pid) {
            Some(pid) => alive(pid),
            None => true,
        }
    }
}

/// Whether process `pid` exists.
fn pid_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks the target exists and may be signalled.
        let rc = unsafe { libc::kill(pid, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn record_time(value: &Value) -> Option<DateTime<Utc>> {
    crate::parsers::claude::record_timestamp(value)
}

fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The job id in a launch's text, for a result without `details`
/// ("Command running in background with ID: jb-…").
fn job_id_in_text(text: &str) -> Option<String> {
    let at = text.find("with ID: ")? + "with ID: ".len();
    let id: String = text[at..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!id.is_empty()).then_some(id)
}

/// The job ids a completion report names (`[jb-…]`).
fn reported_job_ids(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        if let Some(end) = rest.find(']') {
            out.push(rest[..end].to_string());
        }
    }
    out
}

fn subagent_label(arguments: Option<&Value>) -> String {
    let field = |key: &str| {
        arguments
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    if let (Some(agent), Some(task)) = (field("agent"), field("task")) {
        return format!("{agent}: {task}");
    }
    if field("workflowScript").is_some() {
        return "workflow".to_string();
    }
    if let Some(n) = arguments
        .and_then(|a| a.get("tasks"))
        .and_then(Value::as_array)
        .map(Vec::len)
    {
        return format!("{n} parallel tasks");
    }
    if arguments.and_then(|a| a.get("chain")).is_some() {
        return "chain".to_string();
    }
    field("agent").unwrap_or_default().to_string()
}

/// What a transcript says still runs, given the registry. `lines` are the
/// transcript's records in order; `alive` answers whether a pid exists.
pub(crate) fn pending_work<'a>(
    lines: impl Iterator<Item = &'a str>,
    registry: &JobsRegistry,
    alive: &dyn Fn(i32) -> bool,
    now: DateTime<Utc>,
) -> Vec<BackgroundSnapshotItem> {
    // Launch calls, by tool-call id: (tool, label).
    let mut calls: HashMap<String, (String, String)> = HashMap::new();
    // In launch order, with the pid each launch reported.
    let mut jobs: Vec<(BackgroundSnapshotItem, Option<i32>)> = Vec::new();
    let mut runs: Vec<BackgroundSnapshotItem> = Vec::new();
    let mut ended: HashSet<String> = HashSet::new();
    let mut notices: Vec<String> = Vec::new();

    for line in lines {
        // Cheap filter before parsing: only the records that matter.
        if !(line.contains("bgj_")
            || line.contains("\"subagent")
            || line.contains("Background job"))
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("custom_message") => {
                if value.get("customType").and_then(Value::as_str) == Some("subagent-notify") {
                    notices.push(text_of(value.get("content")));
                }
                continue;
            }
            Some("message") => {}
            _ => continue,
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let at = record_time(&value);
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                for block in message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if block.get("type").and_then(Value::as_str) != Some("toolCall") {
                        continue;
                    }
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                    let Some(id) = block.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let arguments = block.get("arguments");
                    let label = match name {
                        "bgj_run" => arguments
                            .and_then(|a| a.get("command"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        "subagent" => subagent_label(arguments),
                        _ => continue,
                    };
                    calls.insert(id.to_string(), (name.to_string(), label));
                }
            }
            Some("toolResult") => {
                let tool = message
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let details = message.get("details");
                let call = message
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .and_then(|id| calls.get(id));
                match tool {
                    "bgj_run" => {
                        let id = details
                            .and_then(|d| d.get("id"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or_else(|| job_id_in_text(&text_of(message.get("content"))));
                        if let Some(id) = id {
                            let label = call.map(|(_, l)| l.as_str()).unwrap_or("");
                            let mut item = BackgroundSnapshotItem::new(KIND_PI_JOB, label);
                            item.id = Some(id);
                            item.started_at = at;
                            let pid = details
                                .and_then(|d| d.get("pid"))
                                .and_then(Value::as_i64)
                                .and_then(|p| i32::try_from(p).ok())
                                .filter(|p| *p > 0);
                            jobs.push((item, pid));
                        }
                    }
                    "subagent" => {
                        let Some(run) = details
                            .and_then(|d| d.get("asyncId"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        else {
                            continue;
                        };
                        let label = call.map(|(_, l)| l.as_str()).unwrap_or("");
                        let mut item = BackgroundSnapshotItem::new(KIND_PI_SUBAGENT, label);
                        item.id = Some(run.to_string());
                        item.started_at = at;
                        runs.push(item);
                    }
                    "bgj_status" | "bgj_wait" | "bgj_kill" => {
                        let job = details.and_then(|d| d.get("job"));
                        let state = job.and_then(|j| j.get("state")).and_then(Value::as_str);
                        if let (Some(id), Some(state)) =
                            (job.and_then(|j| j.get("id")).and_then(Value::as_str), state)
                        {
                            if state != "running" {
                                ended.insert(id.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("user") => {
                let text = text_of(message.get("content"));
                let head = text.trim_start();
                if JOB_REPORT_HEADS.iter().any(|h| head.starts_with(h)) {
                    ended.extend(reported_job_ids(&text));
                }
            }
            _ => {}
        }
    }

    let oldest_run = now - chrono::Duration::hours(RUN_MAX_AGE_HOURS);
    let mut out: Vec<BackgroundSnapshotItem> = jobs
        .into_iter()
        .filter(|(job, pid)| {
            let id = job.id.as_deref().unwrap_or("");
            !ended.contains(id) && registry.may_run(id, *pid, alive)
        })
        .map(|(job, _)| job)
        .collect();
    out.extend(runs.into_iter().filter(|run| {
        let id = run.id.as_deref().unwrap_or("");
        !notices.iter().any(|n| n.contains(id)) && run.started_at.is_none_or(|t| t >= oldest_run)
    }));
    // The same job or run launched twice is one item.
    let mut seen = HashSet::new();
    out.retain(|item| seen.insert((item.kind.clone(), item.id.clone())));
    out
}

/// Read the last [`TAIL_BYTES`] of a transcript, from the first whole line.
fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Ok(text);
    }
    // Skip the line the cut landed in.
    Ok(match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => String::new(),
    })
}

#[derive(Default)]
struct ScanState {
    /// Each session's transcript, once found.
    paths: HashMap<String, PathBuf>,
    /// The last scan of each transcript: its stamp, the registry's, the work.
    cache: HashMap<PathBuf, (FileStamp, Option<FileStamp>, Vec<BackgroundSnapshotItem>)>,
}

/// Reads the live Pi sessions' background work, re-reading a transcript only
/// once it (or the registry) changed.
#[derive(Clone)]
pub struct PiScanner {
    sessions_dir: PathBuf,
    registry: PathBuf,
    state: Arc<StdMutex<ScanState>>,
}

impl PiScanner {
    pub fn new(sessions_dir: PathBuf, registry: PathBuf) -> Self {
        Self {
            sessions_dir,
            registry,
            state: Arc::new(StdMutex::new(ScanState::default())),
        }
    }

    /// Pi's own locations. The bg-jobs extension keeps its registry under
    /// the home directory whatever `PI_CODING_AGENT_DIR` says.
    pub fn resolve() -> Self {
        let registry = dirs::home_dir()
            .unwrap_or_default()
            .join(".pi")
            .join("agent")
            .join("bg-jobs")
            .join("jobs.json");
        Self::new(crate::parsers::pi::resolve_pi_sessions_dir(), registry)
    }

    /// The work each live, bound Pi session has running, by conversation.
    pub async fn scan_live(
        &self,
        manager: &ConnectionManager,
        now: DateTime<Utc>,
    ) -> HashMap<i32, Vec<BackgroundSnapshotItem>> {
        let sessions = live_pi_sessions(manager).await;
        if sessions.is_empty() {
            return HashMap::new();
        }
        let scanner = self.clone();
        tokio::task::spawn_blocking(move || scanner.scan(&sessions, now, &pid_alive))
            .await
            .unwrap_or_default()
    }

    /// The blocking half of [`Self::scan_live`]: `(conversation id, session
    /// id)` pairs in, work out.
    pub fn scan(
        &self,
        sessions: &[(i32, String)],
        now: DateTime<Utc>,
        alive: &dyn Fn(i32) -> bool,
    ) -> HashMap<i32, Vec<BackgroundSnapshotItem>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let registry_stamp = FileStamp::of(&self.registry);
        let mut registry: Option<JobsRegistry> = None;
        let mut out = HashMap::new();
        let mut scanned: HashSet<PathBuf> = HashSet::new();
        for (conversation_id, session_id) in sessions {
            let Some(path) = self.find(&mut state, session_id) else {
                continue;
            };
            let Some(stamp) = FileStamp::of(&path) else {
                state.paths.remove(session_id);
                continue;
            };
            scanned.insert(path.clone());
            let cached = state.cache.get(&path).and_then(|(file, reg, items)| {
                let registry_same = match (reg, &registry_stamp) {
                    (Some(a), Some(b)) => a.same_as(b),
                    (None, None) => true,
                    _ => false,
                };
                (file.same_as(&stamp) && registry_same).then(|| items.clone())
            });
            let items = match cached {
                Some(items) => items,
                None => {
                    let registry =
                        registry.get_or_insert_with(|| JobsRegistry::load(&self.registry));
                    let items = match read_tail(&path) {
                        Ok(text) => pending_work(text.lines(), registry, alive, now),
                        Err(_) => Vec::new(),
                    };
                    state
                        .cache
                        .insert(path.clone(), (stamp, registry_stamp, items.clone()));
                    items
                }
            };
            if !items.is_empty() {
                out.insert(*conversation_id, items);
            }
        }
        // Forget transcripts no live session holds any more.
        state.cache.retain(|path, _| scanned.contains(path));
        out
    }

    /// The transcript of `session_id`: `<bucket>/<time>_<id>.jsonl`, or flat
    /// under a configured directory, found by name.
    fn find(&self, state: &mut ScanState, session_id: &str) -> Option<PathBuf> {
        if let Some(path) = state.paths.get(session_id) {
            if path.is_file() {
                return Some(path.clone());
            }
        }
        for entry in walkdir::WalkDir::new(&self.sessions_dir)
            .max_depth(2)
            .into_iter()
            .flatten()
        {
            let path = entry.path();
            if !entry.file_type().is_file()
                || path.extension().and_then(|e| e.to_str()) != Some("jsonl")
            {
                continue;
            }
            if crate::parsers::pi::fallback_id(path) == session_id {
                state
                    .paths
                    .insert(session_id.to_string(), path.to_path_buf());
                return Some(path.to_path_buf());
            }
        }
        None
    }
}

/// `(conversation id, Pi session id)` of every open Pi connection bound to a
/// conversation.
async fn live_pi_sessions(manager: &ConnectionManager) -> Vec<(i32, String)> {
    let mut out = Vec::new();
    for info in manager.list_connections().await {
        if info.agent_type != AgentType::Pi {
            continue;
        }
        let Some(state) = manager.get_state(&info.id).await else {
            continue;
        };
        let s = state.read().await;
        if matches!(
            s.status,
            ConnectionStatus::Disconnected | ConnectionStatus::Error
        ) {
            continue;
        }
        if let (Some(conversation_id), Some(session_id)) =
            (s.conversation_id, s.external_id.clone())
        {
            out.push((conversation_id, session_id));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant_call(id: &str, name: &str, arguments: Value) -> String {
        serde_json::json!({
            "type": "message",
            "timestamp": "2026-11-12T11:00:00.000Z",
            "message": {"role": "assistant", "content": [
                {"type": "toolCall", "id": id, "name": name, "arguments": arguments}
            ]}
        })
        .to_string()
    }

    fn tool_result(call: &str, tool: &str, details: Value, text: &str) -> String {
        serde_json::json!({
            "type": "message",
            "timestamp": "2026-11-12T11:00:01.000Z",
            "message": {"role": "toolResult", "toolCallId": call, "toolName": tool,
                "details": details, "content": [{"type": "text", "text": text}]}
        })
        .to_string()
    }

    fn user(text: &str) -> String {
        serde_json::json!({
            "type": "message",
            "timestamp": "2026-11-12T11:05:00.000Z",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]}
        })
        .to_string()
    }

    fn launch_job(call: &str, job: &str, command: &str) -> Vec<String> {
        vec![
            assistant_call(call, "bgj_run", serde_json::json!({"command": command})),
            tool_result(
                call,
                "bgj_run",
                serde_json::json!({"id": job, "pid": 4242, "logFile": "/tmp/x.log"}),
                &format!("Command running in background with ID: {job} (pid 4242)."),
            ),
        ]
    }

    fn now() -> DateTime<Utc> {
        "2026-11-12T11:30:00Z".parse().unwrap()
    }

    fn scan(lines: &[String], registry: &JobsRegistry) -> Vec<BackgroundSnapshotItem> {
        pending_work(lines.iter().map(String::as_str), registry, &|_| true, now())
    }

    #[test]
    fn a_job_runs_until_its_report_or_a_terminal_status() {
        let mut lines = launch_job("c1", "jb-one", "cargo test");
        lines.extend(launch_job("c2", "jb-two", "npm run build"));
        lines.extend(launch_job("c3", "jb-three", "sleep 900"));
        let none = JobsRegistry::default();
        let all = scan(&lines, &none);
        assert_eq!(
            all.iter()
                .map(|i| i.id.clone().unwrap())
                .collect::<Vec<_>>(),
            vec!["jb-one", "jb-two", "jb-three"]
        );
        assert_eq!(all[0].kind, KIND_PI_JOB);
        assert_eq!(all[0].label, "cargo test");
        assert!(all[0].started_at.is_some());

        lines.push(user(
            "✅ Background job finished (exit 0, ran 2m)\n[jb-one] completed exit 0 · 2m · cargo test",
        ));
        lines.push(tool_result(
            "c9",
            "bgj_status",
            serde_json::json!({"job": {"id": "jb-two", "state": "failed"}}),
            "[jb-two] failed exit 1",
        ));
        let left = scan(&lines, &none);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id.as_deref(), Some("jb-three"));
    }

    #[test]
    fn the_registry_and_the_process_have_the_last_word() {
        let lines = [launch_job("c1", "jb-a", "a"), launch_job("c2", "jb-b", "b")].concat();
        let registry = JobsRegistry::parse(
            r#"{"jb-a": {"id": "jb-a", "pid": 11, "exitedAtMs": 5, "exitCode": 0},
                "jb-b": {"id": "jb-b", "pid": 12}}"#,
        );
        let left = scan(&lines, &registry);
        assert_eq!(left.len(), 1, "the registry saw jb-a exit");
        assert_eq!(left[0].id.as_deref(), Some("jb-b"));
        let dead = pending_work(
            lines.iter().map(String::as_str),
            &registry,
            &|_| false,
            now(),
        );
        assert!(dead.is_empty(), "a job whose process is gone runs nothing");
        // A registry another Pi process rewrote without these jobs: their
        // processes decide.
        let empty = JobsRegistry::parse("{}");
        assert_eq!(scan(&lines, &empty).len(), 2);
        let gone = pending_work(lines.iter().map(String::as_str), &empty, &|_| false, now());
        assert!(gone.is_empty());
    }

    #[test]
    fn an_async_run_runs_until_its_notice() {
        let launch = [
            assistant_call(
                "s1",
                "subagent",
                serde_json::json!({"async": true, "agent": "researcher", "task": "Find prices"}),
            ),
            tool_result(
                "s1",
                "subagent",
                serde_json::json!({"mode": "single", "asyncId": "910e998f"}),
                "Async run [910e998f]",
            ),
            // A synchronous call names no run.
            assistant_call("s2", "subagent", serde_json::json!({"action": "list"})),
            tool_result(
                "s2",
                "subagent",
                serde_json::json!({"mode": "management"}),
                "x",
            ),
        ];
        let none = JobsRegistry::default();
        let running = scan(&launch, &none);
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].kind, KIND_PI_SUBAGENT);
        assert_eq!(running[0].id.as_deref(), Some("910e998f"));
        assert_eq!(running[0].label, "researcher: Find prices");

        let mut done = launch.to_vec();
        done.push(
            serde_json::json!({"type": "custom_message", "customType": "subagent-notify",
                "content": "Background task failed: **workflow**\nWorkflow receipt: /tmp/x/910e998f/workflow-receipt.json"})
            .to_string(),
        );
        assert!(scan(&done, &none).is_empty());

        // A run launched long ago with no notice is lost, not running.
        let later = now() + chrono::Duration::hours(RUN_MAX_AGE_HOURS + 1);
        assert!(
            pending_work(launch.iter().map(String::as_str), &none, &|_| true, later).is_empty()
        );
    }

    #[test]
    fn a_launch_without_details_is_read_from_its_text() {
        let lines = [
            assistant_call("c1", "bgj_run", serde_json::json!({"command": "make"})),
            tool_result(
                "c1",
                "bgj_run",
                Value::Null,
                "Command running in background with ID: jb-x1y2 (pid 7).",
            ),
        ];
        let items = scan(&lines, &JobsRegistry::default());
        assert_eq!(items[0].id.as_deref(), Some("jb-x1y2"));
        assert_eq!(items[0].label, "make");
    }

    #[test]
    fn the_scanner_finds_the_transcript_and_rereads_it_only_when_it_changed() {
        let dir = tempfile::tempdir().unwrap();
        let bucket = dir.path().join("sessions").join("--work--");
        std::fs::create_dir_all(&bucket).unwrap();
        let path = bucket.join("2026-11-12T10-00-00-000Z_pi-session-1.jsonl");
        std::fs::write(
            &path,
            launch_job("c1", "jb-z", "sleep 900").join("\n") + "\n",
        )
        .unwrap();
        let scanner = PiScanner::new(
            dir.path().join("sessions"),
            dir.path().join("bg-jobs").join("jobs.json"),
        );
        let sessions = vec![(7, "pi-session-1".to_string()), (8, "missing".to_string())];
        let work = scanner.scan(&sessions, now(), &|_| true);
        assert_eq!(work.len(), 1);
        assert_eq!(work[&7][0].id.as_deref(), Some("jb-z"));

        std::fs::write(
            &path,
            [
                launch_job("c1", "jb-z", "sleep 900"),
                vec![user(
                    "🛑 Background job killed (bgj_kill, ran 9s)\n[jb-z] killed",
                )],
            ]
            .concat()
            .join("\n")
                + "\n",
        )
        .unwrap();
        // A different length is a change, whatever the clock says.
        let work = scanner.scan(&sessions, now(), &|_| true);
        assert!(work.is_empty(), "the job's report landed");
    }
}
