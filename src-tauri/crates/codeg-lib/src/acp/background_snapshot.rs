//! What each live session runs in the background, written to its
//! conversation row, so the next start knows what an exit stopped.
//!
//! A session's background work — async sub-agents, background shells,
//! monitors, workflows, codeg's own delegations, a turn the agent runs on its
//! own — lives in memory only (`acp::background_status`). It keeps running
//! after the turn that started it ended, and codeg's exit (a quit, a crash, an
//! update restart) stops all of it. The automatic resume
//! (`acp::auto_resume`) only knew about turns, so a session whose turn had
//! ended came back idle, its sub-agents and shells gone, and nothing went on
//! until someone typed.
//!
//! So the background status is persisted per conversation
//! (`conversation.background_snapshot`) as a [`BackgroundSnapshot`]: the
//! items running and the time they were last seen running.
//!
//! * **While codeg runs**, every change to a session's background status
//!   ([`note_changed`], from the `conversation://background` broadcast) wakes
//!   the writer, which waits [`DEBOUNCE`] for the burst to settle and writes
//!   what changed — one write per change, coalesced; the row is cleared once
//!   nothing runs. Every [`HEARTBEAT`] it rewrites the running ones with a
//!   fresh time, so a crash leaves a snapshot that says when the work was
//!   last alive. These continuous writes are what cover a crash.
//! * **A graceful quit** ([`flush_for_exit`]) stops the writer and writes
//!   every session's snapshot once more, synchronously, before the
//!   connections are torn down (the teardown itself clears every live
//!   status, which must not reach the rows).
//! * **The exit sweep** (`conversation_service::mark_background_cut_off`,
//!   part of `interrupt_orphaned_turns`) marks the rows whose snapshot lists
//!   work for the automatic resume, which names that work in its prompt.
//!
//! Pi has no live background status of its own yet: for a Pi session the
//! writer reads what its transcript and the bg-jobs registry say still runs
//! ([`pi`]), best effort.

pub mod pi;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};

use crate::acp::background_status::{
    clip_label, ConversationBackground, KIND_DELEGATION, KIND_SUBAGENT,
};
use crate::acp::manager::ConnectionManager;
use crate::db::service::conversation_service;

/// Quiet time after a change before the writer writes, so the burst of
/// events one launch makes is one write.
pub const DEBOUNCE: Duration = Duration::from_secs(5);

/// How often the snapshots of work still running are rewritten with a fresh
/// time. Bounds how stale the time a crash leaves behind is.
pub const HEARTBEAT: Duration = Duration::from_secs(5 * 60);

/// How often the writer looks again with no change to wake it: Pi's work has
/// no events of its own, and is read from its transcript on this tick.
pub const POLL: Duration = Duration::from_secs(30);

/// How long a graceful quit waits for the final write before it goes on.
const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

/// The kinds a snapshot lists. A plain string on the wire, so a kind added
/// later renders as itself.
pub const KIND_SUB_AGENT: &str = "sub_agent";
pub const KIND_SHELL: &str = "shell";
pub const KIND_MONITOR: &str = "monitor";
pub const KIND_WORKFLOW: &str = "workflow";
/// A codeg delegation (`delegate_to_agent`); `id` is its task id.
pub const KIND_CODEG_DELEGATION: &str = "delegation";
/// The agent was running a turn of its own, woken by its background work.
pub const KIND_OUT_OF_TURN: &str = "out_of_turn";
/// A Pi bg-jobs job (`bgj_run`); `id` is its job id.
pub const KIND_PI_JOB: &str = "pi_job";
/// A pi-subagents async run; `id` is its run id.
pub const KIND_PI_SUBAGENT: &str = "pi_subagent";
/// Anything else.
pub const KIND_TASK: &str = "task";

/// One piece of background work a snapshot lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundSnapshotItem {
    /// One of the `KIND_*` constants.
    pub kind: String,
    /// What the agent called it, one clipped line. Empty when it gave none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// When codeg first saw it running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    /// The agent's own id for it (a shell's task id, a delegation's task id,
    /// a Pi job id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// A codeg delegation's child agent, by its wire name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

impl BackgroundSnapshotItem {
    pub fn new(kind: &str, label: &str) -> Self {
        Self {
            kind: kind.to_string(),
            label: clip_label(label),
            started_at: None,
            id: None,
            agent: None,
        }
    }
}

