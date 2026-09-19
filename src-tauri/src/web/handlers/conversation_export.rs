//! Web-mode handler for conversation Markdown export.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::conversation_export;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportMarkdownParams {
    pub conversation_id: i32,
}

pub async fn conversation_export_markdown(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationExportMarkdownParams>,
) -> Result<Json<String>, AppCommandError> {
    let path =
        conversation_export::conversation_export_markdown_core(&state.db.conn, params.conversation_id)
            .await?;
    Ok(Json(path))
}
