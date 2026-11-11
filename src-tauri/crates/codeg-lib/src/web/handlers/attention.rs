//! Web-mode handler for the "waiting on you" snapshot.

use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::acp::background_status::ConversationBackgroundEntry;
use crate::commands::attention::{self, ConversationAttention};

pub async fn list_conversation_attention(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<ConversationAttention>>, AppCommandError> {
    attention::list_conversation_attention_core(&state.connection_manager, &state.db.conn)
        .await
        .map(Json)
}

/// Web-mode handler for the background-activity snapshot.
pub async fn list_conversation_background(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<ConversationBackgroundEntry>>, AppCommandError> {
    attention::list_conversation_background_core(&state.connection_manager)
        .await
        .map(Json)
}
