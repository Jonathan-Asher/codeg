//! Hand a delegated sub-agent's result to its parent after a usage-limit pause.
//!
//! When a usage limit stops a delegation child, `acp::limit_continue` pauses
//! the child's conversation and continues it by itself once the limit resets.
//! The parent's delegation, though, settled at the stop: the broker reports it
//! as paused (`types::PAUSED_USAGE_LIMIT_CODE` — status `running`, "continues at
//! about HH:MM, the result will be delivered"), and the child's later turns
//! belong to no running task. Without this module the continued child's final
//! answer would never reach the parent.
//!
//! The pause is recorded here ([`record_pause`]), durably — a pause outlives
//! codeg restarts, and so must the promise made to the parent. When the child's
//! next turn ends without hitting the limit again ([`child_finished`]), its
//! result is put on the parent's card and status (`broker.settle_paused_call`,
//! when the parent is still the same live connection) and queued for delivery.
//! The limit-continue scheduler then sends it to the parent conversation as a
//! message ([`spawn_deliveries`]), the way a continuation goes out: reopening
//! the session when no window has it open, and only while the parent is idle
//! — a parent mid-turn gets it at its next idle moment.
//!
//! Exactly once:
//! * a delivery is claimed (`Delivered`) before its message goes out, and put
//!   back only when the message provably did not go out (the session was busy,
//!   or could not be reopened);
//! * a parent that already pulled the final result through
//!   `get_delegation_status` ([`note_collected`]) is not sent it again;
//! * a parent that re-delegated the same task meanwhile ([`note_delegation_started`])
//!   gets nothing — its new delegation supersedes the paused one;
//! * a parent conversation that was deleted gets nothing.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, OnceLock};

use chrono::{DateTime, Utc};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};

use crate::acp::auto_resume::{reopen_and_send, ReopenTarget, Sent};
use crate::acp::delegation::broker::{DelegationBroker, SettledDelegation};
use crate::acp::delegation::types::{DelegationOutcome, TaskStatus};
use crate::acp::manager::ConnectionManager;
use crate::db::entities::conversation::{self, ConversationLimitResume, ConversationTurnState};
use crate::db::service::{app_metadata_service, conversation_service};
use crate::db::AppDatabase;
use crate::models::{AgentType, DbConversationSummary};
use crate::web::event_bridge::EventEmitter;

/// `app_metadata` key holding every [`PendingDelivery`] (a small JSON list).
const DELIVERIES_KEY: &str = "delegation_limit_deliveries";
/// Owner label of a parent session reopened only to receive a result.
const OWNER_LABEL: &str = "delegation_delivery";
/// The result text carried in the message, at most (the full output is always
/// in the child's own session).
const RESULT_CAP_CHARS: usize = 32 * 1024;
/// Sends that failed outright (the session would not reopen) before giving up.
const MAX_SEND_FAILURES: u32 = 5;
/// How long after such a failure the next try goes out.
const RETRY_AFTER_SECS: i64 = 120;
/// A settled record (delivered, superseded, dropped) is kept this long, then
/// pruned; an unsettled one this long at most.
const SETTLED_KEEP_HOURS: i64 = 24;
const UNSETTLED_KEEP_DAYS: i64 = 14;
/// The task text compared to spot a re-delegation, at most.
const TASK_KEY_CHARS: usize = 1024;

/// Where a delivery stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    /// The child is paused; its result is not there yet.
    Awaiting,
    /// The child finished: its result waits for the parent's next idle moment.
    Ready,
    /// Sent to the parent, or the parent pulled it itself.
    Delivered,
    /// The parent re-delegated the same task meanwhile.
    Superseded,
    /// Nothing to deliver to: the parent conversation is gone, the child was
    /// stopped by hand, or the message could not be sent.
    Dropped,
}

