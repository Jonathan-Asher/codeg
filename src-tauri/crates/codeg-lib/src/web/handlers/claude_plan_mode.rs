//! Web-mode handlers for Claude Code's plan-mode settings
//! (`acp::claude_plan_mode`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::claude_plan_mode::{
    load_claude_plan_settings, save_claude_plan_settings, ClaudePlanSettings,
};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;

/// Frontend sends `{ settings: <T> }`, which Tauri `invoke()` unwraps; in web
/// mode the whole body arrives as-is.
#[derive(Deserialize)]
pub struct UpdateClaudePlanSettingsParams {
    pub settings: ClaudePlanSettings,
}

pub async fn get_claude_plan_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ClaudePlanSettings>, AppCommandError> {
    Ok(Json(load_claude_plan_settings(&state.db.conn).await))
}

pub async fn update_claude_plan_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateClaudePlanSettingsParams>,
) -> Result<Json<ClaudePlanSettings>, AppCommandError> {
    save_claude_plan_settings(&state.db.conn, params.settings)
        .await
        .map(Json)
}
