use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::lost_history::{self, SavedHistoryExport};
use crate::commands::message_search as search_commands;
use crate::db::service::message_search_service::{MessageSearchHit, SavedTurn};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchParams {
    pub query: String,
    pub limit: Option<u32>,
}

pub async fn message_search(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MessageSearchParams>,
) -> Result<Json<Vec<MessageSearchHit>>, AppCommandError> {
    Ok(Json(
        search_commands::message_search_core(&state.db.conn, &params.query, params.limit).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTurnsParams {
    pub conversation_id: i32,
}

/// The text the message search kept of a conversation — what the read-only
/// view of a session whose history the agent deleted shows.
pub async fn get_conversation_saved_turns(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SavedTurnsParams>,
) -> Result<Json<Vec<SavedTurn>>, AppCommandError> {
    Ok(Json(
        lost_history::saved_turns_core(&state.db.conn, params.conversation_id).await?,
    ))
}

/// That text, ready to hand to a new session: inline when short, else written
/// to a file on this machine (where the agent runs) and handed over by path.
pub async fn export_conversation_saved_history(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SavedTurnsParams>,
) -> Result<Json<SavedHistoryExport>, AppCommandError> {
    Ok(Json(
        lost_history::export_saved_history_core(
            &state.db.conn,
            &state.data_dir,
            params.conversation_id,
        )
        .await?,
    ))
}