/// The final report carried to the parent — the fields `get_delegation_status`
/// reports for a settled task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryReport {
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One paused delegation whose result is owed to its parent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingDelivery {
    /// The broker task id (`delegation_call_id` on the child row).
    pub task_id: String,
    pub child_conversation_id: i32,
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: String,
    pub agent_type: AgentType,
    /// Label of the parent's card ([`SettledDelegation::task_preview`]).
    pub task_preview: String,
    pub resets_at: DateTime<Utc>,
    pub state: DeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<DeliveryReport>,
    #[serde(default)]
    pub send_failures: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

// ─── Store ──────────────────────────────────────────────────────────────

/// Serializes every read-modify-write of the record list.
static STORE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
/// The database, for the hooks that run where none is at hand (the broker's
/// start, the listener's status replies). Installed by the scheduler.
static DB: OnceLock<DatabaseConnection> = OnceLock::new();
/// Whether any delivery is `Ready`, so a turn's end only wakes the scheduler
/// when there is something to deliver.
static ANY_READY: AtomicBool = AtomicBool::new(false);
/// One delivery pass at a time.
static PASS_RUNNING: AtomicBool = AtomicBool::new(false);
/// Task ids whose result is `Ready` — read synchronously by the broker's
/// status and resume answers.
static READY_TASKS: LazyLock<std::sync::Mutex<HashSet<String>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

/// What `get_delegation_status` / `resume_delegation` say about a task whose
/// continued child finished and whose result waits for delivery.
pub const RESULT_WAITING_NOTE: &str = "this task finished after a usage-limit pause; its \
     result is delivered to this conversation as a message right after the current turn. \
     Do not delegate, resume or retry it.";

/// Whether `task_id`'s result is ready and waiting for its parent's next idle
/// moment.
pub fn result_waiting(task_id: &str) -> bool {
    READY_TASKS
        .lock()
        .map(|ready| ready.contains(task_id))
        .unwrap_or(false)
}

/// `Err` only when the store could not be read at all (an unreadable value
/// starts over instead: there is nothing to keep in it).
async fn load(conn: &DatabaseConnection) -> Result<Vec<PendingDelivery>, ()> {
    match app_metadata_service::get_value(conn, DELIVERIES_KEY).await {
        Ok(Some(raw)) => Ok(serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[delegation][delivery] unreadable deliveries ({e}); starting over");
            Vec::new()
        })),
        Ok(None) => Ok(Vec::new()),
        Err(e) => {
            tracing::warn!("[delegation][delivery] failed to load deliveries: {e}");
            Err(())
        }
    }
}

/// Apply `f` to the stored records under the store lock, prune what has aged
/// out, and save — unless the load failed, so a transient read error never
/// wipes the list. Returns `f`'s result.
async fn update<R>(conn: &DatabaseConnection, f: impl FnOnce(&mut Vec<PendingDelivery>) -> R) -> R {
    let _guard = STORE.lock().await;
    let loaded = load(conn).await;
    let readable = loaded.is_ok();
    let mut records = loaded.unwrap_or_default();
    let before = records.clone();
    let out = f(&mut records);
    prune(&mut records, Utc::now());
    if readable {
        let ready: HashSet<String> = records
            .iter()
            .filter(|r| r.state == DeliveryState::Ready)
            .map(|r| r.task_id.clone())
            .collect();
        ANY_READY.store(!ready.is_empty(), Ordering::SeqCst);
        if let Ok(mut slot) = READY_TASKS.lock() {
            *slot = ready;
        }
    }
    if readable && records != before {
        match serde_json::to_string(&records) {
            Ok(raw) => {
                if let Err(e) = app_metadata_service::upsert_value(conn, DELIVERIES_KEY, &raw).await
                {
                    tracing::warn!("[delegation][delivery] failed to save deliveries: {e}");
                }
            }
            Err(e) => tracing::warn!("[delegation][delivery] failed to encode deliveries: {e}"),
        }
    }
    out
}

