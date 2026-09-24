//! FTS5-backed search over conversation message content — the ⌘K
//! "message content" mode.
//!
//! Index lifecycle: a conversation's rows are written wholesale by
//! [`index_conversation`] (one DELETE + batch INSERT). [`run_message_indexer`]
//! — started by both the desktop app and the standalone server — backfills
//! every conversation shortly after start, then every minute re-indexes the
//! ones whose `updated_at` moved since their last indexing (tracked in
//! `message_fts_state`), which covers finished turns, imports and renames
//! without hooking any of those paths. The per-conversation
//! `message_search_index_conversation` command remains for on-demand use.
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
            [
                text.into(),
                conversation_id.into(),
                (idx as i32).into(),
                role.into(),
            ],
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
             JOIN conversation c ON c.id = f.conversation_id \
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

// ── Background indexer ─────────────────────────────────────────────────────

/// Conversations indexed per pass before the loop yields.
const INDEX_BATCH: usize = 25;
/// Wait after start before the first pass, so indexing never competes with
/// workspace boot (folder scan, session load, agent connect).
const INDEX_START_DELAY: std::time::Duration = std::time::Duration::from_secs(15);
/// Gap between passes once caught up.
const INDEX_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
/// A conversation touched more recently than this is left for a later pass:
/// every turn-end signal races the agent CLI flushing its transcript file, so
/// indexing at once could record the transcript without its last reply and,
/// with `updated_at` then unchanged, never look again.
const SETTLE_SECS: i64 = 20;

/// Index up to `batch` conversations that are new or changed since their last
/// indexing and have settled. Returns how many were processed; a full batch
/// means more may be waiting.
pub async fn index_stale_conversations(
    conn: &DatabaseConnection,
    batch: usize,
) -> Result<usize, DbErr> {
    use crate::db::entities::conversation;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Statement};
    use std::collections::HashMap;

    let indexed: HashMap<i32, String> = conn
        .query_all(Statement::from_string(
            conn.get_database_backend(),
            "SELECT conversation_id, indexed_updated_at FROM message_fts_state",
        ))
        .await?
        .into_iter()
        .filter_map(|row| {
            Some((
                row.try_get_by_index::<i32>(0).ok()?,
                row.try_get_by_index::<String>(1).ok()?,
            ))
        })
        .collect();

    let settled_before = chrono::Utc::now() - chrono::Duration::seconds(SETTLE_SECS);
    let candidates: Vec<(i32, chrono::DateTime<chrono::Utc>)> = conversation::Entity::find()
        .select_only()
        .column(conversation::Column::Id)
        .column(conversation::Column::UpdatedAt)
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::UpdatedAt.lt(settled_before))
        .order_by_desc(conversation::Column::UpdatedAt)
        .into_tuple()
        .all(conn)
        .await?;

    let mut done = 0;
    for (id, updated_at) in candidates {
        let stamp = updated_at.to_rfc3339();
        if indexed.get(&id) == Some(&stamp) {
            continue;
        }
        if let Err(err) = index_conversation_core(conn, id).await {
            // A session file that can't be read (moved, agent uninstalled) is
            // recorded anyway: retrying every minute would not fix it, and the
            // next real change to the conversation retries by itself.
            tracing::debug!("[message-search] indexing conversation {id} failed: {err}");
        }
        conn.execute(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "INSERT INTO message_fts_state (conversation_id, indexed_updated_at, indexed_at) \
             VALUES (?, ?, ?) \
             ON CONFLICT(conversation_id) DO UPDATE SET \
               indexed_updated_at = excluded.indexed_updated_at, \
               indexed_at = excluded.indexed_at",
            [
                id.into(),
                stamp.into(),
                chrono::Utc::now().to_rfc3339().into(),
            ],
        ))
        .await?;
        done += 1;
        if done >= batch {
            break;
        }
    }
    Ok(done)
}

/// Keep `message_fts` current for the lifetime of the app. See the module
/// docs for the lifecycle.
pub async fn run_message_indexer(conn: DatabaseConnection) {
    tokio::time::sleep(INDEX_START_DELAY).await;
    loop {
        match index_stale_conversations(&conn, INDEX_BATCH).await {
            // A full batch: more are waiting — keep going, briefly yielding.
            Ok(n) if n >= INDEX_BATCH => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
            Ok(_) => {}
            Err(err) => tracing::warn!("[message-search] indexer pass failed: {err}"),
        }
        tokio::time::sleep(INDEX_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    fn turn(role: TurnRole, text: &str) -> MessageTurn {
        serde_json::from_value(serde_json::json!({
            "id": format!("t-{text}"),
            "role": match role { TurnRole::User => "user", TurnRole::Assistant => "assistant", TurnRole::System => "system" },
            "blocks": [{ "type": "text", "text": text }],
            "timestamp": "2026-09-24T10:00:00Z",
        }))
        .expect("turn fixture")
    }

    #[tokio::test]
    async fn indexed_text_is_found_and_deleted_conversations_are_not() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let b = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        index_conversation(
            &db.conn,
            a,
            &[
                turn(TurnRole::User, "why does the upload retry loop race"),
                turn(
                    TurnRole::Assistant,
                    "the retry loop re-enters before the lock",
                ),
            ],
        )
        .await
        .unwrap();
        index_conversation(
            &db.conn,
            b,
            &[turn(TurnRole::User, "unrelated upload talk")],
        )
        .await
        .unwrap();

        let hits = search_messages(&db.conn, "retry loop", 10).await.unwrap();
        assert_eq!(hits.len(), 2, "both turns of `a` mention the phrase");
        assert!(hits.iter().all(|h| h.conversation_id == a));
        assert!(hits[0].snippet.contains("[[mark]]"));

        crate::db::service::conversation_service::soft_delete(&db.conn, a)
            .await
            .unwrap();
        assert!(search_messages(&db.conn, "retry loop", 10)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            search_messages(&db.conn, "upload", 10).await.unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn stale_pass_records_each_conversation_once_until_it_changes() {
        use crate::db::entities::conversation;
        use sea_orm::{ActiveModelTrait, EntityTrait, Set};

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let backdate = |secs: i64| chrono::Utc::now() - chrono::Duration::seconds(secs);
        let set_updated = |at: chrono::DateTime<chrono::Utc>| {
            let conn = db.conn.clone();
            async move {
                let row = conversation::Entity::find_by_id(id)
                    .one(&conn)
                    .await
                    .unwrap()
                    .unwrap();
                let mut active: conversation::ActiveModel = row.into();
                active.updated_at = Set(at);
                active.update(&conn).await.unwrap();
            }
        };

        // Fresh (inside the settle window): left alone.
        assert_eq!(index_stale_conversations(&db.conn, 25).await.unwrap(), 0);

        // Settled: processed once (the session file doesn't exist here, which
        // is recorded rather than retried), then skipped while unchanged.
        set_updated(backdate(120)).await;
        assert_eq!(index_stale_conversations(&db.conn, 25).await.unwrap(), 1);
        assert_eq!(index_stale_conversations(&db.conn, 25).await.unwrap(), 0);

        // A later change (a finished turn, a rename) makes it stale again.
        set_updated(backdate(60)).await;
        assert_eq!(index_stale_conversations(&db.conn, 25).await.unwrap(), 1);
    }
}
