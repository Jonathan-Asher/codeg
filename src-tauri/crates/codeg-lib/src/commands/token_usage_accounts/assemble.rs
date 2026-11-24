//! Fold the stored aggregates into the session list and the account
//! legend. Pure functions over what the queries returned, so the ranking,
//! the account filter and the sums are exactly testable.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, NaiveDateTime, Utc};

use crate::db::service::token_usage_accounts_service::{CallGroup, PoolTotal, TurnTotal};
use crate::models::token_usage::{
    TokenUsageAccountItem, TokenUsageAccountShare, TokenUsageSlice, TOKEN_USAGE_NO_ACCOUNT,
};

fn add_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    }
}

pub(crate) fn add_slice(into: &mut TokenUsageSlice, other: &TokenUsageSlice) {
    into.tokens = into.tokens.saturating_add(other.tokens);
    into.calls = into.calls.saturating_add(other.calls);
    into.cost_usd = add_opt(into.cost_usd, other.cost_usd);
    into.pct = add_opt(into.pct, other.pct);
}

fn slice_of(g: &CallGroup) -> TokenUsageSlice {
    TokenUsageSlice {
        tokens: g.tokens.max(0) as u64,
        cost_usd: g.cost_usd,
        pct: g.pct,
        calls: g.calls.max(0) as u64,
    }
}

fn account_key(g: &CallGroup) -> &str {
    g.account.as_deref().unwrap_or(TOKEN_USAGE_NO_ACCOUNT)
}

/// A stored timestamp, in any of the text forms SQLite hands back.
pub(crate) fn parse_stored_time(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let raw = raw?.trim();
    if let Ok(t) = DateTime::parse_from_rfc3339(raw) {
        return Some(t.with_timezone(&Utc));
    }
    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f%:z",
        "%Y-%m-%d %H:%M:%S%.f %:z",
        "%Y-%m-%d %H:%M:%S%.f%z",
    ] {
        if let Ok(t) = DateTime::parse_from_str(raw, fmt) {
            return Some(t.with_timezone(&Utc));
        }
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f")
        .ok()
        .map(|n| n.and_utc())
}

fn later(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// One thread of a session before labels are attached.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ThreadDraft {
    pub key: String,
    pub usage: TokenUsageSlice,
    pub by_account: Vec<TokenUsageAccountShare>,
}

/// One session before titles and labels are attached.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionDraft {
    pub conversation_id: i32,
    /// From the turn facts; the command layer fills it for call-only rows.
    pub agent_type: Option<String>,
    pub usage: TokenUsageSlice,
    pub detail: bool,
    pub by_account: Vec<TokenUsageAccountShare>,
    pub threads: Vec<ThreadDraft>,
    pub last_activity_at: Option<DateTime<Utc>>,
}

/// Accounts largest first (by price, then tokens), the unmatched bucket
/// last; ties by name so repeated requests agree.
fn sorted_shares(map: BTreeMap<String, TokenUsageSlice>) -> Vec<TokenUsageAccountShare> {
    let mut out: Vec<TokenUsageAccountShare> = map
        .into_iter()
        .map(|(account, usage)| TokenUsageAccountShare { account, usage })
        .collect();
    out.sort_by(|a, b| {
        (a.account == TOKEN_USAGE_NO_ACCOUNT)
            .cmp(&(b.account == TOKEN_USAGE_NO_ACCOUNT))
            .then(
                b.usage
                    .cost_usd
                    .unwrap_or(0.0)
                    .total_cmp(&a.usage.cost_usd.unwrap_or(0.0)),
            )
            .then(b.usage.tokens.cmp(&a.usage.tokens))
            .then(a.account.cmp(&b.account))
    });
    out
}

