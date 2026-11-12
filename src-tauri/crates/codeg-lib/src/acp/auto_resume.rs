//! Pick the turns codeg's own exit cut off back up on the next start.
//!
//! When codeg quits, crashes or restarts for an update, every agent turn in
//! flight dies with it. The startup sweep (and a graceful quit, just before it
//! tears the connections down) records those rows as interrupted AND marks
//! them `auto_resume = pending` (see
//! `conversation_service::interrupt_orphaned_turns`). Once the database, the
//! connection manager and the lifecycle subscriber are up, [`run_auto_resume`]
//! resumes each one in the backend — no window needs to have it open — through
//! the same establishment path a tab uses, then sends
//! [`RESUME_AFTER_RESTART_PROMPT`] through the same prompt path a typed message
//! takes (conversation link, prompt ledger, cross-client `UserMessage`
//! broadcast), so any client watching sees the turn start live.
//!
//! At most once per interruption: a claim (`pending → claimed`) is persisted
//! before the session is reopened, and the turn it starts turns it into
//! `attempted`, which the next exit keeps. If codeg dies again during the
//! resumed turn, that row comes back as a plain interruption with the manual
//! Continue. A resume that cannot happen (the session will not reopen, the
//! user said stop) releases the claim and leaves the same plain interruption.
//!
//! Every connected client learns about the batch through
//! [`AUTO_RESUME_STATUS_EVENT`] and can read it on connect with
//! [`auto_resume_status`] — events fired before a client connected are lost —
//! and offers a Stop that cancels the resumes not started yet.
//!
//! **Background work.** A session whose turn had ended can still have work
//! running — async sub-agents, background shells, monitors, codeg
//! delegations — and the exit stops all of it. The background snapshot
//! (`acp::background_snapshot`) records that work per session while codeg
//! runs; the exit sweep marks such a session `pending` with reason
//! `background`, and it is resumed with [`RESUME_BACKGROUND_PROMPT_HEAD`] and
//! a list of what was stopped (setting: "Also resume sessions whose
//! background work was stopped"). A turn cut off while background work ran
//! gets the same list under its usual prompt, and a turn the agent ran on its
//! own (woken by that work) is resumed like any cut-off turn.
//!
//! **Pacing.** Resumes start [`DEFAULT_STAGGER_SECS`] apart, so a restart
//! with many sessions due never starts them all at once, and at most
//! [`MAX_RESUMES_IN_A_ROW`] automatic resumes follow one another without the
//! user sending a turn — a resume whose re-launched work keeps getting cut
//! off (a crash it causes) stops there.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::background_snapshot::{
    describe_list, BackgroundSnapshot, KIND_CODEG_DELEGATION, KIND_PI_JOB,
};
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AttachPhase, ConnectionStatus, PromptInputBlock};
use crate::app_error::AppCommandError;
use crate::commands::acp::{
    build_session_runtime_env, resolve_connect_selector_prefs, verify_agent_installed,
};
use crate::db::entities::conversation::ConversationAutoResumeReason;
use crate::db::service::conversation_service::AutoResumeCandidate;
use crate::db::service::{app_metadata_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// The prompt a resumed turn starts with. It goes to the agent, so it is not
/// localized; the transcript recognizes it by its exact text and draws it as a
/// "Resumed after restart" divider. The frontend keeps the same text in
/// `src/lib/auto-resume.ts` — a test below fails if the two drift apart.
pub const RESUME_AFTER_RESTART_PROMPT: &str = "codeg restarted while you were working, so your last turn was cut off. Anything that was running in the background (sub-agents, background shells, monitors) was stopped. Continue where you left off, re-launching anything that still needs to run.";

/// Heads the list [`RESUME_AFTER_RESTART_PROMPT`] carries when background work
/// was running too: the prompt, a blank line, this line, then one `- ` line per
/// item. The transcript recognizes the prompt by this exact start.
pub const RESUME_TURN_BACKGROUND_HEADER: &str =
    "What was running in the background when codeg stopped:";

/// The first line of the prompt that resumes a session whose turn had ended
/// but whose background work the restart stopped. One `- ` line per item
/// follows, then [`RESUME_BACKGROUND_PROMPT_TAIL`]. The transcript recognizes
/// it by this line (and draws "Resumed after restart · background work was
/// stopped"); `src/lib/auto-resume.ts` keeps the same text.
pub const RESUME_BACKGROUND_PROMPT_HEAD: &str = "codeg restarted. Your last turn had finished, but background work you started was still running and was stopped:";

/// The line after the background prompt's list.
pub const RESUME_BACKGROUND_PROMPT_TAIL: &str =
    "Re-launch whatever still needs to run, then carry on.";

/// Closes a prompt whose list names a codeg delegation.
const DELEGATION_HINT: &str = "A codeg delegation continues under its task_id with resume_delegation; get_delegation_status reports it as interrupted until then.";

/// Closes a prompt whose list names a Pi bg-jobs job, which may have kept
/// running through the restart.
const PI_JOB_HINT: &str = "A background job may have kept running through the restart: check it with bgj_status before starting it again.";

/// The background prompt's line when the list was lost.
const UNKNOWN_WORK_LINE: &str = "- background work codeg could not name";

/// `app_metadata` key of [`AutoResumeSettings`]. Per data directory (not the
/// user-wide `~/.codeg/preferences.json`): it describes this database's
/// sessions.
pub const AUTO_RESUME_SETTINGS_KEY: &str = "auto_resume_settings";

/// Broadcast with the full [`AutoResumeStatus`] whenever the batch changes.
pub const AUTO_RESUME_STATUS_EVENT: &str = "app://auto-resume-status";

/// A turn cut off longer ago than this is stale work, not something to pick
/// back up behind the user's back.
const MAX_AGE_HOURS: i64 = 12;

/// How long after startup the first resume starts. Gives clients time to
/// reconnect and show the batch (with its Stop) before anything runs, and the
/// freshly started process a moment to settle. `CODEG_AUTO_RESUME_DELAY_SECS`
/// overrides it.
const DEFAULT_START_DELAY_SECS: u64 = 10;

/// Longest a resume waits for the agent to reopen the session. Claude Code
/// runs the user's SessionStart hooks and MCP servers first, which can take
/// minutes on a loaded machine.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(300);

/// Owner label of the connections the resume opens (logs, the connection
/// list). No window owns them, so closing one never tears them down.
const OWNER_LABEL: &str = "auto_resume";

/// Least time between two resumes starting, so the agents of a large batch do
/// not all start working at once. `CODEG_AUTO_RESUME_STAGGER_SECS` overrides.
const DEFAULT_STAGGER_SECS: u64 = 12;

/// Automatic resumes a conversation gets in a row — without the user sending
/// a turn in between — before it is left alone.
pub const MAX_RESUMES_IN_A_ROW: i32 = 3;

/// "Resume interrupted sessions after restart" (General settings), and under
/// it "Also resume sessions whose background work was stopped". Both on unless
/// the user turned them off; the second needs the first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoResumeSettings {
    pub enabled: bool,
    /// Also resume a session whose turn had ended but whose background work
    /// the restart stopped. A setting stored before this one existed reads
    /// it as on.
    pub background: bool,
}

