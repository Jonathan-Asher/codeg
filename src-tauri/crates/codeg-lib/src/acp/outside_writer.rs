//! Another process running an agent session codeg is about to resume.
//!
//! Claude Code keeps no lock on a session. `claude --resume <id>` opens one
//! whatever else has it open (only `claude respawn` asks first), and two
//! processes that resume the same session both append to its transcript, each
//! from its own context: the history forks, tools from both run in the same
//! tree, and the second resume labels the first one's running background
//! agents "didn't finish". codeg used to check only its own connections, so
//! opening a session — or just resting the pointer on it, which pre-opens it —
//! while another process still ran it started exactly that second writer. An
//! orchestrating session that hands work to a worker with
//! `nohup claude --resume <id> -p "<brief>"` is the usual other process; a
//! terminal is another.
//!
//! **The signal.** The CLI keeps a live-session registry: one
//! `<config dir>/sessions/<pid>.json` per running process, written at startup
//! (by `-p` and SDK processes too, and by a worker started from another
//! session's Bash tool), rewritten when the process moves to another session,
//! and unlinked when it exits. A process that is killed leaves its file
//! behind, and its pid can be reused, so a record counts only while its pid is
//! alive and the process behind it started when the record says it did
//! (`procStart`, the CLI's own guard against a reused pid).
//!
//! **codeg's own processes** run the same CLI and register the same way, with
//! the same `entrypoint`: a worker started from a session codeg runs inherits
//! it. What sets them apart is their parent: claude-agent-acp starts one CLI
//! per session as its direct child, and codeg knows the pid of every adapter
//! it runs ([`crate::acp::manager::ConnectionManager::own_agent_pids`]). Only
//! the direct parent counts. An orchestrator's worker descends from a codeg
//! adapter too (adapter → orchestrating CLI → shell → worker), and it is
//! exactly the process this module exists to find.
//!
//! Claude Code only: pi keeps no such registry. Unix only: elsewhere the
//! registry carries a different start stamp, and nothing here is checked.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::acp::scratch_dir::{probe_pid, PidState};

/// The CLI reads no registry record larger than this; neither does codeg.
const MAX_RECORD_BYTES: u64 = 256 * 1024;

/// Latest plausible `startedAt` (milliseconds since the epoch), the bound the
/// CLI applies to the same field.
const MAX_STARTED_AT_MS: i64 = 4_000_000_000_000_000;

/// How far the start a record names may sit from the start of the process now
/// holding its pid: `procStart` has one-second resolution.
const START_TOLERANCE_SECS: i64 = 1;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// One record of the CLI's live-session registry, as far as codeg reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryRecord {
    pub pid: u32,
    /// The session the process runs now.
    pub session_id: Option<String>,
    /// When the process registered, in milliseconds since the epoch.
    pub started_at_ms: Option<i64>,
    /// When the process started, as `LC_ALL=C TZ=UTC ps -o lstart=` prints it.
    pub proc_start: Option<String>,
    /// `busy`, `idle`, `waiting` or `shell`; absent until the CLI first
    /// reports one.
    pub status: Option<String>,
}

/// A process codeg did not start, running a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideWriter {
    pub pid: u32,
    /// When it registered, in milliseconds since the epoch.
    pub started_at: Option<i64>,
    /// What the process last said it was doing (`busy`, `idle`, ...).
    pub status: Option<String>,
}

/// The size and modification time of a session's transcript: what tells a
/// view waiting on an outside process that the transcript moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStamp {
    pub len: u64,
    pub modified_ms: Option<i64>,
}

/// What a session view polls while another process runs its session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideWriterStatus {
    /// The outside process running the session, or `None` once there is none.
    pub writer: Option<OutsideWriter>,
    pub transcript: Option<TranscriptStamp>,
}

