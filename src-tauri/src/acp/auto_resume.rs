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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AttachPhase, ConnectionStatus, PromptInputBlock};
use crate::app_error::AppCommandError;
use crate::commands::acp::{
    build_session_runtime_env, resolve_connect_selector_prefs, verify_agent_installed,
};
use crate::db::service::{app_metadata_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::{AgentType, DbConversationSummary};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// The prompt a resumed turn starts with. It goes to the agent, so it is not
/// localized; the transcript recognizes it by its exact text and draws it as a
/// "Resumed after restart" divider. The frontend keeps the same text in
/// `src/lib/auto-resume.ts` — a test below fails if the two drift apart.
pub const RESUME_AFTER_RESTART_PROMPT: &str = "codeg restarted while you were working, so your last turn was cut off. Anything that was running in the background (sub-agents, background shells, monitors) was stopped. Continue where you left off, re-launching anything that still needs to run.";

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

/// "Resume interrupted sessions after restart" (General settings). On unless
/// the user turned it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoResumeSettings {
    pub enabled: bool,
}

impl Default for AutoResumeSettings {
    fn default() -> Self {
        Self { enabled: true }
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

fn start_delay() -> Duration {
    let secs = std::env::var("CODEG_AUTO_RESUME_DELAY_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_START_DELAY_SECS);
    Duration::from_secs(secs)
}

/// Whether codeg reopens this agent's sessions by id at all. Cline sessions
/// are never resumed (the chat always starts it fresh), so continuing one
/// would land in an empty session.
fn supports_resume(agent_type: AgentType) -> bool {
    !matches!(agent_type, AgentType::Cline)
}

/// Which candidates this start resumes: none with the setting off, otherwise
/// every candidate whose agent can reopen a session, in the order given (most
/// recently active first).
pub(crate) fn plan_auto_resume(
    settings: AutoResumeSettings,
    candidates: Vec<DbConversationSummary>,
) -> Vec<DbConversationSummary> {
    if !settings.enabled {
        return Vec::new();
    }
    candidates
        .into_iter()
        .filter(|c| supports_resume(c.agent_type))
        .collect()
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
    // an engine's run, an agent that cannot resume, the setting is off) will
    // never be resumed: make it a plain interruption now, so no later start
    // picks it up out of the blue.
    let keep: Vec<i32> = plan.iter().map(|c| c.id).collect();
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
                conversation_id: c.id,
                folder_id: c.folder_id,
                agent_type: c.agent_type,
                title: c.title.clone(),
                state: AutoResumeItemState::Pending,
                error: None,
            })
            .collect();
    });
    publish(&emitter);

    tokio::time::sleep(start_delay()).await;

    let slots = Arc::new(tokio::sync::Semaphore::new(resume_slots(plan.len())));
    let mut running = tokio::task::JoinSet::new();
    for candidate in plan {
        let Ok(slot) = slots.clone().acquire_owned().await else {
            break;
        };
        if STOP.load(Ordering::SeqCst) {
            // `stop_auto_resume_core` already marked it and dropped its mark.
            continue;
        }
        let db = AppDatabase {
            conn: db.conn.clone(),
        };
        let manager = manager.clone_ref();
        let emitter = emitter.clone();
        let data_dir = data_dir.clone();
        running.spawn(async move {
            let _slot = slot;
            resume_one(&db, &manager, &emitter, &data_dir, candidate).await;
        });
    }
    while running.join_next().await.is_some() {}
    tracing::info!("[auto-resume] done");
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
    candidate: DbConversationSummary,
) {
    let cid = candidate.id;
    if STOP.load(Ordering::SeqCst) {
        return;
    }
    match conversation_service::claim_auto_resume(&db.conn, cid).await {
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
    candidate: &DbConversationSummary,
) -> Result<Outcome, String> {
    let agent_type = candidate.agent_type;
    let session_id = candidate
        .external_id
        .clone()
        .ok_or_else(|| "the conversation has no agent session".to_string())?;
    let folder = folder_service::get_folder_by_id(&db.conn, candidate.folder_id)
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

    // A tab that already reopened this session owns that connection: share
    // it, and never tear it down on its behalf.
    let working_dir = PathBuf::from(&folder.path);
    let shared = manager
        .find_connection_for_reuse(agent_type, Some(&working_dir), Some(session_id.as_str()))
        .await
        .is_some();
    let conn_id = manager
        .spawn_agent_detached(
            agent_type,
            Some(folder.path.clone()),
            Some(session_id.clone()),
            runtime_env,
            OWNER_LABEL.to_string(),
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

    if STOP.load(Ordering::SeqCst) {
        // Reopened but not prompted: an idle connection, which the idle sweep
        // reaps unless a tab picks it up.
        return Ok(Outcome::Stopped);
    }

    let blocks = vec![PromptInputBlock::Text {
        text: RESUME_AFTER_RESTART_PROMPT.to_string(),
    }];
    let message_id = format!("auto-resume-{}", uuid::Uuid::new_v4());
    match manager
        .send_prompt_linked_with_message_id(
            db,
            &conn_id,
            blocks,
            Some(candidate.folder_id),
            Some(candidate.id),
            None,
            Some(message_id),
        )
        .await
    {
        Ok(_) => Ok(Outcome::Resumed),
        // A turn is already running on it — someone continued it by hand in
        // the moment between the claim and now.
        Err(AcpError::TurnInProgress) => Ok(Outcome::Skipped),
        Err(e) => Err(e.to_string()),
    }
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
    use crate::db::entities::conversation::{
        self, ConversationAutoResume, ConversationKind, ConversationTurnState,
    };
    use crate::db::service::conversation_service::{
        claim_auto_resume, clear_spent_auto_resume, discard_pending_auto_resumes, finish_turn,
        interrupt_orphaned_turns, list_auto_resume_candidates, mark_turn_cancelled_by_user,
        mark_turn_interrupted, mark_turn_running, release_auto_resume,
    };
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
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
            .map(|c| c.id)
            .collect()
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

    #[test]
    fn the_setting_off_plans_nothing() {
        let summary = |id: i32, agent_type: AgentType| DbConversationSummary {
            agent_type,
            ..sample_summary(id)
        };
        let candidates = vec![
            summary(1, AgentType::ClaudeCode),
            summary(2, AgentType::Codex),
            summary(3, AgentType::Pi),
            summary(4, AgentType::Cline),
        ];
        assert!(
            plan_auto_resume(AutoResumeSettings { enabled: false }, candidates.clone()).is_empty()
        );
        let planned: Vec<i32> = plan_auto_resume(AutoResumeSettings::default(), candidates)
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(
            planned,
            vec![1, 2, 3],
            "every agent that reopens sessions, in order"
        );
    }

    #[tokio::test]
    async fn with_the_setting_off_nothing_resumes_and_the_mark_is_dropped() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/auto-resume-off").await;
        let id = session(&db, folder, "off").await;
        cut_off_by_exit(&db, id).await;
        save_auto_resume_settings(&db.conn, AutoResumeSettings { enabled: false })
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
        assert!(load_auto_resume_settings(&db.conn).await.enabled);
    }

    #[test]
    fn the_frontend_matches_the_same_prompt() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/auto-resume.ts");
        let Ok(source) = std::fs::read_to_string(path) else {
            // Built outside the repository (a packaged source tree): nothing to compare.
            return;
        };
        assert!(
            source.contains(&format!("\"{RESUME_AFTER_RESTART_PROMPT}\"")),
            "src/lib/auto-resume.ts must carry RESUME_AFTER_RESTART_PROMPT verbatim"
        );
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
            pin_order: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
            origin_cwd: None,
            turn_state: Some(ConversationTurnState::Interrupted),
            critical: false,
            critical_stall: true,
        }
    }
}