impl Default for AutoResumeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            background: true,
        }
    }
}

/// The stored setting. A missing or unreadable row reads as the default (on):
/// a damaged preference should not silently strand interrupted work.
pub async fn load_auto_resume_settings(conn: &DatabaseConnection) -> AutoResumeSettings {
    match app_metadata_service::get_value(conn, AUTO_RESUME_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[auto-resume] unreadable settings ({e}); using the default");
            AutoResumeSettings::default()
        }),
        Ok(None) => AutoResumeSettings::default(),
        Err(e) => {
            tracing::warn!("[auto-resume] failed to load settings ({e}); using the default");
            AutoResumeSettings::default()
        }
    }
}

pub async fn save_auto_resume_settings(
    conn: &DatabaseConnection,
    settings: AutoResumeSettings,
) -> Result<AutoResumeSettings, AppCommandError> {
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize auto-resume settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, AUTO_RESUME_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    Ok(settings)
}

/// Where one conversation of the batch stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoResumeItemState {
    /// Waiting for its turn; Stop still cancels it.
    Pending,
    /// Its session is being reopened.
    Resuming,
    /// The continuation prompt went out; the turn runs like any other.
    Resumed,
    /// It could not be resumed; it stays interrupted, with the manual Continue.
    Failed,
    /// The user stopped the batch before it started.
    Stopped,
    /// Someone got there first (continued, settled or deleted it by hand).
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutoResumeItem {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub title: Option<String>,
    pub state: AutoResumeItemState,
    /// Why a `failed` item failed.
    pub error: Option<String>,
    /// `turn`: a turn was cut off. `background`: the turn had ended and only
    /// its background work was stopped (a failure then leaves it finished,
    /// not interrupted).
    pub reason: ConversationAutoResumeReason,
}

/// This process's resume batch. Empty (`started_at: None`) when there was
/// nothing to resume.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AutoResumeStatus {
    pub started_at: Option<DateTime<Utc>>,
    pub items: Vec<AutoResumeItem>,
    /// The user pressed Stop.
    pub stopped: bool,
}

static STATUS: LazyLock<StdMutex<AutoResumeStatus>> =
    LazyLock::new(|| StdMutex::new(AutoResumeStatus::default()));
static STOP: AtomicBool = AtomicBool::new(false);

fn with_status<R>(f: impl FnOnce(&mut AutoResumeStatus) -> R) -> R {
    let mut guard = STATUS.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// The batch as it stands, for a client that just connected.
pub fn auto_resume_status() -> AutoResumeStatus {
    with_status(|s| s.clone())
}

fn publish(emitter: &EventEmitter) {
    emit_event(emitter, AUTO_RESUME_STATUS_EVENT, auto_resume_status());
}

fn set_item_state(conversation_id: i32, state: AutoResumeItemState, error: Option<String>) {
    with_status(|s| {
        if let Some(item) = s
            .items
            .iter_mut()
            .find(|item| item.conversation_id == conversation_id)
        {
            item.state = state;
            item.error = error;
        }
    });
}

/// Stop: cancel every resume that has not started. One whose session is being
/// reopened is abandoned before its prompt goes out; one already resumed is a
/// running turn, stopped the normal way. The stopped rows stay interrupted,
/// with the manual Continue, and no later start resumes them.
pub async fn stop_auto_resume_core(
    db: &DatabaseConnection,
    emitter: &EventEmitter,
) -> AutoResumeStatus {
    STOP.store(true, Ordering::SeqCst);
    with_status(|s| {
        s.stopped = true;
        for item in s.items.iter_mut() {
            if item.state == AutoResumeItemState::Pending {
                item.state = AutoResumeItemState::Stopped;
            }
        }
    });
    // Only this batch still carries `pending` marks (everything else was
    // discarded when the batch was planned), and none of the stopped items
    // was claimed, so this drops exactly theirs.
    if let Err(e) = conversation_service::discard_pending_auto_resumes(db, &[]).await {
        tracing::warn!("[auto-resume] failed to drop the stopped resumes' marks: {e}");
    }
    publish(emitter);
    auto_resume_status()
}

fn max_age() -> chrono::Duration {
    chrono::Duration::hours(MAX_AGE_HOURS)
}

fn secs_from_env(name: &str, default: u64) -> Duration {
    let secs = std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default);
    Duration::from_secs(secs)
}

fn start_delay() -> Duration {
    secs_from_env("CODEG_AUTO_RESUME_DELAY_SECS", DEFAULT_START_DELAY_SECS)
}

fn stagger() -> Duration {
    secs_from_env("CODEG_AUTO_RESUME_STAGGER_SECS", DEFAULT_STAGGER_SECS)
}

/// Whether codeg reopens this agent's sessions by id at all. Cline sessions
/// are never resumed (the chat always starts it fresh), so continuing one
/// would land in an empty session.
fn supports_resume(agent_type: AgentType) -> bool {
    !matches!(agent_type, AgentType::Cline)
}

/// Which candidates this start resumes, in the order given (most recently
/// active first): none with the setting off; otherwise every candidate whose
/// agent can reopen a session, but one due only for its background work only
/// with "Also resume sessions whose background work was stopped" on, and none
/// that has had [`MAX_RESUMES_IN_A_ROW`] automatic resumes since the user's
/// last turn.
pub(crate) fn plan_auto_resume(
    settings: AutoResumeSettings,
    candidates: Vec<AutoResumeCandidate>,
) -> Vec<AutoResumeCandidate> {
    if !settings.enabled {
        return Vec::new();
    }
    candidates
        .into_iter()
        .filter(|c| supports_resume(c.conversation.agent_type))
        .filter(|c| settings.background || c.reason != ConversationAutoResumeReason::Background)
        .filter(|c| c.resumes_in_a_row < MAX_RESUMES_IN_A_ROW)
        .collect()
}

/// The prompt a resume sends.
///
/// * A cut-off turn: [`RESUME_AFTER_RESTART_PROMPT`], and when background
///   work was running too, [`RESUME_TURN_BACKGROUND_HEADER`] and its list.
/// * Background work only: [`RESUME_BACKGROUND_PROMPT_HEAD`], the list, and
///   [`RESUME_BACKGROUND_PROMPT_TAIL`].
///
/// Either ends with a line on how to bring back a codeg delegation or check a
/// Pi job, when the list names one. Times are local (`tz`).
pub fn resume_prompt<Tz: chrono::TimeZone>(
    reason: ConversationAutoResumeReason,
    background: Option<&BackgroundSnapshot>,
    tz: &Tz,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let lines = background
        .map(|snapshot| describe_list(snapshot, tz))
        .unwrap_or_default();
    let mut hints: Vec<&str> = Vec::new();
    if let Some(snapshot) = background {
        let has = |kind: &str| snapshot.background_items().any(|item| item.kind == kind);
        if has(KIND_CODEG_DELEGATION) {
            hints.push(DELEGATION_HINT);
        }
        if has(KIND_PI_JOB) {
            hints.push(PI_JOB_HINT);
        }
    }
    let mut out = match reason {
        ConversationAutoResumeReason::Turn => {
            let mut out = RESUME_AFTER_RESTART_PROMPT.to_string();
            if !lines.is_empty() {
                out.push_str("\n\n");
                out.push_str(RESUME_TURN_BACKGROUND_HEADER);
                for line in &lines {
                    out.push('\n');
                    out.push_str(line);
                }
            }
            out
        }
        ConversationAutoResumeReason::Background => {
            let mut out = RESUME_BACKGROUND_PROMPT_HEAD.to_string();
            if lines.is_empty() {
                out.push('\n');
                out.push_str(UNKNOWN_WORK_LINE);
            }
            for line in &lines {
                out.push('\n');
                out.push_str(line);
            }
            out.push('\n');
            out.push_str(RESUME_BACKGROUND_PROMPT_TAIL);
            out
        }
    };
    if !hints.is_empty() {
        out.push_str("\n\n");
        out.push_str(&hints.join("\n"));
    }
    out
}