/// One registry record from its file name and bytes: `None` for anything that
/// is not a record the CLI wrote. The name must be the pid itself, written the
/// way the CLI writes it (no sign, no leading zero), and a `pid` field, when
/// there is one, must agree with it.
pub fn parse_registry_record(file_name: &str, bytes: &[u8]) -> Option<RegistryRecord> {
    let stem = file_name.strip_suffix(".json")?;
    let pid: u32 = stem.parse().ok()?;
    if pid <= 1 || pid.to_string() != stem {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    if let Some(named) = object.get("pid") {
        if named.as_u64() != Some(u64::from(pid)) {
            return None;
        }
    }
    let text = |key: &str| {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(RegistryRecord {
        pid,
        session_id: text("sessionId"),
        started_at_ms: object
            .get("startedAt")
            .and_then(|v| v.as_i64())
            .filter(|at| *at > 0 && *at <= MAX_STARTED_AT_MS),
        proc_start: text("procStart"),
        status: text("status"),
    })
}

/// Every record in the registry directory `dir`. Files that are not records
/// (the CLI's private `.key` files, anything partly written or too large, a
/// symlink) are skipped; a missing directory reads as an empty registry.
pub fn read_registry(dir: &Path) -> Vec<RegistryRecord> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        // Not followed through a symlink: the CLI writes plain files.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_RECORD_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        if let Some(record) = parse_registry_record(name, &bytes) {
            records.push(record);
        }
    }
    records
}

/// What the OS says about a running process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessFacts {
    pub ppid: u32,
    /// When it started, in seconds since the epoch.
    pub started: i64,
}

/// How processes are looked at: the OS's own answers, or a test's.
pub trait ProcessProbe: Send + Sync {
    fn state(&self, pid: u32) -> PidState;
    fn facts(&self, pid: u32) -> Option<ProcessFacts>;
}

/// The OS: `kill(pid, 0)` for liveness; the parent and start time from
/// `/proc` on Linux, from `ps` elsewhere (as the CLI itself reads them).
pub struct SystemProbe;

impl ProcessProbe for SystemProbe {
    fn state(&self, pid: u32) -> PidState {
        probe_pid(pid)
    }

    fn facts(&self, pid: u32) -> Option<ProcessFacts> {
        system_process_facts(pid)
    }
}

#[cfg(target_os = "linux")]
fn system_process_facts(pid: u32) -> Option<ProcessFacts> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_proc_stat(&stat, boot_time_secs()?, clock_ticks_per_sec()?)
}

#[cfg(target_os = "linux")]
fn boot_time_secs() -> Option<i64> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    stat.lines()
        .find_map(|line| line.strip_prefix("btime "))
        .and_then(|secs| secs.trim().parse().ok())
}

#[cfg(target_os = "linux")]
fn clock_ticks_per_sec() -> Option<u64> {
    // SAFETY: `sysconf` reads a system constant; it touches no memory of ours.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    u64::try_from(ticks).ok().filter(|t| *t > 0)
}

/// The parent and start time out of a `/proc/<pid>/stat` line. The command
/// name (field 2) may hold spaces and parentheses, so fields are counted from
/// the last `)`: the parent is field 4, the start (clock ticks after boot)
/// field 22.
#[cfg(any(test, target_os = "linux"))]
fn parse_proc_stat(stat: &str, boot_secs: i64, ticks_per_sec: u64) -> Option<ProcessFacts> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let ppid = fields.get(1)?.parse().ok()?;
    let start_ticks: u64 = fields.get(19)?.parse().ok()?;
    let after_boot = i64::try_from(start_ticks / ticks_per_sec.max(1)).ok()?;
    Some(ProcessFacts {
        ppid,
        started: boot_secs + after_boot,
    })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn system_process_facts(pid: u32) -> Option<ProcessFacts> {
    let pid = pid.to_string();
    let out = std::process::Command::new("ps")
        .args(["-o", "ppid=,lstart=", "-p", pid.as_str()])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps_facts(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(unix))]
fn system_process_facts(_pid: u32) -> Option<ProcessFacts> {
    None
}

