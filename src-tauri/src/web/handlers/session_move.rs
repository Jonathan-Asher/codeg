//! Web-mode handler for moving a session to another project
//! (`crate::session_move`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::session_move::{move_conversation_to_folder_core, MoveConversationResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveConversationToFolderParams {
    pub conversation_id: i32,
    pub folder_id: i32,
    /// Only say what a move would do (mode, reason, refusal); change nothing.
    #[serde(default)]
    pub dry_run: bool,
}

pub async fn move_conversation_to_folder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MoveConversationToFolderParams>,
) -> Result<Json<MoveConversationResult>, AppCommandError> {
    let result = move_conversation_to_folder_core(
        &state.db,
        &state.emitter,
        &state.connection_manager,
        &state.data_dir,
        params.conversation_id,
        params.folder_id,
        params.dry_run,
    )
    .await?;
    Ok(Json(result))
}
