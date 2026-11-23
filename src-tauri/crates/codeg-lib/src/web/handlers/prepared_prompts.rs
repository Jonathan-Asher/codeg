//! Web-mode handlers for prepared prompts: the same `_core` functions as the
//! desktop commands in `commands/prepared_prompts.rs`. A remote window reads
//! and writes its server's lists through these.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::prepared_prompts as prompt_commands;
use crate::models::PreparedPromptInfo;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPreparedPromptsParams {
    pub conversation_id: i32,
}

pub async fn list_prepared_prompts(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationPreparedPromptsParams>,
) -> Result<Json<Vec<PreparedPromptInfo>>, AppCommandError> {
    Ok(Json(
        prompt_commands::list_prepared_prompts_core(&state.db, params.conversation_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePreparedPromptParams {
    pub conversation_id: i32,
    pub content: String,
}

pub async fn create_prepared_prompt(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreatePreparedPromptParams>,
) -> Result<Json<PreparedPromptInfo>, AppCommandError> {
    Ok(Json(
        prompt_commands::create_prepared_prompt_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            params.content,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreparedPromptParams {
    pub id: i32,
    pub content: String,
}

pub async fn update_prepared_prompt(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdatePreparedPromptParams>,
) -> Result<Json<PreparedPromptInfo>, AppCommandError> {
    Ok(Json(
        prompt_commands::update_prepared_prompt_core(
            &state.emitter,
            &state.db,
            params.id,
            params.content,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPromptIdParams {
    pub id: i32,
}

pub async fn delete_prepared_prompt(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PreparedPromptIdParams>,
) -> Result<Json<()>, AppCommandError> {
    prompt_commands::delete_prepared_prompt_core(&state.emitter, &state.db, params.id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderPreparedPromptsParams {
    pub conversation_id: i32,
    pub ids: Vec<i32>,
}

pub async fn reorder_prepared_prompts(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ReorderPreparedPromptsParams>,
) -> Result<Json<Vec<PreparedPromptInfo>>, AppCommandError> {
    Ok(Json(
        prompt_commands::reorder_prepared_prompts_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            params.ids,
        )
        .await?,
    ))
}

pub async fn mark_prepared_prompt_sent(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PreparedPromptIdParams>,
) -> Result<Json<PreparedPromptInfo>, AppCommandError> {
    Ok(Json(
        prompt_commands::mark_prepared_prompt_sent_core(&state.emitter, &state.db, params.id)
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    fn params<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Json<T> {
        Json(serde_json::from_value(value).expect("the client's JSON body"))
    }

    /// The whole round trip a remote window makes, with the JSON bodies
    /// `src/lib/api.ts` sends.
    #[tokio::test]
    async fn a_remote_window_can_do_everything_the_panel_does() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/prepared-prompt-handlers").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let other = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new_for_test(db, dir.path().to_path_buf()));
        let ext = || Extension(state.clone());

        let Json(first) = create_prepared_prompt(
            ext(),
            params(serde_json::json!({ "conversationId": conv, "content": "first" })),
        )
        .await
        .unwrap();
        let Json(second) = create_prepared_prompt(
            ext(),
            params(serde_json::json!({ "conversationId": conv, "content": "second" })),
        )
        .await
        .unwrap();
        let Json(elsewhere) = create_prepared_prompt(
            ext(),
            params(serde_json::json!({ "conversationId": other, "content": "not here" })),
        )
        .await
        .unwrap();
        assert_eq!(elsewhere.conversation_id, other);

        let Json(edited) = update_prepared_prompt(
            ext(),
            params(serde_json::json!({ "id": first.id, "content": "first, edited" })),
        )
        .await
        .unwrap();
        assert_eq!(edited.content, "first, edited");

        let Json(order) = reorder_prepared_prompts(
            ext(),
            params(serde_json::json!({
                "conversationId": conv,
                "ids": [second.id, first.id],
            })),
        )
        .await
        .unwrap();
        assert_eq!(
            order.iter().map(|p| p.id).collect::<Vec<_>>(),
            [second.id, first.id]
        );

        let Json(sent) =
            mark_prepared_prompt_sent(ext(), params(serde_json::json!({ "id": second.id })))
                .await
                .unwrap();
        assert!(sent.last_sent_at.is_some());
        // What the client reads: camelCase, the sent time included.
        let wire = serde_json::to_value(&sent).unwrap();
        assert!(wire["lastSentAt"].is_string(), "{wire}");
        assert_eq!(wire["conversationId"], conv);
        assert_eq!(wire["sortOrder"], 0);

        let Json(()) = delete_prepared_prompt(ext(), params(serde_json::json!({ "id": first.id })))
            .await
            .unwrap();

        let Json(listed) =
            list_prepared_prompts(ext(), params(serde_json::json!({ "conversationId": conv })))
                .await
                .unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|p| p.content.as_str())
                .collect::<Vec<_>>(),
            ["second"]
        );

        let refused = create_prepared_prompt(
            ext(),
            params(serde_json::json!({ "conversationId": conv, "content": "\n" })),
        )
        .await
        .unwrap_err();
        assert!(matches!(refused.code, AppErrorCode::InvalidInput));
    }
}
