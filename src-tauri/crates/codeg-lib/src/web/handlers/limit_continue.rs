//! Web-mode handlers for the continuation after the usage limit resets
//! (`acp::limit_continue`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::limit_continue::{
    cancel_limit_continue_core, continue_limit_now_core, load_limit_continue_settings,
    save_limit_continue_settings, update_limit_auto_continue_core, LimitContinueSettings,
};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;

/// Frontend sends `{ settings: <T> }`, which Tauri `invoke()` unwraps; in web
/// mode the whole body arrives as-is.
#[derive(Deserialize)]
pub struct UpdateLimitContinueSettingsParams {
    pub settings: LimitContinueSettings,
}

pub async fn get_limit_continue_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<LimitContinueSettings>, AppCommandError> {
    Ok(Json(load_limit_continue_settings(&state.db.conn).await))
}

pub async fn update_limit_continue_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateLimitContinueSettingsParams>,
) -> Result<Json<LimitContinueSettings>, AppCommandError> {
    save_limit_continue_settings(&state.db.conn, &state.emitter, params.settings)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitContinueConversationParams {
    pub conversation_id: i32,
}

pub async fn cancel_limit_continue(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<LimitContinueConversationParams>,
) -> Result<Json<bool>, AppCommandError> {
    cancel_limit_continue_core(&state.db.conn, &state.emitter, params.conversation_id)
        .await
        .map(Json)
}

pub async fn continue_limit_now(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<LimitContinueConversationParams>,
) -> Result<Json<bool>, AppCommandError> {
    continue_limit_now_core(&state.db.conn, params.conversation_id)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLimitAutoContinueParams {
    pub conversation_id: i32,
    pub enabled: bool,
}

pub async fn update_conversation_limit_auto_continue(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateLimitAutoContinueParams>,
) -> Result<Json<()>, AppCommandError> {
    update_limit_auto_continue_core(
        &state.db.conn,
        &state.emitter,
        params.conversation_id,
        params.enabled,
    )
    .await?;
    Ok(Json(()))
}
