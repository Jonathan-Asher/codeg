//! Storage for the ⌘K message search: the `message_fts` full-text index over
//! conversation messages, and the `message_fts_state` stamps recording which
//! version of each conversation it holds.
//!
//!   * **write** — [`index_conversation`] swaps one conversation's rows for a
//!     freshly parsed set and stamps the `conversation.updated_at` they
//!     reflect; [`mark_indexed`] drops the rows and stamps, for a transcript
//!     that could not be read, and [`mark_indexed_keeping_rows`] stamps and
//!     keeps them, for one that is not there at all (the rows are then the last
//!     copy of its text). The indexer driving them lives in
//!     `commands::message_search`.
//!   * **row map** — `message_fts_rows` records which FTS rowid holds which
//!     turn, so every delete names its rows by rowid. `message_fts` keeps
//!     `conversation_id` and `turn_idx` UNINDEXED, and a filter on those reads
//!     the whole index's text — with the write lock held, for a DELETE. Every
//!     write to `message_fts` writes the map in the same transaction.
//!   * **short transactions** — a rewrite is cut into transactions of a few
//!     dozen rows and kilobytes ([`WriteBatching`]) with a pause between them,
//!     so the app's own writes never queue long behind the indexer.
//!   * **saved text** — [`saved_turns`] reads one conversation's rows back,
//!     for the read-only view of a session whose agent deleted its history.
//!   * **read** — [`search_messages`] finds every word of a query anywhere in a
//!     message: words of three or more characters through the trigram index,
//!     shorter ones (common in Chinese: 登录, 修复) with LIKE.
//!
//! Hits join `conversation` and `folder` rather than storing a copy of their
//! fields, so a rename, a soft delete or a removed folder shows up without
//! re-indexing.

use std::collections::HashMap;
use std::ops::Range;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveEnum, ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, RuntimeErr, Statement, TransactionTrait, Value,
};
use serde::Serialize;

use crate::db::entities::conversation::{self, ConversationKind, ConversationTurnState};
use crate::db::error::DbError;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// A turn with more text than this (a pasted log, a dumped file) stays out of
/// the index: its snippets would be noise, and it would dominate the index.
const MAX_TURN_TEXT_BYTES: usize = 100_000;

/// Words shorter than this cannot be looked up in a trigram index, so they are
/// matched with LIKE, which scans the text.
const MIN_INDEXED_WORD_CHARS: usize = 3;

/// Excerpt of a hit found through the index: up to 64 tokens (the most
/// `snippet()` allows) around the best match. A trigram starts at every
/// character, so that is about 64 characters.
const SNIPPET_SQL: &str = "snippet(message_fts, 0, '[[mark]]', '[[/mark]]', '…', 64)";

/// Characters kept on each side of the first match when the excerpt is cut
/// here rather than by `snippet()`.
const EXCERPT_CONTEXT_CHARS: usize = 30;

const MARK_OPEN: &str = "[[mark]]";
const MARK_CLOSE: &str = "[[/mark]]";
const ELLIPSIS: &str = "…";

/// One search hit, as the ⌘K dialog renders it.
#[derive(Debug, Clone, Serialize)]
pub struct MessageSearchHit {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: String,
    pub title: Option<String>,
    /// Position of the matching turn in the parsed conversation.
    pub turn_idx: i32,
    /// `user`, `assistant` or `system`.
    pub role: String,
    /// Excerpt around the match with every matched word wrapped in
    /// `[[mark]]…[[/mark]]` — deliberately not HTML, so the frontend decides
    /// how to render the highlight.
    pub snippet: String,
    /// BM25 rank; lower is better. 0 when no word of the query was long enough
    /// for the index — those hits come most recently active first.
    pub rank: f64,
}

/// A conversation the indexer has to (re-)index.
#[derive(Debug, Clone)]
pub struct StaleConversation {
    pub id: i32,
    pub updated_at: DateTime<Utc>,
    /// A turn of it is still running, so its last turn can still grow.
    pub running: bool,
}

/// The searchable text of one turn: its text blocks, joined by newlines.
/// Reasoning, tool calls and results, and images stay out — the index holds
/// what a reader sees as the conversation's messages.
fn turn_text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn role_name(role: &TurnRole) -> &'static str {
    match role {
        TurnRole::User => "user",
        TurnRole::Assistant => "assistant",
        TurnRole::System => "system",
    }
}

/// What one turn contributes to the index: its role and text, or `None` for a
/// turn the index skips (no text, or more than [`MAX_TURN_TEXT_BYTES`]).
type TurnRow = Option<(&'static str, String)>;

fn turn_rows(turns: &[MessageTurn]) -> Vec<TurnRow> {
    turns
        .iter()
        .map(|turn| {
            let text = turn_text(turn);
            (!text.is_empty() && text.len() <= MAX_TURN_TEXT_BYTES)
                .then(|| (role_name(&turn.role), text))
        })
        .collect()
}

/// A fingerprint of what `rows` put in the index, in order. Stored, so it is a
/// fixed function (FNV-1a), not the std hasher; a collision costs nothing worse
/// than keeping rows a full rewrite would also have written.
fn fingerprint(rows: &[TurnRow]) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(PRIME);
        }
    };
    for row in rows {
        match row {
            Some((role, text)) => {
                feed(role.as_bytes());
                feed(&[0]);
                feed(&(text.len() as u64).to_le_bytes());
                feed(text.as_bytes());
            }
            None => feed(&[1]),
        }
    }
    format!("{:016x}:{}", hash, rows.len())
}

/// How many turns the index held of this conversation, and the fingerprint of
/// all but the last of them. `None` when it was never indexed, or indexed
/// before the index kept this.
async fn indexed_prefix(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Option<(usize, String)>, DbError> {
    let row = conn
        .query_one(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "SELECT indexed_turns, prefix_fp FROM message_fts_state WHERE conversation_id = ?",
            [conversation_id.into()],
        ))
        .await?;
    Ok(row.and_then(|row| {
        let turns = row.try_get_by_index::<Option<i64>>(0).ok()??;
        let fp = row.try_get_by_index::<Option<String>>(1).ok()??;
        Some((usize::try_from(turns).ok()?, fp))
    }))
}

/// How many leading turns of a re-parse are already in the index, as the rows
/// `rows` would write: all but the last turn indexed before (the last could
/// have grown since), when the turns before it are unchanged. 0 when anything
/// before it changed (an edit, a fork, a compaction): everything is rewritten.
fn kept_turns(previous: Option<&(usize, String)>, rows: &[TurnRow]) -> usize {
    match previous {
        Some((count, fp)) if *count > 0 && rows.len() >= *count => {
            let kept = count - 1;
            if fingerprint(&rows[..kept]) == *fp {
                kept
            } else {
                0
            }
        }
        _ => 0,
    }
}

async fn stamp<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    source_updated_at: DateTime<Utc>,
    rows: &[TurnRow],
) -> Result<(), DbErr> {
    let prefix = &rows[..rows.len().saturating_sub(1)];
    conn.execute(Statement::from_sql_and_values(
        conn.get_database_backend(),
        "INSERT INTO message_fts_state \
           (conversation_id, indexed_updated_at, indexed_at, indexed_turns, prefix_fp) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(conversation_id) DO UPDATE SET \
           indexed_updated_at = excluded.indexed_updated_at, \
           indexed_at = excluded.indexed_at, \
           indexed_turns = excluded.indexed_turns, \
           prefix_fp = excluded.prefix_fp",
        [
            conversation_id.into(),
            source_updated_at.to_rfc3339().into(),
            Utc::now().to_rfc3339().into(),
            (rows.len() as i64).into(),
            fingerprint(prefix).into(),
        ],
    ))
    .await?;
    Ok(())
}

