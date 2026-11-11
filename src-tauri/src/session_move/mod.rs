//! Moving a session to another project, with all its related files.
//!
//! A session belongs to a project through `conversation.folder_id`, and every
//! reopen connects in that folder. A move therefore changes more than the row:
//!
//! * **The agent's own files** move where the agent keyed them by folder
//!   ([`relocate`]): Claude Code's transcript, its sub-agent folder and the
//!   transcripts `/clear` rolled over to; pi's session file and its header.
//!   Codex and OpenClaw keep nothing keyed by the folder and resume in the new
//!   one as they are. Every other agent — Gemini and OpenCode, whose stores are
//!   tied to the project; Cline, which codeg never resumes; the rest, whose
//!   stores codeg does not know — is moved **listed only**: the row is filed
//!   under the new project, and the agent keeps running in the folder it ran
//!   in (`origin_cwd`, which `working_dir` then names). So is a Claude Code
//!   session whose adapter predates the relocation record, or whose transcript
//!   is not where Claude Code keeps it. A dry run says which before anything
//!   changes.
//! * **The agent is told once**: the first message after a full move carries a
//!   one-line note naming the old and the new folder (`acp::move_frame`,
//!   pending in `conversation.moved_from_cwd`). Nothing else the agent has
//!   changes — the prompt cache restarts once, because the working directory
//!   and the project's instructions do.
//! * **codeg's own records follow**: the delegation sub-sessions it started in
//!   the same folder (with their files), its open tabs, the chat-channel
//!   senders on it, its git branch. Uploaded attachments live under codeg's
//!   uploads root, not the project, so their links keep working untouched.
//!
//! **Refused** while anything could still be writing the session: a reply
//! running (or background work in its connection), an automatic resume or a
//! usage-limit continuation pending, Claude Code running it outside codeg.
//! Also refused: chat sessions, sub-sessions (they move with their parent),
//! and sessions a work task drives. An idle connection is closed first, and
//! new connections wait until the move is over.
//!
//! Order: guards, close, files, then the database — written last, so a
//! failure anywhere before it puts the files back and changes nothing.

pub mod relocate;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::RwLock;

use crate::acp::manager::{ConnectionManager, HeldConnection};
use crate::acp::session_state::SessionState;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::conversation::{
    self, ConversationAutoResume, ConversationKind, ConversationTurnState,
};
use crate::db::entities::folder::{self, FolderKind};
use crate::db::service::conversation_service::{self, RowMove};
use crate::db::service::{folder_service, sender_context_service, tab_service, work_task_service};
use crate::db::AppDatabase;
use crate::models::{AgentType, DbConversationSummary};
use crate::web::event_bridge::EventEmitter;
use relocate::{ClaudeRoots, PiRoots, Plan};

/// How far a move took the agent's own files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveMode {
    /// Everything moved: the agent continues in the new project's folder.
    Full,
    /// Only the row moved: the agent keeps running in the folder it ran in.
    ListedOnly,
}

/// Why a move is listed only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListedOnlyReason {
    /// codeg cannot move this agent's session files safely: Gemini and
    /// OpenCode tie them to the project, codeg never resumes Cline, and the
    /// other agents' stores are not known to it.
    AgentUnsupported,
    /// The installed Claude adapter predates the relocation record.
    ClaudeAdapterOutdated,
    /// The session's files are not where the agent keeps them.
    SessionFilesNotFound,
}

/// What `move_conversation_to_folder` answers.
#[derive(Debug, Clone, Serialize)]
pub struct MoveConversationResult {
    /// The conversation as it is now (unchanged after a dry run).
    pub conversation: DbConversationSummary,
    pub mode: MoveMode,
    /// Set with `mode = listed_only`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ListedOnlyReason>,
    /// The delegation sub-sessions that moved (or would move) with it.
    pub moved_children: Vec<i32>,
    /// Nothing was changed: the answer says what a move would do.
    pub dry_run: bool,
}

