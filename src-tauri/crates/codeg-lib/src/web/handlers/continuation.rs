//! Web-mode handlers for "Continue in another agent"
//! (`acp::continuation`). Same functions as the desktop commands in
//! `commands/continuation.rs`.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::continuation::{build_mechanical_handoff_core, run_handoff_core, HandoffOutcome};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationParams {
    pub conversation_id: i32,
}

pub async fn continue_in_agent_handoff(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ContinuationParams>,
) -> Result<Json<HandoffOutcome>, AppCommandError> {
    run_handoff_core(
        &state.db,
        &state.connection_manager,
        &state.emitter,
        &state.data_dir,
        params.conversation_id,
    )
    .await
    .map(Json)
}

pub async fn build_mechanical_handoff(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ContinuationParams>,
) -> Result<Json<String>, AppCommandError> {
    build_mechanical_handoff_core(&state.db.conn, params.conversation_id)
        .await
        .map(Json)
}
