//! Moves a session up in the session lists when a turn lands in its transcript
//! while nothing in codeg drives it.
//!
//! A turn codeg sends stamps `updated_at` itself (its start, the running turn's
//! heartbeat, its end), and a connected session's transcript watcher
//! ([`super::background_watch`]) stamps the turns codeg did not send. A session
//! no codeg connection holds had neither: another session resuming it with
//! `-p --resume` (how an orchestrating session hands work to a worker), a
//! terminal, a cron firing in a process codeg did not start. Its row kept its
//! old time, and the lists kept it where it was.
//!
//! This watcher follows the transcripts of the sessions the lists show, for the
//! agents whose transcripts codeg already reads from disk, and moves a row to
//! the transcript's own time of each turn that starts in it: a message typed or
//! sent through the SDK, a message from another session, a queued command, a
//! cron or `/loop` fire, a task notification (see [`ScanState`]). The guards
//! are those of every activity write: strictly forward, one write per turn,
//! never a deleted row or a delegation child, and every moved row is broadcast
//! on `conversation://changed` so each client re-sorts. What a selector, a
//! title or a view writes into a transcript starts no turn.
//!
//! **Whose transcript.** A session bound to a live connection of an agent with
//! a transcript watcher of its own is that watcher's: it reads the same bytes
//! and knows which turns codeg sent. A connection opened only to look at a
//! session is bound by its first prompt, so until then the session is read
//! here. pi has no transcript watcher, so a bound pi session is read here too;
//! only what lands while codeg runs a turn on it (and stamps the row itself)
//! is left alone.
//!
//! **Cost.** Change events for the directories the transcripts sit in
//! (`notify`, not recursive), debounced, and a read of only the bytes appended
//! past each transcript's stored offset; a line is parsed only when it can be a
//! user record. A `stat` scan of the transcripts active in the last
//! [`ACTIVE_DAYS`] days catches what an event missed. A transcript read for the
//! first time, or again after a connection held it, is caught up from its end
//! backwards in growing chunks, only until a record the row's time already
//! covers.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sea_orm::DatabaseConnection;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

use crate::acp::background_watch::{record_submission_id, starts_activity};
use crate::acp::manager::ConnectionManager;
use crate::db::error::DbError;
use crate::db::service::conversation_service::{self, ActivityCandidate};
use crate::models::agent::AgentType;
use crate::parsers::claude::{
    pending_command_verdict, record_timestamp, slash_command_display, PendingCommandVerdict,
};
use crate::parsers::detail_cache::FileStamp;
use crate::web::event_bridge::EventEmitter;

/// The agents whose transcripts are followed: the two codeg reads from disk.
const AGENTS: [AgentType; 2] = [AgentType::ClaudeCode, AgentType::Pi];
/// Quiet time after a change event before the transcript is read. The records
/// one submission writes land together, so they are read, and counted,
/// together.
const DEBOUNCE: Duration = Duration::from_secs(1);
/// The `stat` scan that catches a change no event reported.
const SLOW_SCAN: Duration = Duration::from_secs(60);
/// The same scan when there are no change events at all.
const SCAN_WITHOUT_EVENTS: Duration = Duration::from_secs(15);
/// How often the rows are read again and their transcripts found again.
const REFRESH: Duration = Duration::from_secs(5 * 60);
/// Time the app gets to finish starting before the first catch-up.
const STARTUP_DELAY: Duration = Duration::from_secs(15);
/// A transcript written to, or a row active, in this many days is scanned. Any
/// other is read only once a change event names it.
const ACTIVE_DAYS: i64 = 14;
/// First chunk of a catch-up; each next one is twice the size, up to the max.
const CATCH_UP_FIRST_CHUNK: u64 = 64 * 1024;
const CATCH_UP_MAX_CHUNK: u64 = 1024 * 1024;
/// Most a catch-up reads before it gives up looking for the row's time.
const CATCH_UP_MAX: u64 = 16 * 1024 * 1024;
/// Most read forward in one go. A transcript further behind than this is
/// caught up from its end instead.
const FORWARD_MAX: u64 = 16 * 1024 * 1024;
const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// Where the agents keep their transcripts.
#[derive(Clone, Debug)]
pub(crate) struct TranscriptRoots {
    /// One directory per working directory, each holding `<session id>.jsonl`.
    pub projects: PathBuf,
    /// pi's sessions: `<bucket>/<time>_<session id>.jsonl`, or flat.
    pub pi_sessions: PathBuf,
}

impl TranscriptRoots {
    pub(crate) fn resolve() -> Self {
        Self {
            projects: crate::parsers::claude::resolve_claude_config_dir().join("projects"),
            pi_sessions: crate::parsers::pi::resolve_pi_sessions_dir(),
        }
    }
}

/// The row a transcript belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Candidate {
    conversation_id: i32,
    agent: AgentType,
}

/// What reading a transcript carries from one read to the next.
///
/// Each turn starts with one record, so counting those records is one write
/// per turn (and the records one read finds are written as one, the newest).
/// A record's submission (`promptId`) cannot stand in for the turn: older CLIs
/// kept one id across many turns.
#[derive(Clone, Debug, Default)]
struct ScanState {
    /// A slash command read and not settled yet, with its submission and time.
    /// The records after it say whether it started a turn (its expansion, an
    /// instruction it injects, the model answering) or was a client-side one,
    /// such as a model switch: the same verdict the transcript view reaches
    /// before it shows a command as a turn's prompt.
    pending_command: Option<(Option<String>, DateTime<Utc>)>,
}

impl ScanState {
    /// Read one record: the time of the turn it starts, if it starts one.
    fn feed(&mut self, agent: AgentType, value: &Value) -> Option<DateTime<Utc>> {
        if agent == AgentType::Pi {
            return if crate::parsers::pi::is_user_message(value) {
                record_timestamp(value)
            } else {
                None
            };
        }
        if let Some((command_prompt_id, at)) = self.pending_command.take() {
            match pending_command_verdict(value, command_prompt_id.as_deref()) {
                PendingCommandVerdict::Emit => return Some(at),
                PendingCommandVerdict::Wait => {
                    self.pending_command = Some((command_prompt_id, at));
                }
                PendingCommandVerdict::Drop => {}
            }
        }
        if value.get("type").and_then(Value::as_str) != Some("user") {
            return None;
        }
        let prompt_id = record_submission_id(value);
        let command = value
            .pointer("/message/content")
            .and_then(Value::as_str)
            .and_then(slash_command_display);
        if command.is_some() {
            // A command still unsettled before this one started no turn.
            self.pending_command = record_timestamp(value).map(|at| (prompt_id, at));
            return None;
        }
        if !starts_activity(value) {
            return None;
        }
        // A turn starting on its own says the command before it started none.
        self.pending_command = None;
        record_timestamp(value)
    }

