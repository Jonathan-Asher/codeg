//! Usage by session, thread and account, for the Token Usage page.
//!
//! The dashboard proper (`commands::token_usage`) sums turn facts. This
//! module answers the question it cannot: which threads of a session spent
//! it, and which of the pool's subscription accounts served each call.
//!
//! ## Where the numbers come from
//!
//! * **Calls** ([`calls`]): every API call of a Claude Code session — main
//!   thread and each sub-agent — read from its transcript tree, with the
//!   upstream message id and request id, priced at API list rates
//!   ([`pricing`]). Stored in `token_usage_call`; sub-agent labels in
//!   `token_usage_thread`.
//! * **Accounts** ([`pool`]): the local account pool (maxpool) records one
//!   metadata line per request it served — account, message id, request id,
//!   tokens, the account's weekly reading. codeg copies them into
//!   `usage_pool_request` and joins a call to its record by message id, else
//!   by request id.
//! * **Weekly-limit share** ([`meter`]): each meter step of an account is
//!   split over the requests since the previous step by price; what has no
//!   step yet is its price over the account's measured dollars per percent.
//!
//! Other agents (Codex, Pi, …) and Claude sessions not read since the split
//! began show their turn-fact total only, as the page always has.

pub(crate) mod assemble;
pub(crate) mod calls;
pub(crate) mod meter;
pub(crate) mod pool;
pub(crate) mod pricing;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use chrono::Utc;

use crate::app_error::AppCommandError;
use crate::db::service::token_usage_accounts_service::{self as service, AccountsQuery};
use crate::db::service::token_usage_service as usage_service;
use crate::models::token_usage::{
    TokenUsageSessionItem, TokenUsageSessionsQuery, TokenUsageSessionsReport, TokenUsageThreadItem,
};

const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 50;
/// Transcript trees written to in this window are read for calls: the
/// pool's records (35 days) plus a margin.
pub(crate) const CALL_WINDOW_DAYS: i64 = 40;
/// How long a page request spends catching calls up, and reading the
/// pool, before it answers with what it has.
const REQUEST_CALL_BUDGET: Duration = Duration::from_secs(6);
const REQUEST_POOL_BUDGET: Duration = Duration::from_secs(6);
/// The same, for the dashboard's sync pass.
pub(crate) const SYNC_CALL_BUDGET: Duration = Duration::from_secs(45);

/// Catch calls and pool records up — the tail of a dashboard sync.
///
/// Not in unit tests: it would read this machine's Claude transcripts and
/// its pool. Its parts are tested on their own.
pub(crate) async fn sync_after_turns(conn: &sea_orm::DatabaseConnection) {
    if cfg!(test) {
        return;
    }
    let cutoff = Utc::now() - chrono::Duration::days(CALL_WINDOW_DAYS);
    if let Err(e) =
        calls::sync_claude_calls(conn, Some(cutoff), Some(Instant::now() + SYNC_CALL_BUDGET)).await
    {
        tracing::warn!(error = %e, "token usage: Claude call sync failed");
    }
    pool::refresh_pool(conn, Instant::now() + REQUEST_POOL_BUDGET).await;
}

pub async fn token_usage_sessions_core(
    conn: &sea_orm::DatabaseConnection,
    query: TokenUsageSessionsQuery,
) -> Result<TokenUsageSessionsReport, AppCommandError> {
    let cutoff = Utc::now() - chrono::Duration::days(CALL_WINDOW_DAYS);
    let synced = calls::sync_claude_calls(
        conn,
        Some(cutoff),
        Some(Instant::now() + REQUEST_CALL_BUDGET),
    )
    .await?;
    let pool_state = pool::refresh_pool(conn, Instant::now() + REQUEST_POOL_BUDGET).await;
    build_sessions_report(conn, query, pool_state, synced.remaining).await
}