fn prune(records: &mut Vec<PendingDelivery>, now: DateTime<Utc>) {
    records.retain(|r| {
        let age = now - r.updated_at;
        match r.state {
            DeliveryState::Awaiting | DeliveryState::Ready => {
                age < chrono::Duration::days(UNSETTLED_KEEP_DAYS)
            }
            _ => age < chrono::Duration::hours(SETTLED_KEEP_HOURS),
        }
    });
}

/// Make the database available to the hooks without one at hand. Called once
/// by the scheduler at start.
pub fn install_db(conn: DatabaseConnection) {
    let _ = DB.set(conn);
}

// ─── Hooks ──────────────────────────────────────────────────────────────

/// The reset a child's usage-limit pause waits for while codeg is going to
/// continue it by itself (scheduled, or being sent right now).
pub fn active_pause(row: &DbConversationSummary) -> Option<DateTime<Utc>> {
    row.limit_pause.as_ref().and_then(|pause| {
        matches!(
            pause.state,
            ConversationLimitResume::Scheduled | ConversationLimitResume::Claimed
        )
        .then_some(pause.resets_at)
    })
}

/// A usage limit paused delegation child `row` (task `task_id`) until
/// `resets_at`. `settled` is what the broker settled now — `None` when the task
/// had already left it (paused before, continued, and stopped again).
pub async fn record_pause(
    conn: &DatabaseConnection,
    row: &DbConversationSummary,
    task_id: &str,
    resets_at: DateTime<Utc>,
    settled: Option<&SettledDelegation>,
) {
    let Some(parent_conversation_id) = row.parent_id else {
        return;
    };
    let now = Utc::now();
    let fresh = PendingDelivery {
        task_id: task_id.to_string(),
        child_conversation_id: row.id,
        parent_conversation_id,
        parent_tool_use_id: settled
            .map(|s| s.parent_tool_use_id.clone())
            .or_else(|| row.parent_tool_use_id.clone())
            .unwrap_or_default(),
        agent_type: row.agent_type,
        task_preview: settled
            .map(|s| s.task_preview.clone())
            .or_else(|| row.title.clone())
            .unwrap_or_default(),
        resets_at,
        state: DeliveryState::Awaiting,
        report: None,
        send_failures: 0,
        next_attempt_at: None,
        updated_at: now,
    };
    let recorded = update(conn, |records| upsert_pause(records, fresh)).await;
    if recorded {
        tracing::info!(
            task_id,
            child = row.id,
            parent = parent_conversation_id,
            "[delegation][delivery] child paused by a usage limit until {resets_at}; \
             its result is owed to the parent"
        );
    }
}

/// Record (or refresh) a pause. A task already settled for delivery — handed
/// over, superseded — is not reopened. Returns whether anything was recorded.
fn upsert_pause(records: &mut Vec<PendingDelivery>, fresh: PendingDelivery) -> bool {
    match records.iter_mut().find(|r| r.task_id == fresh.task_id) {
        Some(existing) if existing.state == DeliveryState::Awaiting => {
            existing.resets_at = fresh.resets_at;
            existing.updated_at = fresh.updated_at;
            true
        }
        Some(existing) if existing.state == DeliveryState::Ready => {
            // A finished result still waiting for the parent stays as it is.
            false
        }
        Some(existing) => {
            // Delivered / superseded / dropped: a fresh pause of the same task
            // (the user drove the child on by hand) owes a fresh result.
            *existing = fresh;
            true
        }
        None => {
            records.push(fresh);
            true
        }
    }
}

