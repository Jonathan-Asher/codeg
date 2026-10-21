//! Desktop commands for Claude Code's plan-mode settings
//! (`acp::claude_plan_mode`). The web handlers in
//! `web/handlers/claude_plan_mode.rs` call the same functions.

use tauri::State;

use crate::acp::claude_plan_mode::{
    load_claude_plan_settings, save_claude_plan_settings, ClaudePlanSettings,
};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_claude_plan_settings(
    db: State<'_, AppDatabase>,
) -> Result<ClaudePlanSettings, AppCommandError> {
    Ok(load_claude_plan_settings(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_claude_plan_settings(
    settings: ClaudePlanSettings,
    db: State<'_, AppDatabase>,
) -> Result<ClaudePlanSettings, AppCommandError> {
    save_claude_plan_settings(&db.conn, settings).await
}
