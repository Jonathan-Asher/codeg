//! Desktop command for moving a session to another project
//! (`crate::session_move`). The web handler in `web/handlers/session_move.rs`
//! calls the same function.

use tauri::{Manager, State};

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::session_move::{move_conversation_to_folder_core, MoveConversationResult};
use crate::web::event_bridge::EventEmitter;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn move_conversation_to_folder(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
    conversation_id: i32,
    folder_id: i32,
    dry_run: Option<bool>,
) -> Result<MoveConversationResult, AppCommandError> {
    // The agents' launch environment is resolved through the effective data
    // dir, as `acp_connect` resolves it.
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    move_conversation_to_folder_core(
        &db,
        &EventEmitter::Tauri(app),
        &manager,
        &data_dir,
        conversation_id,
        folder_id,
        dry_run.unwrap_or(false),
    )
    .await
}
