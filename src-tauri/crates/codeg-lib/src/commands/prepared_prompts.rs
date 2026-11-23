//! Prepared prompts: messages the user wrote ahead of time for one
//! conversation, kept in the right-hand panel's Prompts tab and sent from
//! there through the composer (see `db::service::prepared_prompt_service`).
//!
//! The `_core` functions are shared by the desktop commands below and the web
//! handlers in `web/handlers/prepared_prompts.rs`, so a remote window (which
//! reaches its server over HTTP) and the local window take the same path.
//! Every change goes out on [`PREPARED_PROMPTS_CHANGED_EVENT`], so each window
//! showing the conversation's list re-reads it.
//!
//! These are the only writers: no MCP or other agent-facing tool adds, edits
//! or removes a prepared prompt.

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::db::error::DbError;
use crate::db::service::prepared_prompt_service;
use crate::db::AppDatabase;
use crate::models::PreparedPromptInfo;
use crate::web::event_bridge::{
    emit_event, EventEmitter, PreparedPromptsChange, PREPARED_PROMPTS_CHANGED_EVENT,
};

/// Service errors as the UI should read them: a blank or oversized prompt is
/// the request's fault, a missing prompt or conversation is not found; the
/// blanket `From<DbError>` would make both an opaque database error.
fn map_db(e: DbError) -> AppCommandError {
    match e {
        DbError::NotFound(msg) => AppCommandError::not_found(msg),
        DbError::Validation(msg) => AppCommandError::invalid_input(msg),
        other => AppCommandError::from(other),
    }
}

fn emit_changed(emitter: &EventEmitter, conversation_id: i32) {
    emit_event(
        emitter,
        PREPARED_PROMPTS_CHANGED_EVENT,
        PreparedPromptsChange { conversation_id },
    );
}

fn infos(rows: Vec<crate::db::entities::prepared_prompt::Model>) -> Vec<PreparedPromptInfo> {
    rows.into_iter().map(PreparedPromptInfo::from).collect()
}

/// The conversation's prompts, top to bottom.
pub async fn list_prepared_prompts_core(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<Vec<PreparedPromptInfo>, AppCommandError> {
    prepared_prompt_service::list(&db.conn, conversation_id)
        .await
        .map(infos)
        .map_err(map_db)
}

/// Add a prompt at the end of the conversation's list.
pub async fn create_prepared_prompt_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    content: String,
) -> Result<PreparedPromptInfo, AppCommandError> {
    let row = prepared_prompt_service::create(&db.conn, conversation_id, &content)
        .await
        .map_err(map_db)?;
    emit_changed(emitter, row.conversation_id);
    Ok(row.into())
}

/// Replace a prompt's text.
pub async fn update_prepared_prompt_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    content: String,
) -> Result<PreparedPromptInfo, AppCommandError> {
    let row = prepared_prompt_service::update_content(&db.conn, id, &content)
        .await
        .map_err(map_db)?;
    emit_changed(emitter, row.conversation_id);
    Ok(row.into())
}

/// Delete a prompt. Deleting one that is already gone (another window got
/// there first) is not an error.
pub async fn delete_prepared_prompt_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<(), AppCommandError> {
    if let Some(conversation_id) = prepared_prompt_service::delete(&db.conn, id)
        .await
        .map_err(map_db)?
    {
        emit_changed(emitter, conversation_id);
    }
    Ok(())
}

/// Store the order of the conversation's list after a drag (`ids` top to
/// bottom) and return the list as stored.
pub async fn reorder_prepared_prompts_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    ids: Vec<i32>,
) -> Result<Vec<PreparedPromptInfo>, AppCommandError> {
    let rows = prepared_prompt_service::reorder(&db.conn, conversation_id, &ids)
        .await
        .map_err(map_db)?;
    emit_changed(emitter, conversation_id);
    Ok(infos(rows))
}

/// Record that the prompt was just sent (it stays in the list).
pub async fn mark_prepared_prompt_sent_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<PreparedPromptInfo, AppCommandError> {
    let row = prepared_prompt_service::mark_sent(&db.conn, id)
        .await
        .map_err(map_db)?;
    emit_changed(emitter, row.conversation_id);
    Ok(row.into())
}

