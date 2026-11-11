//! Web-mode handlers for critical sessions (`acp::critical_watch`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::critical_watch::{
    ack_critical_session_core, critical_alerts, load_critical_settings, save_critical_settings,
    set_conversation_critical_core, snooze_critical_session_core, CriticalAlertsSnapshot,
    CriticalSessionSettings,
};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationCriticalParams {
    pub conversation_id: i32,
    pub critical: bool,
    #[serde(default)]
    pub stall: Option<bool>,
}

pub async fn update_conversation_critical(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateConversationCriticalParams>,
) -> Result<Json<()>, AppCommandError> {
    set_conversation_critical_core(
        &state.db.conn,
        &state.emitter,
        params.conversation_id,
        params.critical,
        params.stall,
    )
    .await?;
    Ok(Json(()))
}

pub async fn get_critical_alerts() -> Result<Json<CriticalAlertsSnapshot>, AppCommandError> {
    Ok(Json(critical_alerts()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticalSessionParams {
    pub conversation_id: i32,
}

pub async fn ack_critical_session(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CriticalSessionParams>,
) -> Result<Json<CriticalAlertsSnapshot>, AppCommandError> {
    Ok(Json(ack_critical_session_core(
        &state.emitter,
        params.conversation_id,
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeCriticalSessionParams {
    pub conversation_id: i32,
    pub minutes: u32,
}

pub async fn snooze_critical_session(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SnoozeCriticalSessionParams>,
) -> Result<Json<CriticalAlertsSnapshot>, AppCommandError> {
    Ok(Json(snooze_critical_session_core(
        &state.emitter,
        params.conversation_id,
        params.minutes,
    )))
}

/// Frontend sends `{ settings: <T> }`, which Tauri `invoke()` unwraps; in web
/// mode the whole body arrives as-is.
#[derive(Deserialize)]
pub struct UpdateCriticalSessionSettingsParams {
    pub settings: CriticalSessionSettings,
}

pub async fn get_critical_session_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CriticalSessionSettings>, AppCommandError> {
    Ok(Json(load_critical_settings(&state.db.conn).await))
}

pub async fn update_critical_session_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateCriticalSessionSettingsParams>,
) -> Result<Json<CriticalSessionSettings>, AppCommandError> {
    save_critical_settings(&state.db.conn, params.settings)
        .await
        .map(Json)
}