/// How many sessions may be reopening at once: the same limit every resume
/// shares (`CODEG_ACP_MAX_CONCURRENT_ATTACHES`, `0` = unlimited). Holding our
/// own slots on top of the shared gate is what keeps the batch in order —
/// the gate hands its slots to the newest request, which here would be the
/// least recent conversation.
fn resume_slots(batch: usize) -> usize {
    match crate::acp::connection::max_concurrent_attaches() {
        0 => batch.max(1),
        n => n,
    }
}

/// The boot task. Spawn once per process, after the lifecycle subscriber (it
/// records the resumed turn as running, which is what spends the claim).
pub async fn run_auto_resume(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    data_dir: PathBuf,
) {
    let settings = load_auto_resume_settings(&db.conn).await;
    let candidates =
        match conversation_service::list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
        {
            Ok(candidates) => candidates,
            Err(e) => {
                tracing::warn!("[auto-resume] failed to list interrupted sessions: {e}");
                return;
            }
        };
    let plan = plan_auto_resume(settings, candidates);

    // Everything marked but not in the plan (too old, deleted, a sub-session,
    // an engine's run, an agent that cannot resume, the setting is off,
    // resumed too many times in a row) will never be resumed: make it a plain
    // interruption now, so no later start picks it up out of the blue.
    let keep: Vec<i32> = plan.iter().map(|c| c.conversation.id).collect();
    match conversation_service::discard_pending_auto_resumes(&db.conn, &keep).await {
        Ok(0) => {}
        Ok(n) => tracing::info!("[auto-resume] left {n} interrupted session(s) to resume by hand"),
        Err(e) => tracing::warn!("[auto-resume] failed to drop stale resume marks: {e}"),
    }
    if plan.is_empty() {
        if !settings.enabled {
            tracing::info!("[auto-resume] off in settings; interrupted sessions stay as they are");
        }
        return;
    }

    tracing::info!(
        "[auto-resume] resuming {} session(s) interrupted by the last exit",
        plan.len()
    );
    with_status(|s| {
        s.started_at = Some(Utc::now());
        s.stopped = false;
        s.items = plan
            .iter()
            .map(|c| AutoResumeItem {
                conversation_id: c.conversation.id,
                folder_id: c.conversation.folder_id,
                agent_type: c.conversation.agent_type,
                title: c.conversation.title.clone(),
                state: AutoResumeItemState::Pending,
                error: None,
                reason: c.reason,
            })
            .collect();
    });
    publish(&emitter);

    tokio::time::sleep(start_delay()).await;

    let slots = resume_slots(plan.len());
    // `stop_auto_resume_core` has already marked a skipped one and dropped
    // its mark.
    paced(
        plan,
        stagger(),
        slots,
        || STOP.load(Ordering::SeqCst),
        |candidate| {
            let db = AppDatabase {
                conn: db.conn.clone(),
            };
            let manager = manager.clone_ref();
            let emitter = emitter.clone();
            let data_dir = data_dir.clone();
            async move {
                resume_one(&db, &manager, &emitter, &data_dir, candidate).await;
            }
        },
    )
    .await;
    tracing::info!("[auto-resume] done");
}

/// Start `start(item)` for each item in order: each at least `gap` after the
/// one before it started, at most `slots` running at once, none once `stop`
/// says so. Returns when every started one has finished. A large batch so
/// starts one session every `gap` instead of all of them at once.
async fn paced<T, F, Fut>(
    items: Vec<T>,
    gap: Duration,
    slots: usize,
    stop: impl Fn() -> bool,
    mut start: F,
) where
    F: FnMut(T) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let slots = Arc::new(tokio::sync::Semaphore::new(slots.max(1)));
    let mut running = tokio::task::JoinSet::new();
    let mut started_any = false;
    for item in items {
        if started_any && !gap.is_zero() && !stop() {
            tokio::time::sleep(gap).await;
        }
        let Ok(slot) = slots.clone().acquire_owned().await else {
            break;
        };
        if stop() {
            continue;
        }
        started_any = true;
        let run = start(item);
        running.spawn(async move {
            let _slot = slot;
            run.await;
        });
    }
    while running.join_next().await.is_some() {}
}

enum Outcome {
    Resumed,
    Skipped,
    Stopped,
}

async fn resume_one(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    candidate: AutoResumeCandidate,
) {
    let cid = candidate.conversation.id;
    if STOP.load(Ordering::SeqCst) {
        return;
    }
    let claimed = conversation_service::claim_auto_resume(&db.conn, cid).await;
    if claimed.is_ok() {
        // Claimed, the work it names goes into this resume's prompt; taken by
        // someone else, it is history. Either way the row is left to record
        // what the session runs from now on.
        if let Some(raw) = candidate.background_raw.as_deref() {
            if let Err(e) =
                conversation_service::clear_background_snapshot_if(&db.conn, cid, raw).await
            {
                tracing::warn!(
                    conversation_id = cid,
                    "[auto-resume] failed to drop the consumed background snapshot: {e}"
                );
            }
        }
    }
    match claimed {
        Ok(true) => {}
        Ok(false) => {
            set_item_state(cid, AutoResumeItemState::Skipped, None);
            publish(emitter);
            return;
        }
        Err(e) => {
            tracing::warn!(conversation_id = cid, "[auto-resume] claim failed: {e}");
            set_item_state(cid, AutoResumeItemState::Failed, Some(e.to_string()));
            publish(emitter);
            return;
        }
    }
    set_item_state(cid, AutoResumeItemState::Resuming, None);
    publish(emitter);

    let (state, error) = match reopen_and_prompt(db, manager, emitter, data_dir, &candidate).await {
        Ok(Outcome::Resumed) => {
            tracing::info!(conversation_id = cid, "[auto-resume] resumed");
            (AutoResumeItemState::Resumed, None)
        }
        Ok(outcome) => {
            release(db, cid).await;
            let state = match outcome {
                Outcome::Stopped => AutoResumeItemState::Stopped,
                _ => AutoResumeItemState::Skipped,
            };
            (state, None)
        }
        Err(reason) => {
            tracing::warn!(
                conversation_id = cid,
                "[auto-resume] could not resume: {reason}"
            );
            release(db, cid).await;
            (AutoResumeItemState::Failed, Some(reason))
        }
    };
    set_item_state(cid, state, error);
    publish(emitter);
}