/// A session's background work as last seen, stored as JSON on its row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundSnapshot {
    /// The last time the work was seen running: the write, the heartbeat, or
    /// the graceful quit.
    pub at: DateTime<Utc>,
    pub items: Vec<BackgroundSnapshotItem>,
    /// Work running beyond the listed items (the live listing is capped, and
    /// some agents only count their background tasks).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub more: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl BackgroundSnapshot {
    /// Read a stored snapshot. Anything unreadable reads as none: a damaged
    /// row must not name work that may never have run.
    pub fn parse(raw: Option<&str>) -> Option<Self> {
        let raw = raw?.trim();
        if raw.is_empty() {
            return None;
        }
        serde_json::from_str(raw).ok()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Whether it lists any work at all.
    pub fn has_work(&self) -> bool {
        !self.items.is_empty() || self.more > 0
    }

    /// Whether the agent was running a turn of its own.
    pub fn had_turn_of_its_own(&self) -> bool {
        self.items.iter().any(|item| item.kind == KIND_OUT_OF_TURN)
    }

    /// The listed work other than that turn: what a prompt names.
    pub fn background_items(&self) -> impl Iterator<Item = &BackgroundSnapshotItem> {
        self.items
            .iter()
            .filter(|item| item.kind != KIND_OUT_OF_TURN)
    }

    /// The same work as `other`, whatever the time.
    pub fn same_work(&self, other: &BackgroundSnapshot) -> bool {
        self.items == other.items && self.more == other.more
    }
}

/// The snapshot kind of a live background task's kind
/// (`background_status::BackgroundTaskBrief::kind`).
fn snapshot_kind(live: &str) -> String {
    match live.trim() {
        // An async sub-agent, and a sub-agent tool call the turn waits for.
        "agent" | KIND_SUBAGENT => KIND_SUB_AGENT.to_string(),
        "shell" | "bash" => KIND_SHELL.to_string(),
        "monitor" => KIND_MONITOR.to_string(),
        "workflow" => KIND_WORKFLOW.to_string(),
        KIND_DELEGATION => KIND_CODEG_DELEGATION.to_string(),
        "" => KIND_TASK.to_string(),
        other => other.to_ascii_lowercase(),
    }
}

/// A live background status as a snapshot taken `now`, or `None` when it
/// lists no work. A turn held open for background work with nothing named is
/// no work of its own: the running turn is what records it.
pub fn snapshot_of(
    background: &ConversationBackground,
    now: DateTime<Utc>,
) -> Option<BackgroundSnapshot> {
    let mut items: Vec<BackgroundSnapshotItem> = Vec::new();
    if background.out_of_turn {
        items.push(BackgroundSnapshotItem::new(KIND_OUT_OF_TURN, ""));
    }
    for task in &background.tasks {
        let mut item = BackgroundSnapshotItem::new(&snapshot_kind(&task.kind), &task.label);
        item.started_at = task.started_at;
        item.id = Some(task.id.clone()).filter(|id| !id.trim().is_empty());
        if task.kind == KIND_DELEGATION {
            item.agent = task.agent_type.map(|a| a.as_wire().into_owned());
        }
        items.push(item);
    }
    let more = background
        .task_count
        .saturating_sub(background.tasks.len() as u32);
    let snapshot = BackgroundSnapshot {
        at: now,
        items,
        more,
    };
    snapshot.has_work().then_some(snapshot)
}

/// Fold the work read for a Pi session into its snapshot.
fn with_extra(
    snapshot: Option<BackgroundSnapshot>,
    extra: Option<&Vec<BackgroundSnapshotItem>>,
    now: DateTime<Utc>,
) -> Option<BackgroundSnapshot> {
    let extra = extra.filter(|items| !items.is_empty());
    match (snapshot, extra) {
        (snapshot, None) => snapshot,
        (Some(mut snapshot), Some(extra)) => {
            for item in extra {
                if !snapshot.items.contains(item) {
                    snapshot.items.push(item.clone());
                }
            }
            Some(snapshot)
        }
        (None, Some(extra)) => Some(BackgroundSnapshot {
            at: now,
            items: extra.clone(),
            more: 0,
        }),
    }
}

// ─── Prompt lines ───────────────────────────────────────────────────────