/// How the index's writes are cut into transactions. Each one holds SQLite's
/// write lock from its first change to its commit, and every other writer —
/// sending a message, linking a conversation, saving a setting — waits behind
/// it, failing with "database is locked" once the wait passes `busy_timeout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteBatching {
    /// Most rows one transaction inserts or deletes…
    pub max_rows: usize,
    /// …and most bytes of text. FTS5 tokenizes every byte of a row it inserts
    /// or deletes (a trigram starts at every character) and merges index
    /// segments at commit in proportion, so the bytes are what decide how long
    /// a transaction holds the lock. A single row larger than this goes alone.
    pub max_bytes: usize,
    /// Least pause between two transactions of one rewrite; it is never shorter
    /// than the transaction before it took, so the indexer holds the lock at
    /// most half the time. A writer queued behind a transaction for a while
    /// polls for the lock every 100 ms (SQLite's busy handler backs off to
    /// that), so a shorter gap could close before it looks.
    pub pause: Duration,
}

impl WriteBatching {
    /// The background indexer's. Measured on a copy of a real 50K-row index
    /// on a box deep in swap: transactions this size held the lock a few
    /// milliseconds typically and about 120 ms at worst (a segment merge at
    /// commit), a lone 100 KB turn 10-40 ms, where one transaction for a whole
    /// large conversation took over a second.
    pub const INDEXER: Self = Self {
        max_rows: 64,
        max_bytes: 64 * 1024,
        pause: Duration::from_millis(100),
    };
}

/// Attempts at one transaction that finds the database busy (another writer
/// kept the lock past `busy_timeout`) before the conversation is left for the
/// next pass.
const BUSY_ATTEMPTS: u32 = 4;
/// Wait before the first retry of a busy transaction, doubled for each next
/// one: the indexer steps back while the app is writing.
const BUSY_BACKOFF: Duration = Duration::from_secs(1);

/// What [`index_conversation`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexWrite {
    /// Rows inserted.
    pub written: u32,
    /// Rows deleted.
    pub deleted: u32,
    /// Transactions it took.
    pub transactions: u32,
    /// Most rows one transaction changed.
    pub largest_rows: usize,
    /// Most bytes of text one transaction inserted or deleted.
    pub largest_bytes: usize,
    /// Longest one transaction took from begin to commit, including any wait
    /// for the lock.
    pub longest: Duration,
}

/// One row change of a rewrite.
#[derive(Debug)]
enum RowChange<'a> {
    /// Drop an indexed row.
    Delete { fts_rowid: i64, bytes: usize },
    /// Index one turn.
    Insert {
        turn_idx: i32,
        role: &'static str,
        text: &'a str,
    },
}

impl RowChange<'_> {
    fn bytes(&self) -> usize {
        match self {
            Self::Delete { bytes, .. } => *bytes,
            Self::Insert { text, .. } => text.len(),
        }
    }
}

/// `sizes` cut into consecutive ranges of at most `max_rows` items and
/// `max_bytes` bytes each; an item larger than `max_bytes` gets a range of its
/// own. Never empty: no items at all make one empty range, the transaction
/// that still carries the stamp.
fn batch_ranges(sizes: &[usize], batching: &WriteBatching) -> Vec<Range<usize>> {
    let max_rows = batching.max_rows.max(1);
    let mut ranges = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (at, &size) in sizes.iter().enumerate() {
        let rows = at - start;
        if rows > 0 && (rows >= max_rows || bytes + size > batching.max_bytes) {
            ranges.push(start..at);
            start = at;
            bytes = 0;
        }
        bytes += size;
    }
    ranges.push(start..sizes.len());
    ranges
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// The rowids and sizes of one conversation's indexed rows from turn `from`
/// on, found through the row map.
async fn indexed_rows_from<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    from: usize,
) -> Result<Vec<(i64, usize)>, DbErr> {
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "SELECT fts_rowid, bytes FROM message_fts_rows \
             WHERE conversation_id = ? AND turn_idx >= ? ORDER BY turn_idx",
            [conversation_id.into(), (from as i64).into()],
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            let bytes: i64 = row.try_get_by_index(1)?;
            Ok((
                row.try_get_by_index(0)?,
                usize::try_from(bytes).unwrap_or(0),
            ))
        })
        .collect()
}

/// Drop the rows with these rowids from the index and from the row map. The
/// map goes first: it is a plain table, so the write-lock watch (`db::watch`)
/// times the transaction from its start — it does not see FTS5's own writes.
async fn delete_rows<C: ConnectionTrait>(conn: &C, rowids: &[i64]) -> Result<(), DbErr> {
    let marks = placeholders(rowids.len());
    let values: Vec<Value> = rowids.iter().map(|&rowid| rowid.into()).collect();
    for sql in [
        format!("DELETE FROM message_fts_rows WHERE fts_rowid IN ({marks})"),
        format!("DELETE FROM message_fts WHERE rowid IN ({marks})"),
    ] {
        conn.execute(Statement::from_sql_and_values(
            conn.get_database_backend(),
            sql,
            values.clone(),
        ))
        .await?;
    }
    Ok(())
}

/// Index these turns of one conversation. The row map hands out the rowids
/// (and, a plain table written first, starts the write-lock watch's clock);
/// the index rows are then written under them.
async fn insert_rows<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    turns: &[(i32, &'static str, &str)],
) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let mut sql =
        String::from("INSERT INTO message_fts_rows (conversation_id, turn_idx, bytes) VALUES ");
    let mut values: Vec<Value> = Vec::with_capacity(turns.len() * 3);
    for (n, (turn_idx, _, text)) in turns.iter().enumerate() {
        sql.push_str(if n == 0 { "(?, ?, ?)" } else { ", (?, ?, ?)" });
        values.push(conversation_id.into());
        values.push((*turn_idx).into());
        values.push((text.len() as i64).into());
    }
    // RETURNING lists the rows in no set order: matched up by turn.
    sql.push_str(" RETURNING fts_rowid, turn_idx");
    let assigned: HashMap<i32, i64> = conn
        .query_all(Statement::from_sql_and_values(backend, sql, values))
        .await?
        .into_iter()
        .map(|row| Ok((row.try_get_by_index(1)?, row.try_get_by_index(0)?)))
        .collect::<Result<_, DbErr>>()?;

    let mut sql = String::from(
        "INSERT INTO message_fts (rowid, content, conversation_id, turn_idx, role) VALUES ",
    );
    let mut values: Vec<Value> = Vec::with_capacity(turns.len() * 5);
    for (n, (turn_idx, role, text)) in turns.iter().enumerate() {
        let rowid = assigned.get(turn_idx).copied().ok_or_else(|| {
            DbErr::Custom(format!(
                "message_fts_rows assigned no rowid to turn {turn_idx}"
            ))
        })?;
        sql.push_str(if n == 0 {
            "(?, ?, ?, ?, ?)"
        } else {
            ", (?, ?, ?, ?, ?)"
        });
        values.push(rowid.into());
        values.push((*text).into());
        values.push(conversation_id.into());
        values.push((*turn_idx).into());
        values.push((*role).into());
    }
    conn.execute(Statement::from_sql_and_values(backend, sql, values))
        .await?;
    Ok(())
}