async fn release(db: &AppDatabase, conversation_id: i32) {
    if let Err(e) = conversation_service::release_auto_resume(&db.conn, conversation_id).await {
        tracing::warn!(
            conversation_id,
            "[auto-resume] failed to release a claim: {e}"
        );
    }
}

/// Reopen the conversation's agent session the way a tab's connect does —
/// same working directory (so a tab opening it meanwhile shares the one
/// connection), same per-conversation selectors — then send the continuation
/// through the normal prompt path.
async fn reopen_and_prompt(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    candidate: &AutoResumeCandidate,
) -> Result<Outcome, String> {
    let conversation = &candidate.conversation;
    let target = ReopenTarget {
        conversation_id: conversation.id,
        folder_id: conversation.folder_id,
        agent_type: conversation.agent_type,
        external_id: conversation.external_id.clone(),
    };
    let prompt = resume_prompt(
        candidate.reason,
        candidate.background.as_ref(),
        &chrono::Local,
    );
    let sent = reopen_and_send(
        db,
        manager,
        emitter,
        data_dir,
        &target,
        OWNER_LABEL,
        &prompt,
        "auto-resume",
        || STOP.load(Ordering::SeqCst),
    )
    .await?;
    Ok(match sent {
        Sent::Prompted => Outcome::Resumed,
        Sent::Busy => Outcome::Skipped,
        Sent::Aborted => Outcome::Stopped,
    })
}

/// The conversation a backend-driven prompt goes to.
pub(crate) struct ReopenTarget {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub external_id: Option<String>,
}

/// How [`reopen_and_send`] ended when it did not fail.
pub(crate) enum Sent {
    /// The prompt went out; the turn runs like any other.
    Prompted,
    /// A turn was already running on the session (someone sent one by hand).
    Busy,
    /// `abort` said stop after the session reopened, before the prompt.
    Aborted,
}

/// Reopen a conversation's agent session the way a tab's connect does — same
/// working directory (so a tab opening it meanwhile shares the one
/// connection), same per-conversation selectors — then send `prompt` through
/// the normal prompt path (conversation link, prompt ledger, cross-client
/// `UserMessage` broadcast). Shared by the resume after a restart and the
/// continuation after the usage limit (`acp::limit_continue`). `Err` carries
/// why it could not happen.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reopen_and_send(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    target: &ReopenTarget,
    owner_label: &str,
    prompt: &str,
    message_id_prefix: &str,
    abort: impl Fn() -> bool,
) -> Result<Sent, String> {
    let conn_id = reopen_conversation(db, manager, emitter, data_dir, target, owner_label).await?;

    if abort() {
        // Reopened but not prompted: an idle connection, which the idle sweep
        // reaps unless a tab picks it up.
        return Ok(Sent::Aborted);
    }

    let blocks = vec![PromptInputBlock::Text {
        text: prompt.to_string(),
    }];
    let message_id = format!("{message_id_prefix}-{}", uuid::Uuid::new_v4());
    match manager
        .send_prompt_linked_with_message_id(
            db,
            &conn_id,
            blocks,
            Some(target.folder_id),
            Some(target.conversation_id),
            None,
            Some(message_id),
        )
        .await
    {
        Ok(_) => Ok(Sent::Prompted),
        // A turn is already running on it — someone sent one by hand in the
        // moment between the claim and now.
        Err(AcpError::TurnInProgress) => Ok(Sent::Busy),
        Err(e) => Err(e.to_string()),
    }
}

/// The reopening half of [`reopen_and_send`]: open the conversation's session
/// the way a tab's connect does, or share the connection that already has it,
/// and wait until it takes prompts; the connection's id. A connection this
/// call opened is stopped again when the session does not come up. Also what
/// a side question uses to reach a conversation nothing has open
/// (`acp::side_question`).
pub(crate) async fn reopen_conversation(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    target: &ReopenTarget,
    owner_label: &str,
) -> Result<String, String> {
    let agent_type = target.agent_type;
    let session_id = target
        .external_id
        .clone()
        .ok_or_else(|| "the conversation has no agent session".to_string())?;
    let folder = folder_service::get_folder_by_id(&db.conn, target.folder_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "the conversation's folder is gone".to_string())?;
    let runtime_env =
        build_session_runtime_env(db, agent_type, Some(session_id.as_str()), data_dir)
            .await
            .map_err(|e| e.to_string())?;
    verify_agent_installed(agent_type)
        .await
        .map_err(|e| e.to_string())?;
    let (mode_id, config_values) = resolve_connect_selector_prefs(
        &db.conn,
        agent_type,
        Some(session_id.as_str()),
        None,
        BTreeMap::new(),
    )
    .await;

    // The directory a tab reopens it in (`working_dir` on the summary): the
    // folder's path, or where a session moved without its files keeps
    // running. A tab that already reopened this session owns that
    // connection: share it, and never tear it down on its behalf.
    let working_dir_str = conversation_service::working_dir_of(&db.conn, target.conversation_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| folder.path.clone());
    let working_dir = PathBuf::from(&working_dir_str);
    let shared = manager
        .find_connection_for_reuse(agent_type, Some(&working_dir), Some(session_id.as_str()))
        .await
        .is_some();
    let conn_id = manager
        .spawn_agent_detached(
            agent_type,
            Some(working_dir_str.clone()),
            Some(session_id.clone()),
            runtime_env,
            owner_label.to_string(),
            emitter.clone(),
            mode_id,
            config_values,
        )
        .await
        .map_err(|e| e.to_string())?;

    let phase = manager.wait_until_attached(&conn_id, ATTACH_TIMEOUT).await;
    let failure = match phase {
        Some(AttachPhase::Ready) => {
            if reopened_session(manager, &conn_id, agent_type, &session_id).await {
                None
            } else {
                Some("the agent opened a different session")
            }
        }
        Some(AttachPhase::Failed) => Some("the agent could not reopen the session"),
        Some(_) => Some("timed out reopening the session"),
        None => Some("the agent exited while reopening the session"),
    };
    if let Some(reason) = failure {
        if !shared {
            let _ = manager.disconnect(&conn_id).await;
        }
        return Err(reason.to_string());
    }
    Ok(conn_id)
}

