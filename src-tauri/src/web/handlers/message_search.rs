//! Web-mode handlers for the ⌘K message-content search (FTS5 index).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::message_search;
use crate::db::service::message_search::MessageSearchHit;

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
    let hits = message_search::message_search_core(&state.db.conn, params.query, params.limit).await?;
    Ok(Json(hits))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchIndexParams {
    pub conversation_id: i32,
}

pub async fn message_search_index_conversation(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MessageSearchIndexParams>,
) -> Result<Json<u32>, AppCommandError> {
    let written = message_search::message_search_index_conversation_core(
        &state.db.conn,
        params.conversation_id,
    )
    .await?;
    Ok(Json(written))
}