/// `  11936 Mon Nov  2 10:48:09 2026` (`ps -o ppid=,lstart=` in UTC) as the
/// parent and start time.
#[cfg(any(test, all(unix, not(target_os = "linux"))))]
fn parse_ps_facts(text: &str) -> Option<ProcessFacts> {
    let (ppid, lstart) = text.trim().split_once(char::is_whitespace)?;
    Some(ProcessFacts {
        ppid: ppid.parse().ok()?,
        started: parse_lstart_utc(lstart)?,
    })
}

/// `Mon Nov  2 10:48:09 2026` — what `LC_ALL=C TZ=UTC ps -o lstart=` prints,
/// and what the CLI records as `procStart` — in seconds since the epoch.
pub fn parse_lstart_utc(text: &str) -> Option<i64> {
    let mut parts = text.split_whitespace();
    let _weekday = parts.next()?;
    let month_name = parts.next()?;
    let month = MONTHS
        .iter()
        .position(|m| m.eq_ignore_ascii_case(month_name))?;
    let day: u32 = parts.next()?.parse().ok()?;
    let mut clock = parts.next()?.split(':');
    let year: i32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let hour: u32 = clock.next()?.parse().ok()?;
    let minute: u32 = clock.next()?.parse().ok()?;
    let second: u32 = clock.next()?.parse().ok()?;
    if clock.next().is_some() {
        return None;
    }
    let at = chrono::NaiveDate::from_ymd_opt(year, month as u32 + 1, day)?
        .and_hms_opt(hour, minute, second)?;
    Some(at.and_utc().timestamp())
}

/// The process outside codeg that runs `session_id`, if one does: a record
/// naming the session whose pid is alive, is still the process that wrote
/// the record, and is neither one of `own_pids` (codeg's agent processes) nor
/// a direct child of one. The newest such process when there are several.
///
/// A live process whose start and parent cannot be read counts as outside:
/// wrongly waiting costs a banner and a click, a second writer a forked
/// history.
pub fn outside_writer_for(
    records: &[RegistryRecord],
    session_id: &str,
    own_pids: &HashSet<u32>,
    probe: &dyn ProcessProbe,
) -> Option<OutsideWriter> {
    if session_id.is_empty() {
        return None;
    }
    records
        .iter()
        .filter(|record| record.session_id.as_deref() == Some(session_id))
        .filter(|record| runs_outside(record, own_pids, probe))
        .max_by_key(|record| (record.started_at_ms.unwrap_or(0), record.pid))
        .map(|record| OutsideWriter {
            pid: record.pid,
            started_at: record.started_at_ms,
            status: record.status.clone(),
        })
}

fn runs_outside(
    record: &RegistryRecord,
    own_pids: &HashSet<u32>,
    probe: &dyn ProcessProbe,
) -> bool {
    if own_pids.contains(&record.pid) {
        return false;
    }
    if probe.state(record.pid) == PidState::Dead {
        // Killed without unlinking its record.
        return false;
    }
    match probe.facts(record.pid) {
        Some(facts) => {
            let recorded_start = record.proc_start.as_deref().and_then(parse_lstart_utc);
            if recorded_start.is_some_and(|at| (at - facts.started).abs() > START_TOLERANCE_SECS) {
                // The pid now belongs to another process.
                return false;
            }
            !own_pids.contains(&facts.ppid)
        }
        // Gone between the two looks, or not readable: only a process that is
        // still there counts.
        None => probe.state(record.pid) != PidState::Dead,
    }
}

/// Where the registry is and how processes are read. `system()` in the app;
/// tests point it at a directory and a process table of their own.
#[derive(Clone)]
pub struct OutsideWriterLookup {
    /// The Claude config directory, when not the one codeg resolves.
    config_dir: Option<PathBuf>,
    probe: Arc<dyn ProcessProbe>,
}

impl OutsideWriterLookup {
    pub fn system() -> Self {
        Self {
            config_dir: None,
            probe: Arc::new(SystemProbe),
        }
    }

