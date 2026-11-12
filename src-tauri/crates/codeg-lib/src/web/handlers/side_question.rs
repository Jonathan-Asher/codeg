//! Web-mode handlers for side questions (`/btw`) and prompt suggestions. Same
//! functions as the desktop commands in `commands/side_question.rs`.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::error::AcpError;
use crate::acp::prompt_suggestions::{
    self, PromptSuggestionSettings, PromptSuggestionStats, SuggestionAction,
};
use crate::acp::side_question::{self, SideQuestionRecord, SideQuestionTarget};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::app_state::AppState;

/// What a side question failure is to an HTTP client: a question the session
/// cannot take (no such capability, an empty question) is the request's fault,
/// a missing connection is not found, everything else is the agent's.
fn side_question_error(e: AcpError) -> AppCommandError {
    let message = e.to_string();
    match e {
        AcpError::SideQuestionUnsupported | AcpError::InvalidSideQuestion(_) => {
            AppCommandError::new(AppErrorCode::InvalidInput, message)
        }
        AcpError::ConnectionNotFound(_) => AppCommandError::not_found(message),
        _ => AppCommandError::task_execution_failed(message),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSideQuestionParams {
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
    pub question: String,
}

pub async fn acp_side_question(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AcpSideQuestionParams>,
) -> Result<Json<SideQuestionRecord>, AppCommandError> {
    side_question::ask(
        &state.connection_manager,
        &state.db,
        &state.emitter,
        &state.data_dir,
        SideQuestionTarget {
            connection_id: params.connection_id,
            conversation_id: params.conversation_id,
        },
        &params.question,
    )
    .await
    .map(Json)
    .map_err(side_question_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSideQuestionsParams {
    pub conversation_id: i32,
}

pub async fn acp_list_side_questions(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationSideQuestionsParams>,
) -> Result<Json<Vec<SideQuestionRecord>>, AppCommandError> {
    side_question::list(&state.db, params.conversation_id)
        .await
        .map(Json)
        .map_err(side_question_error)
}

pub async fn acp_clear_side_questions(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationSideQuestionsParams>,
) -> Result<Json<u64>, AppCommandError> {
    side_question::clear(&state.db, params.conversation_id)
        .await
        .map(Json)
        .map_err(side_question_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpReportPromptSuggestionParams {
    pub connection_id: String,
    pub suggestion_id: u64,
    pub action: SuggestionAction,
}

pub async fn acp_report_prompt_suggestion(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AcpReportPromptSuggestionParams>,
) -> Result<Json<()>, AppCommandError> {
    prompt_suggestions::report(
        &state.connection_manager,
        &state.db.conn,
        &params.connection_id,
        params.suggestion_id,
        params.action,
    )
    .await
    .map(Json)
    .map_err(side_question_error)
}

pub async fn get_prompt_suggestion_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PromptSuggestionSettings>, AppCommandError> {
    Ok(Json(
        prompt_suggestions::load_settings(&state.db.conn).await,
    ))
}

/// Frontend sends `{ settings: <T> }`, which Tauri `invoke()` unwraps; in web
/// mode the whole body arrives as-is.
#[derive(Deserialize)]
pub struct UpdatePromptSuggestionSettingsParams {
    pub settings: PromptSuggestionSettings,
}

pub async fn update_prompt_suggestion_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdatePromptSuggestionSettingsParams>,
) -> Result<Json<PromptSuggestionSettings>, AppCommandError> {
    prompt_suggestions::save_settings(&state.db.conn, params.settings)
        .await
        .map(Json)
}

pub async fn get_prompt_suggestion_stats(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PromptSuggestionStats>, AppCommandError> {
    Ok(Json(prompt_suggestions::load_stats(&state.db.conn).await))
}