/// One transaction of a rewrite. Every statement in it writes — none reads
/// first — so it never starts on a read snapshot it then cannot upgrade.
async fn write_batch(
    conn: &DatabaseConnection,
    conversation_id: i32,
    changes: &[RowChange<'_>],
    unstamp: bool,
    stamp_with: Option<(DateTime<Utc>, &[TurnRow])>,
) -> Result<(), DbErr> {
    let txn = conn.begin().await?;
    if unstamp {
        txn.execute(Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE message_fts_state SET indexed_turns = NULL, prefix_fp = NULL \
             WHERE conversation_id = ?",
            [conversation_id.into()],
        ))
        .await?;
    }
    let deletes: Vec<i64> = changes
        .iter()
        .filter_map(|change| match change {
            RowChange::Delete { fts_rowid, .. } => Some(*fts_rowid),
            RowChange::Insert { .. } => None,
        })
        .collect();
    if !deletes.is_empty() {
        delete_rows(&txn, &deletes).await?;
    }
    let inserts: Vec<(i32, &'static str, &str)> = changes
        .iter()
        .filter_map(|change| match change {
            RowChange::Insert {
                turn_idx,
                role,
                text,
            } => Some((*turn_idx, *role, *text)),
            RowChange::Delete { .. } => None,
        })
        .collect();
    if !inserts.is_empty() {
        insert_rows(&txn, conversation_id, &inserts).await?;
    }
    if let Some((source_updated_at, rows)) = stamp_with {
        stamp(&txn, conversation_id, source_updated_at, rows).await?;
    }
    txn.commit().await
}

/// Whether `err` is SQLite reporting the database busy: another connection
/// kept the write lock past `busy_timeout` (or moved on from the snapshot a
/// transaction started on).
fn is_busy(err: &DbErr) -> bool {
    let (DbErr::Exec(RuntimeErr::SqlxError(err))
    | DbErr::Query(RuntimeErr::SqlxError(err))
    | DbErr::Conn(RuntimeErr::SqlxError(err))) = err
    else {
        return false;
    };
    match err {
        sea_orm::sqlx::Error::Database(db) => db
            .code()
            .and_then(|code| code.parse::<i32>().ok())
            .is_some_and(|code| code & 0xff == 5),
        _ => false,
    }
}

/// [`write_batch`], retried with a growing back-off while the database is
/// busy. Returns how long the transaction that went through took.
async fn write_batch_backing_off(
    conn: &DatabaseConnection,
    conversation_id: i32,
    changes: &[RowChange<'_>],
    unstamp: bool,
    stamp_with: Option<(DateTime<Utc>, &[TurnRow])>,
) -> Result<Duration, DbErr> {
    let mut attempt = 0;
    loop {
        let started = Instant::now();
        match write_batch(conn, conversation_id, changes, unstamp, stamp_with).await {
            Ok(()) => return Ok(started.elapsed()),
            Err(err) if is_busy(&err) && attempt + 1 < BUSY_ATTEMPTS => {
                let wait = BUSY_BACKOFF * 2u32.pow(attempt);
                tracing::debug!(
                    conversation_id,
                    attempt,
                    wait_ms = wait.as_millis() as u64,
                    "[message-search] database busy; backing off"
                );
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

/// Bring one conversation's rows up to `turns` and stamp the
/// `conversation.updated_at` they were parsed at.
///
/// A conversation that only grew since it was last indexed keeps its rows:
/// only the turns from its previous last one on are written (see
/// [`kept_turns`]), so a long session re-indexed after every turn costs a few
/// rows, not a rewrite of its whole history.
///
/// The rows to drop are found through the row map and deleted by rowid. The
/// changes go in transactions of [`WriteBatching::INDEXER`] size, the stamp in
/// the last one, so the stamp never claims rows that did not land; a small
/// change (the usual one: the last turn grew) is a single transaction, and a
/// search never sees it half-written. A larger rewrite can be seen part-way
/// for the moment it takes. One that starts from the first turn drops the
/// stamp's turn count in its first transaction, so if it is cut off (codeg
/// quits) the next pass rewrites the conversation in full rather than trust
/// rows it had already deleted.
pub async fn index_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
    source_updated_at: DateTime<Utc>,
    turns: &[MessageTurn],
) -> Result<IndexWrite, DbError> {
    index_conversation_batched(
        conn,
        conversation_id,
        source_updated_at,
        turns,
        &WriteBatching::INDEXER,
    )
    .await
}

/// [`index_conversation`] with the transactions cut by `batching`.
pub async fn index_conversation_batched(
    conn: &DatabaseConnection,
    conversation_id: i32,
    source_updated_at: DateTime<Utc>,
    turns: &[MessageTurn],
    batching: &WriteBatching,
) -> Result<IndexWrite, DbError> {
    let rows = turn_rows(turns);
    let previous = indexed_prefix(conn, conversation_id).await?;
    let kept = kept_turns(previous.as_ref(), &rows);

    let mut changes: Vec<RowChange<'_>> = indexed_rows_from(conn, conversation_id, kept)
        .await?
        .into_iter()
        .map(|(fts_rowid, bytes)| RowChange::Delete { fts_rowid, bytes })
        .collect();
    changes.extend(rows.iter().enumerate().skip(kept).filter_map(|(idx, row)| {
        row.as_ref().map(|&(role, ref text)| RowChange::Insert {
            turn_idx: idx as i32,
            role,
            text: text.as_str(),
        })
    }));
    let sizes: Vec<usize> = changes.iter().map(RowChange::bytes).collect();
    let batches = batch_ranges(&sizes, batching);
    let unstamp_first = kept == 0 && batches.len() > 1 && previous.is_some();

    let mut outcome = IndexWrite::default();
    let mut last_took = Duration::ZERO;
    for (n, range) in batches.iter().enumerate() {
        if n > 0 {
            tokio::time::sleep(batching.pause.max(last_took)).await;
        }
        let batch = &changes[range.clone()];
        let stamp_with = (n + 1 == batches.len()).then_some((source_updated_at, rows.as_slice()));
        last_took = write_batch_backing_off(
            conn,
            conversation_id,
            batch,
            n == 0 && unstamp_first,
            stamp_with,
        )
        .await?;

        outcome.transactions += 1;
        outcome.longest = outcome.longest.max(last_took);
        outcome.largest_rows = outcome.largest_rows.max(batch.len());
        outcome.largest_bytes = outcome.largest_bytes.max(sizes[range.clone()].iter().sum());
        for change in batch {
            match change {
                RowChange::Delete { .. } => outcome.deleted += 1,
                RowChange::Insert { .. } => outcome.written += 1,
            }
        }
    }
    Ok(outcome)
}

/// Stamp a conversation as indexed at `source_updated_at` with no rows — for
/// one whose transcript could not be read. Rows from an earlier, readable
/// version go in the same transaction: search still lists the conversation, so
/// they would keep returning text that can no longer be opened, and the stamp
/// would keep them until the conversation changed. Retrying on every pass
/// would not make it readable; its next real change retries by itself.
pub async fn mark_indexed(
    conn: &DatabaseConnection,
    conversation_id: i32,
    source_updated_at: DateTime<Utc>,
) -> Result<(), DbError> {
    index_conversation(conn, conversation_id, source_updated_at, &[]).await?;
    Ok(())
}

/// Stamp a conversation as indexed at `source_updated_at` and leave its rows as
/// they are — for one whose transcript was not found at all: not written yet,
/// or deleted by the agent (Claude Code removes sessions past its retention
/// period). What an earlier read indexed is then the only copy of its text
/// left, and the session's read-only view shows it (see
/// `commands::lost_history`), so it must outlive the file. The stamp's turn
/// count and fingerprint stay those of the rows, so a transcript that comes
/// back is indexed against them like any other re-read. The stamp keeps the
/// indexer from looking for the file every minute; the conversation's next
/// change looks again.
pub async fn mark_indexed_keeping_rows(
    conn: &DatabaseConnection,
    conversation_id: i32,
    source_updated_at: DateTime<Utc>,
) -> Result<(), DbError> {
    conn.execute(Statement::from_sql_and_values(
        conn.get_database_backend(),
        "INSERT INTO message_fts_state \
           (conversation_id, indexed_updated_at, indexed_at) \
         VALUES (?, ?, ?) \
         ON CONFLICT(conversation_id) DO UPDATE SET \
           indexed_updated_at = excluded.indexed_updated_at, \
           indexed_at = excluded.indexed_at",
        [
            conversation_id.into(),
            source_updated_at.to_rfc3339().into(),
            Utc::now().to_rfc3339().into(),
        ],
    ))
    .await?;
    Ok(())
}

/// One turn's text as the index holds it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SavedTurn {
    /// The turn's position in the conversation as it was last read.
    pub turn_idx: i32,
    /// `user`, `assistant` or `system`.
    pub role: String,
    pub content: String,
}

/// The text the index holds of one conversation, oldest turn first: its text
/// blocks only (see [`turn_text`]), and not the turns too long to index.
pub async fn saved_turns(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<SavedTurn>, DbError> {
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "SELECT f.turn_idx, f.role, f.content FROM message_fts_rows r \
             JOIN message_fts f ON f.rowid = r.fts_rowid \
             WHERE r.conversation_id = ? ORDER BY r.turn_idx",
            [conversation_id.into()],
        ))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(SavedTurn {
                turn_idx: row.try_get_by_index::<i32>(0).ok()?,
                role: row.try_get_by_index::<String>(1).ok()?,
                content: row.try_get_by_index::<String>(2).ok()?,
            })
        })
        .collect())
}

