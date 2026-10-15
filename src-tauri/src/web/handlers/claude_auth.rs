use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::claude_auth::{ClaudeAuthStatus, ClaudeLoginStart, LoginOutcome, LoginState};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::claude_auth as commands;

fn failed(e: impl std::fmt::Display) -> AppCommandError {
    AppCommandError::task_execution_failed(e.to_string())
}

pub async fn claude_auth_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ClaudeAuthStatus>, AppCommandError> {
    commands::claude_auth_status_core(&state.db, &state.data_dir)
        .await
        .map(Json)
        .map_err(failed)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartParams {
    #[serde(default)]
    pub console: Option<bool>,
}

pub async fn claude_auth_login_start(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<LoginStartParams>,
) -> Result<Json<ClaudeLoginStart>, AppCommandError> {
    commands::claude_auth_login_start_core(
        &state.db,
        &state.data_dir,
        params.console.unwrap_or(false),
    )
    .await
    .map(Json)
    .map_err(failed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginFinishParams {
    pub handle: String,
    pub code: String,
}

pub async fn claude_auth_login_finish(
    Json(params): Json<LoginFinishParams>,
) -> Result<Json<LoginOutcome>, AppCommandError> {
    Ok(Json(
        commands::claude_auth_login_finish_core(params.handle, params.code).await,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginHandleParams {
    pub handle: String,
}

pub async fn claude_auth_login_state(
    Json(params): Json<LoginHandleParams>,
) -> Result<Json<LoginState>, AppCommandError> {
    Ok(Json(
        commands::claude_auth_login_state_core(params.handle).await,
    ))
}

pub async fn claude_auth_login_cancel(
    Json(params): Json<LoginHandleParams>,
) -> Result<Json<()>, AppCommandError> {
    commands::claude_auth_login_cancel_core(params.handle).await;
    Ok(Json(()))
}

pub async fn claude_auth_logout(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    commands::claude_auth_logout_core(&state.db, &state.data_dir)
        .await
        .map(Json)
        .map_err(failed)
}