/// A turn of delegation child `row` (task `task_id`) ended without the limit
/// stopping it again, and no running broker task took it: if a pause made a
/// promise to its parent, the result is ready for delivery now.
pub async fn child_finished(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    row: &DbConversationSummary,
    task_id: &str,
    stop_reason: &str,
    outcome: &DelegationOutcome,
) {
    let now = Utc::now();
    let report = report_of(outcome);
    let cancelled = stop_reason == "cancelled";
    let settled = update(conn, |records| {
        finish_record(records, task_id, report.clone(), cancelled, now)
    })
    .await;
    let Some(record) = settled else {
        return;
    };
    // The parent's card and `get_delegation_status` show the final result
    // right away when the parent is still the live connection it was.
    broker
        .settle_paused_call(
            task_id,
            outcome,
            &record.parent_tool_use_id,
            &record.task_preview,
        )
        .await;
    if record.state == DeliveryState::Ready {
        tracing::info!(
            task_id,
            child = row.id,
            parent = record.parent_conversation_id,
            "[delegation][delivery] continued child finished ({stop_reason}); \
             delivering its result to the parent"
        );
        crate::acp::limit_continue::wake();
    } else {
        tracing::info!(
            task_id,
            child = row.id,
            "[delegation][delivery] continued child was stopped by hand; nothing to deliver"
        );
    }
}

/// Move an `Awaiting` record to `Ready` (or `Dropped`, for a child the user
/// stopped). `None` when there was no awaiting record.
fn finish_record(
    records: &mut [PendingDelivery],
    task_id: &str,
    report: DeliveryReport,
    cancelled: bool,
    now: DateTime<Utc>,
) -> Option<PendingDelivery> {
    let record = records
        .iter_mut()
        .find(|r| r.task_id == task_id && r.state == DeliveryState::Awaiting)?;
    record.state = if cancelled {
        DeliveryState::Dropped
    } else {
        DeliveryState::Ready
    };
    record.report = Some(report);
    record.next_attempt_at = None;
    record.updated_at = now;
    Some(record.clone())
}

fn report_of(outcome: &DelegationOutcome) -> DeliveryReport {
    match outcome {
        DelegationOutcome::Ok(ok) => DeliveryReport {
            status: TaskStatus::Completed,
            text: Some(ok.text.clone()),
            error_code: None,
            message: None,
        },
        DelegationOutcome::Err { code, message, .. } => DeliveryReport {
            status: if code == "canceled" {
                TaskStatus::Canceled
            } else {
                TaskStatus::Failed
            },
            text: None,
            error_code: Some(code.clone()),
            message: Some(message.clone()),
        },
    }
}

/// The parent pulled these tasks' final results through
/// `get_delegation_status` (completed reports with their text, or failures):
/// they are delivered, nothing more to send.
pub fn note_collected(task_ids: Vec<String>) {
    if task_ids.is_empty() || !ANY_READY.load(Ordering::SeqCst) {
        return;
    }
    let Some(conn) = DB.get().cloned() else {
        return;
    };
    tokio::spawn(async move {
        let collected: HashSet<String> = task_ids.into_iter().collect();
        let now = Utc::now();
        update(&conn, |records| {
            for r in records.iter_mut() {
                if r.state == DeliveryState::Ready && collected.contains(&r.task_id) {
                    r.state = DeliveryState::Delivered;
                    r.updated_at = now;
                    tracing::info!(
                        task_id = %r.task_id,
                        "[delegation][delivery] the parent collected the result itself"
                    );
                }
            }
        })
        .await;
    });
}

/// The parent conversation started a delegation of `task`: one of its paused
/// delegations with the same task is superseded — its result is not delivered
/// on top of the new run's.
pub fn note_delegation_started(parent_conversation_id: i32, task: &str) {
    let Some(conn) = DB.get().cloned() else {
        return;
    };
    let key = task_key(task);
    tokio::spawn(async move {
        let now = Utc::now();
        update(&conn, |records| {
            supersede(records, parent_conversation_id, &key, now);
        })
        .await;
    });
}

fn supersede(
    records: &mut [PendingDelivery],
    parent_conversation_id: i32,
    key: &str,
    now: DateTime<Utc>,
) -> usize {
    let mut n = 0;
    for r in records.iter_mut() {
        if r.parent_conversation_id == parent_conversation_id
            && matches!(r.state, DeliveryState::Awaiting | DeliveryState::Ready)
            && task_key(&r.task_preview) == key
        {
            r.state = DeliveryState::Superseded;
            r.updated_at = now;
            n += 1;
            tracing::info!(
                task_id = %r.task_id,
                "[delegation][delivery] the parent delegated the same task again; \
                 the paused one's result will not be delivered"
            );
        }
    }
    n
}

