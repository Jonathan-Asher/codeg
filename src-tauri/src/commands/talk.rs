//! Desktop commands for Talk mode (`crate::talk`): switching it per
//! conversation, and its settings. The web handlers in `web/handlers/talk.rs`
//! call the same functions.

use tauri::State;

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::talk::{
    load_talk_settings, save_talk_settings, set_conversation_talk_mode_core, TalkSettings,
};
use crate::web::event_bridge::EventEmitter;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_conversation_talk_mode(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
    conversation_id: i32,
    enabled: bool,
) -> Result<(), AppCommandError> {
    set_conversation_talk_mode_core(
        &db.conn,
        &EventEmitter::Tauri(app),
        &manager,
        conversation_id,
        enabled,
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_talk_settings(
    db: State<'_, AppDatabase>,
) -> Result<TalkSettings, AppCommandError> {
    Ok(load_talk_settings(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_talk_settings(
    settings: TalkSettings,
    db: State<'_, AppDatabase>,
) -> Result<TalkSettings, AppCommandError> {
    save_talk_settings(&db.conn, settings).await
}