/// Whether the connection holds the conversation's own session, not a fresh
/// one an agent fell back to when it could not reopen it (continuing THAT
/// would talk to an agent that remembers nothing).
async fn reopened_session(
    manager: &ConnectionManager,
    conn_id: &str,
    agent_type: AgentType,
    session_id: &str,
) -> bool {
    let Some(state) = manager.get_state(conn_id).await else {
        return false;
    };
    let state = state.read().await;
    if matches!(
        state.status,
        ConnectionStatus::Disconnected | ConnectionStatus::Error
    ) {
        return false;
    }
    match state.external_id.as_deref() {
        // Not confirmed yet: the connection was spawned to reopen exactly
        // this id, and the prompt's bind settles it either way.
        None => true,
        Some(id) if id == session_id => true,
        Some(id) => crate::acp::continued_session_ids(agent_type, id)
            .iter()
            .any(|ancestor| ancestor == session_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::background_snapshot::{
        BackgroundSnapshotItem, KIND_OUT_OF_TURN, KIND_PI_SUBAGENT, KIND_SHELL, KIND_SUB_AGENT,
    };
    use crate::db::entities::conversation::{
        self, ConversationAutoResume, ConversationKind, ConversationTurnState,
    };
    use crate::db::service::conversation_service::{
        claim_auto_resume, clear_spent_auto_resume, discard_pending_auto_resumes, finish_turn,
        interrupt_orphaned_turns, list_auto_resume_candidates, mark_turn_cancelled_by_user,
        mark_turn_interrupted, mark_turn_running, release_auto_resume, set_background_snapshot,
    };
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::models::DbConversationSummary;
    use sea_orm::{ActiveModelTrait, EntityTrait, Set};

    async fn row(db: &AppDatabase, id: i32) -> conversation::Model {
        conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("row present")
    }

    /// A top-level conversation bound to agent session `sess-<title>`.
    async fn session(db: &AppDatabase, folder: i32, title: &str) -> i32 {
        let created =
            conversation_service::create(&db.conn, folder, AgentType::ClaudeCode, None, None)
                .await
                .expect("row");
        let mut active: conversation::ActiveModel = created.into();
        active.title = Set(Some(title.to_string()));
        active.external_id = Set(Some(format!("sess-{title}")));
        let updated = active.update(&db.conn).await.expect("bind session");
        updated.id
    }

    /// Run a turn on `id` and have codeg's exit cut it off.
    async fn cut_off_by_exit(db: &AppDatabase, id: i32) {
        assert!(mark_turn_running(&db.conn, id).await.unwrap());
        interrupt_orphaned_turns(&db.conn).await.unwrap();
    }

    async fn candidate_ids(db: &AppDatabase) -> Vec<i32> {
        list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
            .expect("candidates")
            .into_iter()
            .map(|c| c.conversation.id)
            .collect()
    }

    fn item(kind: &str, label: &str) -> BackgroundSnapshotItem {
        BackgroundSnapshotItem::new(kind, label)
    }

    fn snapshot(at: DateTime<Utc>, items: Vec<BackgroundSnapshotItem>) -> BackgroundSnapshot {
        BackgroundSnapshot { at, items, more: 0 }
    }

    /// The live writer recorded `items` running for `id`, then codeg exited.
    async fn background_cut_off(db: &AppDatabase, id: i32, items: Vec<BackgroundSnapshotItem>) {
        set_background_snapshot(&db.conn, id, Some(snapshot(Utc::now(), items).to_json()))
            .await
            .unwrap();
        interrupt_orphaned_turns(&db.conn).await.unwrap();
    }

    #[tokio::test]
    async fn a_turn_running_at_launch_is_a_candidate_and_an_idle_one_is_not() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-basic").await;
        let working = session(&db, folder, "working").await;
        let idle = session(&db, folder, "idle").await;
        let finished = session(&db, folder, "finished").await;
        mark_turn_running(&db.conn, finished).await.unwrap();
        finish_turn(&db.conn, finished, None).await.unwrap();

        cut_off_by_exit(&db, working).await;

        assert_eq!(candidate_ids(&db).await, vec![working]);
        let working_row = row(&db, working).await;
        assert_eq!(
            working_row.turn_state,
            Some(ConversationTurnState::Interrupted)
        );
        assert_eq!(
            working_row.auto_resume,
            Some(ConversationAutoResume::Pending)
        );
        assert_eq!(row(&db, idle).await.auto_resume, None);
        assert_eq!(row(&db, finished).await.auto_resume, None);
    }

    #[tokio::test]
    async fn an_agent_dying_while_codeg_runs_is_not_a_candidate() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-runtime").await;
        let id = session(&db, folder, "crashed-agent").await;
        mark_turn_running(&db.conn, id).await.unwrap();
        // The lifecycle subscriber saw the connection die mid-turn.
        assert!(mark_turn_interrupted(&db.conn, id).await.unwrap());
        // A later restart finds it interrupted, not running.
        interrupt_orphaned_turns(&db.conn).await.unwrap();
        assert!(candidate_ids(&db).await.is_empty());
    }

    #[tokio::test]
    async fn cancelled_old_deleted_and_delegated_turns_are_excluded() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-excluded").await;
        let keep = session(&db, folder, "keep").await;
        let cancelled = session(&db, folder, "cancelled").await;
        let deleted = session(&db, folder, "deleted").await;
        let child = session(&db, folder, "child").await;
        let unbound = conversation_service::create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .unwrap()
            .id;

        for id in [keep, cancelled, deleted, child, unbound] {
            mark_turn_running(&db.conn, id).await.unwrap();
        }
        // The user pressed Stop; codeg exited before the agent confirmed.
        assert!(mark_turn_cancelled_by_user(&db.conn, cancelled)
            .await
            .unwrap());
        conversation_service::soft_delete(&db.conn, deleted)
            .await
            .unwrap();
        let mut active: conversation::ActiveModel = row(&db, child).await.into();
        active.parent_id = Set(Some(keep));
        active.kind = Set(ConversationKind::Delegate);
        active.update(&db.conn).await.unwrap();

        interrupt_orphaned_turns(&db.conn).await.unwrap();

        assert_eq!(candidate_ids(&db).await, vec![keep]);
        assert_eq!(
            row(&db, cancelled).await.auto_resume,
            Some(ConversationAutoResume::Cancelled),
            "the exit keeps the user's stop"
        );

        // Twelve hours later the same interruption is stale.
        let later =
            Utc::now() + chrono::Duration::hours(MAX_AGE_HOURS) + chrono::Duration::minutes(1);
        let stale = list_auto_resume_candidates(&db.conn, later, max_age())
            .await
            .unwrap();
        assert!(
            stale.is_empty(),
            "a turn cut off over 12 h ago is not resumed"
        );
    }

    #[tokio::test]
    async fn a_resume_happens_at_most_once_per_interruption() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-once").await;
        let id = session(&db, folder, "once").await;
        cut_off_by_exit(&db, id).await;

        // This start claims it; a second claim (another process, a retry) loses.
        assert!(claim_auto_resume(&db.conn, id).await.unwrap());
        assert!(!claim_auto_resume(&db.conn, id).await.unwrap());
        assert!(candidate_ids(&db).await.is_empty());

        // The resumed turn starts, possibly more than once per turn.
        mark_turn_running(&db.conn, id).await.unwrap();
        mark_turn_running(&db.conn, id).await.unwrap();
        assert_eq!(
            row(&db, id).await.auto_resume,
            Some(ConversationAutoResume::Attempted)
        );

        // codeg dies again during the resumed turn: a plain interruption.
        interrupt_orphaned_turns(&db.conn).await.unwrap();
        let after = row(&db, id).await;
        assert_eq!(after.turn_state, Some(ConversationTurnState::Interrupted));
        assert_eq!(after.auto_resume, Some(ConversationAutoResume::Attempted));
        assert!(candidate_ids(&db).await.is_empty(), "never resumed twice");

        // The user continues by hand: a new turn, so a new interruption is
        // due its own single resume.
        assert!(clear_spent_auto_resume(&db.conn, id).await.unwrap());
        cut_off_by_exit(&db, id).await;
        assert_eq!(candidate_ids(&db).await, vec![id]);

        // A turn that ends normally settles every mark.
        assert!(claim_auto_resume(&db.conn, id).await.unwrap());
        mark_turn_running(&db.conn, id).await.unwrap();
        finish_turn(&db.conn, id, None).await.unwrap();
        assert_eq!(row(&db, id).await.auto_resume, None);
    }

    #[tokio::test]
    async fn a_released_claim_leaves_a_plain_interruption() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-release").await;
        let id = session(&db, folder, "release").await;
        cut_off_by_exit(&db, id).await;
        assert!(claim_auto_resume(&db.conn, id).await.unwrap());
        assert!(release_auto_resume(&db.conn, id).await.unwrap());
        let after = row(&db, id).await;
        assert_eq!(after.turn_state, Some(ConversationTurnState::Interrupted));
        assert_eq!(after.auto_resume, None);
        assert!(candidate_ids(&db).await.is_empty());
    }

    #[tokio::test]
    async fn discarding_keeps_only_the_planned_marks() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-discard").await;
        let a = session(&db, folder, "a").await;
        let b = session(&db, folder, "b").await;
        cut_off_by_exit(&db, a).await;
        cut_off_by_exit(&db, b).await;
        assert_eq!(
            discard_pending_auto_resumes(&db.conn, &[a]).await.unwrap(),
            1
        );
        assert_eq!(candidate_ids(&db).await, vec![a]);
        assert_eq!(
            discard_pending_auto_resumes(&db.conn, &[]).await.unwrap(),
            1
        );
        assert!(candidate_ids(&db).await.is_empty());
    }

    fn candidate(
        id: i32,
        agent_type: AgentType,
        reason: ConversationAutoResumeReason,
    ) -> AutoResumeCandidate {
        AutoResumeCandidate {
            conversation: DbConversationSummary {
                agent_type,
                ..sample_summary(id)
            },
            reason,
            background: None,
            background_raw: None,
            resumes_in_a_row: 0,
        }
    }

    fn ids(plan: Vec<AutoResumeCandidate>) -> Vec<i32> {
        plan.into_iter().map(|c| c.conversation.id).collect()
    }

    #[test]
    fn the_setting_off_plans_nothing() {
        use ConversationAutoResumeReason::{Background, Turn};
        let candidates = vec![
            candidate(1, AgentType::ClaudeCode, Turn),
            candidate(2, AgentType::Codex, Turn),
            candidate(3, AgentType::Pi, Background),
            candidate(4, AgentType::Cline, Turn),
            candidate(5, AgentType::ClaudeCode, Background),
        ];
        let off = AutoResumeSettings {
            enabled: false,
            background: true,
        };
        assert!(plan_auto_resume(off, candidates.clone()).is_empty());
        assert_eq!(
            ids(plan_auto_resume(
                AutoResumeSettings::default(),
                candidates.clone()
            )),
            vec![1, 2, 3, 5],
            "every agent that reopens sessions, in order"
        );
        let turns_only = AutoResumeSettings {
            enabled: true,
            background: false,
        };
        assert_eq!(
            ids(plan_auto_resume(turns_only, candidates)),
            vec![1, 2],
            "with background resumes off, only cut-off turns"
        );
    }

    #[test]
    fn a_conversation_resumed_too_often_in_a_row_is_left_alone() {
        let mut tired = candidate(
            1,
            AgentType::ClaudeCode,
            ConversationAutoResumeReason::Background,
        );
        tired.resumes_in_a_row = MAX_RESUMES_IN_A_ROW;
        let mut fresh = candidate(2, AgentType::ClaudeCode, ConversationAutoResumeReason::Turn);
        fresh.resumes_in_a_row = MAX_RESUMES_IN_A_ROW - 1;
        assert_eq!(
            ids(plan_auto_resume(
                AutoResumeSettings::default(),
                vec![tired, fresh]
            )),
            vec![2]
        );
    }

    #[test]
    fn a_stored_setting_from_before_the_background_switch_reads_it_as_on() {
        let old: AutoResumeSettings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert_eq!(
            old,
            AutoResumeSettings {
                enabled: false,
                background: true
            }
        );
    }

    #[tokio::test]
    async fn with_the_setting_off_nothing_resumes_and_the_mark_is_dropped() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-off").await;
        let id = session(&db, folder, "off").await;
        cut_off_by_exit(&db, id).await;
        save_auto_resume_settings(
            &db.conn,
            AutoResumeSettings {
                enabled: false,
                background: true,
            },
        )
        .await
        .unwrap();
        assert!(!load_auto_resume_settings(&db.conn).await.enabled);

        let manager = ConnectionManager::new();
        run_auto_resume(
            AppDatabase {
                conn: db.conn.clone(),
            },
            manager.clone_ref(),
            EventEmitter::Noop,
            PathBuf::from("/tmp/auto-resume-off-data"),
        )
        .await;

        assert!(
            manager.list_connections().await.is_empty(),
            "no session reopened"
        );
        let after = row(&db, id).await;
        assert_eq!(
            after.turn_state,
            Some(ConversationTurnState::Interrupted),
            "still interrupted, with the manual Continue"
        );
        assert_eq!(
            after.auto_resume, None,
            "and not resumed by a later start either"
        );
    }

    #[tokio::test]
    async fn the_setting_defaults_to_on() {
        let db = fresh_in_memory_db().await;
        let settings = load_auto_resume_settings(&db.conn).await;
        assert!(settings.enabled);
        assert!(settings.background);
    }

    #[test]
    fn the_frontend_matches_the_same_prompts() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/lib/auto-resume.ts"
        );
        let Ok(source) = std::fs::read_to_string(path) else {
            // Built outside the repository (a packaged source tree): nothing to compare.
            return;
        };
        for (name, text) in [
            ("RESUME_AFTER_RESTART_PROMPT", RESUME_AFTER_RESTART_PROMPT),
            (
                "RESUME_TURN_BACKGROUND_HEADER",
                RESUME_TURN_BACKGROUND_HEADER,
            ),
            (
                "RESUME_BACKGROUND_PROMPT_HEAD",
                RESUME_BACKGROUND_PROMPT_HEAD,
            ),
            (
                "RESUME_BACKGROUND_PROMPT_TAIL",
                RESUME_BACKGROUND_PROMPT_TAIL,
            ),
        ] {
            assert!(
                source.contains(&format!("\"{text}\"")),
                "src/lib/auto-resume.ts must carry {name} verbatim"
            );
        }
    }

    // ─── Background work ───────────────────────────────────────────────

    #[tokio::test]
    async fn background_work_running_at_the_exit_marks_a_finished_turn_for_resume() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-bg").await;
        let orchestrator = session(&db, folder, "orchestrator").await;
        let quiet = session(&db, folder, "quiet").await;
        // Its turn ran and ended; a sub-agent and a shell it launched still ran.
        mark_turn_running(&db.conn, orchestrator).await.unwrap();
        finish_turn(&db.conn, orchestrator, None).await.unwrap();

        background_cut_off(
            &db,
            orchestrator,
            vec![
                item(KIND_SUB_AGENT, "Review the parser"),
                item(KIND_SHELL, "sleep 900"),
            ],
        )
        .await;

        let marked = row(&db, orchestrator).await;
        assert_eq!(marked.turn_state, None, "the turn itself finished");
        assert_eq!(marked.auto_resume, Some(ConversationAutoResume::Pending));
        assert_eq!(
            marked.auto_resume_reason,
            Some(ConversationAutoResumeReason::Background)
        );
        assert!(
            marked.background_snapshot.is_some(),
            "its list waits for the resume's prompt"
        );
        assert_eq!(row(&db, quiet).await.auto_resume, None);

        let candidates = list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
            .unwrap();
        assert_eq!(candidates.len(), 1);
        let c = &candidates[0];
        assert_eq!(c.conversation.id, orchestrator);
        assert_eq!(c.reason, ConversationAutoResumeReason::Background);
        assert_eq!(c.background.as_ref().unwrap().items.len(), 2);

        // A second sweep (the next start after a graceful quit's) changes nothing.
        interrupt_orphaned_turns(&db.conn).await.unwrap();
        assert_eq!(candidate_ids(&db).await, vec![orchestrator]);
    }

    #[tokio::test]
    async fn a_turn_of_its_own_cut_off_is_resumed_like_a_running_turn() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-woken").await;
        let id = session(&db, folder, "woken").await;
        background_cut_off(
            &db,
            id,
            vec![item(KIND_OUT_OF_TURN, ""), item(KIND_SUB_AGENT, "Tests")],
        )
        .await;
        let marked = row(&db, id).await;
        assert_eq!(marked.turn_state, Some(ConversationTurnState::Interrupted));
        assert_eq!(marked.auto_resume, Some(ConversationAutoResume::Pending));
        assert_eq!(
            marked.auto_resume_reason,
            Some(ConversationAutoResumeReason::Turn)
        );
        let candidates = list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
            .unwrap();
        assert_eq!(candidates[0].reason, ConversationAutoResumeReason::Turn);
    }

    #[tokio::test]
    async fn a_running_turn_keeps_its_list_and_unused_lists_are_dropped() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-lists").await;
        let working = session(&db, folder, "working").await;
        let stopped = session(&db, folder, "stopped").await;
        let list = Some(snapshot(Utc::now(), vec![item(KIND_SHELL, "build")]).to_json());
        for id in [working, stopped] {
            mark_turn_running(&db.conn, id).await.unwrap();
            set_background_snapshot(&db.conn, id, list.clone())
                .await
                .unwrap();
        }
        // The user stopped one turn; codeg exited before the agent confirmed.
        assert!(mark_turn_cancelled_by_user(&db.conn, stopped)
            .await
            .unwrap());
        interrupt_orphaned_turns(&db.conn).await.unwrap();

        let w = row(&db, working).await;
        assert_eq!(w.auto_resume, Some(ConversationAutoResume::Pending));
        assert_eq!(
            w.auto_resume_reason,
            Some(ConversationAutoResumeReason::Turn)
        );
        assert!(w.background_snapshot.is_some(), "named in its prompt");
        let s = row(&db, stopped).await;
        assert_eq!(s.auto_resume, Some(ConversationAutoResume::Cancelled));
        assert_eq!(s.background_snapshot, None, "nothing will read it");

        let c = &list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
            .unwrap()[0];
        assert_eq!(c.reason, ConversationAutoResumeReason::Turn);
        let prompt = resume_prompt(c.reason, c.background.as_ref(), &Utc);
        assert!(prompt.starts_with(RESUME_AFTER_RESTART_PROMPT));
        assert!(prompt.contains(&format!(
            "\n\n{RESUME_TURN_BACKGROUND_HEADER}\n- background shell: build"
        )));
    }

    #[tokio::test]
    async fn the_background_resume_happens_at_most_once() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-bg-once").await;
        let id = session(&db, folder, "bg-once").await;
        background_cut_off(&db, id, vec![item(KIND_SUB_AGENT, "Audit")]).await;
        let raw = row(&db, id).await.background_snapshot.unwrap();

        assert!(claim_auto_resume(&db.conn, id).await.unwrap());
        assert!(!claim_auto_resume(&db.conn, id).await.unwrap());
        assert!(
            conversation_service::clear_background_snapshot_if(&db.conn, id, &raw)
                .await
                .unwrap()
        );
        assert_eq!(row(&db, id).await.auto_resume_count, 1);

        // The resumed turn starts; codeg dies during it: a plain interruption.
        mark_turn_running(&db.conn, id).await.unwrap();
        interrupt_orphaned_turns(&db.conn).await.unwrap();
        let after = row(&db, id).await;
        assert_eq!(after.auto_resume, Some(ConversationAutoResume::Attempted));
        assert!(candidate_ids(&db).await.is_empty(), "never resumed twice");
    }

    #[tokio::test]
    async fn the_user_getting_there_first_spends_the_mark_and_its_list() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-bg-user").await;
        let id = session(&db, folder, "bg-user").await;
        background_cut_off(&db, id, vec![item(KIND_SHELL, "serve")]).await;
        // The user sends a message before the resume claims it.
        mark_turn_running(&db.conn, id).await.unwrap();
        let after = row(&db, id).await;
        assert_eq!(after.auto_resume, None);
        assert_eq!(after.background_snapshot, None, "the old list is history");
        assert!(!claim_auto_resume(&db.conn, id).await.unwrap());
        // The next exit cuts off the user's turn: a fresh interruption, with
        // nothing stale named.
        interrupt_orphaned_turns(&db.conn).await.unwrap();
        let c = &list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
            .unwrap()[0];
        assert_eq!(c.reason, ConversationAutoResumeReason::Turn);
        assert!(c.background.is_none());
    }

    #[tokio::test]
    async fn resumes_in_a_row_are_counted_until_the_user_sends_a_turn() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-streak").await;
        let id = session(&db, folder, "streak").await;
        for round in 1..=MAX_RESUMES_IN_A_ROW {
            background_cut_off(&db, id, vec![item(KIND_SHELL, "job")]).await;
            let c = list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
                .await
                .unwrap();
            assert_eq!(plan_auto_resume(AutoResumeSettings::default(), c).len(), 1);
            assert!(claim_auto_resume(&db.conn, id).await.unwrap());
            // The resumed turn re-launches the job and ends.
            mark_turn_running(&db.conn, id).await.unwrap();
            finish_turn(&db.conn, id, None).await.unwrap();
            assert_eq!(row(&db, id).await.auto_resume_count, round);
        }
        background_cut_off(&db, id, vec![item(KIND_SHELL, "job")]).await;
        let c = list_auto_resume_candidates(&db.conn, Utc::now(), max_age())
            .await
            .unwrap();
        assert!(
            plan_auto_resume(AutoResumeSettings::default(), c).is_empty(),
            "a fourth resume in a row is not made"
        );
        // The user sends a turn: the count starts over.
        assert!(clear_spent_auto_resume(&db.conn, id).await.unwrap());
        assert_eq!(row(&db, id).await.auto_resume_count, 0);
    }

    #[tokio::test]
    async fn the_age_limit_runs_from_the_snapshot_time() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-bg-age").await;
        let id = session(&db, folder, "bg-age").await;
        // Last active long ago, but its background work ran until the exit.
        let mut active: conversation::ActiveModel = row(&db, id).await.into();
        active.updated_at = Set(Utc::now() - chrono::Duration::hours(30));
        active.update(&db.conn).await.unwrap();
        background_cut_off(&db, id, vec![item(KIND_SUB_AGENT, "Long run")]).await;
        assert_eq!(candidate_ids(&db).await, vec![id]);

        let later = Utc::now() + max_age() + chrono::Duration::minutes(1);
        assert!(
            list_auto_resume_candidates(&db.conn, later, max_age())
                .await
                .unwrap()
                .is_empty(),
            "work last seen over 12 h before the start is not resumed"
        );
    }

    #[tokio::test]
    async fn with_background_resumes_off_the_session_stays_finished() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-bg-off").await;
        let id = session(&db, folder, "bg-off").await;
        background_cut_off(&db, id, vec![item(KIND_SHELL, "sleep 900")]).await;
        save_auto_resume_settings(
            &db.conn,
            AutoResumeSettings {
                enabled: true,
                background: false,
            },
        )
        .await
        .unwrap();

        let manager = ConnectionManager::new();
        run_auto_resume(
            AppDatabase {
                conn: db.conn.clone(),
            },
            manager.clone_ref(),
            EventEmitter::Noop,
            PathBuf::from("/tmp/auto-resume-bg-off-data"),
        )
        .await;

        assert!(
            manager.list_connections().await.is_empty(),
            "no session reopened"
        );
        let after = row(&db, id).await;
        assert_eq!(after.turn_state, None, "still a finished turn");
        assert_eq!(after.auto_resume, None);
        assert_eq!(after.background_snapshot, None, "and nothing left to name");
        interrupt_orphaned_turns(&db.conn).await.unwrap();
        assert!(
            candidate_ids(&db).await.is_empty(),
            "not resumed by a later start either"
        );
    }

    #[test]
    fn the_background_prompt_names_what_was_stopped() {
        let at: DateTime<Utc> = "2026-11-12T11:14:00Z".parse().unwrap();
        let mut agent = item(KIND_SUB_AGENT, "Resume background work after restart");
        agent.started_at = Some("2026-11-12T11:02:00Z".parse().unwrap());
        let mut delegation = item("delegation", "run the tests");
        delegation.id = Some("6f1c".into());
        delegation.agent = Some("codex".into());
        let mut snap = snapshot(at, vec![agent, item(KIND_SHELL, "sleep 900"), delegation]);
        snap.more = 2;
        let prompt = resume_prompt(ConversationAutoResumeReason::Background, Some(&snap), &Utc);
        assert_eq!(
            prompt,
            format!(
                "{RESUME_BACKGROUND_PROMPT_HEAD}\n\
                 - sub-agent: Resume background work after restart (started 11:02)\n\
                 - background shell: sleep 900\n\
                 - codeg delegation to codex, task_id 6f1c: run the tests\n\
                 - and 2 more background tasks\n\
                 {RESUME_BACKGROUND_PROMPT_TAIL}\n\n{DELEGATION_HINT}"
            )
        );

        // A turn with nothing in the background keeps the prompt it always had.
        assert_eq!(
            resume_prompt(ConversationAutoResumeReason::Turn, None, &Utc),
            RESUME_AFTER_RESTART_PROMPT
        );
        let only_turn = snapshot(at, vec![item(KIND_OUT_OF_TURN, "")]);
        assert_eq!(
            resume_prompt(ConversationAutoResumeReason::Turn, Some(&only_turn), &Utc),
            RESUME_AFTER_RESTART_PROMPT
        );
        // A lost list still says what happened.
        let lost = resume_prompt(ConversationAutoResumeReason::Background, None, &Utc);
        assert!(lost.starts_with(&format!("{RESUME_BACKGROUND_PROMPT_HEAD}\n- ")));
        assert!(lost.ends_with(RESUME_BACKGROUND_PROMPT_TAIL));
        // A Pi run is named by its run id.
        let mut run = item(KIND_PI_SUBAGENT, "researcher: Find prices");
        run.id = Some("910e998f".into());
        let pi = resume_prompt(
            ConversationAutoResumeReason::Background,
            Some(&snapshot(at, vec![run])),
            &Utc,
        );
        assert!(pi.contains("- async sub-agent run 910e998f: researcher: Find prices"));
    }

    #[tokio::test(start_paused = true)]
    async fn resumes_start_a_stagger_apart() {
        use std::sync::Mutex;
        let gap = Duration::from_secs(12);
        let t0 = tokio::time::Instant::now();
        let starts: Arc<Mutex<Vec<(u32, Duration)>>> = Arc::default();
        let log = starts.clone();
        paced(
            vec![1u32, 2, 3, 4],
            gap,
            2,
            || false,
            move |i| {
                let log = log.clone();
                async move {
                    log.lock().unwrap().push((i, t0.elapsed()));
                    // Reopening a session takes a while.
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            },
        )
        .await;
        let starts = starts.lock().unwrap().clone();
        assert_eq!(
            starts.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
            vec![1, 2, 3, 4],
            "in order"
        );
        for pair in starts.windows(2) {
            assert!(
                pair[1].1 - pair[0].1 >= gap,
                "{:?} started less than {gap:?} after {:?}",
                pair[1],
                pair[0]
            );
        }
        // Two slots: the third waits for the first to finish reopening.
        assert_eq!(starts[2].1, Duration::from_secs(30));

        // Stop cancels whatever has not started.
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ran: Arc<Mutex<Vec<u32>>> = Arc::default();
        let (flag, log) = (stopped.clone(), ran.clone());
        paced(
            vec![1u32, 2, 3],
            gap,
            1,
            move || stopped.load(Ordering::SeqCst),
            move |i| {
                let (flag, log) = (flag.clone(), log.clone());
                async move {
                    log.lock().unwrap().push(i);
                    flag.store(true, Ordering::SeqCst);
                }
            },
        )
        .await;
        assert_eq!(*ran.lock().unwrap(), vec![1]);
    }

    fn sample_summary(id: i32) -> DbConversationSummary {
        DbConversationSummary {
            id,
            folder_id: 1,
            title: None,
            title_locked: false,
            agent_type: AgentType::ClaudeCode,
            status: "in_progress".into(),
            kind: ConversationKind::Regular,
            model: None,
            git_branch: None,
            external_id: Some(format!("sess-{id}")),
            message_count: 0,
            child_count: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            last_viewed_at: None,
            pin_order: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
            origin_cwd: None,
            working_dir: None,
            turn_state: Some(ConversationTurnState::Interrupted),
            critical: false,
            critical_stall: true,
            talk_mode: false,
            limit_pause: None,
            limit_auto_continue: true,
            limit_reason: None,
            selector_state: None,
            background: None,
        }
    }
}