/// What identifies "the same task": its text with whitespace collapsed, cut
/// to the first [`TASK_KEY_CHARS`] characters (the broker's preview of it is
/// capped at 2 KiB, so a long task compares by its opening).
fn task_key(task: &str) -> String {
    task.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TASK_KEY_CHARS)
        .collect()
}

/// Wake the scheduler at a turn's end when a result may be waiting for the
/// conversation that just went idle.
pub fn turn_ended() {
    if ANY_READY.load(Ordering::SeqCst) {
        crate::acp::limit_continue::wake();
    }
}

// ─── Delivery ───────────────────────────────────────────────────────────

/// Start a delivery pass in the background unless one is running. Called on
/// every scheduler tick (and so on every wake).
pub fn spawn_deliveries(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
) {
    if !ANY_READY.load(Ordering::SeqCst) && !first_pass_pending() {
        return;
    }
    if PASS_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let manager = manager.clone_ref();
    let emitter = emitter.clone();
    let data_dir = data_dir.to_path_buf();
    tokio::spawn(async move {
        deliver_ready(&db, &manager, &emitter, &data_dir).await;
        PASS_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// `ANY_READY` starts false; the first pass after start reads the store.
fn first_pass_pending() -> bool {
    static DONE: AtomicBool = AtomicBool::new(false);
    !DONE.swap(true, Ordering::SeqCst)
}

/// What to do with one ready delivery, given its parent conversation.
#[derive(Debug, PartialEq, Eq)]
enum ParentGate {
    /// Idle: send now.
    Send,
    /// Mid-turn, or paused on a limit itself: later.
    Wait,
    /// Gone: drop the delivery.
    Gone,
}

fn parent_gate(parent: Option<&conversation::Model>) -> ParentGate {
    let Some(parent) = parent else {
        return ParentGate::Gone;
    };
    if parent.deleted_at.is_some() {
        return ParentGate::Gone;
    }
    if crate::acp::limit_continue::is_limit_paused(parent)
        || parent.turn_state == Some(ConversationTurnState::Running)
    {
        return ParentGate::Wait;
    }
    ParentGate::Send
}

async fn deliver_ready(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
) {
    let now = Utc::now();
    let ready: Vec<PendingDelivery> = update(&db.conn, |records| {
        records
            .iter()
            .filter(|r| {
                r.state == DeliveryState::Ready && r.next_attempt_at.is_none_or(|at| at <= now)
            })
            .cloned()
            .collect()
    })
    .await;
    for delivery in ready {
        deliver_one(db, manager, emitter, data_dir, delivery).await;
    }
}

async fn deliver_one(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    delivery: PendingDelivery,
) {
    let task_id = delivery.task_id.clone();
    let parent = match conversation::Entity::find_by_id(delivery.parent_conversation_id)
        .one(&db.conn)
        .await
    {
        Ok(parent) => parent,
        Err(e) => {
            tracing::warn!(task_id = %task_id, "[delegation][delivery] parent lookup failed: {e}");
            return;
        }
    };
    match parent_gate(parent.as_ref()) {
        ParentGate::Wait => return,
        ParentGate::Gone => {
            set_state(
                &db.conn,
                &task_id,
                DeliveryState::Ready,
                DeliveryState::Dropped,
            )
            .await;
            tracing::info!(
                task_id = %task_id,
                "[delegation][delivery] the parent conversation is gone; dropping the result"
            );
            return;
        }
        ParentGate::Send => {}
    }
    let Some(parent) = parent else {
        return;
    };
    // Claim it first: a message that goes out is never sent twice, even if
    // this process dies right after.
    if !set_state(
        &db.conn,
        &task_id,
        DeliveryState::Ready,
        DeliveryState::Delivered,
    )
    .await
    {
        return;
    }
    let target = ReopenTarget {
        conversation_id: parent.id,
        folder_id: parent.folder_id,
        agent_type: conversation_service::parse_agent_type(&parent.agent_type),
        external_id: parent.external_id.clone(),
    };
    let prompt = delivery_prompt(&delivery);
    let sent = reopen_and_send(
        db,
        manager,
        emitter,
        data_dir,
        &target,
        OWNER_LABEL,
        &prompt,
        "delegation-result",
        || false,
    )
    .await;
    match sent {
        Ok(Sent::Prompted) => tracing::info!(
            task_id = %task_id,
            parent = parent.id,
            "[delegation][delivery] delivered the continued child's result to the parent"
        ),
        Ok(Sent::Busy | Sent::Aborted) => {
            // A turn started meanwhile: its end wakes the next try.
            set_state(
                &db.conn,
                &task_id,
                DeliveryState::Delivered,
                DeliveryState::Ready,
            )
            .await;
        }
        Err(reason) => {
            tracing::warn!(
                task_id = %task_id,
                parent = parent.id,
                "[delegation][delivery] could not deliver the result: {reason}"
            );
            let now = Utc::now();
            update(&db.conn, |records| {
                if let Some(r) = records.iter_mut().find(|r| r.task_id == task_id) {
                    r.send_failures += 1;
                    r.updated_at = now;
                    if r.send_failures >= MAX_SEND_FAILURES {
                        r.state = DeliveryState::Dropped;
                    } else {
                        r.state = DeliveryState::Ready;
                        r.next_attempt_at = Some(now + chrono::Duration::seconds(RETRY_AFTER_SECS));
                    }
                }
            })
            .await;
        }
    }
}

/// Move `task_id` from `from` to `to`. `false` when it was not in `from`.
async fn set_state(
    conn: &DatabaseConnection,
    task_id: &str,
    from: DeliveryState,
    to: DeliveryState,
) -> bool {
    let now = Utc::now();
    update(conn, |records| {
        match records
            .iter_mut()
            .find(|r| r.task_id == task_id && r.state == from)
        {
            Some(r) => {
                r.state = to;
                r.updated_at = now;
                true
            }
            None => false,
        }
    })
    .await
}

/// The message the parent agent receives. It goes to the agent, so it is not
/// localized; it says what it is, that it is new, and what not to do with it.
pub fn delivery_prompt(delivery: &PendingDelivery) -> String {
    let report = delivery.report.clone().unwrap_or(DeliveryReport {
        status: TaskStatus::Completed,
        text: None,
        error_code: None,
        message: None,
    });
    let status = match report.status {
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Canceled => "canceled",
        TaskStatus::Running => "running",
        TaskStatus::Unknown => "unknown",
    };
    let body = match (&report.text, &report.message) {
        (Some(text), _) if !text.trim().is_empty() => cap_chars(text, RESULT_CAP_CHARS),
        (_, Some(message)) => message.clone(),
        _ => "(the sub-agent finished without a final message)".to_string(),
    };
    let code = report
        .error_code
        .as_deref()
        .map(|c| format!(" error_code=\"{c}\""))
        .unwrap_or_default();
    format!(
        "A task you delegated earlier has finished. A usage limit had paused its \
         sub-agent and codeg continued it; this is its final result, delivered once. \
         Carry on with it — do not delegate, resume or retry this task.\n\n\
         <delegation-result task_id=\"{task_id}\" agent=\"{agent}\" status=\"{status}\"{code} \
         child_session=\"{child}\">\n{body}\n</delegation-result>",
        task_id = delivery.task_id,
        agent = delivery.agent_type.as_wire(),
        child = delivery.child_conversation_id,
    )
}

fn cap_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}\n… (truncated; the full output is in the sub-agent's own session)")
}

#[cfg(test)]
mod tests;
