//! Desktop commands for side questions (`/btw`, see `acp::side_question`) and
//! prompt suggestions (`acp::prompt_suggestions`): asking, the stored
//! exchanges, the suggestion reports and the setting. The web handlers in
//! `web/handlers/side_question.rs` call the same functions.

use std::path::PathBuf;

use tauri::{Manager, State};

use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::prompt_suggestions::{
    self, PromptSuggestionSettings, PromptSuggestionStats, SuggestionAction,
};
use crate::acp::side_question::{self, SideQuestionRecord, SideQuestionTarget};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

/// Ask a side question on the conversation's live Claude Code connection
/// (`connection_id`, else the conversation's own, else one opened for it).
/// Resolves with the stored exchange once the agent answered.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_side_question(
    connection_id: Option<String>,
    conversation_id: Option<i32>,
    question: String,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
    app_handle: tauri::AppHandle,
) -> Result<SideQuestionRecord, AcpError> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| PathBuf::from("."));
    side_question::ask(
        &manager,
        &db,
        &EventEmitter::Tauri(app_handle),
        &data_dir,
        SideQuestionTarget {
            connection_id,
            conversation_id,
        },
        &question,
    )
    .await
}

/// The conversation's side questions, oldest first.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_list_side_questions(
    conversation_id: i32,
    db: State<'_, AppDatabase>,
) -> Result<Vec<SideQuestionRecord>, AcpError> {
    side_question::list(&db, conversation_id).await
}

/// Forget the conversation's side questions; how many there were.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_clear_side_questions(
    conversation_id: i32,
    db: State<'_, AppDatabase>,
) -> Result<u64, AcpError> {
    side_question::clear(&db, conversation_id).await
}

/// The composer showed prediction `suggestion_id` of the connection, or the
/// user accepted it with Tab.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_report_prompt_suggestion(
    connection_id: String,
    suggestion_id: u64,
    action: SuggestionAction,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    prompt_suggestions::report(&manager, &db.conn, &connection_id, suggestion_id, action).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_prompt_suggestion_settings(
    db: State<'_, AppDatabase>,
) -> Result<PromptSuggestionSettings, AppCommandError> {
    Ok(prompt_suggestions::load_settings(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_prompt_suggestion_settings(
    settings: PromptSuggestionSettings,
    db: State<'_, AppDatabase>,
) -> Result<PromptSuggestionSettings, AppCommandError> {
    prompt_suggestions::save_settings(&db.conn, settings).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_prompt_suggestion_stats(
    db: State<'_, AppDatabase>,
) -> Result<PromptSuggestionStats, AppCommandError> {
    Ok(prompt_suggestions::load_stats(&db.conn).await)
}