/// Why a move was refused. [`MoveRefusal::code`] is the stable code a client
/// maps (it travels as the error's `detail`; `i18n_key` is
/// `errors.<code>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveRefusal {
    ConversationNotFound,
    FolderNotFound,
    SameFolder,
    ChatConversation,
    ChatFolder,
    Subsession,
    UnsupportedConversation,
    WorkTaskLinked,
    ConversationRunning,
    ResumePending,
    RunningElsewhere,
    SessionClosing,
    MoveFailed,
}

impl MoveRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::ConversationNotFound => "conversation_not_found",
            Self::FolderNotFound => "folder_not_found",
            Self::SameFolder => "same_folder",
            Self::ChatConversation => "chat_conversation",
            Self::ChatFolder => "chat_folder",
            Self::Subsession => "subsession",
            Self::UnsupportedConversation => "unsupported_conversation",
            Self::WorkTaskLinked => "work_task_linked",
            Self::ConversationRunning => "conversation_running",
            Self::ResumePending => "resume_pending",
            Self::RunningElsewhere => "running_elsewhere",
            Self::SessionClosing => "session_closing",
            Self::MoveFailed => "move_failed",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::ConversationNotFound => "The session no longer exists.",
            Self::FolderNotFound => "The project is not in the workspace any more.",
            Self::SameFolder => "The session is already in that project.",
            Self::ChatConversation => "Chat sessions have no project to move from.",
            Self::ChatFolder => "A session cannot be moved into a chat.",
            Self::Subsession => "A sub-session moves with the session that started it.",
            Self::UnsupportedConversation => "This kind of session cannot be moved.",
            Self::WorkTaskLinked => {
                "A work task runs this session; it stays with the task's project."
            }
            Self::ConversationRunning => {
                "The session is working. Move it once its reply has finished."
            }
            Self::ResumePending => {
                "The session is about to continue by itself. Move it once that is done, or \
                 turn its automatic continuation off."
            }
            Self::RunningElsewhere => {
                "Claude Code is running this session outside codeg. Move it once that process \
                 has finished."
            }
            Self::SessionClosing => "The session's agent is still closing. Try again in a moment.",
            Self::MoveFailed => "The session's files could not be moved; nothing was changed.",
        }
    }

    fn app_code(self) -> AppErrorCode {
        match self {
            Self::ConversationNotFound | Self::FolderNotFound => AppErrorCode::NotFound,
            Self::ConversationRunning | Self::ResumePending | Self::SessionClosing => {
                AppErrorCode::TurnInProgress
            }
            Self::RunningElsewhere => AppErrorCode::SessionRunningElsewhere,
            Self::MoveFailed => AppErrorCode::IoError,
            Self::SameFolder
            | Self::ChatConversation
            | Self::ChatFolder
            | Self::Subsession
            | Self::UnsupportedConversation
            | Self::WorkTaskLinked => AppErrorCode::InvalidInput,
        }
    }

    pub fn into_error(self) -> AppCommandError {
        self.error_with(None)
    }

    fn error_with(self, cause: Option<String>) -> AppCommandError {
        let message = match cause {
            Some(cause) => format!("{} ({cause})", self.message()),
            None => self.message().to_string(),
        };
        AppCommandError::new(self.app_code(), message)
            .with_detail(self.code())
            .with_i18n(format!("errors.{}", self.code()), BTreeMap::new())
    }
}

impl From<MoveRefusal> for AppCommandError {
    fn from(refusal: MoveRefusal) -> Self {
        refusal.into_error()
    }
}

/// Whether the installed Claude adapter reads the relocation record.
#[derive(Debug, Clone, Copy)]
pub enum ClaudeSupport {
    /// Look at the adapter codeg would launch ([`relocate::claude_relocation_support`]).
    Probe,
    /// Known (tests).
    Known(Option<bool>),
}