/// The report from what is stored now — no transcript read, no pool read.
pub(crate) async fn build_sessions_report(
    conn: &sea_orm::DatabaseConnection,
    query: TokenUsageSessionsQuery,
    pool_state: crate::models::token_usage::TokenUsagePoolState,
    indexing: bool,
) -> Result<TokenUsageSessionsReport, AppCommandError> {
    let filter = &query.filter;
    let folder_ids = match filter.folder_ids {
        Some(ref ids) if ids.is_empty() => Some(Vec::new()),
        Some(ref ids) => Some(
            usage_service::expand_folder_ids(conn, ids)
                .await
                .map_err(AppCommandError::from)?,
        ),
        None => None,
    };
    let q = AccountsQuery {
        start: filter.start,
        end: filter.end,
        folder_ids,
        agent_types: filter.agent_types.clone(),
        models: filter.models.clone(),
    };
    let groups = service::call_groups(conn, &q)
        .await
        .map_err(AppCommandError::from)?;
    let turns = service::turn_totals(conn, &q)
        .await
        .map_err(AppCommandError::from)?;
    let mut ids: Vec<i32> = turns
        .iter()
        .map(|t| t.conversation_id)
        .chain(groups.iter().map(|g| g.conversation_id))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    let has_calls = service::conversations_with_calls(conn, &ids)
        .await
        .map_err(AppCommandError::from)?;
    let selected: Option<HashSet<String>> = query.accounts.map(|v| v.into_iter().collect());
    let limit = query
        .limit
        .map_or(DEFAULT_LIMIT, |l| l as usize)
        .clamp(1, MAX_LIMIT);
    let drafts = assemble::rank_sessions(&turns, &groups, &has_calls, selected.as_ref(), limit);

    let top: Vec<i32> = drafts.iter().map(|d| d.conversation_id).collect();
    let labels = usage_service::conversation_labels(conn, &top)
        .await
        .map_err(AppCommandError::from)?;
    let thread_rows = service::threads_of(conn, &top)
        .await
        .map_err(AppCommandError::from)?;
    let thread_labels: HashMap<(i32, String), (Option<String>, Option<String>)> = thread_rows
        .into_iter()
        .map(|t| ((t.conversation_id, t.thread_key), (t.label, t.agent_type)))
        .collect();

    let sessions = drafts
        .into_iter()
        .map(|d| {
            let (title, agent_type, folder_label) = labels
                .get(&d.conversation_id)
                .cloned()
                .unwrap_or((None, d.agent_type.clone().unwrap_or_default(), None));
            let threads = d
                .threads
                .into_iter()
                .map(|t| {
                    let (label, agent) = thread_labels
                        .get(&(d.conversation_id, t.key.clone()))
                        .cloned()
                        .unwrap_or((None, None));
                    TokenUsageThreadItem {
                        main: t.key.is_empty(),
                        key: t.key,
                        label,
                        agent_type: agent,
                        usage: t.usage,
                        by_account: t.by_account,
                    }
                })
                .collect();
            TokenUsageSessionItem {
                conversation_id: d.conversation_id,
                title,
                agent_type,
                folder_label,
                last_activity_at: d.last_activity_at,
                usage: d.usage,
                detail: d.detail,
                by_account: d.by_account,
                threads,
            }
        })
        .collect();

    let pool_totals = service::pool_totals(conn, filter.start, filter.end)
        .await
        .map_err(AppCommandError::from)?;
    let rates = pool::measured_rates(conn).await?;
    let accounts =
        assemble::account_items(&groups, &pool_totals, &rates, meter::BASELINE_USD_PER_PCT);

    Ok(TokenUsageSessionsReport {
        pool: pool_state,
        accounts,
        sessions,
        indexing,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn token_usage_sessions(
    db: tauri::State<'_, crate::db::AppDatabase>,
    query: TokenUsageSessionsQuery,
) -> Result<TokenUsageSessionsReport, AppCommandError> {
    token_usage_sessions_core(&db.conn, query).await
}
