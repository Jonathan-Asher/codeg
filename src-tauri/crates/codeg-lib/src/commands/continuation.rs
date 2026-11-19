//! Desktop commands for "Continue in another agent" (`acp::continuation`):
//! the handoff the old session's agent writes, and the plain one codeg puts
//! together when it cannot. The web handlers in `web/handlers/continuation.rs`
//! call the same functions.

use tauri::{Manager, State};

use crate::acp::continuation::{build_mechanical_handoff_core, run_handoff_core, HandoffOutcome};
use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

/// Ask the conversation's agent for a handoff and wait until its turn ends.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn continue_in_agent_handoff(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
    conversation_id: i32,
) -> Result<HandoffOutcome, AppCommandError> {
    // Reopening the session resolves the agent's launch environment through
    // the effective data dir, as `acp_connect` does.
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    run_handoff_core(
        &db,
        &manager,
        &EventEmitter::from_app(&app),
        &data_dir,
        conversation_id,
    )
    .await
}

/// The plain handoff: the session's link, folder, branch, first message and
/// `git status --short`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn build_mechanical_handoff(
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<String, AppCommandError> {
    build_mechanical_handoff_core(&db.conn, conversation_id).await
}