/// Where a move finds the agents' files, and how it waits.
#[derive(Debug, Clone)]
pub struct MoveEnv {
    pub claude: ClaudeRoots,
    /// What a Claude Code launch's environment says (`CLAUDE_CONFIG_DIR`):
    /// the registry the outside-writer check reads.
    pub claude_runtime_env: BTreeMap<String, String>,
    pub pi: PiRoots,
    pub claude_support: ClaudeSupport,
    /// How long a closed connection's agent may take to exit.
    pub close_timeout: Duration,
    /// Consult Claude Code's live-session registry (a test with none skips it).
    pub check_registry: bool,
}

impl MoveEnv {
    /// The roots the agents use, from their launch environment (the agent's
    /// settings) over codeg's own.
    pub async fn resolve(db: &AppDatabase, data_dir: &Path) -> Self {
        let launch_env = |agent: AgentType| async move {
            crate::commands::acp::build_session_runtime_env(db, agent, None, data_dir)
                .await
                .unwrap_or_default()
        };
        let claude_env = launch_env(AgentType::ClaudeCode).await;
        let pi_env = launch_env(AgentType::Pi).await;

        let config_dir = crate::acp::outside_writer::launch_config_dir(&claude_env)
            .unwrap_or_else(crate::parsers::claude::resolve_claude_config_dir);
        #[cfg(unix)]
        let temp_root = Some(
            match claude_env
                .get("CLAUDE_CODE_TMPDIR")
                .map(|dir| dir.trim())
                .filter(|dir| !dir.is_empty())
            {
                Some(base) => std::path::PathBuf::from(base)
                    .join(format!("claude-{}", unsafe { libc::getuid() })),
                None => crate::commands::quick_ask::claude_temp_root(),
            },
        );
        #[cfg(not(unix))]
        let temp_root = None;

        let env_or_process = |name: &str| {
            pi_env
                .get(name)
                .map(std::ffi::OsString::from)
                .or_else(|| std::env::var_os(name))
        };
        let sessions_dir = crate::parsers::pi::resolve_pi_sessions_dir_from(
            env_or_process("PI_CODING_AGENT_SESSION_DIR"),
            env_or_process("PI_CODING_AGENT_DIR"),
            dirs::home_dir(),
        );
        let session_map = dirs::home_dir()
            .map(|home| home.join(".pi").join("pi-acp").join("session-map.json"))
            .filter(|path| path.is_file());

        Self {
            claude: ClaudeRoots {
                config_dir,
                temp_root,
            },
            claude_runtime_env: claude_env,
            pi: PiRoots {
                sessions_dir,
                session_map,
            },
            claude_support: ClaudeSupport::Probe,
            close_timeout: Duration::from_secs(5),
            check_registry: true,
        }
    }
}

/// Move `conversation_id` to the project `folder_id` (see the module docs),
/// or with `dry_run` only say what a move would do. Broadcasts every row it
/// changed, the tabs it re-filed, and the target folder if it had to open it.
pub async fn move_conversation_to_folder_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    manager: &ConnectionManager,
    data_dir: &Path,
    conversation_id: i32,
    folder_id: i32,
    dry_run: bool,
) -> Result<MoveConversationResult, AppCommandError> {
    let env = MoveEnv::resolve(db, data_dir).await;
    move_conversation_with(
        db,
        emitter,
        manager,
        &env,
        conversation_id,
        folder_id,
        dry_run,
    )
    .await
}

/// One row a move takes along.
struct Item {
    row: conversation::Model,
    agent: AgentType,
    /// Where the agent runs it now.
    old_dir: String,
    mode: MoveMode,
    reason: Option<ListedOnlyReason>,
    plan: Plan,
    held: Vec<HeldConnection>,
}