    /// Whether a raw line has to be parsed: only a user record starts a turn,
    /// and while a command waits for its verdict the model's answer settles it.
    fn wants(&self, agent: AgentType, line: &str) -> bool {
        if agent == AgentType::Pi {
            return line.contains(r#""role":"user""#);
        }
        line.contains(r#""type":"user""#)
            || (self.pending_command.is_some() && line.contains(r#""type":"assistant""#))
    }
}

/// A record of the conversation itself (not metadata), whose time tells how far
/// the transcript had got.
fn is_conversation_record(agent: AgentType, value: &Value) -> bool {
    let kind = value.get("type").and_then(Value::as_str);
    if agent == AgentType::Pi {
        kind == Some("message")
    } else {
        matches!(kind, Some("user" | "assistant"))
    }
}

/// Cheap test on a raw line before [`is_conversation_record`] parses it.
fn may_be_conversation_record(agent: AgentType, line: &str) -> bool {
    if agent == AgentType::Pi {
        line.contains(r#""type":"message""#)
    } else {
        line.contains(r#""type":"user""#) || line.contains(r#""type":"assistant""#)
    }
}

/// Read the complete lines appended at `from`: the newest turn start among
/// them, and the offset after the last complete line. A line still being
/// written is left for the next read.
fn read_forward(
    path: &Path,
    agent: AgentType,
    from: u64,
    scan: &mut ScanState,
    bytes_read: &mut u64,
) -> std::io::Result<(Option<DateTime<Utc>>, u64)> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut offset = from;
    let mut newest = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        *bytes_read += n as u64;
        if line.last() != Some(&b'\n') {
            break;
        }
        offset += n as u64;
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        if !scan.wants(agent, text) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        newest = newest.max(scan.feed(agent, &value));
    }
    Ok((newest, offset))
}

/// What a catch-up found.
struct CatchUp {
    /// The newest turn start after the floor.
    newest: Option<DateTime<Utc>>,
    /// The offset after the last complete line, where reading forward resumes.
    resume: u64,
    scan: ScanState,
}

/// Catch a transcript up from its end: the newest turn start after `floor`.
///
/// Reads backwards in growing chunks, each one's lines in order, and stops at
/// the first chunk that holds a turn start or a conversation record `floor`
/// already covers (everything before such a record is older still), at the
/// start of the file, or after [`CATCH_UP_MAX`] bytes. Most transcripts end in
/// a record the row's time covers, so their catch-up is one small read.
fn catch_up(
    path: &Path,
    agent: AgentType,
    len: u64,
    floor: DateTime<Utc>,
    bytes_read: &mut u64,
) -> std::io::Result<CatchUp> {
    let mut file = File::open(path)?;
    // [hi, len) has been read. `carry` holds the bytes from `hi` to the first
    // newline after it: a line that began before `hi`.
    let mut hi = len;
    let mut carry: Vec<u8> = Vec::new();
    let mut resume: Option<u64> = None;
    let mut chunk = CATCH_UP_FIRST_CHUNK;
    let mut read = 0u64;
    // How the scan stands at the end of the file (a command its last records
    // left open): reading forward goes on from there. Taken from the first
    // chunk that held whole lines.
    let mut at_end: Option<ScanState> = None;
    while hi > 0 && read < CATCH_UP_MAX {
        let lo = hi.saturating_sub(chunk);
        let mut buf = vec![0u8; (hi - lo) as usize];
        file.seek(SeekFrom::Start(lo))?;
        file.read_exact(&mut buf)?;
        read += hi - lo;
        *bytes_read += hi - lo;
        buf.extend_from_slice(&carry);
        hi = lo;
        chunk = (chunk * 2).min(CATCH_UP_MAX_CHUNK);
        if resume.is_none() {
            // A line still being written at the end is left to the next
            // forward read.
            match buf.iter().rposition(|b| *b == b'\n') {
                Some(last) => {
                    resume = Some(lo + last as u64 + 1);
                    buf.truncate(last + 1);
                }
                None if lo == 0 => {
                    resume = Some(0);
                    break;
                }
                None => {
                    carry = buf;
                    continue;
                }
            }
        }
        // The bytes before the first newline may be the end of a line that
        // began before `lo`: they go with the next chunk.
        let first = if lo == 0 {
            0
        } else {
            match buf.iter().position(|b| *b == b'\n') {
                Some(newline) => newline + 1,
                None => {
                    carry = buf;
                    continue;
                }
            }
        };
        let mut scan = ScanState::default();
        let mut newest = None;
        let mut covered = false;
        for line in buf[first..].split_inclusive(|b| *b == b'\n') {
            let Ok(text) = std::str::from_utf8(line) else {
                continue;
            };
            if !may_be_conversation_record(agent, text) && !scan.wants(agent, text) {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            if is_conversation_record(agent, &value)
                && record_timestamp(&value).is_some_and(|at| at <= floor)
            {
                covered = true;
            }
            newest = newest.max(scan.feed(agent, &value));
        }
        if at_end.is_none() && first < buf.len() {
            at_end = Some(scan);
        }
        if let Some(at) = newest.filter(|at| *at > floor) {
            return Ok(CatchUp {
                newest: Some(at),
                resume: resume.unwrap_or(len),
                scan: at_end.unwrap_or_default(),
            });
        }
        if covered {
            break;
        }
        carry = buf[..first].to_vec();
    }
    Ok(CatchUp {
        newest: None,
        resume: resume.unwrap_or(len),
        scan: at_end.unwrap_or_default(),
    })
}

/// One transcript to look at, with what is known about it.
struct ReadJob {
    path: PathBuf,
    agent: AgentType,
    offset: Option<u64>,
    seen: Option<FileStamp>,
    floor: DateTime<Utc>,
    scan: ScanState,
}

enum ReadOutcome {
    /// The transcript is gone (moved, deleted).
    Missing,
    /// Not written since it was last read.
    Unchanged,
    /// It could not be read this time; nothing changes.
    Failed,
    Read {
        newest: Option<DateTime<Utc>>,
        offset: u64,
        seen: FileStamp,
        scan: ScanState,
        bytes: u64,
    },
}

/// Look at one transcript: nothing when a `stat` says it is unchanged, the
/// bytes appended past the offset when there is one to trust, a catch-up from
/// the end otherwise.
fn read_transcript(job: ReadJob) -> ReadOutcome {
    let Some(stamp) = FileStamp::of(&job.path) else {
        return ReadOutcome::Missing;
    };
    let mut scan = job.scan;
    let mut bytes = 0;
    let continues_from = match (job.offset, job.seen) {
        (Some(_), Some(seen)) if seen.same_as(&stamp) => return ReadOutcome::Unchanged,
        // Same file, grown (or rewritten in place to at least the same size,
        // which the agents never do), and not too far behind.
        (Some(offset), Some(seen))
            if seen.ino == stamp.ino
                && stamp.len >= offset
                && stamp.len - offset <= FORWARD_MAX =>
        {
            Some(offset)
        }
        _ => None,
    };
    let result = if let Some(offset) = continues_from {
        read_forward(&job.path, job.agent, offset, &mut scan, &mut bytes)
    } else if stamp
        .mtime
        .is_some_and(|mtime| DateTime::<Utc>::from(mtime) <= job.floor)
    {
        // Not written since the row's time: nothing in it is newer.
        scan = ScanState::default();
        Ok((None, stamp.len))
    } else {
        catch_up(&job.path, job.agent, stamp.len, job.floor, &mut bytes).map(|found| {
            scan = found.scan;
            (found.newest, found.resume)
        })
    };
    match result {
        Ok((newest, offset)) => ReadOutcome::Read {
            newest,
            offset,
            seen: stamp,
            scan,
            bytes,
        },
        Err(error) => {
            tracing::debug!(
                "[outside-activity] could not read {}: {error}",
                job.path.display()
            );
            ReadOutcome::Failed
        }
    }
}

/// A transcript this watcher reads.
#[derive(Debug)]
struct Tracked {
    candidate: Candidate,
    /// End of the last complete line read. `None` until the transcript has
    /// been caught up: it is new here, or a connection held it.
    offset: Option<u64>,
    /// The transcript's `stat` when it was last read.
    seen: Option<FileStamp>,
    scan: ScanState,
    /// The row's activity time as far as this watcher knows: what its last
    /// write or read of the row said. A turn at or before it moves nothing.
    floor: DateTime<Utc>,
    /// `floor` was read from the row just now, so a catch-up can use it as is.
    floor_fresh: bool,
    /// A turn whose write failed, to try again.
    unwritten: Option<DateTime<Utc>>,
}

impl Tracked {
    fn new(candidate: Candidate, floor: DateTime<Utc>) -> Self {
        Self {
            candidate,
            offset: None,
            seen: None,
            scan: ScanState::default(),
            floor,
            floor_fresh: true,
            unwritten: None,
        }
    }
}

/// Which transcripts a pass looks at.
pub(crate) enum Scope {
    /// Every transcript followed: the slow scan.
    Tracked,
    /// The ones change events named.
    Changed(HashSet<PathBuf>),
}

/// Where a row's transcript was found.
struct Located {
    path: PathBuf,
    candidate: Candidate,
    updated_at: DateTime<Utc>,
    modified: Option<SystemTime>,
}

/// Find the transcripts of `rows` by file name alone: a session's file is named
/// after its id (`<project>/<id>.jsonl`; pi's `<bucket>/<time>_<id>.jsonl`, or
/// flat under a configured directory), so nothing is opened, and one directory
/// listing per project is the whole cost. The roots are resolved to real paths,
/// which is what change events name.
fn locate(roots: &TranscriptRoots, rows: &[ActivityCandidate]) -> Vec<Located> {
    let mut wanted: HashMap<AgentType, HashMap<&str, &ActivityCandidate>> = HashMap::new();
    for row in rows {
        wanted
            .entry(row.agent_type)
            .or_default()
            .insert(row.external_id.as_str(), row);
    }
    let mut found = Vec::new();
    let mut taken: HashSet<(AgentType, String)> = HashSet::new();
    let mut take = |agent: AgentType, id: &str, path: PathBuf, modified: Option<SystemTime>| {
        let Some(row) = wanted.get(&agent).and_then(|rows| rows.get(id)) else {
            return;
        };
        // The first file found wins, as it does for the transcript view.
        if taken.insert((agent, id.to_string())) {
            found.push(Located {
                path,
                candidate: Candidate {
                    conversation_id: row.id,
                    agent,
                },
                updated_at: row.updated_at,
                modified,
            });
        }
    };
    let modified = |entry: &std::fs::DirEntry| entry.metadata().ok()?.modified().ok();

    if let Ok(root) = std::fs::canonicalize(&roots.projects) {
        for project in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            let dir = project.path();
            if !dir.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(id) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(str::to_string)
                else {
                    continue;
                };
                take(AgentType::ClaudeCode, &id, path, modified(&entry));
            }
        }
    }

    if let Ok(root) = std::fs::canonicalize(&roots.pi_sessions) {
        for entry in walkdir::WalkDir::new(&root)
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
            let id = crate::parsers::pi::fallback_id(path);
            let mtime = entry.metadata().ok().and_then(|m| m.modified().ok());
            take(AgentType::Pi, &id, path.to_path_buf(), mtime);
        }
    }
    found
}

/// The transcripts followed, and how far each has been read.
pub(crate) struct OutsideActivity {
    roots: TranscriptRoots,
    /// Every transcript of a row the lists show, wherever it was found.
    known: HashMap<PathBuf, Candidate>,
    /// The ones read: those active lately, and any a change event named.
    tracked: HashMap<PathBuf, Tracked>,
    /// Bytes read from transcripts so far.
    bytes_read: u64,
}

impl OutsideActivity {
    pub(crate) fn new(roots: TranscriptRoots) -> Self {
        Self {
            roots,
            known: HashMap::new(),
            tracked: HashMap::new(),
            bytes_read: 0,
        }
    }

    pub(crate) fn is_known(&self, path: &Path) -> bool {
        self.known.contains_key(path)
    }

    /// The directories the transcripts sit in: what the change events watch.
    pub(crate) fn watch_dirs(&self) -> HashSet<PathBuf> {
        self.known
            .keys()
            .filter_map(|path| path.parent().map(Path::to_path_buf))
            .collect()
    }

    /// Read the rows again and find their transcripts again. A transcript
    /// active in the last [`ACTIVE_DAYS`] days is followed from here on (and
    /// caught up by the next pass); one that went quiet is dropped until a
    /// change event names it.
    pub(crate) async fn refresh(&mut self, db: &DatabaseConnection) -> Result<(), DbError> {
        let rows = conversation_service::list_activity_candidates(db, &AGENTS).await?;
        let roots = self.roots.clone();
        let located = tokio::task::spawn_blocking(move || locate(&roots, &rows))
            .await
            .unwrap_or_default();
        let active_since = Utc::now() - chrono::Duration::days(ACTIVE_DAYS);
        let mut known = HashMap::with_capacity(located.len());
        for found in located {
            let active = found.updated_at >= active_since
                || found
                    .modified
                    .is_some_and(|modified| DateTime::<Utc>::from(modified) >= active_since);
            let followed = self
                .tracked
                .get(&found.path)
                .is_some_and(|entry| entry.candidate == found.candidate);
            if !active {
                self.tracked.remove(&found.path);
            } else if followed {
                if let Some(entry) = self.tracked.get_mut(&found.path) {
                    entry.floor = entry.floor.max(found.updated_at);
                }
            } else {
                self.tracked.insert(
                    found.path.clone(),
                    Tracked::new(found.candidate, found.updated_at),
                );
            }
            known.insert(found.path, found.candidate);
        }
        self.tracked
            .retain(|path, entry| known.get(path) == Some(&entry.candidate));
        self.known = known;
        Ok(())
    }

    /// Read what landed in the transcripts `scope` names and move each row a
    /// turn started in. Returns how many rows moved.
    pub(crate) async fn process(
        &mut self,
        db: &DatabaseConnection,
        manager: &ConnectionManager,
        emitter: &EventEmitter,
        scope: Scope,
    ) -> usize {
        let paths: Vec<PathBuf> = match scope {
            Scope::Tracked => self.tracked.keys().cloned().collect(),
            Scope::Changed(paths) => paths
                .into_iter()
                .filter(|path| self.known.contains_key(path))
                .collect(),
        };
        if paths.is_empty() {
            return 0;
        }
        let bound = manager.bound_conversations().await;

        let mut jobs = Vec::new();
        for path in paths {
            let Some(candidate) = self.known.get(&path).copied() else {
                continue;
            };
            // pi has no transcript watcher of its own; every other agent here
            // has, and a bound session's bytes are its.
            let held =
                candidate.agent != AgentType::Pi && bound.contains_key(&candidate.conversation_id);
            let needs_floor = !held
                && self
                    .tracked
                    .get(&path)
                    .is_none_or(|entry| entry.offset.is_none() && !entry.floor_fresh);
            let floor = if needs_floor {
                match conversation_service::activity_floor(db, candidate.conversation_id).await {
                    Ok(Some(floor)) => Some(floor),
                    Ok(None) => {
                        // Deleted since the last refresh.
                        self.tracked.remove(&path);
                        self.known.remove(&path);
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!(
                            "[outside-activity] reading conversation {} failed: {error}",
                            candidate.conversation_id
                        );
                        continue;
                    }
                }
            } else {
                None
            };
            // A change event can name a transcript no scan follows: from now on
            // it is followed.
            let entry = self.tracked.entry(path.clone()).or_insert_with(|| {
                let mut entry = Tracked::new(candidate, floor.unwrap_or(DateTime::<Utc>::MIN_UTC));
                entry.floor_fresh = floor.is_some();
                entry
            });
            if held {
                // Once the connection is gone, the transcript is caught up from
                // its end, against the row's time as it is then.
                entry.offset = None;
                entry.seen = None;
                entry.floor_fresh = false;
                continue;
            }
            if let Some(floor) = floor {
                entry.floor = floor;
            }
            entry.floor_fresh = false;
            jobs.push(ReadJob {
                path,
                agent: candidate.agent,
                offset: entry.offset,
                seen: entry.seen,
                floor: entry.floor,
                scan: entry.scan.clone(),
            });
        }
        if jobs.is_empty() {
            return 0;
        }

        let outcomes = match tokio::task::spawn_blocking(move || {
            jobs.into_iter()
                .map(|job| (job.path.clone(), read_transcript(job)))
                .collect::<Vec<_>>()
        })
        .await
        {
            Ok(outcomes) => outcomes,
            Err(error) => {
                tracing::warn!("[outside-activity] reading transcripts failed: {error}");
                return 0;
            }
        };

        let mut moved = 0;
        for (path, outcome) in outcomes {
            let newest = match outcome {
                ReadOutcome::Missing => {
                    // The next refresh finds it again, wherever it went.
                    self.tracked.remove(&path);
                    self.known.remove(&path);
                    continue;
                }
                ReadOutcome::Unchanged | ReadOutcome::Failed => None,
                ReadOutcome::Read {
                    newest,
                    offset,
                    seen,
                    scan,
                    bytes,
                } => {
                    self.bytes_read += bytes;
                    let Some(entry) = self.tracked.get_mut(&path) else {
                        continue;
                    };
                    entry.offset = Some(offset);
                    entry.seen = Some(seen);
                    entry.scan = scan;
                    newest
                }
            };
            let Some(entry) = self.tracked.get_mut(&path) else {
                continue;
            };
            let Some(at) = newest
                .max(entry.unwritten.take())
                .filter(|at| *at > entry.floor)
            else {
                continue;
            };
            let conversation_id = entry.candidate.conversation_id;
            if bound.get(&conversation_id) == Some(&true) {
                // codeg runs a turn on it right now and stamps the row itself.
                entry.floor = at;
                continue;
            }
            match conversation_service::record_out_of_turn_activity(db, conversation_id, at).await {
                Ok(written) => {
                    entry.floor = at;
                    if written {
                        tracing::info!(
                            "[outside-activity] conversation={conversation_id} moved to {at} by {}",
                            path.display()
                        );
                        crate::commands::conversations::emit_conversation_upsert(
                            emitter,
                            db,
                            conversation_id,
                        )
                        .await;
                        moved += 1;
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        "[outside-activity] moving conversation {conversation_id} failed: {error}"
                    );
                    entry.unwritten = Some(at);
                }
            }
        }
        moved
    }
}

/// Change events for transcripts, as their paths. `None` when the platform
/// offers no watcher; the scan then runs more often.
fn start_watcher(
    events: mpsc::Sender<PathBuf>,
    overflowed: Arc<AtomicBool>,
) -> Option<RecommendedWatcher> {
    let handler = move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) {
            return;
        }
        for path in event.paths {
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Err(TrySendError::Full(_)) = events.try_send(path) {
                overflowed.store(true, Ordering::Relaxed);
            }
        }
    };
    match notify::recommended_watcher(handler) {
        Ok(watcher) => Some(watcher),
        Err(error) => {
            tracing::warn!("[outside-activity] no change events, scanning instead: {error}");
            None
        }
    }
}

