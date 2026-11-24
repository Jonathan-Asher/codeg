//! Copy the pool's request records into the database and keep each
//! request's share of its account's weekly limit current.
//!
//! The pool keeps 35 days of records; codeg reads what it has not seen yet
//! (from the newest record held, less an overlap the unique record id
//! absorbs) whenever the usage page asks, at most every
//! [`PULL_MIN_GAP`], and then recomputes the shares that were still
//! estimates ([`super::meter`]).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sea_orm::{ActiveValue::NotSet, Set};

use super::meter::{self, MeterInput, MeterStart, PctSource, BASELINE_USD_PER_PCT};
use super::pricing::{self, CallTokens};
use crate::app_error::AppCommandError;
use crate::commands::usage_pool::records::{self, PoolRecord, RecordsError};
use crate::db::entities::usage_pool_request;
use crate::db::service::app_metadata_service;
use crate::db::service::token_usage_accounts_service::{self as service, ShareUpdate};
use crate::models::token_usage::TokenUsagePoolState;

/// The newest record time held, epoch ms.
const PULLED_UNTIL_KEY: &str = "token_usage_pool_pulled_ms";
/// Re-read this far back each time: records from a second worker during a
/// pool reload can land slightly out of order.
const PULL_OVERLAP_MS: i64 = 5 * 60_000;
/// The pool's own retention.
const POOL_RETENTION_DAYS: i64 = 35;
/// Records older than this are dropped from the database.
const KEEP_DAYS: i64 = 40;
pub(crate) const PULL_MIN_GAP: Duration = Duration::from_secs(10);
/// Dollars per percent is measured over this many days of meter steps.
const RATE_WINDOW_DAYS: i64 = 7;

struct PullMemo {
    at: Option<Instant>,
    state: TokenUsagePoolState,
}

static MEMO: Mutex<PullMemo> = Mutex::new(PullMemo {
    at: None,
    state: TokenUsagePoolState {
        configured: false,
        reachable: false,
        error: None,
        last_pulled_at: None,
        records_since: None,
    },
});

static PULL_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn memo_state() -> (Option<Instant>, TokenUsagePoolState) {
    let memo = MEMO.lock().unwrap_or_else(|p| p.into_inner());
    (memo.at, memo.state.clone())
}

fn set_memo(state: &TokenUsagePoolState) {
    let mut memo = MEMO.lock().unwrap_or_else(|p| p.into_inner());
    memo.at = Some(Instant::now());
    memo.state = state.clone();
}

/// A stored row for one pool record. Calls through a linked pool, which
/// sees only its own share of the account's traffic, are estimated from
/// their price at once; provider calls have no weekly meter.
pub(crate) fn row_of(record: &PoolRecord) -> Option<usage_pool_request::ActiveModel> {
    let ts = record.ts?;
    let occurred_at = DateTime::<Utc>::from_timestamp_millis(ts)?;
    let tokens = CallTokens {
        input: record.input.unwrap_or(0),
        output: record.output.unwrap_or(0),
        cache_read: record.cache_read.unwrap_or(0),
        cache_write_5m: record.cache_write5m.unwrap_or(0),
        cache_write_1h: record.cache_write1h.unwrap_or(0),
    };
    let cost = pricing::cost_usd(record.model.as_deref(), &tokens);
    let kind = record.kind.clone().unwrap_or_else(|| "claude".to_string());
    let (pct, source) = match kind.as_str() {
        "link" => (
            Some(cost.unwrap_or(0.0) / BASELINE_USD_PER_PCT),
            PctSource::Estimate,
        ),
        "provider" => (None, PctSource::Estimate),
        _ => (None, PctSource::Pending),
    };
    let i = |v: u64| v.min(i64::MAX as u64) as i64;
    Some(usage_pool_request::ActiveModel {
        id: NotSet,
        record_id: Set(record.id.clone()?),
        occurred_at: Set(occurred_at),
        account: Set(record.account.clone()?),
        account_kind: Set(kind),
        link_row: Set(record.link_row.clone()),
        model: Set(record.model.clone()),
        message_id: Set(record.message_id.clone()),
        request_id: Set(record.request_id.clone()),
        session_id: Set(record.session_id.clone()),
        input_tokens: Set(i(tokens.input)),
        output_tokens: Set(i(tokens.output)),
        cache_read_tokens: Set(i(tokens.cache_read)),
        cache_write_5m_tokens: Set(i(tokens.cache_write_5m)),
        cache_write_1h_tokens: Set(i(tokens.cache_write_1h)),
        util7d: Set(record.util7d),
        util7d_prev: Set(record.util7d_prev),
        reset7d_ms: Set(record.reset7d),
        cost_usd: Set(cost),
        pct: Set(pct),
        pct_source: Set(source as i32),
        meter_level: Set(None),
    })
}

/// Each account's dollars per percent, measured from its own meter steps
/// over the last week; accounts with too little movement are absent.
pub(crate) async fn measured_rates(
    conn: &sea_orm::DatabaseConnection,
) -> Result<HashMap<String, f64>, AppCommandError> {
    let since = Utc::now() - chrono::Duration::days(RATE_WINDOW_DAYS);
    let totals = service::metered_totals(conn, since)
        .await
        .map_err(AppCommandError::from)?;
    Ok(totals
        .into_iter()
        .filter_map(|(account, cost, pct)| {
            meter::measured_usd_per_pct(cost, pct).map(|rate| (account, rate))
        })
        .collect())
}