/// [`move_conversation_to_folder_core`] with the roots given.
pub async fn move_conversation_with(
    db: &AppDatabase,
    emitter: &EventEmitter,
    manager: &ConnectionManager,
    env: &MoveEnv,
    conversation_id: i32,
    folder_id: i32,
    dry_run: bool,
) -> Result<MoveConversationResult, AppCommandError> {
    // No connection may open while files move: one opened in the old folder
    // would resume a transcript that is about to leave it. Taken before
    // anything is read, so two moves of one session run one after the
    // other. A dry run changes nothing and holds nothing.
    let _lockout = if dry_run {
        None
    } else {
        Some(manager.lock_out_new_connections().await)
    };
    let conn = &db.conn;

    let root = conversation_service::find_live_row(conn, conversation_id)
        .await?
        .ok_or(MoveRefusal::ConversationNotFound)?;
    let target = folder_service::get_folder_by_id(conn, folder_id)
        .await?
        .ok_or(MoveRefusal::FolderNotFound)?;
    if target.kind == FolderKind::Chat {
        return Err(MoveRefusal::ChatFolder.into());
    }
    match root.kind {
        ConversationKind::Regular => {}
        ConversationKind::Chat => return Err(MoveRefusal::ChatConversation.into()),
        ConversationKind::Delegate => return Err(MoveRefusal::Subsession.into()),
        ConversationKind::Loop => return Err(MoveRefusal::UnsupportedConversation.into()),
    }
    if root.parent_id.is_some() {
        return Err(MoveRefusal::Subsession.into());
    }
    // Its folder as stored, even one removed from the workspace since.
    use sea_orm::EntityTrait;
    let current = folder::Entity::find_by_id(root.folder_id)
        .one(conn)
        .await
        .map_err(|e| {
            AppCommandError::database_error("Database operation failed").with_detail(e.to_string())
        })?
        .ok_or(MoveRefusal::ConversationNotFound)?;
    if current.kind == FolderKind::Chat {
        return Err(MoveRefusal::ChatConversation.into());
    }
    if root.folder_id == folder_id {
        return Err(MoveRefusal::SameFolder.into());
    }
    if work_task_service::conversation_has_live_task(conn, root.id).await? {
        return Err(MoveRefusal::WorkTaskLinked.into());
    }

    // The sub-sessions it started in the same folder move with it; one
    // filed under another folder stays where it is, with its own subtree.
    let mut rows = vec![root.clone()];
    let mut queue = vec![root.id];
    while let Some(parent) = queue.pop() {
        for child in conversation_service::list_live_child_rows(conn, parent).await? {
            if child.folder_id == root.folder_id && !rows.iter().any(|r| r.id == child.id) {
                queue.push(child.id);
                rows.push(child);
            }
        }
    }

    let limit_continue_on = crate::acp::limit_continue::load_limit_continue_settings(conn)
        .await
        .enabled;
    for row in &rows {
        refuse_if_pending(row, limit_continue_on)?;
    }

    let new_dir = target.path.clone();
    let mut claude_support: Option<Option<bool>> = None;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let agent = conversation_service::parse_agent_type(&row.agent_type);
        let old_dir =
            conversation_service::effective_working_dir(row.origin_cwd.as_deref(), &current.path);
        let (mode, reason, plan) = plan_files(
            env,
            &mut claude_support,
            agent,
            row.external_id.as_deref(),
            &new_dir,
        )
        .await;
        items.push(Item {
            row,
            agent,
            old_dir,
            mode,
            reason,
            plan,
            held: Vec::new(),
        });
    }

    for item in &mut items {
        item.held = manager
            .connections_holding_conversation(
                item.row.id,
                item.agent,
                item.row.external_id.as_deref(),
            )
            .await;
        if item.held.iter().any(|held| held.busy) {
            return Err(MoveRefusal::ConversationRunning.into());
        }
        if item.agent == AgentType::ClaudeCode && env.check_registry {
            if let Some(session_id) = item.row.external_id.as_deref() {
                if manager
                    .outside_writer_of(AgentType::ClaudeCode, session_id, &env.claude_runtime_env)
                    .await
                    .is_some()
                {
                    return Err(MoveRefusal::RunningElsewhere.into());
                }
            }
        }
    }

    let root_id = items[0].row.id;
    let (root_mode, root_reason) = (items[0].mode, items[0].reason);
    let moved_children: Vec<i32> = items.iter().skip(1).map(|item| item.row.id).collect();
    if dry_run {
        return Ok(MoveConversationResult {
            conversation: conversation_service::get_by_id(conn, root_id).await?,
            mode: root_mode,
            reason: root_reason,
            moved_children,
            dry_run: true,
        });
    }

    // Close what holds it open, and wait until nothing runs it any more.
    for item in &items {
        for held in &item.held {
            if !manager.disconnect_and_wait(held, env.close_timeout).await {
                return Err(MoveRefusal::SessionClosing.into());
            }
        }
        if item.agent == AgentType::ClaudeCode && env.check_registry {
            if let Some(session_id) = item.row.external_id.as_deref() {
                if !wait_until_unregistered(env, session_id).await {
                    return Err(MoveRefusal::SessionClosing.into());
                }
            }
        }
    }

    let branch = if items.iter().any(|item| item.mode == MoveMode::Full) {
        Some(crate::commands::conversations::detect_git_branch(&new_dir).await)
    } else {
        None
    };

    let plans: Vec<Plan> = items.iter().map(|item| item.plan.clone()).collect();
    let applied = tokio::task::spawn_blocking(move || relocate::apply_all(&plans))
        .await
        .map_err(|e| MoveRefusal::MoveFailed.error_with(Some(e.to_string())))?
        .map_err(|e| {
            tracing::warn!("[session-move] conversation {root_id}: files not moved: {e}");
            MoveRefusal::MoveFailed.error_with(Some(e.to_string()))
        })?;

    let moves: Vec<RowMove> = items
        .iter()
        .map(|item| row_move(item, folder_id, &new_dir, branch.as_ref()))
        .collect();
    if let Err(e) = conversation_service::move_rows_to_folder(conn, &moves).await {
        tracing::error!(
            "[session-move] conversation {root_id}: rows not written ({e}); files put back"
        );
        let _ = tokio::task::spawn_blocking(move || applied.rollback()).await;
        return Err(AppCommandError::from(e));
    }
    applied.commit();
    tracing::info!(
        "[session-move] conversation {root_id} moved to folder {folder_id} ({:?}{}), with {} \
         sub-session(s)",
        root_mode,
        root_reason.map(|r| format!(", {r:?}")).unwrap_or_default(),
        moved_children.len()
    );

    let ids: Vec<i32> = items.iter().map(|item| item.row.id).collect();
    follow_up(db, emitter, &ids, folder_id).await;

    Ok(MoveConversationResult {
        conversation: conversation_service::get_by_id(conn, root_id).await?,
        mode: root_mode,
        reason: root_reason,
        moved_children,
        dry_run: false,
    })
}