/// Watch exactly `wanted` (each directory on its own, not recursively).
fn sync_watches(
    watcher: &mut Option<RecommendedWatcher>,
    watched: &mut HashSet<PathBuf>,
    wanted: HashSet<PathBuf>,
) {
    let Some(watcher) = watcher.as_mut() else {
        return;
    };
    let stale: Vec<PathBuf> = watched.difference(&wanted).cloned().collect();
    for dir in stale {
        let _ = watcher.unwatch(&dir);
        watched.remove(&dir);
    }
    for dir in wanted {
        if watched.contains(&dir) {
            continue;
        }
        match watcher.watch(&dir, RecursiveMode::NonRecursive) {
            Ok(()) => {
                watched.insert(dir);
            }
            Err(error) => {
                tracing::debug!("[outside-activity] cannot watch {}: {error}", dir.display())
            }
        }
    }
}

async fn sleep_until(due: Option<tokio::time::Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(due).await,
        None => std::future::pending().await,
    }
}

/// Follow the transcripts of the sessions the lists show for as long as the
/// app runs, moving a row up whenever a turn starts in its transcript outside
/// codeg. Spawned once at startup, in both runtimes.
pub async fn outside_activity_task(
    db: DatabaseConnection,
    manager: ConnectionManager,
    emitter: EventEmitter,
) {
    let (events_tx, mut events) = mpsc::channel::<PathBuf>(EVENT_CHANNEL_CAPACITY);
    let overflowed = Arc::new(AtomicBool::new(false));
    let mut watcher = start_watcher(events_tx, overflowed.clone());
    let mut events_live = watcher.is_some();
    let mut watched = HashSet::new();
    let mut core = OutsideActivity::new(TranscriptRoots::resolve());

    tokio::time::sleep(STARTUP_DELAY).await;
    // What landed while codeg was not running is caught up first.
    match core.refresh(&db).await {
        Ok(()) => sync_watches(&mut watcher, &mut watched, core.watch_dirs()),
        Err(error) => tracing::warn!("[outside-activity] reading conversations failed: {error}"),
    }
    let moved = core.process(&db, &manager, &emitter, Scope::Tracked).await;
    tracing::info!(
        "[outside-activity] following {} transcripts ({} known) in {} directories; \
         catching up read {} KiB and moved {moved} sessions",
        core.tracked.len(),
        core.known.len(),
        watched.len(),
        core.bytes_read / 1024
    );

    let scan_every = if events_live {
        SLOW_SCAN
    } else {
        SCAN_WITHOUT_EVENTS
    };
    let start = tokio::time::Instant::now();
    let mut scan = tokio::time::interval_at(start + scan_every, scan_every);
    scan.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut refresh = tokio::time::interval_at(start + REFRESH, REFRESH);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut changed: HashSet<PathBuf> = HashSet::new();
    let mut due: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            event = events.recv(), if events_live => match event {
                Some(path) => {
                    if core.is_known(&path) {
                        changed.insert(path);
                        due.get_or_insert_with(|| tokio::time::Instant::now() + DEBOUNCE);
                    }
                }
                None => events_live = false,
            },
            _ = sleep_until(due) => {
                due = None;
                let changed = std::mem::take(&mut changed);
                // Events were dropped: look at everything instead.
                let scope = if overflowed.swap(false, Ordering::Relaxed) {
                    Scope::Tracked
                } else {
                    Scope::Changed(changed)
                };
                core.process(&db, &manager, &emitter, scope).await;
            }
            _ = scan.tick() => {
                core.process(&db, &manager, &emitter, Scope::Tracked).await;
            }
            _ = refresh.tick() => match core.refresh(&db).await {
                Ok(()) => sync_watches(&mut watcher, &mut watched, core.watch_dirs()),
                Err(error) => {
                    tracing::warn!("[outside-activity] reading conversations failed: {error}");
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::ConnectionStatus;
    use crate::db::entities::conversation;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::web::event_bridge::{WebEventBroadcaster, CONVERSATION_CHANGED_EVENT};
    use chrono::SecondsFormat;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    use serde_json::json;
    use std::io::Write;

    struct Fixture {
        db: crate::db::AppDatabase,
        _dir: tempfile::TempDir,
        roots: TranscriptRoots,
        folder: i32,
        manager: ConnectionManager,
        events: tokio::sync::broadcast::Receiver<crate::web::event_bridge::WebEvent>,
        emitter: EventEmitter,
        core: OutsideActivity,
    }

    async fn fixture() -> Fixture {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let roots = TranscriptRoots {
            projects: dir.path().join("projects"),
            pi_sessions: dir.path().join("pi-sessions"),
        };
        std::fs::create_dir_all(roots.projects.join("-work-app")).unwrap();
        std::fs::create_dir_all(roots.pi_sessions.join("--work-app--")).unwrap();
        let folder = seed_folder(&db, "/work/app").await;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let events = broadcaster.subscribe();
        Fixture {
            db,
            _dir: dir,
            core: OutsideActivity::new(roots.clone()),
            roots,
            folder,
            manager: ConnectionManager::new(),
            events,
            emitter: EventEmitter::test_web_only(broadcaster),
        }
    }

    impl Fixture {
        /// A conversation of `agent` bound to agent session `session`, and the
        /// path its transcript goes to.
        async fn conversation(&self, agent: AgentType, session: &str) -> (i32, PathBuf) {
            let row = conversation_service::create(&self.db.conn, self.folder, agent, None, None)
                .await
                .unwrap();
            conversation::Entity::update_many()
                .col_expr(
                    conversation::Column::ExternalId,
                    sea_orm::sea_query::Expr::value(session),
                )
                .filter(conversation::Column::Id.eq(row.id))
                .exec(&self.db.conn)
                .await
                .unwrap();
            let path = if agent == AgentType::Pi {
                self.roots
                    .pi_sessions
                    .join("--work-app--")
                    .join(format!("2026-11-02T17-00-00-000Z_{session}.jsonl"))
            } else {
                self.roots
                    .projects
                    .join("-work-app")
                    .join(format!("{session}.jsonl"))
            };
            (row.id, path)
        }

        async fn updated_at(&self, id: i32) -> DateTime<Utc> {
            conversation::Entity::find_by_id(id)
                .one(&self.db.conn)
                .await
                .unwrap()
                .unwrap()
                .updated_at
        }

        async fn refresh(&mut self) {
            self.core.refresh(&self.db.conn).await.unwrap();
        }

        /// The pass a change event for `path` runs.
        async fn changed(&mut self, path: &Path) -> usize {
            let canonical = std::fs::canonicalize(path).unwrap();
            self.core
                .process(
                    &self.db.conn,
                    &self.manager,
                    &self.emitter,
                    Scope::Changed(HashSet::from([canonical])),
                )
                .await
        }

        /// The slow scan's pass.
        async fn scan(&mut self) -> usize {
            self.core
                .process(&self.db.conn, &self.manager, &self.emitter, Scope::Tracked)
                .await
        }

        /// The ids of the rows broadcast as changed since the last call.
        fn broadcast(&mut self) -> Vec<i64> {
            let mut ids = Vec::new();
            while let Ok(event) = self.events.try_recv() {
                if event.channel == CONVERSATION_CHANGED_EVENT && event.payload["kind"] == "upsert"
                {
                    ids.push(event.payload["summary"]["id"].as_i64().unwrap());
                }
            }
            ids
        }

        /// A live connection bound to `conversation_id`, as after its first
        /// prompt.
        async fn bind(&self, connection: &str, agent: AgentType, conversation_id: Option<i32>) {
            self.manager
                .insert_test_connection(connection, agent, None, EventEmitter::Noop)
                .await;
            let state = self.manager.get_state(connection).await.unwrap();
            state.write().await.conversation_id = conversation_id;
        }

        async fn set_prompting(&self, connection: &str, prompting: bool) {
            let state = self.manager.get_state(connection).await.unwrap();
            state.write().await.status = if prompting {
                ConnectionStatus::Prompting
            } else {
                ConnectionStatus::Connected
            };
        }

        async fn drop_connection(&self, connection: &str) {
            self.manager.connections.lock().await.remove(connection);
        }
    }

    fn append(path: &Path, lines: &[String]) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn ts(at: DateTime<Utc>) -> String {
        at.to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    /// A time after the rows were created, so a turn then is newer than them,
    /// at the precision transcripts carry.
    fn later(seconds: i64) -> DateTime<Utc> {
        to_millis(Utc::now() + chrono::Duration::seconds(60 + seconds))
    }

    /// A time before the rows were created: history they already cover.
    fn earlier(seconds: i64) -> DateTime<Utc> {
        to_millis(Utc::now() - chrono::Duration::seconds(3600 + seconds))
    }

    fn to_millis(at: DateTime<Utc>) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(at.timestamp_millis()).unwrap()
    }

    /// A message another session sends through the SDK, as `-p --resume`
    /// writes it.
    fn sent(prompt_id: &str, at: DateTime<Utc>, text: &str) -> String {
        json!({
            "type": "user", "promptId": prompt_id, "uuid": format!("u-{prompt_id}"),
            "timestamp": ts(at), "promptSource": "sdk", "turnOrigin": "sdk",
            "message": {"role": "user", "content": text}
        })
        .to_string()
    }

    fn reply(uuid: &str, at: DateTime<Utc>, text: &str) -> String {
        json!({
            "type": "assistant", "uuid": uuid, "timestamp": ts(at),
            "message": {"id": format!("msg-{uuid}"), "role": "assistant", "content": [{"type": "text", "text": text}]}
        })
        .to_string()
    }

    fn tool_result(prompt_id: &str, at: DateTime<Utc>) -> String {
        json!({
            "type": "user", "promptId": prompt_id, "uuid": format!("r-{}", at.timestamp_millis()),
            "timestamp": ts(at),
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}
        })
        .to_string()
    }

    fn peer_message(at: DateTime<Utc>) -> String {
        json!({
            "type": "user", "uuid": format!("p-{}", at.timestamp_millis()), "timestamp": ts(at),
            "isMeta": true, "promptSource": "system", "turnOrigin": "peer", "origin": {"kind": "peer"},
            "message": {"role": "user", "content": "Another session sent a message:\n<cross-session-message from-name=\"Orchestrator\">Run the next step</cross-session-message>"}
        })
        .to_string()
    }

    fn task_notification(prompt_id: &str, at: DateTime<Utc>) -> String {
        json!({
            "type": "user", "promptId": prompt_id, "uuid": format!("n-{}", at.timestamp_millis()),
            "timestamp": ts(at), "promptSource": "system", "origin": {"kind": "task-notification"},
            "message": {"role": "user", "content": "<task-notification>\n<task-id>a1</task-id>\n<status>stopped</status>\n</task-notification>"}
        })
        .to_string()
    }

    /// The note a resume writes, for the transcript only, of background work an
    /// earlier process left unfinished: opening a session in codeg writes one.
    fn unfinished_work_note(prompt_id: &str, at: DateTime<Utc>) -> String {
        let mut value: Value = serde_json::from_str(&task_notification(prompt_id, at)).unwrap();
        value["queueTranscriptOnly"] = json!(true);
        value.to_string()
    }

    /// What a model switch leaves: the caveat, the command, its output.
    fn model_switch(prompt_id: &str, at: DateTime<Utc>) -> Vec<String> {
        let record = |uuid: &str, meta: bool, content: &str| {
            let mut value = json!({
                "type": "user", "promptId": prompt_id, "uuid": uuid, "timestamp": ts(at),
                "message": {"role": "user", "content": content}
            });
            if meta {
                value["isMeta"] = json!(true);
            }
            value.to_string()
        };
        vec![
            record(
                "cv",
                true,
                "<local-command-caveat>The command below was run directly, not sent to you as a request.</local-command-caveat>",
            ),
            record(
                "cmd",
                false,
                "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>",
            ),
            record("out", false, "<local-command-stdout>Set model to opus</local-command-stdout>"),
        ]
    }

    /// Records that start no turn: metadata, titles, the queue's bookkeeping,
    /// a rename's note, a resume's note, attachments, the model's own records.
    fn no_turn(at: DateTime<Utc>) -> Vec<String> {
        vec![
            json!({"type": "custom-title", "customTitle": "Store listings", "sessionId": "s"}).to_string(),
            json!({"type": "ai-title", "aiTitle": "Privacy policy", "sessionId": "s"}).to_string(),
            json!({"type": "last-prompt", "lastPrompt": "hello", "sessionId": "s"}).to_string(),
            json!({"type": "mode", "mode": "bypassPermissions", "sessionId": "s"}).to_string(),
            json!({"type": "queue-operation", "operation": "enqueue", "timestamp": ts(at), "content": "hello"}).to_string(),
            json!({"type": "attachment", "timestamp": ts(at), "attachment": {"type": "queued_command", "commandMode": "task-notification"}}).to_string(),
            json!({
                "type": "user", "uuid": "named", "timestamp": ts(at), "isMeta": true,
                "message": {"role": "user", "content": "<system-reminder>\nThe user named this session \"Store listings\".\n</system-reminder>"}
            })
            .to_string(),
            json!({"type": "system", "subtype": "turn_duration", "timestamp": ts(at)}).to_string(),
            unfinished_work_note("p-resume", at),
            reply("a-meta", at, "done"),
            tool_result("p-old", at),
        ]
    }

    #[tokio::test]
    async fn a_turn_written_outside_codeg_moves_the_session_once() {
        let mut f = fixture().await;
        let (id, path) = f.conversation(AgentType::ClaudeCode, "s-1").await;
        append(
            &path,
            &[
                sent("p-0", earlier(0), "an old message"),
                reply("a0", earlier(0), "ok"),
            ],
        );
        let created = f.updated_at(id).await;
        f.refresh().await;
        assert_eq!(
            f.scan().await,
            0,
            "history the row already covers moves nothing"
        );
        assert_eq!(f.updated_at(id).await, created);

        // The orchestrator resumes it: the queue's bookkeeping, the message,
        // then the turn it starts.
        let message = later(0);
        append(
            &path,
            &[
                json!({"type": "queue-operation", "operation": "enqueue", "timestamp": ts(message)})
                    .to_string(),
                sent("p-1", message, "From the orchestrator: take the store listings"),
                reply("a1", later(1), "On it"),
                tool_result("p-1", later(2)),
            ],
        );
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, message);
        assert_eq!(f.broadcast(), vec![i64::from(id)], "every client re-sorts");

        // The same turn going on is not a new one.
        append(
            &path,
            &[reply("a2", later(3), "Done"), tool_result("p-1", later(4))],
        );
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(f.updated_at(id).await, message);
        assert!(f.broadcast().is_empty());

        // A background task reporting back starts the next turn, even when the
        // CLI files it under the same submission id.
        let reported = later(5);
        append(
            &path,
            &[
                task_notification("p-1", reported),
                reply("a3", later(6), "The inventory is in"),
            ],
        );
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, reported);
        assert_eq!(f.broadcast(), vec![i64::from(id)]);

        // So does a message from another session; two turns read at once are
        // one write, at the newer.
        let first = later(10);
        let second = later(12);
        append(
            &path,
            &[
                peer_message(first),
                reply("a4", later(11), "Reported"),
                peer_message(second),
            ],
        );
        assert_eq!(f.scan().await, 1, "the slow scan finds what no event named");
        assert_eq!(f.updated_at(id).await, second);
        assert_eq!(f.broadcast(), vec![i64::from(id)]);
    }

    #[tokio::test]
    async fn records_that_start_no_turn_leave_the_session_where_it_is() {
        let mut f = fixture().await;
        let (id, path) = f.conversation(AgentType::ClaudeCode, "s-2").await;
        append(&path, &[]);
        f.refresh().await;
        f.scan().await;
        let before = f.updated_at(id).await;

        let mut quiet = no_turn(later(0));
        quiet.extend(model_switch("p-model", later(1)));
        append(&path, &quiet);
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(
            f.updated_at(id).await,
            before,
            "a selector or a title is not activity"
        );
        assert!(f.broadcast().is_empty());

        // A cron fire is a turn, the model switch before it none.
        let cron = later(5);
        append(
            &path,
            &[json!({
                "type": "user", "uuid": "cron", "timestamp": ts(cron), "isMeta": true,
                "promptSource": "system", "turnOrigin": "scheduled",
                "message": {"role": "user", "content": "check the build"}
            })
            .to_string()],
        );
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, cron);
    }

    #[tokio::test]
    async fn a_command_that_starts_a_turn_counts_and_a_client_side_one_does_not() {
        let mut f = fixture().await;
        let (id, path) = f.conversation(AgentType::ClaudeCode, "s-3").await;
        append(&path, &[]);
        f.refresh().await;
        f.scan().await;
        let before = f.updated_at(id).await;

        append(&path, &model_switch("p-model", later(0)));
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(f.updated_at(id).await, before);

        // `/loop` expands into the prompt the model answers.
        let typed = later(5);
        append(
            &path,
            &[
                json!({
                    "type": "user", "promptId": "p-loop", "uuid": "loop", "timestamp": ts(typed),
                    "message": {"role": "user", "content": "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m check the build</command-args>"}
                })
                .to_string(),
                json!({
                    "type": "user", "promptId": "p-loop", "uuid": "loop-x", "timestamp": ts(later(6)), "isMeta": true,
                    "message": {"role": "user", "content": [{"type": "text", "text": "Run this every 5 minutes: check the build"}]}
                })
                .to_string(),
            ],
        );
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, typed, "the command's own time");
    }

    #[tokio::test]
    async fn deleted_rows_and_delegation_children_never_move() {
        let mut f = fixture().await;
        let (parent, parent_path) = f.conversation(AgentType::ClaudeCode, "s-parent").await;
        let (deleted, deleted_path) = f.conversation(AgentType::ClaudeCode, "s-deleted").await;
        conversation_service::soft_delete(&f.db.conn, deleted)
            .await
            .unwrap();
        let child = conversation_service::create_with_delegation(
            &f.db.conn,
            f.folder,
            AgentType::ClaudeCode,
            None,
            None,
            Some(crate::acp::delegation::spawner::DelegationLink {
                parent_conversation_id: parent,
                parent_tool_use_id: "tu-1".into(),
                delegation_call_id: "call-1".into(),
            }),
        )
        .await
        .unwrap()
        .id;
        conversation::Entity::update_many()
            .col_expr(
                conversation::Column::ExternalId,
                sea_orm::sea_query::Expr::value("s-child"),
            )
            .filter(conversation::Column::Id.eq(child))
            .exec(&f.db.conn)
            .await
            .unwrap();
        let child_path = f.roots.projects.join("-work-app").join("s-child.jsonl");
        for path in [&parent_path, &deleted_path, &child_path] {
            append(path, &[]);
        }
        let deleted_before = f.updated_at(deleted).await;
        let child_before = f.updated_at(child).await;
        f.refresh().await;
        assert!(!f
            .core
            .is_known(&std::fs::canonicalize(&deleted_path).unwrap()));
        assert!(!f
            .core
            .is_known(&std::fs::canonicalize(&child_path).unwrap()));
        f.scan().await;

        append(&deleted_path, &[sent("p-d", later(0), "hello")]);
        append(&child_path, &[sent("p-c", later(0), "hello")]);
        assert_eq!(f.changed(&deleted_path).await, 0);
        assert_eq!(f.changed(&child_path).await, 0);
        assert_eq!(f.updated_at(deleted).await, deleted_before);
        assert_eq!(f.updated_at(child).await, child_before);

        // Deleted while followed: the write's own guard holds.
        conversation_service::soft_delete(&f.db.conn, parent)
            .await
            .unwrap();
        let parent_before = f.updated_at(parent).await;
        append(&parent_path, &[sent("p-p", later(1), "hello")]);
        assert_eq!(f.changed(&parent_path).await, 0);
        assert_eq!(f.updated_at(parent).await, parent_before);
        assert!(f.broadcast().is_empty());
    }

    #[tokio::test]
    async fn a_session_its_connection_drives_is_left_to_that_connection() {
        let mut f = fixture().await;
        let (id, path) = f.conversation(AgentType::ClaudeCode, "s-4").await;
        append(&path, &[]);
        f.refresh().await;
        f.scan().await;
        let before = f.updated_at(id).await;

        // Bound by its first prompt: its own transcript watcher reads it.
        f.bind("c1", AgentType::ClaudeCode, Some(id)).await;
        let read_before = f.core.bytes_read;
        let message = later(0);
        append(
            &path,
            &[peer_message(message), reply("a1", later(1), "On it")],
        );
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(f.scan().await, 0);
        assert_eq!(f.core.bytes_read, read_before, "not even read");
        assert_eq!(f.updated_at(id).await, before);

        // The connection is gone: what landed meanwhile is caught up from the
        // end of the transcript.
        f.drop_connection("c1").await;
        assert_eq!(f.scan().await, 1);
        assert_eq!(f.updated_at(id).await, message);

        // A connection opened only to look at the session is bound by its
        // first prompt, so until then this watcher covers it.
        f.bind("c2", AgentType::ClaudeCode, None).await;
        let next = later(10);
        append(&path, &[task_notification("p-9", next)]);
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, next);
    }

    #[tokio::test]
    async fn a_pi_session_moves_on_a_user_message_unless_codeg_runs_its_turn() {
        let mut f = fixture().await;
        let (id, path) = f
            .conversation(AgentType::Pi, "01a0a9d6-55e2-71a6-964e-281653a46f35")
            .await;
        let header = json!({"type": "session", "version": 3, "id": "01a0a9d6-55e2-71a6-964e-281653a46f35", "timestamp": ts(earlier(0)), "cwd": "/work/app"}).to_string();
        append(&path, &[header]);
        f.refresh().await;
        f.scan().await;
        let before = f.updated_at(id).await;

        let message = |at: DateTime<Utc>, role: &str, text: &str| {
            json!({
                "type": "message", "id": format!("m{}", at.timestamp_millis()), "timestamp": ts(at),
                "message": {"role": role, "content": [{"type": "text", "text": text}]}
            })
            .to_string()
        };
        append(
            &path,
            &[
                json!({"type": "model_change", "timestamp": ts(later(0)), "provider": "p", "modelId": "m"}).to_string(),
                message(later(1), "assistant", "still here"),
            ],
        );
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(f.updated_at(id).await, before);

        // A background job's notice reaches the agent as a user message.
        let notice = later(2);
        append(&path, &[message(notice, "user", "Background job finished")]);
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, notice);

        // Bound and running a codeg turn: that turn stamps the row itself.
        f.bind("pi-1", AgentType::Pi, Some(id)).await;
        f.set_prompting("pi-1", true).await;
        append(&path, &[message(later(3), "user", "steer: also the docs")]);
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(f.updated_at(id).await, notice);

        // Bound but idle: a message pi starts a turn on by itself counts.
        f.set_prompting("pi-1", false).await;
        let idle = later(4);
        append(
            &path,
            &[message(idle, "user", "Background job killed (timeout)")],
        );
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.updated_at(id).await, idle);
    }

    #[tokio::test]
    async fn reading_costs_only_what_was_appended() {
        let mut f = fixture().await;
        let (id, path) = f.conversation(AgentType::ClaudeCode, "s-5").await;
        // A long history the row already covers.
        let filler = "x".repeat(2000);
        let history: Vec<String> = (0..1200)
            .map(|i| reply(&format!("h{i}"), earlier(2000 - i), &filler))
            .collect();
        append(&path, &history);
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > 2 * 1024 * 1024);
        f.refresh().await;
        f.scan().await;
        assert!(
            f.core.bytes_read <= CATCH_UP_FIRST_CHUNK,
            "the catch-up stops at the first record the row covers ({} of {size})",
            f.core.bytes_read
        );

        // Only the appended bytes are read, and an unchanged file costs a stat.
        let read_before = f.core.bytes_read;
        let line = sent("p-1", later(0), "next");
        append(&path, &[line.clone()]);
        assert_eq!(f.changed(&path).await, 1);
        assert_eq!(f.core.bytes_read - read_before, line.len() as u64 + 1);
        let read_before = f.core.bytes_read;
        assert_eq!(f.scan().await, 0);
        assert_eq!(f.changed(&path).await, 0);
        assert_eq!(f.core.bytes_read, read_before);
        assert_eq!(f.updated_at(id).await, later_ts(&line));
    }

    #[tokio::test]
    async fn a_catch_up_reads_back_only_to_the_turn_it_is_looking_for() {
        let mut f = fixture().await;
        let (id, path) = f.conversation(AgentType::ClaudeCode, "s-6").await;
        let filler = "y".repeat(2000);
        let old: Vec<String> = (0..600)
            .map(|i| reply(&format!("h{i}"), earlier(1000 - i), &filler))
            .collect();
        append(&path, &old);
        // Written while codeg was not running: a message, then more than a
        // first chunk of records that start no turn, then a line still being
        // written.
        let message = later(0);
        let mut tail = vec![sent("p-1", message, "From the orchestrator")];
        tail.extend((0..100).map(|i| {
            json!({"type": "api-request-blob", "hash": i, "message": filler}).to_string()
        }));
        append(&path, &tail);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(br#"{"type":"assistant","timestamp":"#)
            .unwrap();
        let size = std::fs::metadata(&path).unwrap().len();

        f.refresh().await;
        assert_eq!(f.scan().await, 1);
        assert_eq!(f.updated_at(id).await, message);
        assert!(
            f.core.bytes_read < size / 2,
            "read {} of {size} bytes",
            f.core.bytes_read
        );
        // Reading resumes at the line still being written, which counts once
        // it ends.
        let canonical = std::fs::canonicalize(&path).unwrap();
        let offset = f.core.tracked[&canonical].offset.unwrap();
        assert_eq!(
            offset,
            size - br#"{"type":"assistant","timestamp":"#.len() as u64
        );
    }

    #[test]
    fn what_a_resume_writes_starts_no_turn_and_the_next_message_does() {
        // The shape codeg's resume of the reported session left: the model
        // applied again, then the note of an earlier process's unfinished
        // work, in the same submission. Then the next message.
        let at = later(0);
        let message = at + chrono::Duration::seconds(30);
        let mut records = model_switch("p-1", at);
        records.push(unfinished_work_note(
            "p-1",
            at + chrono::Duration::milliseconds(16),
        ));
        records.push(sent("p-2", message, "From the orchestrator"));
        let mut scan = ScanState::default();
        let starts: Vec<DateTime<Utc>> = records
            .iter()
            .filter_map(|line| {
                scan.feed(AgentType::ClaudeCode, &serde_json::from_str(line).unwrap())
            })
            .collect();
        assert_eq!(starts, vec![message]);
    }

    /// The `timestamp` a line carries.
    fn later_ts(line: &str) -> DateTime<Utc> {
        let value: Value = serde_json::from_str(line).unwrap();
        record_timestamp(&value).unwrap()
    }
}
