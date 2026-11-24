//! Storage for the usage page's per-thread and per-account split.
//!
//! * **calls** — [`replace_conversation_calls`] swaps one Claude
//!   conversation's call rows and thread labels for a freshly read set, and
//!   stamps the main thread's row with what was read.
//! * **pool records** — [`insert_pool_records`] adds the account pool's
//!   request records (a re-read overlap inserts nothing twice), and the
//!   meter helpers read and rewrite one account's shares.
//! * **reads** — [`call_groups`], [`turn_totals`] and [`pool_totals`] answer
//!   the session list with GROUP BY aggregates; the command layer assembles
//!   them (`commands::token_usage_accounts`).
//!
//! Every read joins `conversation` for folder, agent and soft delete, as the
//! token dashboard does.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Set, Statement, TransactionTrait, Value,
};

use crate::db::entities::{token_usage_call, token_usage_thread, usage_pool_request};
use crate::db::error::DbError;

/// Rows per `INSERT`: thirteen columns each, well under SQLite's bound
/// parameter limit.
const INSERT_CHUNK: usize = 150;

/// A Claude conversation the call sync may need to read.
#[derive(Debug, Clone, PartialEq)]
pub struct CallSyncCandidate {
    pub conversation_id: i32,
    pub external_id: String,
    pub source_path: Option<String>,
    pub source_fingerprint: Option<String>,
    pub schema_version: Option<i32>,
    /// When the calls were last read, as SQLite returned it.
    pub synced_at: Option<String>,
}