    /// A lookup over `config_dir` (holding `sessions/` and `projects/`) and the
    /// processes `probe` reports.
    pub fn new(config_dir: PathBuf, probe: Arc<dyn ProcessProbe>) -> Self {
        Self {
            config_dir: Some(config_dir),
            probe,
        }
    }

    /// The config directory: the lookup's own, the one a launch sets with
    /// `CLAUDE_CONFIG_DIR` (`launch_config_dir`), or codeg's.
    fn config_dir(&self, launch_config_dir: Option<&Path>) -> PathBuf {
        if let Some(dir) = &self.config_dir {
            return dir.clone();
        }
        launch_config_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(crate::parsers::claude::resolve_claude_config_dir)
    }

    /// The process outside codeg that runs Claude Code session `session_id`,
    /// if one does. Blocking: reads the registry and asks the OS about the
    /// processes it names.
    pub fn find(
        &self,
        session_id: &str,
        own_pids: &HashSet<u32>,
        launch_config_dir: Option<&Path>,
    ) -> Option<OutsideWriter> {
        if !cfg!(unix) {
            return None;
        }
        let records = read_registry(&self.config_dir(launch_config_dir).join("sessions"));
        outside_writer_for(&records, session_id, own_pids, self.probe.as_ref())
    }

    /// The size and modification time of the session's transcript, if it has
    /// one. Blocking.
    pub fn transcript_stamp(&self, session_id: &str) -> Option<TranscriptStamp> {
        let projects = self.config_dir(None).join("projects");
        let path = crate::parsers::claude::find_session_file_in(&projects, session_id)?;
        let meta = std::fs::metadata(path).ok()?;
        Some(TranscriptStamp {
            len: meta.len(),
            modified_ms: meta
                .modified()
                .ok()
                .map(|at| chrono::DateTime::<chrono::Utc>::from(at).timestamp_millis()),
        })
    }
}