/// How a resume prompt names one item:
/// `sub-agent: Review the parser (started 13:02)`. Times are local (`tz`),
/// with the day when it was not the snapshot's.
pub fn describe_item<Tz: TimeZone>(
    item: &BackgroundSnapshotItem,
    at: DateTime<Utc>,
    tz: &Tz,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let id = item
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let what = match item.kind.as_str() {
        KIND_SUB_AGENT => "sub-agent".to_string(),
        KIND_SHELL => "background shell".to_string(),
        KIND_MONITOR => "monitor".to_string(),
        KIND_WORKFLOW => "workflow".to_string(),
        KIND_CODEG_DELEGATION => {
            let mut what = "codeg delegation".to_string();
            if let Some(agent) = item.agent.as_deref() {
                what.push_str(&format!(" to {agent}"));
            }
            if let Some(id) = id {
                what.push_str(&format!(", task_id {id}"));
            }
            what
        }
        KIND_PI_JOB => match id {
            Some(id) => format!("background job {id}"),
            None => "background job".to_string(),
        },
        KIND_PI_SUBAGENT => match id {
            Some(id) => format!("async sub-agent run {id}"),
            None => "async sub-agent run".to_string(),
        },
        KIND_OUT_OF_TURN => "a turn of its own, woken by its background work".to_string(),
        KIND_TASK => "background task".to_string(),
        other => format!("background {}", other.replace('_', " ")),
    };
    let mut line = what;
    if !item.label.is_empty() {
        line.push_str(": ");
        line.push_str(&item.label);
    }
    if let Some(started) = item.started_at {
        let local = started.with_timezone(tz);
        let same_day = local.date_naive() == at.with_timezone(tz).date_naive();
        let when = if same_day {
            local.format("%H:%M").to_string()
        } else {
            local.format("%b %-d %H:%M").to_string()
        };
        line.push_str(&format!(" (started {when})"));
    }
    line
}

/// The list a resume prompt carries: one `- ` line per item, then one for
/// whatever the listing left out. Empty when nothing is listed.
pub fn describe_list<Tz: TimeZone>(snapshot: &BackgroundSnapshot, tz: &Tz) -> Vec<String>
where
    Tz::Offset: std::fmt::Display,
{
    let mut lines: Vec<String> = snapshot
        .background_items()
        .map(|item| format!("- {}", describe_item(item, snapshot.at, tz)))
        .collect();
    if snapshot.more > 0 {
        let n = snapshot.more;
        let noun = if n == 1 { "task" } else { "tasks" };
        let prefix = if lines.is_empty() { "" } else { "and " };
        lines.push(format!("- {prefix}{n} more background {noun}"));
    }
    lines
}

// ─── Writer ─────────────────────────────────────────────────────────────

/// Keeps the rows' snapshots in step with the live sessions. One per process
/// ([`WRITER`]); tests build their own.
pub struct SnapshotWriter {
    /// Set by a graceful quit: the teardown that follows clears every live
    /// status, which must not reach the rows.
    frozen: AtomicBool,
    wake: Notify,
    /// What this process last wrote for each conversation; the rows of those
    /// not listed hold none (or one the startup sweep left for a resume).
    written: Mutex<HashMap<i32, BackgroundSnapshot>>,
    pi: pi::PiScanner,
    /// Rows written so far (tests count them).
    writes: AtomicU64,
}

/// The process's writer.
pub static WRITER: LazyLock<SnapshotWriter> =
    LazyLock::new(|| SnapshotWriter::new(pi::PiScanner::resolve()));

/// A session's background status changed: the writer writes it once the
/// burst settles. Called on every `conversation://background` broadcast.
pub fn note_changed() {
    WRITER.note_changed();
}

/// The boot task: keep the rows' snapshots current until a graceful quit.
/// Spawn once per process, after the startup sweep.
pub async fn run_background_snapshot_writer(db: DatabaseConnection, manager: ConnectionManager) {
    WRITER.run(&db, &manager, DEBOUNCE, HEARTBEAT, POLL).await;
}

