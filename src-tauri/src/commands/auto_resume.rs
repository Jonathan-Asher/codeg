//! Desktop commands for the automatic resume after a restart
//! (`acp::auto_resume`): its on/off setting, the current batch, and Stop. The
//! web handlers in `web/handlers/auto_resume.rs` call the same functions.

use tauri::State;

use crate::acp::auto_resume::{
    auto_resume_status, load_auto_resume_settings, save_auto_resume_settings,
    stop_auto_resume_core, AutoResumeSettings, AutoResumeStatus,
};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_auto_resume_settings(
    db: State<'_, AppDatabase>,
) -> Result<AutoResumeSettings, AppCommandError> {
    Ok(load_auto_resume_settings(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_auto_resume_settings(
    settings: AutoResumeSettings,
    db: State<'_, AppDatabase>,
) -> Result<AutoResumeSettings, AppCommandError> {
    save_auto_resume_settings(&db.conn, settings).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_auto_resume_status() -> Result<AutoResumeStatus, AppCommandError> {
    Ok(auto_resume_status())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_auto_resume(
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<AutoResumeStatus, AppCommandError> {
    let emitter = crate::web::event_bridge::EventEmitter::Tauri(app);
    Ok(stop_auto_resume_core(&db.conn, &emitter).await)
}