/// The top `limit` sessions.
///
/// A session with per-call data (a Claude session read by the call sync)
/// is summed from its calls, split by thread and account; any other is
/// its turn facts' total and has no split. With an account selection only
/// calls served by the selected accounts count, and sessions without
/// per-call data drop out — they cannot say which account served them.
pub(crate) fn rank_sessions(
    turns: &[TurnTotal],
    groups: &[CallGroup],
    has_calls: &HashSet<i32>,
    accounts: Option<&HashSet<String>>,
    limit: usize,
) -> Vec<SessionDraft> {
    let selected = |key: &str| accounts.is_none_or(|set| set.contains(key));

    // conversation → thread → account → usage
    let mut by_conv: HashMap<i32, BTreeMap<String, BTreeMap<String, TokenUsageSlice>>> =
        HashMap::new();
    let mut last: HashMap<i32, Option<DateTime<Utc>>> = HashMap::new();
    for g in groups {
        if !selected(account_key(g)) {
            continue;
        }
        let slot = by_conv
            .entry(g.conversation_id)
            .or_default()
            .entry(g.thread_key.clone())
            .or_default()
            .entry(account_key(g).to_string())
            .or_default();
        add_slice(slot, &slice_of(g));
        let at = parse_stored_time(g.last_at.as_deref());
        let entry = last.entry(g.conversation_id).or_insert(None);
        *entry = later(*entry, at);
    }

    let mut drafts: Vec<SessionDraft> = Vec::new();
    let mut agent_of: HashMap<i32, &str> = HashMap::new();
    for t in turns {
        agent_of.insert(t.conversation_id, t.agent_type.as_str());
    }

    for (conversation_id, threads) in by_conv {
        let mut usage = TokenUsageSlice::default();
        let mut by_account: BTreeMap<String, TokenUsageSlice> = BTreeMap::new();
        let mut thread_drafts = Vec::new();
        for (key, per_account) in threads {
            let mut t_usage = TokenUsageSlice::default();
            for (account, slice) in &per_account {
                add_slice(&mut t_usage, slice);
                add_slice(by_account.entry(account.clone()).or_default(), slice);
            }
            add_slice(&mut usage, &t_usage);
            thread_drafts.push(ThreadDraft {
                key,
                usage: t_usage,
                by_account: sorted_shares(per_account),
            });
        }
        // The main thread first, then the sub-agents largest first.
        thread_drafts.sort_by(|a, b| {
            (!a.key.is_empty())
                .cmp(&(!b.key.is_empty()))
                .then(b.usage.tokens.cmp(&a.usage.tokens))
                .then(a.key.cmp(&b.key))
        });
        drafts.push(SessionDraft {
            conversation_id,
            agent_type: agent_of.get(&conversation_id).map(|s| s.to_string()),
            usage,
            detail: true,
            by_account: sorted_shares(by_account),
            threads: thread_drafts,
            last_activity_at: last.get(&conversation_id).copied().flatten(),
        });
    }

    if accounts.is_none() {
        for t in turns {
            if has_calls.contains(&t.conversation_id) {
                // Read by the call sync: its calls are the source, and a
                // session with none in the window used nothing in it.
                continue;
            }
            drafts.push(SessionDraft {
                conversation_id: t.conversation_id,
                agent_type: Some(t.agent_type.clone()),
                usage: TokenUsageSlice {
                    tokens: t.tokens.max(0) as u64,
                    cost_usd: None,
                    pct: None,
                    calls: 0,
                },
                detail: false,
                by_account: Vec::new(),
                threads: Vec::new(),
                last_activity_at: parse_stored_time(t.last_at.as_deref()),
            });
        }
    }

    drafts.retain(|d| d.usage.tokens > 0);
    drafts.sort_by(|a, b| {
        b.usage
            .tokens
            .cmp(&a.usage.tokens)
            .then(a.conversation_id.cmp(&b.conversation_id))
    });
    drafts.truncate(limit);
    drafts
}

/// The legend: every account the window's calls or the pool's records
/// name, with what the filtered sessions used on it and what the pool
/// served on it in total.
pub(crate) fn account_items(
    groups: &[CallGroup],
    pool: &[PoolTotal],
    rates: &HashMap<String, f64>,
    baseline_usd_per_pct: f64,
) -> Vec<TokenUsageAccountItem> {
    let mut items: BTreeMap<String, TokenUsageAccountItem> = BTreeMap::new();
    let blank = |account: &str, kind: &str| TokenUsageAccountItem {
        account: account.to_string(),
        kind: kind.to_string(),
        usage: TokenUsageSlice::default(),
        pool_cost_usd: 0.0,
        pool_pct: 0.0,
        pool_calls: 0,
        pool_metered_pct: 0.0,
        usd_per_pct: None,
        usd_per_pct_measured: false,
    };
    for g in groups {
        let key = account_key(g);
        let kind = if g.account.is_none() {
            "none"
        } else {
            g.account_kind.as_deref().unwrap_or("claude")
        };
        let item = items
            .entry(key.to_string())
            .or_insert_with(|| blank(key, kind));
        add_slice(&mut item.usage, &slice_of(g));
    }
    for p in pool {
        let item = items
            .entry(p.account.clone())
            .or_insert_with(|| blank(&p.account, &p.account_kind));
        item.pool_cost_usd += p.cost_usd;
        item.pool_pct += p.pct;
        item.pool_calls += p.calls.max(0) as u64;
        item.pool_metered_pct += p.metered_pct;
    }
    let mut out: Vec<TokenUsageAccountItem> = items
        .into_values()
        .map(|mut item| {
            if item.kind == "claude" || item.kind == "link" {
                match rates.get(&item.account) {
                    Some(rate) if item.kind == "claude" => {
                        item.usd_per_pct = Some(*rate);
                        item.usd_per_pct_measured = true;
                    }
                    _ => item.usd_per_pct = Some(baseline_usd_per_pct),
                }
            }
            item
        })
        .collect();
    out.sort_by(|a, b| {
        (a.account == TOKEN_USAGE_NO_ACCOUNT)
            .cmp(&(b.account == TOKEN_USAGE_NO_ACCOUNT))
            .then(
                b.usage
                    .cost_usd
                    .unwrap_or(0.0)
                    .total_cmp(&a.usage.cost_usd.unwrap_or(0.0)),
            )
            .then(b.pool_cost_usd.total_cmp(&a.pool_cost_usd))
            .then(a.account.cmp(&b.account))
    });
    out
}