/// The `CLAUDE_CONFIG_DIR` a launch sets for its agent, if it sets one.
pub fn launch_config_dir(
    runtime_env: &std::collections::BTreeMap<String, String>,
) -> Option<PathBuf> {
    runtime_env
        .get("CLAUDE_CONFIG_DIR")
        .map(|dir| dir.trim())
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

/// Stand-ins for the registry and the OS, for tests here and elsewhere.
#[cfg(any(test, feature = "test-utils"))]
pub mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// `Mon Nov  2 10:48:09 2026` for `secs`, the way the CLI records it.
    pub fn lstart(secs: i64) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
            .expect("a valid time")
            .format("%a %b %e %H:%M:%S %Y")
            .to_string()
    }

    /// Write the record the CLI writes for a process running `session_id`,
    /// started at `started` (seconds since the epoch).
    pub fn write_record(sessions_dir: &Path, pid: u32, session_id: &str, started: i64) {
        std::fs::create_dir_all(sessions_dir).expect("create the registry");
        let record = serde_json::json!({
            "pid": pid,
            "sessionId": session_id,
            "cwd": "/work/project",
            "startedAt": started * 1000,
            "procStart": lstart(started),
            "version": "2.1.312",
            "peerProtocol": 1,
            "kind": "interactive",
            "entrypoint": "sdk-ts",
            "pidDomain": "darwin",
            "messagingSocketPath": format!("/tmp/cc-socks/{pid}.sock"),
            "status": "busy",
        });
        std::fs::write(
            sessions_dir.join(format!("{pid}.json")),
            serde_json::to_vec(&record).expect("serialize"),
        )
        .expect("write the record");
    }

    #[derive(Debug, Clone, Copy)]
    struct Process {
        ppid: u32,
        started: i64,
        alive: bool,
    }

    /// A process table: what tests have started and stopped.
    #[derive(Default)]
    pub struct FakeProcesses {
        table: Mutex<HashMap<u32, Process>>,
    }

    impl FakeProcesses {
        pub fn start(&self, pid: u32, ppid: u32, started: i64) {
            self.table.lock().expect("table").insert(
                pid,
                Process {
                    ppid,
                    started,
                    alive: true,
                },
            );
        }

        pub fn exit(&self, pid: u32) {
            if let Some(process) = self.table.lock().expect("table").get_mut(&pid) {
                process.alive = false;
            }
        }
    }

    impl ProcessProbe for FakeProcesses {
        fn state(&self, pid: u32) -> PidState {
            match self.table.lock().expect("table").get(&pid) {
                Some(process) if process.alive => PidState::Alive,
                _ => PidState::Dead,
            }
        }

        fn facts(&self, pid: u32) -> Option<ProcessFacts> {
            match self.table.lock().expect("table").get(&pid) {
                Some(process) if process.alive => Some(ProcessFacts {
                    ppid: process.ppid,
                    started: process.started,
                }),
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{lstart, write_record, FakeProcesses};
    use super::*;

    const STARTED: i64 = 1_793_616_489; // Mon Nov  2 10:48:09 2026 UTC
    const ADAPTER: u32 = 11_936;

    fn own() -> HashSet<u32> {
        HashSet::from([ADAPTER])
    }

    fn record(pid: u32, session: &str, started: i64) -> RegistryRecord {
        RegistryRecord {
            pid,
            session_id: Some(session.to_string()),
            started_at_ms: Some(started * 1000),
            proc_start: Some(lstart(started)),
            status: Some("busy".to_string()),
        }
    }

    /// A record exactly as the CLI wrote it on this machine (2.1.303).
    #[test]
    fn parses_a_registry_record_the_cli_wrote() {
        let bytes = br#"{"pid":12531,"sessionId":"46abbd7d-9c8b-47fe-82a7-f90eee1e30b1","cwd":"/Users/me/Work/alphabeita","startedAt":1793616490351,"procStart":"Mon Nov  2 10:48:09 2026","version":"2.1.303","peerProtocol":1,"peerFeatures":["notify_idle","reply_across_default_dirs","artifact_yield"],"kind":"interactive","entrypoint":"sdk-ts","pidDomain":"darwin","messagingSocketPath":"/tmp/cc-socks/12531.sock","name":"alphabeita-90","nameSource":"derived","nameSince":1793616490351,"updatedAt":1793616678606,"status":"idle","statusUpdatedAt":1793616678606}"#;
        let parsed = parse_registry_record("12531.json", bytes).expect("a record");
        assert_eq!(
            parsed,
            RegistryRecord {
                pid: 12531,
                session_id: Some("46abbd7d-9c8b-47fe-82a7-f90eee1e30b1".to_string()),
                started_at_ms: Some(1_793_616_490_351),
                proc_start: Some("Mon Nov  2 10:48:09 2026".to_string()),
                status: Some("idle".to_string()),
            }
        );
        assert_eq!(parse_lstart_utc("Mon Nov  2 10:48:09 2026"), Some(STARTED));
    }

    /// A `-p` process registers before it reports any status.
    #[test]
    fn a_record_without_a_status_still_counts() {
        let bytes = br#"{"pid":54020,"sessionId":"s","startedAt":1793696119105,"procStart":"Tue Nov  3 08:55:18 2026","kind":"interactive"}"#;
        let parsed = parse_registry_record("54020.json", bytes).expect("a record");
        assert_eq!(parsed.status, None);
        assert_eq!(parsed.session_id.as_deref(), Some("s"));
    }

    #[test]
    fn anything_the_cli_did_not_write_is_not_a_record() {
        let ok = br#"{"pid":4242,"sessionId":"s"}"#;
        assert!(parse_registry_record("4242.json", ok).is_some());
        for name in [
            "04242.json",
            "+4242.json",
            "4242",
            "4242.json.tmp",
            "abc.json",
            "1.json",
        ] {
            assert!(parse_registry_record(name, ok).is_none(), "{name}");
        }
        assert!(parse_registry_record("4242.json", br#"{"pid":4243}"#).is_none());
        assert!(parse_registry_record("4242.json", br#"{"pid":"4242"}"#).is_none());
        assert!(parse_registry_record("4242.json", b"[1,2]").is_none());
        assert!(parse_registry_record("4242.json", br#"{"pid":4242,"session"#).is_none());
    }

    #[test]
    fn the_registry_is_read_without_its_key_files_or_oversized_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_record(dir.path(), 4242, "s", STARTED);
        std::fs::write(dir.path().join("4242.0f1e2d.key"), b"secret").unwrap();
        std::fs::write(dir.path().join("4243.json"), vec![b' '; 300 * 1024]).unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"{}").unwrap();
        let records = read_registry(dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, 4242);
        assert!(read_registry(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn a_live_process_codeg_did_not_start_is_an_outside_writer() {
        let processes = FakeProcesses::default();
        processes.start(4242, 1, STARTED);
        let found = outside_writer_for(&[record(4242, "s", STARTED)], "s", &own(), &processes);
        assert_eq!(
            found,
            Some(OutsideWriter {
                pid: 4242,
                started_at: Some(STARTED * 1000),
                status: Some("busy".to_string()),
            })
        );
    }

    #[test]
    fn a_record_left_by_a_dead_process_is_stale() {
        let processes = FakeProcesses::default();
        processes.start(4242, 1, STARTED);
        processes.exit(4242);
        assert_eq!(
            outside_writer_for(&[record(4242, "s", STARTED)], "s", &own(), &processes),
            None
        );
        // Never seen at all.
        assert_eq!(
            outside_writer_for(&[record(4343, "s", STARTED)], "s", &own(), &processes),
            None
        );
    }

    #[test]
    fn a_pid_now_held_by_another_process_is_stale() {
        let processes = FakeProcesses::default();
        processes.start(4242, 1, STARTED + 3600);
        assert_eq!(
            outside_writer_for(&[record(4242, "s", STARTED)], "s", &own(), &processes),
            None
        );
        // Within the stamp's resolution it is the same process.
        processes.start(4242, 1, STARTED + 1);
        assert!(
            outside_writer_for(&[record(4242, "s", STARTED)], "s", &own(), &processes).is_some()
        );
    }

    /// claude-agent-acp starts the CLI as its own child: that is codeg's.
    #[test]
    fn a_cli_whose_parent_is_a_codeg_adapter_is_codegs_own() {
        let processes = FakeProcesses::default();
        processes.start(12531, ADAPTER, STARTED);
        assert_eq!(
            outside_writer_for(&[record(12531, "s", STARTED)], "s", &own(), &processes),
            None
        );
    }

    /// An orchestrating session codeg runs starts its worker from its Bash
    /// tool: the worker descends from a codeg adapter, but not directly.
    #[test]
    fn a_worker_started_by_a_codeg_session_is_outside() {
        let processes = FakeProcesses::default();
        processes.start(32830, ADAPTER, STARTED); // the orchestrating CLI
        processes.start(40000, 32830, STARTED + 5); // its Bash tool's shell
        processes.start(40001, 40000, STARTED + 6); // nohup claude --resume -p
        let records = [
            record(32830, "orchestrator", STARTED),
            record(40001, "s", STARTED + 6),
        ];
        assert_eq!(
            outside_writer_for(&records, "s", &own(), &processes).map(|w| w.pid),
            Some(40001)
        );
        assert_eq!(
            outside_writer_for(&records, "orchestrator", &own(), &processes),
            None
        );
    }

    #[test]
    fn another_sessions_process_is_ignored() {
        let processes = FakeProcesses::default();
        processes.start(4242, 1, STARTED);
        assert_eq!(
            outside_writer_for(&[record(4242, "other", STARTED)], "s", &own(), &processes),
            None
        );
        assert_eq!(
            outside_writer_for(&[record(4242, "s", STARTED)], "", &own(), &processes),
            None
        );
    }

    /// Alive, but neither its parent nor its start can be read.
    #[test]
    fn a_live_process_that_cannot_be_read_counts_as_outside() {
        struct AliveUnreadable;
        impl ProcessProbe for AliveUnreadable {
            fn state(&self, _pid: u32) -> PidState {
                PidState::Alive
            }
            fn facts(&self, _pid: u32) -> Option<ProcessFacts> {
                None
            }
        }
        assert!(
            outside_writer_for(&[record(4242, "s", STARTED)], "s", &own(), &AliveUnreadable)
                .is_some()
        );
    }

    #[test]
    fn the_newest_of_several_outside_processes_is_reported() {
        let processes = FakeProcesses::default();
        processes.start(4242, 1, STARTED);
        processes.start(4343, 1, STARTED + 60);
        let records = [record(4242, "s", STARTED), record(4343, "s", STARTED + 60)];
        assert_eq!(
            outside_writer_for(&records, "s", &own(), &processes).map(|w| w.pid),
            Some(4343)
        );
    }

    #[test]
    fn the_lookup_reads_its_own_registry_and_transcripts() {
        let dir = tempfile::tempdir().unwrap();
        let processes = Arc::new(FakeProcesses::default());
        processes.start(4242, 1, STARTED);
        write_record(&dir.path().join("sessions"), 4242, "s", STARTED);
        let project = dir.path().join("projects").join("-work-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("s.jsonl"), b"{}\n").unwrap();

        let lookup = OutsideWriterLookup::new(dir.path().to_path_buf(), processes.clone());
        assert_eq!(lookup.find("s", &own(), None).map(|w| w.pid), Some(4242));
        assert_eq!(lookup.transcript_stamp("s").map(|t| t.len), Some(3));
        assert_eq!(lookup.transcript_stamp("t"), None);
        processes.exit(4242);
        assert_eq!(lookup.find("s", &own(), None), None);
    }

    #[test]
    fn a_launch_can_name_its_own_config_dir() {
        let mut env = std::collections::BTreeMap::new();
        assert_eq!(launch_config_dir(&env), None);
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "  ".to_string());
        assert_eq!(launch_config_dir(&env), None);
        env.insert(
            "CLAUDE_CONFIG_DIR".to_string(),
            "/elsewhere/.claude".to_string(),
        );
        assert_eq!(
            launch_config_dir(&env),
            Some(PathBuf::from("/elsewhere/.claude"))
        );
    }

    #[test]
    fn ps_and_proc_output_are_read() {
        assert_eq!(
            parse_ps_facts("  11936 Mon Nov  2 10:48:09 2026\n"),
            Some(ProcessFacts {
                ppid: 11936,
                started: STARTED,
            })
        );
        assert_eq!(parse_ps_facts(""), None);
        assert_eq!(parse_lstart_utc("Mon Nov 31 10:48:09 2026"), None);
        assert_eq!(parse_lstart_utc("Mon Nov  2 10:48 2026"), None);
        // A command name with spaces and parentheses.
        let stat =
            "4242 (claude (x) y) S 1000 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 250 0 0";
        assert_eq!(
            parse_proc_stat(stat, 1_000_000, 100),
            Some(ProcessFacts {
                ppid: 1000,
                started: 1_000_002,
            })
        );
    }

    /// The real probe on this machine: the test process itself is alive, its
    /// parent is its parent, and it started a moment ago; a child that has
    /// been reaped is dead.
    #[cfg(unix)]
    #[test]
    fn the_system_probe_reads_this_process() {
        let me = std::process::id();
        assert_eq!(SystemProbe.state(me), PidState::Alive);
        let facts = SystemProbe.facts(me).expect("facts about this process");
        // SAFETY: getppid takes no arguments and cannot fail.
        let parent = unsafe { libc::getppid() };
        assert_eq!(i64::from(facts.ppid), i64::from(parent));
        let now = chrono::Utc::now().timestamp();
        assert!(facts.started <= now + 1 && facts.started > now - 24 * 3600);

        let mut child = std::process::Command::new("true").spawn().expect("spawn");
        let pid = child.id();
        child.wait().expect("reap");
        assert_eq!(SystemProbe.state(pid), PidState::Dead);
    }
}