/// Refuse a row that something is about to continue by itself.
fn refuse_if_pending(
    row: &conversation::Model,
    limit_continue_on: bool,
) -> Result<(), MoveRefusal> {
    if row.turn_state == Some(ConversationTurnState::Running) {
        return Err(MoveRefusal::ConversationRunning);
    }
    if matches!(
        row.auto_resume,
        Some(ConversationAutoResume::Pending | ConversationAutoResume::Claimed)
    ) {
        return Err(MoveRefusal::ResumePending);
    }
    if row.limit_resume_state.is_some() && row.limit_auto_continue && limit_continue_on {
        return Err(MoveRefusal::ResumePending);
    }
    Ok(())
}

/// What a move does with an agent's files.
async fn plan_files(
    env: &MoveEnv,
    claude_support: &mut Option<Option<bool>>,
    agent: AgentType,
    session_id: Option<&str>,
    new_dir: &str,
) -> (MoveMode, Option<ListedOnlyReason>, Plan) {
    let full = |plan| (MoveMode::Full, None, plan);
    let listed = |reason| (MoveMode::ListedOnly, Some(reason), Plan::Nothing);
    match agent {
        AgentType::Codex | AgentType::OpenClaw => full(Plan::Nothing),
        AgentType::ClaudeCode => {
            let Some(session_id) = session_id else {
                return full(Plan::Nothing);
            };
            let support = match *claude_support {
                Some(known) => known,
                None => {
                    let probed = match env.claude_support {
                        ClaudeSupport::Known(known) => known,
                        ClaudeSupport::Probe => relocate::claude_relocation_support().await,
                    };
                    *claude_support = Some(probed);
                    probed
                }
            };
            if support == Some(false) {
                return listed(ListedOnlyReason::ClaudeAdapterOutdated);
            }
            let roots = env.claude.clone();
            let (session_id, new_dir) = (session_id.to_string(), new_dir.to_string());
            match tokio::task::spawn_blocking(move || {
                relocate::plan_claude(&roots, &session_id, &new_dir)
            })
            .await
            .ok()
            .flatten()
            {
                Some(plan) => full(Plan::Claude(plan)),
                None => listed(ListedOnlyReason::SessionFilesNotFound),
            }
        }
        AgentType::Pi => {
            let Some(session_id) = session_id else {
                return full(Plan::Nothing);
            };
            let roots = env.pi.clone();
            let (session_id, new_dir) = (session_id.to_string(), new_dir.to_string());
            match tokio::task::spawn_blocking(move || {
                relocate::plan_pi(&roots, &session_id, &new_dir)
            })
            .await
            .ok()
            .flatten()
            {
                Some(plan) => full(Plan::Pi(plan)),
                None => listed(ListedOnlyReason::SessionFilesNotFound),
            }
        }
        _ => listed(ListedOnlyReason::AgentUnsupported),
    }
}

