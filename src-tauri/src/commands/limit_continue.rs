//! Desktop commands for the continuation after the usage limit resets
//! (`acp::limit_continue`): its on/off setting, a paused session's Cancel and
//! Continue now, and the per-session switch. The web handlers in
//! `web/handlers/limit_continue.rs` call the same functions.

use tauri::State;

use crate::acp::limit_continue::{
    cancel_limit_continue_core, continue_limit_now_core, load_limit_continue_settings,
    save_limit_continue_settings, update_limit_auto_continue_core, LimitContinueSettings,
};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_limit_continue_settings(
    db: State<'_, AppDatabase>,
) -> Result<LimitContinueSettings, AppCommandError> {
    Ok(load_limit_continue_settings(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_limit_continue_settings(
    app: tauri::AppHandle,
    settings: LimitContinueSettings,
    db: State<'_, AppDatabase>,
) -> Result<LimitContinueSettings, AppCommandError> {
    save_limit_continue_settings(&db.conn, &EventEmitter::Tauri(app), settings).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn cancel_limit_continue(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<bool, AppCommandError> {
    cancel_limit_continue_core(&db.conn, &EventEmitter::Tauri(app), conversation_id).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn continue_limit_now(
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<bool, AppCommandError> {
    continue_limit_now_core(&db.conn, conversation_id).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_conversation_limit_auto_continue(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    enabled: bool,
) -> Result<(), AppCommandError> {
    update_limit_auto_continue_core(
        &db.conn,
        &EventEmitter::Tauri(app),
        conversation_id,
        enabled,
    )
    .await
}