/// How many turns of one conversation the index holds.
pub async fn saved_turn_count(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<u32, DbError> {
    let row = conn
        .query_one(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "SELECT COUNT(*) FROM message_fts_rows WHERE conversation_id = ?",
            [conversation_id.into()],
        ))
        .await?;
    Ok(row
        .and_then(|row| row.try_get_by_index::<i64>(0).ok())
        .and_then(|count| u32::try_from(count).ok())
        .unwrap_or(0))
}

/// Drop one conversation's rows AND its stamp, leaving it as if never indexed.
///
/// For a row that was re-pointed at another agent session (a fork or an edit
/// of a past message): what it indexed was read from the session it left, so
/// search would keep returning text — the replaced message included — that the
/// conversation no longer shows. Without the stamp the next pass indexes it
/// again from the session it holds now, once it has settled.
///
/// Takes any connection so it can join the caller's transaction, and returns
/// the raw `DbErr` for the same reason. The rows are deleted by rowid, found
/// through the row map, so the caller's transaction holds the write lock for
/// as long as this conversation's text takes to remove, not for a read of the
/// whole index.
pub async fn forget_conversation<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    for sql in [
        "DELETE FROM message_fts WHERE rowid IN \
         (SELECT fts_rowid FROM message_fts_rows WHERE conversation_id = ?)",
        "DELETE FROM message_fts_rows WHERE conversation_id = ?",
        "DELETE FROM message_fts_state WHERE conversation_id = ?",
    ] {
        conn.execute(Statement::from_sql_and_values(
            backend,
            sql,
            [conversation_id.into()],
        ))
        .await?;
    }
    Ok(())
}

/// Up to `limit` conversations that were never indexed or changed since, most
/// recently active first. Only conversations a search can return are listed
/// (top-level, not a loop run, not deleted), and one touched at or after
/// `settled_before` is left for a later pass.
pub async fn list_stale_conversations(
    conn: &DatabaseConnection,
    settled_before: DateTime<Utc>,
    limit: usize,
) -> Result<Vec<StaleConversation>, DbError> {
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

    let candidates: Vec<(i32, DateTime<Utc>, Option<String>)> = conversation::Entity::find()
        .select_only()
        .column(conversation::Column::Id)
        .column(conversation::Column::UpdatedAt)
        .column(conversation::Column::TurnState)
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::ParentId.is_null())
        .filter(conversation::Column::Kind.ne(ConversationKind::Loop))
        .filter(conversation::Column::UpdatedAt.lt(settled_before))
        .order_by_desc(conversation::Column::UpdatedAt)
        .into_tuple()
        .all(conn)
        .await?;

    let running = ConversationTurnState::Running.to_value();
    Ok(candidates
        .into_iter()
        .filter(|(id, updated_at, _)| indexed.get(id) != Some(&updated_at.to_rfc3339()))
        .take(limit)
        .map(|(id, updated_at, turn_state)| StaleConversation {
            id,
            updated_at,
            running: turn_state.as_deref() == Some(running.as_str()),
        })
        .collect())
}

/// The whitespace-separated words of a query, split by how they are matched.
/// Every word has to appear in the message, anywhere, in any order.
struct QueryWords<'q> {
    /// Long enough for the trigram index.
    indexed: Vec<&'q str>,
    /// Too short for it: matched with LIKE.
    short: Vec<&'q str>,
}

impl<'q> QueryWords<'q> {
    fn parse(query: &'q str) -> Self {
        let (indexed, short) = query
            .split_whitespace()
            .partition(|word| word.chars().count() >= MIN_INDEXED_WORD_CHARS);
        Self { indexed, short }
    }
}

/// FTS5 query requiring every indexed word. Each word is a quoted string, so
/// operators and punctuation (`OR`, `-`, `*`, `:`, `"`) are matched as text
/// instead of failing to parse.
fn match_expression(words: &[&str]) -> String {
    words
        .iter()
        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// LIKE pattern matching `word` anywhere, its own `%`, `_` and `\` taken
/// literally (the query declares `ESCAPE '\'`).
fn like_pattern(word: &str) -> String {
    let mut pattern = String::with_capacity(word.len() + 2);
    pattern.push('%');
    for c in word.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// Best `limit` hits for `query` across every conversation the sidebar lists:
/// top-level, not a loop run, not deleted, in a folder that is not removed.
///
/// Hits found through the index are ranked by BM25. A query whose words are
/// all too short for the index scans the text instead, and its hits come most
/// recently active first.
pub async fn search_messages(
    conn: &DatabaseConnection,
    query: &str,
    limit: u32,
) -> Result<Vec<MessageSearchHit>, DbError> {
    let words = QueryWords::parse(query);
    let by_index = !words.indexed.is_empty();
    if !by_index && words.short.is_empty() {
        return Ok(Vec::new());
    }

    let mut conditions = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if by_index {
        conditions.push("message_fts MATCH ?");
        values.push(match_expression(&words.indexed).into());
    }
    for word in &words.short {
        conditions.push("f.content LIKE ? ESCAPE '\\'");
        values.push(like_pattern(word).into());
    }
    values.push(i64::from(limit).into());

    // Without a MATCH there is neither `snippet()` nor a rank: the whole text
    // comes back, and the excerpt is cut from it below.
    let (text, rank, order) = if by_index {
        (SNIPPET_SQL, "rank", "rank")
    } else {
        ("f.content", "0.0", "c.updated_at DESC, f.turn_idx DESC")
    };
    let conditions = conditions.join(" AND ");
    let sql = format!(
        "SELECT c.id, c.folder_id, c.agent_type, c.title, f.turn_idx, f.role, {text}, {rank} \
         FROM message_fts f \
         JOIN conversation c ON c.id = f.conversation_id \
         JOIN folder fo ON fo.id = c.folder_id \
         WHERE {conditions} \
           AND c.deleted_at IS NULL \
           AND c.parent_id IS NULL \
           AND c.kind <> 'loop' \
           AND fo.deleted_at IS NULL \
         ORDER BY {order} \
         LIMIT ?"
    );
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            sql,
            values,
        ))
        .await?;

    let short_words = fold_words(&words.short);
    let mut hits = Vec::with_capacity(rows.len());
    for row in rows {
        let text: String = row.try_get_by_index(6)?;
        hits.push(MessageSearchHit {
            conversation_id: row.try_get_by_index(0)?,
            folder_id: row.try_get_by_index(1)?,
            agent_type: row.try_get_by_index(2)?,
            title: row.try_get_by_index(3)?,
            turn_idx: row.try_get_by_index(4)?,
            role: row.try_get_by_index(5)?,
            // `snippet()` marks only what the index matched.
            snippet: if by_index {
                mark_outside_marks(&text, &short_words)
            } else {
                excerpt(&text, &short_words)
            },
            rank: row.try_get_by_index(7)?,
        });
    }
    Ok(hits)
}