/// Recompute every share that is still an estimate.
pub(crate) async fn recompute_shares(
    conn: &sea_orm::DatabaseConnection,
) -> Result<(), AppCommandError> {
    let rates = measured_rates(conn).await?;
    let accounts = service::accounts_with_pending_shares(conn)
        .await
        .map_err(AppCommandError::from)?;
    for account in accounts {
        let (before, rows) = service::meter_window(conn, &account)
            .await
            .map_err(AppCommandError::from)?;
        if rows.is_empty() {
            continue;
        }
        let start = match &before {
            Some(b) => MeterStart {
                level: b.meter_level,
                reset_ms: b.reset7d_ms,
            },
            None => MeterStart {
                level: rows[0].util7d_prev.map(|u| u * 100.0),
                reset_ms: None,
            },
        };
        let inputs: Vec<MeterInput> = rows
            .iter()
            .map(|r| MeterInput {
                id: r.id as i64,
                cost_usd: r.cost_usd.unwrap_or(0.0),
                util: r.util7d,
                reset_ms: r.reset7d_ms,
            })
            .collect();
        let rate = rates.get(&account).copied().unwrap_or(BASELINE_USD_PER_PCT);
        let shares = meter::distribute(&inputs, start, rate);
        let updates: Vec<ShareUpdate> = rows
            .iter()
            .zip(shares)
            .filter(|(row, s)| {
                row.pct.is_none_or(|p| (p - s.pct).abs() > 1e-12)
                    || row.pct_source != s.source as i32
                    || row.meter_level != s.level
            })
            .map(|(row, s)| ShareUpdate {
                id: row.id,
                pct: s.pct,
                pct_source: s.source as i32,
                meter_level: s.level,
            })
            .collect();
        service::write_shares(conn, &updates)
            .await
            .map_err(AppCommandError::from)?;
    }
    Ok(())
}

/// Read the pool's new records (until `deadline`) and recompute shares.
/// A read within [`PULL_MIN_GAP`] of the last one answers from memory.
pub(crate) async fn refresh_pool(
    conn: &sea_orm::DatabaseConnection,
    deadline: Instant,
) -> TokenUsagePoolState {
    let (at, state) = memo_state();
    if at.is_some_and(|t| t.elapsed() < PULL_MIN_GAP) {
        return with_coverage(conn, state).await;
    }
    let Ok(_guard) = PULL_GUARD.try_lock() else {
        return with_coverage(conn, state).await;
    };
    let state = pull(conn, deadline).await;
    set_memo(&state);
    if state.configured {
        if let Err(e) = recompute_shares(conn).await {
            tracing::warn!(error = %e, "token usage: failed to recompute weekly-limit shares");
        }
        let _ =
            service::prune_pool_records(conn, Utc::now() - chrono::Duration::days(KEEP_DAYS)).await;
    }
    with_coverage(conn, state).await
}

async fn with_coverage(
    conn: &sea_orm::DatabaseConnection,
    mut state: TokenUsagePoolState,
) -> TokenUsagePoolState {
    state.records_since = service::oldest_pool_record(conn).await.ok().flatten();
    state
}

async fn pull(conn: &sea_orm::DatabaseConnection, deadline: Instant) -> TokenUsagePoolState {
    let config = match records::pool_config() {
        Ok(config) => config,
        Err(RecordsError::NotConfigured) => return TokenUsagePoolState::default(),
        Err(e) => {
            return TokenUsagePoolState {
                configured: true,
                error: Some(e.code().to_string()),
                ..Default::default()
            }
        }
    };
    let now_ms = Utc::now().timestamp_millis();
    let held: Option<i64> = app_metadata_service::get_value(conn, PULLED_UNTIL_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok());
    let floor = now_ms - POOL_RETENTION_DAYS * 86_400_000;
    let since = held.map_or(floor, |h| (h - PULL_OVERLAP_MS).max(floor));
    let mut newest = held.unwrap_or(0);
    let mut cursor: Option<String> = None;
    let mut state = TokenUsagePoolState {
        configured: true,
        ..Default::default()
    };
    loop {
        match records::fetch_page(&config, since, cursor.as_deref()).await {
            Ok(page) => {
                state.reachable = true;
                let rows: Vec<_> = page.records.iter().filter_map(row_of).collect();
                if let Err(e) = service::insert_pool_records(conn, rows).await {
                    tracing::warn!(error = %e, "token usage: failed to store pool records");
                    state.error = Some("store_failed".to_string());
                    break;
                }
                // Only what is stored moves the mark, so a failed write is
                // read again next time.
                newest = newest.max(page.records.iter().filter_map(|r| r.ts).max().unwrap_or(0));
                cursor = page.next;
                if cursor.is_none() || Instant::now() >= deadline {
                    break;
                }
            }
            Err(e) => {
                state.reachable = false;
                state.error = Some(e.code().to_string());
                break;
            }
        }
    }
    if newest > held.unwrap_or(0) {
        let _ =
            app_metadata_service::upsert_value(conn, PULLED_UNTIL_KEY, &newest.to_string()).await;
    }
    if state.reachable {
        state.last_pulled_at = Some(Utc::now());
    }
    state
}
