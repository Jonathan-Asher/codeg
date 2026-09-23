//! FTS5-backed search over conversation message content — the ⌘K
//! "message content" mode.
//!
//! Index lifecycle: a conversation's rows are written wholesale by
//! [`index_conversation`] (one DELETE + batch INSERT), triggered at app
//! start for every non-deleted conversation, after each completed turn
//! (via the TurnComplete path in `commands/acp.rs`), and by the
//! explicit reindex command `message_search_reindex`.
//!
//! Queries run through `message_fts MATCH` with
//! [`snippet()`](sea_query) post-processing: match terms wrapped in
//! `[[mark]] … [[/mark]]` (deliberately non-HTML so the frontend decides
//! how to render), limited to `limit` rows, best rank first.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, TransactionTrait};

use crate::app_error::AppCommandError;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// Rows written into `message_fts` for one turn.
pub struct SearchRecord {
    pub content: String,
    pub turn_idx: i32,
    pub role: String,
}

/// Streaming progress surface for the full-app (re)index. The frontend
/// drives the reindex command conversation-by-conversation, so this never
/// runs unbounded inside one call.
pub struct IndexProgress {
    pub done: u32,
    pub total: u32,
    pub conversation_id: i32,
}

/// Extract an indexable text blob from one turn: text blocks joined with a
/// newline. Reasoning traces, tool calls/results and images are excluded —
/// the index mirrors what a reader scans, exactly like find-in-chat.
fn turn_text(turn: &MessageTurn) -> String {
    let mut parts = Vec::new();
    for block in &turn.blocks {
        if let ContentBlock::Text { text } = block {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    parts.join("\n")
}

pub async fn index_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
    turns: &[MessageTurn],
) -> Result<u32, DbErr> {
    let txn = conn.begin().await?;

    use sea_orm::Statement;
    txn.execute(Statement::from_sql_and_values(
        conn.get_database_backend(),
        "DELETE FROM message_fts WHERE conversation_id = ?",
        [conversation_id.into()],
    ))
    .await?;

    let mut inserted: u32 = 0;
    for (idx, turn) in turns.iter().enumerate() {
        // Skip huge blobs (images/base64 are excluded by turn_text already;
        // this guards pathological tool-result text). 100 KB per turn.
        let text = turn_text(turn);
        if text.trim().is_empty() || text.len() > 100_000 {
            continue;
        }
        let role = match turn.role {
            TurnRole::User => "user",
            TurnRole::Assistant => "assistant",
            TurnRole::System => "system",
        };
        txn.execute(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "INSERT INTO message_fts (content, conversation_id, turn_idx, role) \
             VALUES (?, ?, ?, ?)",
            [text.into(), conversation_id.into(), (idx as i32).into(), role.into()],
        ))
        .await?;
        inserted += 1;
    }

    txn.commit().await?;
    Ok(inserted)
}

/// One search hit, projected for the frontend search dialog.
#[derive(serde::Serialize)]
pub struct MessageSearchHit {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: String,
    pub title: Option<String>,
    pub turn_idx: i32,
    pub role: String,
    /// `[[mark]]`-wrapped snippet (frontend renders its own highlight).
    pub snippet: String,
    /// Best-match rank (BM25 — lower is better).
    pub rank: f64,
}

pub async fn search_messages(
    conn: &DatabaseConnection,
    query: &str,
    limit: u32,
) -> Result<Vec<MessageSearchHit>, DbErr> {
    use sea_orm::Statement;

    // FTS5 query syntax is user-hostile for raw input; quote each
    // whitespace-separated token as a phrase so "fix the bug" matches the
    // phrase and brotects the parser from stray operators (`-`, `OR`, `"…"`).
    let sanitized = query
        .split_whitespace()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }

    let stmt = Statement::from_string(
        conn.get_database_backend(),
        format!(
            "SELECT c.id, c.folder_id, c.agent_type, c.title, \
                    f.turn_idx, f.role, \
                    snippet(message_fts, 0, '[[mark]]', '[[/mark]]', '…', 14) AS snip, \
                    rank \
             FROM message_fts f \
             JOIN conversations c ON c.id = f.conversation_id \
             WHERE message_fts MATCH '{}' AND c.deleted_at IS NULL \
             ORDER BY rank LIMIT {}",
            sanitized.replace('\'', "''"),
            limit
        ),
    );

    let rows = conn.query_all(stmt).await?;
    let mut hits = Vec::with_capacity(rows.len());
    for row in rows {
        // sea_orm's query_all rows are accessed by try_get_by_column or
        // try_get by index — the SELECT order is fixed above.
        let conversation_id: i32 = row.try_get_by_index(0)?;
        let folder_id: i32 = row.try_get_by_index(1)?;
        let agent_type: String = row.try_get_by_index(2)?;
        let title: Option<String> = row.try_get_by_index(3).ok();
        let turn_idx: i32 = row.try_get_by_index(4)?;
        let role: String = row.try_get_by_index(5)?;
        let snippet: String = row.try_get_by_index(6)?;
        let rank: f64 = row.try_get_by_index(7)?;

        hits.push(MessageSearchHit {
            conversation_id,
            folder_id,
            agent_type,
            title,
            turn_idx,
            role,
            snippet,
            rank,
        });
    }
    Ok(hits)
}

/// Count a conversation's currently indexed turns — used by the reindex
/// command to report staleness to the caller without re-reading turns.
pub async fn indexed_turn_count(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<u32, DbErr> {
    use sea_orm::Statement;

    let stmt = Statement::from_sql_and_values(
        conn.get_database_backend(),
        "SELECT COUNT(*) FROM message_fts WHERE conversation_id = ?",
        [conversation_id.into()],
    );
    let row = conn
        .query_one(stmt)
        .await?
        .ok_or_else(|| DbErr::Custom("message_fts count row missing".into()))?;
    let v = row.try_get_by_index::<i64>(0)?;
    Ok(v as u32)
}

/// Command-level entry: index ONE conversation (loads turns via the same
/// parser machinery the detail view uses) and report how many turns were
/// written.
pub async fn index_conversation_core(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<u32, AppCommandError> {
    let (detail, _) =
        crate::commands::conversations::get_folder_conversation_core(conn, conversation_id).await?;
    index_conversation(conn, conversation_id, &detail.turns)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}