/// Two directory paths name the same place (a trailing separator aside, or
/// through a symlink).
fn same_dir(a: &str, b: &str) -> bool {
    let trim = |p: &str| p.trim_end_matches(['/', '\\']).to_string();
    if trim(a) == trim(b) {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The row's new place.
fn row_move(
    item: &Item,
    folder_id: i32,
    new_dir: &str,
    branch: Option<&Option<String>>,
) -> RowMove {
    match item.mode {
        MoveMode::Full => {
            // The agent ran it somewhere: it hears about the move with its
            // next message. A note still pending from an earlier move keeps
            // its own starting point; a move back there before the agent
            // heard anything needs none.
            let moved_from_cwd = item.row.external_id.as_ref().and_then(|_| {
                let from = item
                    .row
                    .moved_from_cwd
                    .clone()
                    .unwrap_or_else(|| item.old_dir.clone());
                (!same_dir(&from, new_dir)).then_some(from)
            });
            RowMove {
                conversation_id: item.row.id,
                folder_id,
                origin_cwd: None,
                git_branch: branch.cloned(),
                moved_from_cwd,
            }
        }
        MoveMode::ListedOnly => RowMove {
            conversation_id: item.row.id,
            folder_id,
            // It keeps running where it ran; moving it back there clears
            // the note.
            origin_cwd: (!same_dir(&item.old_dir, new_dir)).then(|| item.old_dir.clone()),
            git_branch: None,
            moved_from_cwd: item.row.moved_from_cwd.clone(),
        },
    }
}

/// Wait until no live process runs Claude Code session `session_id` — the
/// adapter's CLI, which outlives the adapter by a moment — so nothing writes
/// its transcript once it moved. `false` when one still does at the close
/// timeout.
async fn wait_until_unregistered(env: &MoveEnv, session_id: &str) -> bool {
    let sessions = crate::acp::outside_writer::launch_config_dir(&env.claude_runtime_env)
        .unwrap_or_else(|| env.claude.config_dir.clone())
        .join("sessions");
    let deadline = tokio::time::Instant::now() + env.close_timeout;
    let session_id = session_id.to_string();
    loop {
        let (sessions, session_id_now) = (sessions.clone(), session_id.clone());
        let running = tokio::task::spawn_blocking(move || {
            let records = crate::acp::outside_writer::read_registry(&sessions);
            crate::acp::outside_writer::outside_writer_for(
                &records,
                &session_id_now,
                &std::collections::HashSet::new(),
                &crate::acp::outside_writer::SystemProbe,
            )
            .is_some()
        })
        .await
        .unwrap_or(false);
        if !running {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Everything that follows a move once the rows are written: tabs, the
/// chat-channel senders, the target folder, and the broadcasts.
async fn follow_up(db: &AppDatabase, emitter: &EventEmitter, ids: &[i32], folder_id: i32) {
    let conn = &db.conn;
    match tab_service::move_conversation_tabs_and_bump(conn, ids, folder_id).await {
        Ok(moved) => {
            if let Some(tabs) = moved.emit {
                crate::commands::conversations::emit_tabs_changed(
                    emitter,
                    moved.version,
                    tabs,
                    "server".to_string(),
                );
            }
        }
        Err(e) => tracing::error!("[session-move] tabs not re-filed: {e}"),
    }
    if let Err(e) =
        sender_context_service::retarget_folder_for_conversations(conn, ids, folder_id).await
    {
        tracing::warn!("[session-move] chat-channel senders not re-pointed: {e}");
    }
    // A move into a folder closed meanwhile opens it, or the session would
    // vanish from every list.
    if matches!(
        folder_service::get_open_folder_by_id(conn, folder_id).await,
        Ok(None)
    ) {
        if let Err(e) = folder_service::set_folder_open(conn, folder_id, true).await {
            tracing::warn!("[session-move] target folder not opened: {e}");
        } else if let Ok(Some(detail)) = folder_service::get_folder_by_id(conn, folder_id).await {
            crate::commands::folders::emit_folder_upsert(emitter, detail);
        }
    }
    for id in ids {
        crate::commands::conversations::emit_conversation_upsert(emitter, conn, *id).await;
    }
}

// ─── The note to the agent ────────────────────────────────────────────────

/// The move note a message is about to carry (see [`pending_note`]).
#[derive(Debug, Clone)]
pub struct PendingNote {
    /// The directory the note says the session moved from.
    pub from: String,
    /// The rendered frame (`acp::move_frame`).
    pub frame: String,
}

/// The note the next message on `session` must carry, if the conversation
/// moved with its files and the agent has not been told: from the directory
/// it ran in to the one this connection runs it in. `None` when nothing is
/// pending, or when this connection still runs it in the old directory (a
/// client that opened it there) — the note would be false, and it waits for
/// a connection in the new one. Best-effort: a database error sends nothing.
pub async fn pending_note(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
    session: &Arc<RwLock<SessionState>>,
) -> Option<PendingNote> {
    let from = match conversation_service::take_move_note_from(conn, conversation_id).await {
        Ok(from) => from?,
        Err(e) => {
            tracing::warn!(
                conversation_id,
                "[session-move] failed to read the move note: {e}"
            );
            return None;
        }
    };
    let to = session
        .read()
        .await
        .working_dir
        .as_ref()
        .map(|dir| dir.to_string_lossy().to_string())?;
    if same_dir(&from, &to) {
        return None;
    }
    let frame = crate::acp::move_frame::render(&crate::acp::move_frame::note(&from, &to));
    Some(PendingNote { from, frame })
}

/// The note reached the agent: clear it (only if no later move replaced it).
pub async fn note_delivered(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
    note: &PendingNote,
) {
    if let Err(e) = conversation_service::clear_move_note(conn, conversation_id, &note.from).await {
        tracing::warn!(
            conversation_id,
            "[session-move] failed to clear the move note: {e}"
        );
    }
}