/// Live Claude Code conversations that name a session, with the call
/// sync's stamp when there is one.
pub async fn call_sync_candidates(
    conn: &DatabaseConnection,
) -> Result<Vec<CallSyncCandidate>, DbError> {
    let rows = conn
        .query_all(Statement::from_string(
            conn.get_database_backend(),
            "SELECT cv.id, cv.external_id, th.source_path, th.source_fingerprint, th.schema_version, \
                    th.synced_at \
             FROM conversation cv \
             LEFT JOIN token_usage_thread th ON th.conversation_id = cv.id AND th.thread_key = '' \
             WHERE cv.deleted_at IS NULL AND cv.agent_type = 'claude_code' \
               AND cv.external_id IS NOT NULL AND cv.external_id != ''"
                .to_owned(),
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(CallSyncCandidate {
                conversation_id: row.try_get_by_index(0)?,
                external_id: row.try_get_by_index(1)?,
                source_path: row.try_get_by_index(2)?,
                source_fingerprint: row.try_get_by_index(3)?,
                schema_version: row.try_get_by_index(4)?,
                synced_at: row.try_get_by_index(5)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(DbError::from)
}

/// One call, ready to persist.
#[derive(Debug, Clone, PartialEq)]
pub struct CallRow {
    pub thread_key: String,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_5m_tokens: i64,
    pub cache_write_1h_tokens: i64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThreadRow {
    pub thread_key: String,
    pub label: Option<String>,
    pub agent_type: Option<String>,
    pub parent_key: Option<String>,
}

/// What the call sync read, stamped on the main thread's row.
#[derive(Debug, Clone, PartialEq)]
pub struct CallStamp {
    pub source_path: String,
    pub source_fingerprint: String,
    pub schema_version: i32,
}

/// Swap a conversation's calls and threads for a fresh set, in one
/// transaction: a crash mid-write can never leave it counted twice or
/// stamped while its rows are missing.
pub async fn replace_conversation_calls(
    conn: &DatabaseConnection,
    conversation_id: i32,
    calls: &[CallRow],
    threads: &[ThreadRow],
    stamp: &CallStamp,
) -> Result<(), DbError> {
    let now = Utc::now();
    let txn = conn.begin().await?;
    token_usage_call::Entity::delete_many()
        .filter(token_usage_call::Column::ConversationId.eq(conversation_id))
        .exec(&txn)
        .await?;
    token_usage_thread::Entity::delete_many()
        .filter(token_usage_thread::Column::ConversationId.eq(conversation_id))
        .exec(&txn)
        .await?;
    for chunk in calls.chunks(INSERT_CHUNK) {
        let rows: Vec<token_usage_call::ActiveModel> = chunk
            .iter()
            .map(|c| token_usage_call::ActiveModel {
                id: NotSet,
                conversation_id: Set(conversation_id),
                thread_key: Set(c.thread_key.clone()),
                message_id: Set(c.message_id.clone()),
                request_id: Set(c.request_id.clone()),
                occurred_at: Set(c.occurred_at),
                model: Set(c.model.clone()),
                input_tokens: Set(c.input_tokens),
                output_tokens: Set(c.output_tokens),
                cache_read_tokens: Set(c.cache_read_tokens),
                cache_write_5m_tokens: Set(c.cache_write_5m_tokens),
                cache_write_1h_tokens: Set(c.cache_write_1h_tokens),
                cost_usd: Set(c.cost_usd),
            })
            .collect();
        token_usage_call::Entity::insert_many(rows)
            .exec(&txn)
            .await?;
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut thread_rows: Vec<token_usage_thread::ActiveModel> = Vec::new();
    // The main thread's row is the stamp, written even for a session with
    // no calls yet.
    thread_rows.push(token_usage_thread::ActiveModel {
        conversation_id: Set(conversation_id),
        thread_key: Set(String::new()),
        label: Set(None),
        agent_type: Set(None),
        parent_key: Set(None),
        source_path: Set(Some(stamp.source_path.clone())),
        source_fingerprint: Set(Some(stamp.source_fingerprint.clone())),
        schema_version: Set(stamp.schema_version),
        synced_at: Set(now),
    });
    seen.insert("");
    for t in threads {
        if !seen.insert(t.thread_key.as_str()) {
            continue;
        }
        thread_rows.push(token_usage_thread::ActiveModel {
            conversation_id: Set(conversation_id),
            thread_key: Set(t.thread_key.clone()),
            label: Set(t.label.clone()),
            agent_type: Set(t.agent_type.clone()),
            parent_key: Set(t.parent_key.clone()),
            source_path: Set(None),
            source_fingerprint: Set(None),
            schema_version: Set(stamp.schema_version),
            synced_at: Set(now),
        });
    }
    for chunk in thread_rows.chunks(INSERT_CHUNK) {
        token_usage_thread::Entity::insert_many(chunk.to_vec())
            .exec(&txn)
            .await?;
    }
    txn.commit().await?;
    Ok(())
}

/// Add pool records; a record already held (same pool record id) is left
/// as it is.
pub async fn insert_pool_records(
    conn: &DatabaseConnection,
    rows: Vec<usage_pool_request::ActiveModel>,
) -> Result<(), DbError> {
    if rows.is_empty() {
        return Ok(());
    }
    let txn = conn.begin().await?;
    let mut rows = rows;
    while !rows.is_empty() {
        let rest = rows.split_off(rows.len().min(INSERT_CHUNK));
        usage_pool_request::Entity::insert_many(rows)
            .on_conflict(
                OnConflict::column(usage_pool_request::Column::RecordId)
                    .do_nothing()
                    .to_owned(),
            )
            .do_nothing()
            .exec(&txn)
            .await?;
        rows = rest;
    }
    txn.commit().await?;
    Ok(())
}

/// Accounts with requests whose share of the weekly limit is still an
/// estimate the next meter step revises.
pub async fn accounts_with_pending_shares(
    conn: &DatabaseConnection,
) -> Result<Vec<String>, DbError> {
    let rows: Vec<String> = usage_pool_request::Entity::find()
        .select_only()
        .column(usage_pool_request::Column::Account)
        .filter(usage_pool_request::Column::AccountKind.eq("claude"))
        .filter(usage_pool_request::Column::PctSource.eq(0))
        .distinct()
        .into_tuple()
        .all(conn)
        .await?;
    Ok(rows)
}

/// One account's requests from its first pending one on (oldest first),
/// and the final request before them, where the meter resumes.
pub async fn meter_window(
    conn: &DatabaseConnection,
    account: &str,
) -> Result<
    (
        Option<usage_pool_request::Model>,
        Vec<usage_pool_request::Model>,
    ),
    DbError,
> {
    let first = usage_pool_request::Entity::find()
        .filter(usage_pool_request::Column::Account.eq(account))
        .filter(usage_pool_request::Column::AccountKind.eq("claude"))
        .filter(usage_pool_request::Column::PctSource.eq(0))
        .order_by_asc(usage_pool_request::Column::OccurredAt)
        .order_by_asc(usage_pool_request::Column::Id)
        .one(conn)
        .await?;
    let Some(first) = first else {
        return Ok((None, Vec::new()));
    };
    let before = usage_pool_request::Entity::find()
        .filter(usage_pool_request::Column::Account.eq(account))
        .filter(usage_pool_request::Column::AccountKind.eq("claude"))
        .filter(usage_pool_request::Column::PctSource.ne(0))
        .filter(usage_pool_request::Column::OccurredAt.lte(first.occurred_at))
        .filter(usage_pool_request::Column::Id.ne(first.id))
        .order_by_desc(usage_pool_request::Column::OccurredAt)
        .order_by_desc(usage_pool_request::Column::Id)
        .one(conn)
        .await?;
    let rows = usage_pool_request::Entity::find()
        .filter(usage_pool_request::Column::Account.eq(account))
        .filter(usage_pool_request::Column::AccountKind.eq("claude"))
        .filter(usage_pool_request::Column::OccurredAt.gte(first.occurred_at))
        .order_by_asc(usage_pool_request::Column::OccurredAt)
        .order_by_asc(usage_pool_request::Column::Id)
        .all(conn)
        .await?;
    Ok((before, rows))
}

/// One request's recomputed share.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareUpdate {
    pub id: i32,
    pub pct: f64,
    pub pct_source: i32,
    pub meter_level: Option<f64>,
}

pub async fn write_shares(
    conn: &DatabaseConnection,
    updates: &[ShareUpdate],
) -> Result<(), DbError> {
    if updates.is_empty() {
        return Ok(());
    }
    let txn = conn.begin().await?;
    for u in updates {
        txn.execute(Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE usage_pool_request SET pct = ?, pct_source = ?, meter_level = ? WHERE id = ?",
            [
                u.pct.into(),
                u.pct_source.into(),
                u.meter_level.into(),
                u.id.into(),
            ],
        ))
        .await?;
    }
    txn.commit().await?;
    Ok(())
}

/// The summed price and percent of an account's metered requests since
/// `since` — what its dollars per percent is measured from.
pub async fn metered_totals(
    conn: &DatabaseConnection,
    since: DateTime<Utc>,
) -> Result<Vec<(String, f64, f64)>, DbError> {
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            "SELECT account, COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(pct), 0.0) \
             FROM usage_pool_request \
             WHERE account_kind = 'claude' AND pct_source = 1 AND occurred_at >= ? \
             GROUP BY account",
            [since.into()],
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get_by_index(0)?,
                row.try_get_by_index(1)?,
                row.try_get_by_index(2)?,
            ))
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(DbError::from)
}

/// The window and the dimension filters every read shares.
#[derive(Debug, Clone, Default)]
pub struct AccountsQuery {
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    pub folder_ids: Option<Vec<i32>>,
    pub agent_types: Option<Vec<String>>,
    pub models: Option<Vec<String>>,
}

impl AccountsQuery {
    fn is_empty_selection(&self) -> bool {
        self.folder_ids.as_ref().is_some_and(|v| v.is_empty())
            || self.agent_types.as_ref().is_some_and(|v| v.is_empty())
            || self.models.as_ref().is_some_and(|v| v.is_empty())
    }

    /// ` AND …` clauses for a fact table aliased `alias` joined to `cv`.
    fn clauses(&self, alias: &str, values: &mut Vec<Value>) -> String {
        let mut sql = String::new();
        if let Some(start) = self.start {
            sql.push_str(&format!(" AND {alias}.occurred_at >= ?"));
            values.push(start.into());
        }
        if let Some(end) = self.end {
            sql.push_str(&format!(" AND {alias}.occurred_at < ?"));
            values.push(end.into());
        }
        let mut list = |column: &str, items: Vec<Value>, sql: &mut String| {
            let marks = vec!["?"; items.len()].join(", ");
            sql.push_str(&format!(" AND {column} IN ({marks})"));
            values.extend(items);
        };
        if let Some(ids) = &self.folder_ids {
            list(
                "cv.folder_id",
                ids.iter().map(|v| (*v).into()).collect(),
                &mut sql,
            );
        }
        if let Some(agents) = &self.agent_types {
            list(
                "cv.agent_type",
                agents.iter().map(|v| v.clone().into()).collect(),
                &mut sql,
            );
        }
        if let Some(models) = &self.models {
            list(
                &format!("{alias}.model"),
                models.iter().map(|v| v.clone().into()).collect(),
                &mut sql,
            );
        }
        sql
    }
}

/// Calls summed by conversation, thread and the account that served them
/// (`None` when no pool record matched).
#[derive(Debug, Clone, PartialEq)]
pub struct CallGroup {
    pub conversation_id: i32,
    pub thread_key: String,
    pub account: Option<String>,
    pub account_kind: Option<String>,
    pub calls: i64,
    pub tokens: i64,
    pub cost_usd: Option<f64>,
    pub pct: Option<f64>,
    pub last_at: Option<String>,
}

/// The join: a call matches the pool record with its message id, else one
/// with its request id that carries no message id.
pub async fn call_groups(
    conn: &DatabaseConnection,
    q: &AccountsQuery,
) -> Result<Vec<CallGroup>, DbError> {
    if q.is_empty_selection() {
        return Ok(Vec::new());
    }
    let mut values: Vec<Value> = Vec::new();
    let filters = q.clauses("c", &mut values);
    let sql = format!(
        "SELECT c.conversation_id, c.thread_key, \
                COALESCE(pm.account, pr.account), COALESCE(pm.account_kind, pr.account_kind), \
                COUNT(*), \
                SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens), \
                SUM(c.cost_usd), SUM(COALESCE(pm.pct, pr.pct)), MAX(c.occurred_at) \
         FROM token_usage_call c \
         JOIN conversation cv ON cv.id = c.conversation_id \
         LEFT JOIN usage_pool_request pm ON c.message_id IS NOT NULL AND pm.message_id = c.message_id \
         LEFT JOIN usage_pool_request pr ON pm.id IS NULL AND c.request_id IS NOT NULL \
              AND pr.request_id = c.request_id AND pr.message_id IS NULL \
         WHERE cv.deleted_at IS NULL{filters} \
         GROUP BY c.conversation_id, c.thread_key, \
                  COALESCE(pm.account, pr.account), COALESCE(pm.account_kind, pr.account_kind)"
    );
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            sql,
            values,
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(CallGroup {
                conversation_id: row.try_get_by_index(0)?,
                thread_key: row.try_get_by_index(1)?,
                account: row.try_get_by_index(2)?,
                account_kind: row.try_get_by_index(3)?,
                calls: row.try_get_by_index(4)?,
                tokens: row.try_get_by_index::<Option<i64>>(5)?.unwrap_or(0),
                cost_usd: row.try_get_by_index(6)?,
                pct: row.try_get_by_index(7)?,
                last_at: row.try_get_by_index(8)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(DbError::from)
}

/// One conversation's turn facts in the window — the dashboard's own total.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnTotal {
    pub conversation_id: i32,
    pub agent_type: String,
    pub tokens: i64,
    pub last_at: Option<String>,
}

pub async fn turn_totals(
    conn: &DatabaseConnection,
    q: &AccountsQuery,
) -> Result<Vec<TurnTotal>, DbError> {
    if q.is_empty_selection() {
        return Ok(Vec::new());
    }
    let mut values: Vec<Value> = Vec::new();
    let filters = q.clauses("t", &mut values);
    let sql = format!(
        "SELECT t.conversation_id, cv.agent_type, SUM(t.total_tokens), MAX(t.occurred_at) \
         FROM token_usage_turn t JOIN conversation cv ON cv.id = t.conversation_id \
         WHERE cv.deleted_at IS NULL{filters} \
         GROUP BY t.conversation_id, cv.agent_type"
    );
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            sql,
            values,
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(TurnTotal {
                conversation_id: row.try_get_by_index(0)?,
                agent_type: row.try_get_by_index(1)?,
                tokens: row.try_get_by_index::<Option<i64>>(2)?.unwrap_or(0),
                last_at: row.try_get_by_index(3)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(DbError::from)
}

/// Conversations whose calls have been read at least once.
pub async fn conversations_with_calls(
    conn: &DatabaseConnection,
    ids: &[i32],
) -> Result<HashSet<i32>, DbError> {
    let mut out = HashSet::new();
    for chunk in ids.chunks(500) {
        let found: Vec<i32> = token_usage_thread::Entity::find()
            .select_only()
            .column(token_usage_thread::Column::ConversationId)
            .filter(token_usage_thread::Column::ThreadKey.eq(""))
            .filter(token_usage_thread::Column::ConversationId.is_in(chunk.to_vec()))
            .into_tuple()
            .all(conn)
            .await?;
        out.extend(found);
    }
    Ok(out)
}

/// Thread labels of the given conversations.
pub async fn threads_of(
    conn: &DatabaseConnection,
    ids: &[i32],
) -> Result<Vec<token_usage_thread::Model>, DbError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(token_usage_thread::Entity::find()
        .filter(token_usage_thread::Column::ConversationId.is_in(ids.to_vec()))
        .all(conn)
        .await?)
}

/// Every request the pool served in the window, by account.
#[derive(Debug, Clone, PartialEq)]
pub struct PoolTotal {
    pub account: String,
    pub account_kind: String,
    pub calls: i64,
    pub cost_usd: f64,
    pub pct: f64,
    pub metered_pct: f64,
}

pub async fn pool_totals(
    conn: &DatabaseConnection,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
) -> Result<Vec<PoolTotal>, DbError> {
    let mut values: Vec<Value> = Vec::new();
    let mut sql = String::from(
        "SELECT account, account_kind, COUNT(*), COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(pct), 0.0), \
                COALESCE(SUM(CASE WHEN pct_source = 1 THEN pct END), 0.0) \
         FROM usage_pool_request WHERE 1 = 1",
    );
    if let Some(start) = start {
        sql.push_str(" AND occurred_at >= ?");
        values.push(start.into());
    }
    if let Some(end) = end {
        sql.push_str(" AND occurred_at < ?");
        values.push(end.into());
    }
    sql.push_str(" GROUP BY account, account_kind");
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            conn.get_database_backend(),
            sql,
            values,
        ))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PoolTotal {
                account: row.try_get_by_index(0)?,
                account_kind: row.try_get_by_index(1)?,
                calls: row.try_get_by_index(2)?,
                cost_usd: row.try_get_by_index(3)?,
                pct: row.try_get_by_index(4)?,
                metered_pct: row.try_get_by_index(5)?,
            })
        })
        .collect::<Result<Vec<_>, sea_orm::DbErr>>()
        .map_err(DbError::from)
}

/// The oldest pool record held — where the account split starts.
pub async fn oldest_pool_record(
    conn: &DatabaseConnection,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let first: Option<DateTime<Utc>> = usage_pool_request::Entity::find()
        .select_only()
        .column(usage_pool_request::Column::OccurredAt)
        .order_by_asc(usage_pool_request::Column::OccurredAt)
        .into_tuple()
        .one(conn)
        .await?;
    Ok(first)
}

/// Pool records older than `before` go: the pool itself keeps 35 days, and
/// a held copy past that only grows the database.
pub async fn prune_pool_records(
    conn: &DatabaseConnection,
    before: DateTime<Utc>,
) -> Result<u64, DbError> {
    let res = usage_pool_request::Entity::delete_many()
        .filter(usage_pool_request::Column::OccurredAt.lt(before))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}
