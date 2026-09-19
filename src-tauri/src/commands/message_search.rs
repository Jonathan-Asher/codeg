//! ⌘K "message content" search — command surface for the FTS5 index
//! (see `db::service::message_search` for the index lifecycle).

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::db::service::message_search::{index_conversation_core, search_messages, MessageSearchHit};

/// Global message-content search across every non-deleted conversation.
/// The dialog debounces input client-side; this call is read-only over the
/// FTS5 index.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn message_search(
    query: String,
    limit: Option<u32>,
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<MessageSearchHit>, AppCommandError> {
    let conn = db.conn.clone();
    search_messages(&conn, &query, limit.unwrap_or(40))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}

/// (Re)index one conversation's turns. The search dialog drives full reindex
/// conversation-by-conversation from the frontend (it owns progress UX), so
/// this stays a bounded single-conversation call — no unbounded loop in the
/// backend, no blocking of the event loop while parsers chew a session file.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn message_search_index_conversation(
    conversation_id: i32,
    db: tauri::State<'_, AppDatabase>,
) -> Result<u32, AppCommandError> {
    let conn = db.conn.clone();
    index_conversation_core(&conn, conversation_id).await
}

/// Server-mode variant without the Tauri state — see
/// `web/handlers/message_search`.
pub async fn message_search_core(
    conn: &sea_orm::DatabaseConnection,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<MessageSearchHit>, AppCommandError> {
    search_messages(conn, &query, limit.unwrap_or(40))
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}

pub async fn message_search_index_conversation_core(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) -> Result<u32, AppCommandError> {
    index_conversation_core(conn, conversation_id).await
}
