//! Web-mode handlers for the automatic resume after a restart.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::auto_resume::{
    auto_resume_status, load_auto_resume_settings, save_auto_resume_settings,
    stop_auto_resume_core, AutoResumeSettings, AutoResumeStatus,
};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;

/// Frontend sends `{ settings: <T> }`, which Tauri `invoke()` unwraps; in web
/// mode the whole body arrives as-is.
#[derive(Deserialize)]
pub struct UpdateAutoResumeSettingsParams {
    pub settings: AutoResumeSettings,
}

pub async fn get_auto_resume_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AutoResumeSettings>, AppCommandError> {
    Ok(Json(load_auto_resume_settings(&state.db.conn).await))
}

pub async fn update_auto_resume_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateAutoResumeSettingsParams>,
) -> Result<Json<AutoResumeSettings>, AppCommandError> {
    save_auto_resume_settings(&state.db.conn, params.settings)
        .await
        .map(Json)
}

pub async fn get_auto_resume_status() -> Result<Json<AutoResumeStatus>, AppCommandError> {
    Ok(Json(auto_resume_status()))
}

pub async fn stop_auto_resume(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AutoResumeStatus>, AppCommandError> {
    Ok(Json(
        stop_auto_resume_core(&state.db.conn, &state.emitter).await,
    ))
}