/// Deletion-funnel hook, called from
/// `conversations::delete_conversation_with_cleanup_core`: deleting a
/// conversation only marks its row, so no foreign key removes its prompts.
/// Best effort, like the funnel's other cleanups: a failure is logged.
pub async fn cleanup_prepared_prompts_for_deleted_conversation(
    emitter: &EventEmitter,
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) {
    match prepared_prompt_service::delete_for_conversation(conn, conversation_id).await {
        Ok(0) => {}
        Ok(_) => emit_changed(emitter, conversation_id),
        Err(e) => tracing::error!(
            "[prepared_prompts] cleanup failed (conversation {conversation_id}): {e}"
        ),
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_prepared_prompts(
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<Vec<PreparedPromptInfo>, AppCommandError> {
    list_prepared_prompts_core(&db, conversation_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_prepared_prompt(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    content: String,
) -> Result<PreparedPromptInfo, AppCommandError> {
    create_prepared_prompt_core(&EventEmitter::from_app(&app), &db, conversation_id, content).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_prepared_prompt(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    id: i32,
    content: String,
) -> Result<PreparedPromptInfo, AppCommandError> {
    update_prepared_prompt_core(&EventEmitter::from_app(&app), &db, id, content).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_prepared_prompt(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    delete_prepared_prompt_core(&EventEmitter::from_app(&app), &db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn reorder_prepared_prompts(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    ids: Vec<i32>,
) -> Result<Vec<PreparedPromptInfo>, AppCommandError> {
    reorder_prepared_prompts_core(&EventEmitter::from_app(&app), &db, conversation_id, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn mark_prepared_prompt_sent(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    id: i32,
) -> Result<PreparedPromptInfo, AppCommandError> {
    mark_prepared_prompt_sent_core(&EventEmitter::from_app(&app), &db, id).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::app_error::AppErrorCode;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::WebEventBroadcaster;

    fn changed_conversation(
        rx: &mut tokio::sync::broadcast::Receiver<crate::web::event_bridge::WebEvent>,
    ) -> Option<i64> {
        let evt = rx.try_recv().ok()?;
        assert_eq!(evt.channel, PREPARED_PROMPTS_CHANGED_EVENT);
        evt.payload["conversationId"].as_i64()
    }

    #[tokio::test]
    async fn every_change_is_broadcast_for_its_conversation() {
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/prepared-prompt-commands").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let expected = Some(i64::from(conv));

        let one = create_prepared_prompt_core(&emitter, &db, conv, "one".into())
            .await
            .unwrap();
        assert_eq!(changed_conversation(&mut rx), expected);
        let two = create_prepared_prompt_core(&emitter, &db, conv, "two".into())
            .await
            .unwrap();
        assert_eq!(changed_conversation(&mut rx), expected);

        update_prepared_prompt_core(&emitter, &db, one.id, "one, edited".into())
            .await
            .unwrap();
        assert_eq!(changed_conversation(&mut rx), expected);
        let order = reorder_prepared_prompts_core(&emitter, &db, conv, vec![two.id, one.id])
            .await
            .unwrap();
        assert_eq!(
            order.iter().map(|p| p.id).collect::<Vec<_>>(),
            [two.id, one.id]
        );
        assert_eq!(changed_conversation(&mut rx), expected);
        let sent = mark_prepared_prompt_sent_core(&emitter, &db, two.id)
            .await
            .unwrap();
        assert!(sent.last_sent_at.is_some());
        assert_eq!(changed_conversation(&mut rx), expected);
        delete_prepared_prompt_core(&emitter, &db, one.id)
            .await
            .unwrap();
        assert_eq!(changed_conversation(&mut rx), expected);

        // Deleting it again is fine and tells nobody anything.
        delete_prepared_prompt_core(&emitter, &db, one.id)
            .await
            .unwrap();
        assert_eq!(changed_conversation(&mut rx), None);

        let listed = list_prepared_prompts_core(&db, conv).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|p| p.content.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
    }

    #[tokio::test]
    async fn refusals_read_as_bad_input_or_not_found() {
        let emitter = EventEmitter::Noop;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/prepared-prompt-refusals").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        let blank = create_prepared_prompt_core(&emitter, &db, conv, "  ".into())
            .await
            .unwrap_err();
        assert!(
            matches!(blank.code, AppErrorCode::InvalidInput),
            "{blank:?}"
        );
        let missing = create_prepared_prompt_core(&emitter, &db, 9_999, "x".into())
            .await
            .unwrap_err();
        assert!(
            matches!(missing.code, AppErrorCode::NotFound),
            "{missing:?}"
        );
        let missing = update_prepared_prompt_core(&emitter, &db, 9_999, "x".into())
            .await
            .unwrap_err();
        assert!(
            matches!(missing.code, AppErrorCode::NotFound),
            "{missing:?}"
        );
        let missing = mark_prepared_prompt_sent_core(&emitter, &db, 9_999)
            .await
            .unwrap_err();
        assert!(
            matches!(missing.code, AppErrorCode::NotFound),
            "{missing:?}"
        );
    }
}
