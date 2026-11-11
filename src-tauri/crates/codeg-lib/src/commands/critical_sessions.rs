//! Desktop commands for critical sessions (`acp::critical_watch`): marking a
//! conversation critical, the alerts waiting for an acknowledgement, ack and
//! snooze, and the settings. The web handlers in
//! `web/handlers/critical_sessions.rs` call the same functions.

use tauri::State;

use crate::acp::critical_watch::{
    ack_critical_session_core, critical_alerts, load_critical_settings, save_critical_settings,
    set_conversation_critical_core, snooze_critical_session_core, CriticalAlertsSnapshot,
    CriticalSessionSettings,
};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_conversation_critical(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    critical: bool,
    stall: Option<bool>,
) -> Result<(), AppCommandError> {
    set_conversation_critical_core(
        &db.conn,
        &EventEmitter::Tauri(app),
        conversation_id,
        critical,
        stall,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_critical_alerts() -> Result<CriticalAlertsSnapshot, AppCommandError> {
    Ok(critical_alerts())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn ack_critical_session(
    app: tauri::AppHandle,
    conversation_id: i32,
) -> Result<CriticalAlertsSnapshot, AppCommandError> {
    Ok(ack_critical_session_core(
        &EventEmitter::Tauri(app),
        conversation_id,
    ))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn snooze_critical_session(
    app: tauri::AppHandle,
    conversation_id: i32,
    minutes: u32,
) -> Result<CriticalAlertsSnapshot, AppCommandError> {
    Ok(snooze_critical_session_core(
        &EventEmitter::Tauri(app),
        conversation_id,
        minutes,
    ))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_critical_session_settings(
    db: State<'_, AppDatabase>,
) -> Result<CriticalSessionSettings, AppCommandError> {
    Ok(load_critical_settings(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_critical_session_settings(
    settings: CriticalSessionSettings,
    db: State<'_, AppDatabase>,
) -> Result<CriticalSessionSettings, AppCommandError> {
    save_critical_settings(&db.conn, settings).await
}