fn fold_char(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Words as lower-cased characters, for [`word_ranges`].
fn fold_words(words: &[&str]) -> Vec<Vec<char>> {
    words
        .iter()
        .map(|word| word.chars().map(fold_char).collect())
        .collect()
}

/// Char ranges of the case-insensitive occurrences of `words` in `text`, in
/// order and without overlaps; where several words start at the same place,
/// the longest wins.
fn word_ranges(text: &[char], words: &[Vec<char>]) -> Vec<(usize, usize)> {
    let folded: Vec<char> = text.iter().copied().map(fold_char).collect();
    let mut ranges = Vec::new();
    let mut at = 0;
    while at < folded.len() {
        let longest = words
            .iter()
            .filter(|word| !word.is_empty() && folded[at..].starts_with(word))
            .map(Vec::len)
            .max();
        match longest {
            Some(len) => {
                ranges.push((at, at + len));
                at += len;
            }
            None => at += 1,
        }
    }
    ranges
}

/// `text` with each of `ranges` wrapped in mark tags.
fn mark_ranges(text: &[char], ranges: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(text.len() + ranges.len() * 17);
    let mut at = 0;
    for &(start, end) in ranges {
        out.extend(&text[at..start]);
        out.push_str(MARK_OPEN);
        out.extend(&text[start..end]);
        out.push_str(MARK_CLOSE);
        at = end;
    }
    out.extend(&text[at..]);
    out
}

/// Excerpt for a hit found without the index: the text around the first
/// occurrence of a word, cut on character boundaries, with every occurrence in
/// it marked the way `snippet()` marks indexed matches.
fn excerpt(text: &str, words: &[Vec<char>]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let ranges = word_ranges(&chars, words);
    let (first_start, first_end) = ranges.first().copied().unwrap_or((0, 0));
    let start = first_start.saturating_sub(EXCERPT_CONTEXT_CHARS);
    let end = (first_end + EXCERPT_CONTEXT_CHARS).min(chars.len());
    let inside: Vec<(usize, usize)> = ranges
        .iter()
        .filter(|&&(from, to)| from >= start && to <= end)
        .map(|&(from, to)| (from - start, to - start))
        .collect();

    let mut out = String::new();
    if start > 0 {
        out.push_str(ELLIPSIS);
    }
    out.push_str(&mark_ranges(&chars[start..end], &inside));
    if end < chars.len() {
        out.push_str(ELLIPSIS);
    }
    out
}

/// `snippet` with `words` marked as well, outside the marks FTS5 placed around
/// what the index matched.
fn mark_outside_marks(snippet: &str, words: &[Vec<char>]) -> String {
    if words.is_empty() {
        return snippet.to_owned();
    }
    let mut out = String::with_capacity(snippet.len());
    let mut rest = snippet;
    while !rest.is_empty() {
        let open = rest.find(MARK_OPEN).unwrap_or(rest.len());
        let close = rest[open..]
            .find(MARK_CLOSE)
            .map_or(rest.len(), |at| open + at + MARK_CLOSE.len());
        let plain: Vec<char> = rest[..open].chars().collect();
        out.push_str(&mark_ranges(&plain, &word_ranges(&plain, words)));
        out.push_str(&rest[open..close]);
        rest = &rest[close..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::spawner::DelegationLink;
    use crate::db::service::{conversation_service, folder_service};
    use crate::db::test_helpers::{
        fresh_disk_db, fresh_in_memory_db, seed_conversation, seed_folder,
    };
    use crate::models::agent::AgentType;
    use sea_orm::DbBackend;

    fn turn(role: &str, text: &str) -> MessageTurn {
        serde_json::from_value(serde_json::json!({
            "id": format!("t-{text}"),
            "role": role,
            "blocks": [{ "type": "text", "text": text }],
            "timestamp": "2026-09-24T10:00:00Z",
        }))
        .expect("turn fixture")
    }

    async fn search(conn: &DatabaseConnection, query: &str) -> Vec<MessageSearchHit> {
        search_messages(conn, query, 10).await.expect("search")
    }

    fn ids(hits: &[MessageSearchHit]) -> Vec<i32> {
        hits.iter().map(|h| h.conversation_id).collect()
    }

    /// One indexed conversation per text, each with a single user turn.
    async fn seed_texts(db: &crate::db::AppDatabase, texts: &[&str]) -> Vec<i32> {
        let folder = seed_folder(db, "/tmp/fts-proj").await;
        let mut ids = Vec::new();
        for text in texts {
            let id = seed_conversation(db, folder, AgentType::ClaudeCode).await;
            index_conversation(&db.conn, id, Utc::now(), &[turn("user", text)])
                .await
                .unwrap();
            ids.push(id);
        }
        ids
    }

    #[tokio::test]
    async fn indexed_text_is_found_and_deleted_conversations_are_not() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let b = seed_conversation(&db, folder, AgentType::Codex).await;
        index_conversation(
            &db.conn,
            a,
            Utc::now(),
            &[
                turn("user", "why does the upload retry loop race"),
                turn("assistant", "the retry loop re-enters before the lock"),
            ],
        )
        .await
        .unwrap();
        index_conversation(
            &db.conn,
            b,
            Utc::now(),
            &[turn("user", "unrelated upload talk")],
        )
        .await
        .unwrap();

        let hits = search(&db.conn, "retry loop").await;
        assert_eq!(hits.len(), 2, "both turns of `a` mention both words");
        assert!(hits.iter().all(|h| h.conversation_id == a));
        assert!(hits[0].snippet.contains("[[mark]]"));
        assert_eq!(search(&db.conn, "upload").await.len(), 2);

        conversation_service::soft_delete(&db.conn, a)
            .await
            .unwrap();
        assert!(search(&db.conn, "retry loop").await.is_empty());
        let hits = search(&db.conn, "upload").await;
        assert_eq!(ids(&hits), [b]);
        assert_eq!(hits[0].agent_type, "codex");
        assert_eq!(hits[0].role, "user");
    }

    #[tokio::test]
    async fn words_are_found_inside_words_and_unspaced_text() {
        let db = fresh_in_memory_db().await;
        let seeded = seed_texts(
            &db,
            &[
                "the upload retry loop races",
                "修复登录问题，然后重新部署",
                "ログインの問題を修正しました",
            ],
        )
        .await;
        let (en, zh, ja) = (seeded[0], seeded[1], seeded[2]);

        // Part of a word, in any case, through the index.
        let hits = search(&db.conn, "RETR").await;
        assert_eq!(ids(&hits), [en]);
        assert_eq!(
            hits[0].snippet,
            "the upload [[mark]]retr[[/mark]]y loop races"
        );

        // A two-character Chinese word inside a run of characters: too short
        // for the index, found by LIKE.
        let hits = search(&db.conn, "登录").await;
        assert_eq!(ids(&hits), [zh]);
        assert_eq!(
            hits[0].snippet,
            "修复[[mark]]登录[[/mark]]问题，然后重新部署"
        );

        // A four-character one, through the index.
        let hits = search(&db.conn, "登录问题").await;
        assert_eq!(ids(&hits), [zh]);
        assert_eq!(
            hits[0].snippet,
            "修复[[mark]]登录问题[[/mark]]，然后重新部署"
        );

        // Japanese, both ways.
        let hits = search(&db.conn, "ログイン").await;
        assert_eq!(ids(&hits), [ja]);
        assert_eq!(
            hits[0].snippet,
            "[[mark]]ログイン[[/mark]]の問題を修正しました"
        );
        let hits = search(&db.conn, "問題").await;
        assert_eq!(ids(&hits), [ja]);
        assert_eq!(
            hits[0].snippet,
            "ログインの[[mark]]問題[[/mark]]を修正しました"
        );
    }

    #[tokio::test]
    async fn short_and_long_words_must_all_match() {
        let db = fresh_in_memory_db().await;
        let seeded = seed_texts(
            &db,
            &[
                "先修复登录问题，再修复部署",
                "登录问题仍然存在",
                "the db call hit a timeout",
                "a timeout in the parser",
            ],
        )
        .await;

        let hits = search(&db.conn, "修复 登录问题").await;
        assert_eq!(ids(&hits), [seeded[0]]);
        // The index marks the long word, and the short one is marked too.
        assert_eq!(
            hits[0].snippet,
            "先[[mark]]修复[[/mark]][[mark]]登录问题[[/mark]]，再[[mark]]修复[[/mark]]部署"
        );

        let hits = search(&db.conn, "DB timeout").await;
        assert_eq!(ids(&hits), [seeded[2]]);
        assert_eq!(
            hits[0].snippet,
            "the [[mark]]db[[/mark]] call hit a [[mark]]timeout[[/mark]]"
        );
    }

    #[tokio::test]
    async fn short_words_order_hits_by_recency() {
        let db = fresh_in_memory_db().await;
        let seeded = seed_texts(&db, &["one 登录", "two 登录", "three 登录"]).await;
        // A rename bumps `updated_at`, making the middle one the most recent.
        conversation_service::update_title(&db.conn, seeded[1], "renamed".into())
            .await
            .unwrap();

        let hits = search(&db.conn, "登录").await;
        assert_eq!(ids(&hits), [seeded[1], seeded[2], seeded[0]]);
    }

    #[tokio::test]
    async fn query_text_is_matched_literally() {
        let db = fresh_in_memory_db().await;
        let seeded = seed_texts(
            &db,
            &[
                "fix: parse \"config\" (or not) -> panic*",
                "coverage is at 100%",
                "a_b c\\d",
            ],
        )
        .await;
        let (code, percent, underscore) = (seeded[0], seeded[1], seeded[2]);

        // FTS5 syntax and punctuation are text to find, not operators.
        for query in [
            "\"config\"",
            "(or",
            "not)",
            "->",
            "panic*",
            "fix:",
            "OR",
            "NOT",
            "-",
        ] {
            assert_eq!(
                ids(&search(&db.conn, query).await),
                [code],
                "query {query:?}"
            );
        }
        assert!(search(&db.conn, "->>").await.is_empty());

        // LIKE wildcards in short words match only themselves.
        assert_eq!(ids(&search(&db.conn, "%").await), [percent]);
        assert_eq!(ids(&search(&db.conn, "0%").await), [percent]);
        assert_eq!(ids(&search(&db.conn, "_").await), [underscore]);
        assert_eq!(ids(&search(&db.conn, "\\").await), [underscore]);

        for query in ["", "   "] {
            assert!(search(&db.conn, query).await.is_empty(), "query {query:?}");
        }
    }

    #[tokio::test]
    async fn reindexing_replaces_the_conversation_rows() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        index_conversation(&db.conn, id, Utc::now(), &[turn("user", "first draft")])
            .await
            .unwrap();
        index_conversation(&db.conn, id, Utc::now(), &[turn("user", "second draft")])
            .await
            .unwrap();

        assert!(search(&db.conn, "first").await.is_empty());
        assert_eq!(search(&db.conn, "draft").await.len(), 1);
    }

    async fn row_texts(conn: &DatabaseConnection, id: i32) -> Vec<(i32, String)> {
        conn.query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "SELECT turn_idx, content FROM message_fts WHERE conversation_id = ? \
             ORDER BY turn_idx",
            [id.into()],
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get_by_index::<i32>(0).unwrap(),
                row.try_get_by_index::<String>(1).unwrap(),
            )
        })
        .collect()
    }

    /// A conversation that only grew is indexed by writing its previous last
    /// turn (it may have grown) and the new ones; the rest stay as they were.
    #[tokio::test]
    async fn a_grown_conversation_is_indexed_by_appending() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let first = [
            turn("user", "deploy the parser"),
            turn("assistant", "on it"),
            turn("user", "and the docs"),
        ];
        assert_eq!(
            index_conversation(&db.conn, id, Utc::now(), &first)
                .await
                .unwrap()
                .written,
            3
        );

        let mut grown = first.to_vec();
        grown[2] = turn("user", "and the docs too");
        grown.push(turn("assistant", "both shipped"));
        assert_eq!(
            index_conversation(&db.conn, id, Utc::now(), &grown)
                .await
                .unwrap()
                .written,
            2,
            "the previous last turn and the new one"
        );
        assert_eq!(
            row_texts(&db.conn, id).await,
            [
                (0, "deploy the parser".to_string()),
                (1, "on it".to_string()),
                (2, "and the docs too".to_string()),
                (3, "both shipped".to_string()),
            ]
        );

        // Unchanged: only the last turn is rewritten.
        assert_eq!(
            index_conversation(&db.conn, id, Utc::now(), &grown)
                .await
                .unwrap()
                .written,
            1
        );
        assert_eq!(row_texts(&db.conn, id).await.len(), 4);
    }

    /// History that changed before the last turn (an edit, a fork, a
    /// compaction) or shrank is rewritten in full.
    #[tokio::test]
    async fn changed_history_is_rewritten() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let first = [
            turn("user", "rename the module"),
            turn("assistant", "renamed"),
            turn("user", "thanks"),
        ];
        index_conversation(&db.conn, id, Utc::now(), &first).await.unwrap();

        let edited = [
            turn("user", "rename the crate"),
            turn("assistant", "renamed"),
            turn("user", "thanks"),
        ];
        assert_eq!(
            index_conversation(&db.conn, id, Utc::now(), &edited)
                .await
                .unwrap()
                .written,
            3
        );
        assert!(search(&db.conn, "module").await.is_empty());
        assert_eq!(search(&db.conn, "crate").await.len(), 1);

        let shrunk = [turn("user", "rename the crate")];
        assert_eq!(
            index_conversation(&db.conn, id, Utc::now(), &shrunk)
                .await
                .unwrap()
                .written,
            1
        );
        assert_eq!(row_texts(&db.conn, id).await, [(0, "rename the crate".to_string())]);
    }

    #[test]
    fn the_fingerprint_follows_roles_texts_and_skipped_turns() {
        let rows = |items: &[Option<(&'static str, &str)>]| -> Vec<TurnRow> {
            items
                .iter()
                .map(|r| r.map(|(role, text)| (role, text.to_string())))
                .collect()
        };
        let base = fingerprint(&rows(&[Some(("user", "ab")), None]));
        assert_eq!(base, fingerprint(&rows(&[Some(("user", "ab")), None])));
        assert_ne!(base, fingerprint(&rows(&[Some(("assistant", "ab")), None])));
        assert_ne!(base, fingerprint(&rows(&[Some(("user", "a")), None])));
        assert_ne!(base, fingerprint(&rows(&[Some(("user", "ab"))])));
        assert_ne!(base, fingerprint(&rows(&[None, Some(("user", "ab"))])));
    }

    /// A row re-pointed at another session stops returning what it indexed at
    /// once, and — its stamp gone — is back on the indexer's list, while the
    /// other conversations keep theirs.
    #[tokio::test]
    async fn forgetting_a_conversation_drops_its_rows_and_its_stamp() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let mut seeded = Vec::new();
        for text in ["replaced message", "kept message"] {
            let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
            // Stamped at the row's own version, so it reads as up to date.
            let row = conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .unwrap()
                .unwrap();
            index_conversation(&db.conn, id, row.updated_at, &[turn("user", text)])
                .await
                .unwrap();
            seeded.push(id);
        }
        let (forgotten, kept) = (seeded[0], seeded[1]);

        forget_conversation(&db.conn, forgotten).await.unwrap();

        assert!(search(&db.conn, "replaced").await.is_empty());
        assert_eq!(ids(&search(&db.conn, "kept").await), [kept]);
        let settled = Utc::now() + chrono::Duration::seconds(60);
        let stale: Vec<i32> = list_stale_conversations(&db.conn, settled, 10)
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert!(stale.contains(&forgotten), "the forgotten row is indexed again");
        assert!(!stale.contains(&kept), "nothing else is");
    }

    #[tokio::test]
    async fn hits_are_limited_to_conversations_the_sidebar_lists() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let parent = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let child = conversation_service::create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            None,
            Some(DelegationLink {
                parent_conversation_id: parent,
                parent_tool_use_id: "tu-1".into(),
                delegation_call_id: "call-1".into(),
                assistant: None,
            }),
        )
        .await
        .unwrap()
        .id;
        let removed = seed_folder(&db, "/tmp/fts-removed").await;
        let in_removed = seed_conversation(&db, removed, AgentType::ClaudeCode).await;
        for id in [parent, child, in_removed] {
            index_conversation(&db.conn, id, Utc::now(), &[turn("user", "shared needle")])
                .await
                .unwrap();
        }
        folder_service::soft_delete_folder(&db.conn, removed)
            .await
            .unwrap();

        assert_eq!(ids(&search(&db.conn, "needle").await), [parent]);
        assert_eq!(ids(&search(&db.conn, "ne").await), [parent]);
    }

    #[tokio::test]
    async fn stale_list_follows_the_recorded_stamps() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let row = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        let later = row.updated_at + chrono::Duration::seconds(1);
        let stale = |settled_before| list_stale_conversations(&db.conn, settled_before, 10);

        // Touched at or after the cut-off: not settled yet.
        assert!(stale(row.updated_at).await.unwrap().is_empty());
        // Settled and never indexed.
        let listed = stale(later).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);

        // Indexed (or marked) at its current version: nothing to do.
        mark_indexed(&db.conn, id, row.updated_at).await.unwrap();
        assert!(stale(later).await.unwrap().is_empty());

        // Stamped at an older version: stale again.
        mark_indexed(&db.conn, id, row.updated_at - chrono::Duration::seconds(5))
            .await
            .unwrap();
        assert_eq!(stale(later).await.unwrap().len(), 1);
    }

    /// Every row of the index, and every entry of its row map, as
    /// `(rowid, conversation, turn, bytes)`.
    async fn quads(conn: &DatabaseConnection, sql: &str) -> Vec<(i64, i64, i64, i64)> {
        conn.query_all(Statement::from_string(conn.get_database_backend(), sql))
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.try_get_by_index(0).unwrap(),
                    row.try_get_by_index(1).unwrap(),
                    row.try_get_by_index(2).unwrap(),
                    row.try_get_by_index(3).unwrap(),
                )
            })
            .collect()
    }

    /// The row map names exactly the rows the index holds.
    async fn assert_map_matches_index(conn: &DatabaseConnection, step: &str) {
        let index = quads(
            conn,
            "SELECT rowid, conversation_id, turn_idx, length(CAST(content AS BLOB)) \
             FROM message_fts ORDER BY rowid",
        )
        .await;
        let map = quads(
            conn,
            "SELECT fts_rowid, conversation_id, turn_idx, bytes FROM message_fts_rows \
             ORDER BY fts_rowid",
        )
        .await;
        assert_eq!(map, index, "after {step}");
    }

    async fn texts(conn: &DatabaseConnection, id: i32) -> Vec<(i32, String)> {
        saved_turns(conn, id)
            .await
            .unwrap()
            .into_iter()
            .map(|turn| (turn.turn_idx, turn.content))
            .collect()
    }

    const NO_PAUSE: Duration = Duration::ZERO;

    /// Inserts, a tail re-index, a full rewrite, a shrink, a drop and a
    /// rebuild all keep the row map in step with the index — in one
    /// transaction per write, and cut into many.
    #[tokio::test]
    async fn the_row_map_follows_every_write() {
        let tiny = WriteBatching {
            max_rows: 2,
            max_bytes: 24,
            pause: NO_PAUSE,
        };
        for batching in [WriteBatching::INDEXER, tiny] {
            let db = fresh_in_memory_db().await;
            let conn = &db.conn;
            let folder = seed_folder(&db, "/tmp/fts-proj").await;
            let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
            let b = seed_conversation(&db, folder, AgentType::Codex).await;
            let index = move |id: i32, turns: Vec<MessageTurn>| async move {
                index_conversation_batched(conn, id, Utc::now(), &turns, &batching)
                    .await
                    .unwrap()
            };

            let first = vec![
                turn("user", "deploy the parser"),
                turn("assistant", "on it"),
                turn("user", "and the docs"),
            ];
            index(a, first.clone()).await;
            index(b, vec![turn("user", "the other conversation")]).await;
            assert_map_matches_index(conn, "the first index").await;

            let mut grown = first.clone();
            grown[2] = turn("user", "and the docs too");
            grown.push(turn("assistant", "both shipped"));
            let wrote = index(a, grown.clone()).await;
            assert_eq!((wrote.deleted, wrote.written), (1, 2), "{batching:?}");
            assert_map_matches_index(conn, "a tail re-index").await;
            assert_eq!(
                texts(conn, a).await,
                [
                    (0, "deploy the parser".to_string()),
                    (1, "on it".to_string()),
                    (2, "and the docs too".to_string()),
                    (3, "both shipped".to_string()),
                ]
            );

            let mut edited = grown.clone();
            edited[0] = turn("user", "deploy the lexer");
            let wrote = index(a, edited).await;
            assert_eq!((wrote.deleted, wrote.written), (4, 4));
            assert_map_matches_index(conn, "a full rewrite").await;
            assert!(search(conn, "parser").await.is_empty());

            index(a, vec![turn("user", "deploy the lexer")]).await;
            assert_map_matches_index(conn, "a shrink").await;
            assert_eq!(texts(conn, a).await, [(0, "deploy the lexer".to_string())]);

            mark_indexed(conn, a, Utc::now()).await.unwrap();
            assert_map_matches_index(conn, "an unreadable transcript").await;
            assert!(texts(conn, a).await.is_empty());
            assert_eq!(saved_turn_count(conn, a).await.unwrap(), 0);

            index(a, grown.clone()).await;
            assert_map_matches_index(conn, "a rebuild").await;
            assert_eq!(saved_turn_count(conn, a).await.unwrap(), 4);

            forget_conversation(conn, a).await.unwrap();
            assert_map_matches_index(conn, "forgetting").await;
            assert!(texts(conn, a).await.is_empty());
            index(a, grown).await;
            assert_map_matches_index(conn, "a rebuild after forgetting").await;

            assert_eq!(
                texts(conn, b).await,
                [(0, "the other conversation".to_string())],
                "the other conversation was never touched"
            );
        }
    }

    #[test]
    #[allow(clippy::single_range_in_vec_init)]
    fn batches_hold_to_the_row_and_byte_limits() {
        let batching = WriteBatching {
            max_rows: 3,
            max_bytes: 10,
            pause: NO_PAUSE,
        };
        let cut = |sizes: &[usize]| batch_ranges(sizes, &batching);
        assert_eq!(
            cut(&[]),
            [0..0],
            "a stamp-only write still has its transaction"
        );
        assert_eq!(cut(&[1; 7]), [0..3, 3..6, 6..7]);
        assert_eq!(cut(&[4, 4, 4, 4]), [0..2, 2..4]);
        assert_eq!(
            cut(&[2, 25, 2]),
            [0..1, 1..2, 2..3],
            "an oversized row goes alone"
        );
        assert_eq!(cut(&[10, 0]), [0..2]);
    }

    /// A rewrite larger than one transaction's share goes in several, none
    /// over the limits, and its stamp lands with the last: the next re-index
    /// of the grown conversation only appends.
    #[tokio::test]
    async fn a_large_rewrite_goes_in_transactions_within_the_limits() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let batching = WriteBatching {
            max_rows: 8,
            max_bytes: 200,
            pause: NO_PAUSE,
        };
        let turns: Vec<MessageTurn> = (0..50)
            .map(|n| {
                let role = if n % 2 == 0 { "user" } else { "assistant" };
                turn(role, &format!("message number {n:02} about the parser"))
            })
            .collect();

        let wrote = index_conversation_batched(&db.conn, id, Utc::now(), &turns, &batching)
            .await
            .unwrap();
        assert_eq!((wrote.deleted, wrote.written), (0, 50));
        assert_eq!(wrote.transactions, 10, "34-byte rows, 5 to a transaction");
        assert!(wrote.largest_rows <= batching.max_rows);
        assert!(wrote.largest_bytes <= batching.max_bytes);

        let mut edited = turns.clone();
        edited[0] = turn("user", "message number 00 about the lexer");
        let wrote = index_conversation_batched(&db.conn, id, Utc::now(), &edited, &batching)
            .await
            .unwrap();
        assert_eq!((wrote.deleted, wrote.written), (50, 50));
        assert!(wrote.transactions >= 20);
        assert!(wrote.largest_rows <= batching.max_rows);
        assert!(wrote.largest_bytes <= batching.max_bytes);
        assert_map_matches_index(&db.conn, "a rewrite in many transactions").await;

        let mut grown = edited.clone();
        grown.push(turn("assistant", "done"));
        let wrote = index_conversation_batched(&db.conn, id, Utc::now(), &grown, &batching)
            .await
            .unwrap();
        assert_eq!(
            (wrote.deleted, wrote.written, wrote.transactions),
            (1, 2, 1),
            "the stamp of the batched rewrite holds: only the tail is rewritten"
        );
    }

    /// Search returns the same hits, in the same order with the same
    /// snippets and ranks, however the writes were cut.
    #[tokio::test]
    async fn search_results_do_not_depend_on_the_transactions() {
        let whole = WriteBatching {
            max_rows: usize::MAX,
            max_bytes: usize::MAX,
            pause: NO_PAUSE,
        };
        let one_by_one = WriteBatching {
            max_rows: 1,
            max_bytes: 1,
            pause: NO_PAUSE,
        };
        let conversations = [
            vec![
                turn("user", "why does the upload retry loop race"),
                turn("assistant", "the retry loop re-enters before the lock"),
            ],
            vec![
                turn("user", "修复登录问题，然后重新部署"),
                turn("assistant", "the db call hit a timeout in the parser"),
            ],
            vec![turn("user", "a timeout in the parser, again")],
        ];
        let mut results = Vec::new();
        for batching in [whole, one_by_one] {
            let db = fresh_in_memory_db().await;
            let folder = seed_folder(&db, "/tmp/fts-proj").await;
            for turns in &conversations {
                let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
                // Indexed twice, the second time rewritten from the first turn.
                let mut draft = turns.clone();
                draft[0] = turn("user", "a draft");
                index_conversation_batched(&db.conn, id, Utc::now(), &draft, &batching)
                    .await
                    .unwrap();
                index_conversation_batched(&db.conn, id, Utc::now(), turns, &batching)
                    .await
                    .unwrap();
            }
            let mut found = Vec::new();
            for query in ["retry loop", "parser", "timeout", "登录", "db", "draft"] {
                found.push(format!("{query}: {:?}", search(&db.conn, query).await));
            }
            results.push(found);
        }
        assert_eq!(results[0], results[1]);
        assert!(results[0][1].contains("[[mark]]parser[[/mark]]"));
        assert!(results[0][5].ends_with(": []"), "the drafts were replaced");
    }

    /// With 50K rows indexed, dropping one conversation — or its last turn,
    /// the indexer's usual delete — finds its rows by rowid and takes
    /// milliseconds; the filter on the UNINDEXED column it replaces reads the
    /// text of every row, which on a real index under memory pressure took
    /// seconds.
    #[tokio::test]
    async fn deleting_one_conversation_among_50k_rows_takes_milliseconds() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(dir.path()).await;
        let conn = &db.conn;
        let backend = conn.get_database_backend();
        for sql in [
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49999) \
             INSERT INTO message_fts (rowid, content, conversation_id, turn_idx, role) \
             SELECT i + 1, \
                    printf('turn %d of conversation %d about the upload retry loop', \
                           i % 250, i / 250 + 1), \
                    i / 250 + 1, i % 250, 'user' \
             FROM n",
            "INSERT INTO message_fts_rows (fts_rowid, conversation_id, turn_idx, bytes) \
             SELECT rowid, conversation_id, turn_idx, length(CAST(content AS BLOB)) \
             FROM message_fts",
        ] {
            conn.execute(Statement::from_string(backend, sql))
                .await
                .unwrap();
        }
        assert_eq!(saved_turn_count(conn, 7).await.unwrap(), 250);

        let started = Instant::now();
        forget_conversation(conn, 7).await.unwrap();
        let whole = started.elapsed();

        let tail = indexed_rows_from(conn, 8, 249).await.unwrap();
        assert_eq!(tail.len(), 1);
        let started = Instant::now();
        let txn = conn.begin().await.unwrap();
        delete_rows(&txn, &[tail[0].0]).await.unwrap();
        txn.commit().await.unwrap();
        let last_turn = started.elapsed();

        // The statement this replaced, rolled back so the map stays whole.
        let started = Instant::now();
        let txn = conn.begin().await.unwrap();
        txn.execute(Statement::from_string(
            backend,
            "DELETE FROM message_fts WHERE conversation_id = 9 AND turn_idx >= 249",
        ))
        .await
        .unwrap();
        let by_filter = started.elapsed();
        txn.rollback().await.unwrap();

        eprintln!(
            "50K rows: one conversation by rowid {whole:?}, its last turn {last_turn:?}; \
             the last turn by the UNINDEXED filter {by_filter:?}"
        );
        assert!(whole < Duration::from_millis(250), "{whole:?}");
        assert!(last_turn < Duration::from_millis(100), "{last_turn:?}");
        assert_eq!(saved_turn_count(conn, 7).await.unwrap(), 0);
        assert_eq!(saved_turn_count(conn, 8).await.unwrap(), 249);
        assert_eq!(saved_turn_count(conn, 9).await.unwrap(), 250);
        assert_map_matches_index(conn, "the deletes").await;
    }

    /// A pool of one connection to the database at `path` that fails a write
    /// at once when another connection holds the lock.
    async fn impatient_pool(path: &std::path::Path) -> DatabaseConnection {
        let pool = sea_orm::sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(crate::db::connect_options(path).busy_timeout(Duration::ZERO))
            .await
            .unwrap();
        sea_orm::SqlxSqliteConnector::from_sqlx_sqlite_pool(pool)
    }

    /// Another writer holding the lock makes the indexer's transaction fail as
    /// busy; it backs off, retries, and goes through once the lock is free.
    #[tokio::test]
    async fn a_busy_database_is_retried_after_a_back_off() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(dir.path()).await;
        let folder = seed_folder(&db, "/tmp/fts-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let indexer = impatient_pool(&dir.path().join("source.db")).await;

        // The app holds the write lock for a moment.
        let txn = db.conn.begin().await.unwrap();
        txn.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE conversation SET title = title WHERE id = ?",
            [id.into()],
        ))
        .await
        .unwrap();
        let err = indexer
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "UPDATE message_fts_state SET indexed_at = indexed_at",
            ))
            .await
            .unwrap_err();
        assert!(is_busy(&err), "{err:?}");
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            txn.commit().await.unwrap();
        });

        let started = Instant::now();
        let wrote = index_conversation(&indexer, id, Utc::now(), &[turn("user", "after the wait")])
            .await
            .unwrap();
        release.await.unwrap();
        assert_eq!(wrote.written, 1);
        assert!(
            started.elapsed() >= BUSY_BACKOFF,
            "it waited before retrying"
        );
        assert_eq!(ids(&search(&db.conn, "after the wait").await), [id]);

        let syntax = indexer
            .execute(Statement::from_string(DbBackend::Sqlite, "UPDATE nowhere"))
            .await
            .unwrap_err();
        assert!(!is_busy(&syntax), "only a busy database is retried");
    }

    #[test]
    fn like_patterns_take_wildcards_literally() {
        assert_eq!(like_pattern("登录"), "%登录%");
        assert_eq!(like_pattern("5%"), "%5\\%%");
        assert_eq!(like_pattern("a_\\"), "%a\\_\\\\%");
    }

    #[test]
    fn excerpt_is_cut_around_the_first_match_with_every_match_marked() {
        let words = fold_words(&["登录"]);
        let text = format!("{}登录然后再登录{}", "前".repeat(40), "后".repeat(40));
        assert_eq!(
            excerpt(&text, &words),
            format!(
                "…{}[[mark]]登录[[/mark]]然后再[[mark]]登录[[/mark]]{}…",
                "前".repeat(30),
                "后".repeat(25)
            )
        );

        // Case-insensitive, keeping the text's own case; short text is whole.
        let words = fold_words(&["db"]);
        assert_eq!(
            excerpt("The DB is down", &words),
            "The [[mark]]DB[[/mark]] is down"
        );
    }

    #[test]
    fn short_words_are_marked_outside_the_index_marks() {
        let words = fold_words(&["修复"]);
        assert_eq!(
            mark_outside_marks("…先修复[[mark]]登录问题[[/mark]]再修复…", &words),
            "…先[[mark]]修复[[/mark]][[mark]]登录问题[[/mark]]再[[mark]]修复[[/mark]]…"
        );
        assert_eq!(
            mark_outside_marks("a [[mark]]b[[/mark]]", &[]),
            "a [[mark]]b[[/mark]]"
        );
    }
}