/// A graceful quit: stop the writer and write every live session's snapshot
/// once more, before the connections are torn down. Bounded, so a stuck
/// database never holds the quit.
pub async fn flush_for_exit(db: &DatabaseConnection, manager: &ConnectionManager) {
    WRITER.freeze();
    match tokio::time::timeout(
        EXIT_FLUSH_TIMEOUT,
        WRITER.pass(db, manager, Utc::now(), true),
    )
    .await
    {
        Ok(0) => {}
        Ok(n) => tracing::info!(
            "[background-snapshot] quitting with background work in {n} session(s); recorded"
        ),
        Err(_) => tracing::warn!("[background-snapshot] the final write timed out"),
    }
}

impl SnapshotWriter {
    pub fn new(pi: pi::PiScanner) -> Self {
        Self {
            frozen: AtomicBool::new(false),
            wake: Notify::new(),
            written: Mutex::new(HashMap::new()),
            pi,
            writes: AtomicU64::new(0),
        }
    }

    pub fn note_changed(&self) {
        // One stored permit at most: a burst of changes is one wake.
        self.wake.notify_one();
    }

    pub fn freeze(&self) {
        self.frozen.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen.load(Ordering::SeqCst)
    }

    /// Rows written so far.
    pub fn writes(&self) -> u64 {
        self.writes.load(Ordering::SeqCst)
    }

    /// Write on every change (after `debounce`), every `poll` (Pi), and every
    /// `heartbeat` (all running work, with a fresh time), until frozen.
    pub async fn run(
        &self,
        db: &DatabaseConnection,
        manager: &ConnectionManager,
        debounce: Duration,
        heartbeat: Duration,
        poll: Duration,
    ) {
        let mut last_heartbeat = tokio::time::Instant::now();
        loop {
            let to_heartbeat = heartbeat.saturating_sub(last_heartbeat.elapsed());
            tokio::select! {
                _ = self.wake.notified() => {
                    if self.is_frozen() {
                        return;
                    }
                    tokio::time::sleep(debounce).await;
                }
                _ = tokio::time::sleep(poll.min(to_heartbeat)) => {}
            }
            if self.is_frozen() {
                return;
            }
            let heartbeat_due = last_heartbeat.elapsed() >= heartbeat;
            if heartbeat_due {
                last_heartbeat = tokio::time::Instant::now();
            }
            self.pass(db, manager, Utc::now(), heartbeat_due).await;
        }
    }

    /// One pass: bring every row this process knows about in step with the
    /// live sessions. `refresh` rewrites work still running with time `now`
    /// even when it did not change. Returns how many sessions have work
    /// running.
    pub async fn pass(
        &self,
        db: &DatabaseConnection,
        manager: &ConnectionManager,
        now: DateTime<Utc>,
        refresh: bool,
    ) -> usize {
        let live = manager.background_by_conversation().await;
        let pi_work = self.pi.scan_live(manager, now).await;
        let mut written = self.written.lock().await;
        let ids: HashSet<i32> = live
            .keys()
            .chain(pi_work.keys())
            .chain(written.keys())
            .copied()
            .collect();
        let mut running = 0;
        for id in ids {
            let fresh = with_extra(
                live.get(&id).and_then(|bg| snapshot_of(bg, now)),
                pi_work.get(&id),
                now,
            );
            let unchanged = match (&fresh, written.get(&id)) {
                (Some(fresh), Some(previous)) => previous.same_work(fresh),
                _ => false,
            };
            match fresh {
                Some(fresh) => {
                    running += 1;
                    // Unchanged work keeps the time it was last confirmed
                    // at until the heartbeat; changed work is seen now.
                    if (refresh || !unchanged) && self.write(db, id, Some(&fresh)).await {
                        written.insert(id, fresh);
                    }
                }
                None if written.contains_key(&id) => {
                    if self.write(db, id, None).await {
                        written.remove(&id);
                    }
                }
                None => {}
            }
        }
        running
    }

    async fn write(
        &self,
        db: &DatabaseConnection,
        conversation_id: i32,
        snapshot: Option<&BackgroundSnapshot>,
    ) -> bool {
        match conversation_service::set_background_snapshot(
            db,
            conversation_id,
            snapshot.map(BackgroundSnapshot::to_json),
        )
        .await
        {
            Ok(_) => {
                self.writes.fetch_add(1, Ordering::SeqCst);
                true
            }
            Err(e) => {
                tracing::warn!(
                    conversation_id,
                    "[background-snapshot] failed to record background work: {e}"
                );
                false
            }
        }
    }
}

#[cfg(test)]
mod tests;
