//! Web-mode handlers for Talk mode (`crate::talk`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::talk::{
    load_talk_settings, save_talk_settings, set_conversation_talk_mode_core, TalkSettings,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConversationTalkModeParams {
    pub conversation_id: i32,
    pub enabled: bool,
}

pub async fn set_conversation_talk_mode(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetConversationTalkModeParams>,
) -> Result<Json<()>, AppCommandError> {
    set_conversation_talk_mode_core(
        &state.db.conn,
        &state.emitter,
        &state.connection_manager,
        params.conversation_id,
        params.enabled,
    )
    .await?;
    Ok(Json(()))
}

pub async fn get_talk_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TalkSettings>, AppCommandError> {
    Ok(Json(load_talk_settings(&state.db.conn).await))
}

/// Frontend sends `{ settings: <T> }`, which Tauri `invoke()` unwraps; in web
/// mode the whole body arrives as-is.
#[derive(Deserialize)]
pub struct UpdateTalkSettingsParams {
    pub settings: TalkSettings,
}

pub async fn update_talk_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateTalkSettingsParams>,
) -> Result<Json<TalkSettings>, AppCommandError> {
    save_talk_settings(&state.db.conn, params.settings)
        .await
        .map(Json)
}
