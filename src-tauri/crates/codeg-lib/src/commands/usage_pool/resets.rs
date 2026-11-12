//! Usage-limit resets of the pool's Claude accounts, through the pool's own
//! routes: `GET /maxpool/resets` (each account's reset grants, read with every
//! status poll), `POST /maxpool/resets/redeem` (use one) and
//! `POST /maxpool/accounts/<name>/recheck` (read an account again now, so a
//! bench its last reading no longer justifies is lifted at once).
//!
//! maxpool holds the accounts' sign-ins and claims a reset itself; codeg only
//! asks it, with the same key as its status. codeg never reads an account's
//! sign-in and never calls the provider for a reset.
//!
//! A pool without these routes (an older maxpool) forwards unknown paths to
//! its upstream, so they are only used once `GET /maxpool/resets` has
//! answered as a listing: a pool that answers anything else is not asked
//! again for half an hour unless its version changes, and is never sent a
//! redeem or a recheck.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    clean_label, lenient, lenient_list, lenient_time, PlanUsagePool, PoolConfig, ProxyKey, CLIENT,
};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::limit_resets::LimitResetKind;
use crate::db::AppDatabase;

/// Path of the status endpoint the config names; the other routes sit next
/// to it.
const STATUS_PATH: &str = "/maxpool/status";
const RESETS_MAX_BYTES: usize = 1024 * 1024;
const ANSWER_MAX_BYTES: usize = 256 * 1024;
/// A redeem lists the grants, claims one and reads the account again.
const REDEEM_TIMEOUT: Duration = Duration::from_secs(75);
const RECHECK_TIMEOUT: Duration = Duration::from_secs(40);
/// How long a pool found without the routes is left alone (per version).
const UNSUPPORTED_BACKOFF: Duration = Duration::from_secs(30 * 60);
const MAX_GRANTS: usize = 16;
const GRANT_ID_MAX_CHARS: usize = 128;
/// The provider's names for grants run longer than an account name ("New
/// model launch: one Fable reset for Max, Team Premium and Enterprise
/// Premium").
const GRANT_LABEL_MAX_CHARS: usize = 160;

impl PoolConfig {
    /// A route next to the status endpoint, on the same address.
    fn route_url(&self, path: &str) -> String {
        let base = self
            .status_url
            .strip_suffix(STATUS_PATH)
            .unwrap_or(&self.status_url);
        format!("{base}{path}")
    }
}

// ─── What the pool sends (allow-listed) ─────────────────────────────────

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawResets {
    #[serde(deserialize_with = "lenient")]
    ok: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    auto_redeem: Option<RawAutoRedeem>,
    /// Required: a body without it is not a listing.
    #[serde(deserialize_with = "lenient")]
    accounts: Option<Vec<Value>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawAutoRedeem {
    #[serde(deserialize_with = "lenient")]
    enabled: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    would_act: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawResetAccount {
    #[serde(deserialize_with = "lenient")]
    name: Option<String>,
    #[serde(deserialize_with = "lenient")]
    enabled: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    provider: Option<String>,
    #[serde(deserialize_with = "lenient_list")]
    grants: Vec<RawGrant>,
    #[serde(deserialize_with = "lenient")]
    next_grant_id: Option<Value>,
    #[serde(deserialize_with = "lenient_time")]
    cooldown_until: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    eligible: Option<bool>,
    #[serde(deserialize_with = "lenient_time")]
    checked_at: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    auto_redeem: Option<RawAutoRedeem>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawGrant {
    #[serde(deserialize_with = "lenient")]
    id: Option<Value>,
    #[serde(deserialize_with = "lenient")]
    label: Option<String>,
    #[serde(deserialize_with = "lenient")]
    resets_left: Option<f64>,
    #[serde(deserialize_with = "lenient_time")]
    ends_at: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    usable_now: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    paused: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    requires_limit: Option<bool>,
    #[serde(deserialize_with = "lenient_list")]
    clears: Vec<String>,
    #[serde(deserialize_with = "lenient")]
    gives_back_weekly: Option<bool>,
}

// ─── What the screen gets ───────────────────────────────────────────────

/// One reset grant of a pool account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolResetGrant {
    /// The pool's id for it, which a redeem takes.
    pub id: String,
    /// The provider's own name for it.
    pub label: Option<String>,
    /// What it refills.
    pub kind: LimitResetKind,
    /// The model family whose own weekly limit a `model_weekly` grant
    /// refills ("Fable"); `None` for any other kind.
    #[serde(default)]
    pub model: Option<String>,
    /// The account's windows it refills, by id in the pool reading
    /// (`five_hour`, `seven_day`, `seven_day_fable`). Empty when what it
    /// refills isn't known: such a grant is shown, never used from here.
    #[serde(default)]
    pub refills: Vec<String>,
    /// Resets it still holds.
    pub count: u32,
    /// Epoch seconds.
    pub expires_at: Option<i64>,
    /// It can be used now (not paused, in date, offered now).
    pub usable_now: bool,
    /// It only works once a limit it refills is reached.
    pub requires_limit: bool,
    /// Using it also gives back to the general weekly limit what the model
    /// used of it this week — only that much.
    #[serde(default)]
    pub gives_back_weekly: bool,
}

/// A pool account's usage-limit resets, as the pool last listed them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolAccountResets {
    /// Resets left over its grants still in date.
    pub available: u32,
    /// Soonest to expire first.
    pub grants: Vec<PoolResetGrant>,
    /// The grant the provider would use next, when it says.
    pub next_grant_id: Option<String>,
    /// No reset can be used on the account before then (epoch seconds).
    pub cooldown_until: Option<i64>,
    /// The account is offered resets at all; `None` before the pool has
    /// listed them.
    pub eligible: Option<bool>,
    /// The pool would use one by itself at its next check.
    pub auto_redeem: bool,
    /// When the pool last listed them (epoch seconds).
    pub checked_at: Option<i64>,
    /// The account's windows at their limit at this reading, by id in its
    /// `windows` (`five_hour`, `seven_day`, a model's `seven_day_<family>`):
    /// what a reset has to refill to free it. Read from the account each
    /// reading, not from the listing.
    #[serde(default)]
    pub limits_reached: Vec<String>,
}

/// The window a grant's `clears` names for the 5-hour limit.
const SESSION_CLEARS: &str = "five_hour";
/// The window it names for the general weekly limit.
const WEEKLY_CLEARS: &str = "seven_day";
/// The windows it names for one model family's own weekly limit, and the
/// family (the pool's key for it; its window in a reading is
/// `seven_day_<family>`).
const MODEL_WEEKLY_CLEARS: &[(&str, &str)] = &[("seven_day_overage_included", "fable")];

/// What a grant refills, from the windows it clears.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GrantScope {
    pub kind: LimitResetKind,
    /// The model family, for a `model_weekly` grant ("Fable").
    pub model: Option<String>,
    /// The account's windows it refills, by id in the pool reading.
    pub refills: Vec<String>,
}

/// What a grant refills, read the way the pool reads it: `five_hour` is
/// the 5-hour limit, `seven_day` the general weekly one, and
/// `seven_day_overage_included` Fable's own weekly limit only. Any other
/// window is not known here: it adds nothing, so a grant that clears only
/// such windows is `Other` — never taken for the weekly limit because its
/// name starts like it.
pub(crate) fn grant_scope(clears: &[String]) -> GrantScope {
    let clears_window = |window: &str| clears.iter().any(|w| w == window);
    let session = clears_window(SESSION_CLEARS);
    let weekly = clears_window(WEEKLY_CLEARS);
    let families: Vec<&str> = MODEL_WEEKLY_CLEARS
        .iter()
        .filter(|(window, _)| clears_window(window))
        .map(|(_, family)| *family)
        .collect();
    let mut refills = Vec::new();
    if session {
        refills.push(SESSION_CLEARS.to_string());
    }
    if weekly {
        refills.push(WEEKLY_CLEARS.to_string());
    }
    refills.extend(families.iter().map(|family| format!("seven_day_{family}")));
    let kind = match (session, weekly, families.is_empty()) {
        (true, true, _) => LimitResetKind::Full,
        (false, true, _) => LimitResetKind::Weekly,
        (true, false, _) => LimitResetKind::Session,
        (false, false, false) => LimitResetKind::ModelWeekly,
        (false, false, true) => LimitResetKind::Other,
    };
    let model = if kind == LimitResetKind::ModelWeekly {
        families.first().copied().map(model_name)
    } else {
        None
    };
    GrantScope {
        kind,
        model,
        refills,
    }
}

/// A model family's name as its own weekly window is labelled ("Fable").
fn model_name(family: &str) -> String {
    crate::commands::plan_usage::claude_window(&format!("seven_day_{family}"), 0.0, None).label
}

fn grant_id(value: Option<&Value>) -> Option<String> {
    let id = match value? {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let fine = !id.is_empty()
        && id.chars().count() <= GRANT_ID_MAX_CHARS
        && !id.chars().any(char::is_control);
    fine.then_some(id)
}

/// The provider's name for a grant: control characters dropped, trimmed,
/// capped.
fn grant_label(raw: Option<String>) -> Option<String> {
    let cleaned: String = raw?.chars().filter(|c| !c.is_control()).collect();
    let cleaned: String = cleaned.trim().chars().take(GRANT_LABEL_MAX_CHARS).collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn grant_from(raw: RawGrant, now: i64) -> Option<PoolResetGrant> {
    let id = grant_id(raw.id.as_ref())?;
    let count = raw
        .resets_left
        .filter(|n| n.is_finite() && *n >= 1.0)
        .map(|n| n.min(f64::from(u32::MAX)) as u32)?;
    if raw.ends_at.is_some_and(|at| at <= now) {
        return None;
    }
    let clears: Vec<String> = raw
        .clears
        .into_iter()
        .filter_map(|w| clean_label(Some(w)))
        .collect();
    let scope = grant_scope(&clears);
    Some(PoolResetGrant {
        id,
        label: grant_label(raw.label),
        kind: scope.kind,
        model: scope.model,
        refills: scope.refills,
        count,
        expires_at: raw.ends_at,
        usable_now: raw.usable_now.unwrap_or(false) && !raw.paused.unwrap_or(false),
        requires_limit: raw.requires_limit.unwrap_or(false),
        gives_back_weekly: raw.gives_back_weekly.unwrap_or(false),
    })
}

/// Each Claude account's resets in a `GET /maxpool/resets` body, by name.
/// `None` for a body that isn't a listing.
pub(crate) fn parse_resets(body: &[u8], now: i64) -> Option<Vec<(String, PoolAccountResets)>> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    if !value.is_object() {
        return None;
    }
    let raw: RawResets = serde_json::from_value(value).ok()?;
    if raw.ok == Some(false) {
        return None;
    }
    let auto_on = raw
        .auto_redeem
        .as_ref()
        .and_then(|a| a.enabled)
        .unwrap_or(false);
    let mut out = Vec::new();
    for entry in raw.accounts? {
        let Ok(account) = serde_json::from_value::<RawResetAccount>(entry) else {
            continue;
        };
        if account
            .provider
            .as_deref()
            .is_some_and(|p| p != "anthropic")
        {
            continue;
        }
        let Some(name) = clean_label(account.name) else {
            continue;
        };
        let enabled = account.enabled.unwrap_or(true);
        let mut grants: Vec<PoolResetGrant> = if enabled {
            account
                .grants
                .into_iter()
                .filter_map(|g| grant_from(g, now))
                .collect()
        } else {
            Vec::new()
        };
        grants.sort_by_key(|g| g.expires_at.unwrap_or(i64::MAX));
        grants.truncate(MAX_GRANTS);
        let available = grants
            .iter()
            .fold(0u32, |sum, g| sum.saturating_add(g.count));
        out.push((
            name,
            PoolAccountResets {
                available,
                grants,
                next_grant_id: grant_id(account.next_grant_id.as_ref()),
                cooldown_until: account.cooldown_until.filter(|t| *t > now),
                eligible: account.eligible,
                auto_redeem: enabled
                    && auto_on
                    && account
                        .auto_redeem
                        .and_then(|a| a.would_act)
                        .unwrap_or(false),
                checked_at: account.checked_at,
                limits_reached: Vec::new(),
            },
        ));
    }
    Some(out)
}

// ─── Reading them with the status ───────────────────────────────────────

/// What asking `GET /maxpool/resets` came to.
pub(crate) enum ResetsRead {
    /// The routes are there: each Claude account's resets, by name.
    Listed(Vec<(String, PoolAccountResets)>),
    /// A pool without the routes.
    Unsupported,
    /// No answer this time: keep what was shown.
    Unavailable,
}

/// What a pool (by its status address) was last found to have, for the
/// version it ran.
struct Support {
    pool: String,
    version: Option<String>,
    supported: bool,
    at: Instant,
}

static SUPPORT: Mutex<Vec<Support>> = Mutex::new(Vec::new());
const SUPPORT_KEPT: usize = 8;

fn support_known(pool: &str, version: Option<&str>) -> Option<bool> {
    let guard = SUPPORT.lock().unwrap_or_else(|e| e.into_inner());
    let support = guard.iter().find(|s| s.pool == pool)?;
    if support.version.as_deref() != version {
        return None;
    }
    if !support.supported && support.at.elapsed() >= UNSUPPORTED_BACKOFF {
        return None;
    }
    Some(support.supported)
}

fn note_support(pool: &str, version: Option<&str>, supported: bool) {
    let mut guard = SUPPORT.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|s| s.pool != pool);
    if guard.len() >= SUPPORT_KEPT {
        guard.remove(0);
    }
    guard.push(Support {
        pool: pool.to_string(),
        version: version.map(str::to_string),
        supported,
        at: Instant::now(),
    });
}

/// The routes answered as a listing at this pool, for this version.
fn known_supported(pool: &str, version: Option<&str>) -> bool {
    support_known(pool, version) == Some(true)
}

async fn read_capped(mut response: reqwest::Response, max: usize) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > max {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

fn with_key(request: reqwest::RequestBuilder, config: &PoolConfig) -> reqwest::RequestBuilder {
    match config.key.as_ref().and_then(ProxyKey::header_value) {
        Some(value) => request.header("x-api-key", value),
        None => request,
    }
}

/// Ask the pool for its accounts' resets, unless it is known not to have
/// the route.
pub(super) async fn read_resets(config: &PoolConfig, version: Option<&str>, now: i64) -> ResetsRead {
    let pool = config.status_url.as_str();
    if support_known(pool, version) == Some(false) {
        return ResetsRead::Unsupported;
    }
    let Some(client) = CLIENT.as_ref() else {
        return ResetsRead::Unavailable;
    };
    let request = with_key(client.get(config.route_url("/maxpool/resets")), config);
    let response = match request.send().await {
        Ok(response) => response,
        // An older pool holds a path it doesn't know while it forwards it;
        // a pool with the route answers it from memory.
        Err(error) if error.is_timeout() && !known_supported(pool, version) => {
            note_support(pool, version, false);
            return ResetsRead::Unsupported;
        }
        Err(_) => return ResetsRead::Unavailable,
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return ResetsRead::Unavailable;
    }
    if !status.is_success() {
        note_support(pool, version, false);
        return ResetsRead::Unsupported;
    }
    let Some(body) = read_capped(response, RESETS_MAX_BYTES).await else {
        return ResetsRead::Unavailable;
    };
    match parse_resets(&body, now) {
        Some(listed) => {
            note_support(pool, version, true);
            ResetsRead::Listed(listed)
        }
        None => {
            note_support(pool, version, false);
            ResetsRead::Unsupported
        }
    }
}

/// Put what the ask came to on a new reading. With no answer, the previous
/// reading's resets stay. Either way, what holds each account back is read
/// from the new reading.
pub(crate) fn attach(pool: &mut PlanUsagePool, read: ResetsRead, previous: Option<&PlanUsagePool>) {
    put_resets(pool, read, previous);
    let (now, threshold) = (pool.checked_at, pool.switch_threshold);
    for account in pool.accounts.iter_mut() {
        let reached = account.limits_reached(now, threshold);
        if let Some(resets) = account.resets.as_mut() {
            resets.limits_reached = reached;
        }
    }
}

fn put_resets(pool: &mut PlanUsagePool, read: ResetsRead, previous: Option<&PlanUsagePool>) {
    match read {
        ResetsRead::Listed(listed) => {
            pool.resets_supported = true;
            for account in pool.accounts.iter_mut().filter(|a| !a.provider) {
                account.resets = listed
                    .iter()
                    .find(|(name, _)| *name == account.name)
                    .map(|(_, resets)| resets.clone());
            }
        }
        ResetsRead::Unsupported => pool.resets_supported = false,
        ResetsRead::Unavailable => {
            let Some(previous) = previous else {
                return;
            };
            pool.resets_supported = previous.resets_supported;
            for account in pool.accounts.iter_mut().filter(|a| !a.provider) {
                account.resets = previous
                    .accounts
                    .iter()
                    .find(|p| p.name == account.name)
                    .and_then(|p| p.resets.clone());
            }
        }
    }
}

// ─── Using one, and reading an account again ────────────────────────────

/// What using a pool reset came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolResetOutcome {
    /// It went through: the account's limits it covers are refilled.
    Reset,
    /// That reset had already been used (an earlier try went through).
    AlreadyUsed,
    /// No confirmation came. It may have gone through; the account is read
    /// again before another try.
    Unconfirmed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolRedeemResult {
    pub account: String,
    pub outcome: PoolResetOutcome,
    /// The pool read again after it.
    pub pool: Option<PlanUsagePool>,
    /// The paused session sent on, when one was named and the reset landed.
    pub continued: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolRecheckResult {
    pub account: String,
    /// The pool read the account's usage.
    pub read: bool,
    /// A hold the new reading no longer justified was lifted.
    pub lifted: bool,
    /// The pool read again after it.
    pub pool: Option<PlanUsagePool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawAnswer {
    #[serde(deserialize_with = "lenient")]
    ok: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    error: Option<String>,
    #[serde(deserialize_with = "lenient")]
    message: Option<String>,
    #[serde(deserialize_with = "lenient")]
    already_used: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    probe: Option<RawProbe>,
    #[serde(deserialize_with = "lenient")]
    recovered: Option<Value>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawProbe {
    #[serde(deserialize_with = "lenient")]
    ok: Option<bool>,
}

/// The i18n key (under `PlanUsage`) for a pool's refusal code.
fn refusal_key(code: &str) -> &'static str {
    match code {
        "recently_claimed" => "pool.resets.error.recentlyUsed",
        "claim_in_progress" => "pool.resets.error.inProgress",
        "cooldown" => "pool.resets.error.cooldown",
        "no_usable_grant" | "grant_unusable" | "grant_not_found" | "grant_scope_unknown" => {
            "pool.resets.error.noUsableReset"
        }
        "not_eligible" => "pool.resets.error.notEligible",
        "account_disabled" | "pool_benched" => "pool.resets.error.disabled",
        "needs_login" | "subscription_gone" => "pool.resets.error.needsLogin",
        "account_not_found" => "pool.resets.error.noAccount",
        "too_soon" => "pool.resets.error.tooSoon",
        _ => "pool.resets.error.failed",
    }
}

fn pool_error(status: u16, answer: &RawAnswer) -> AppCommandError {
    let code = answer
        .error
        .as_deref()
        .and_then(|c| clean_label(Some(c.to_string())))
        .unwrap_or_else(|| format!("http_{status}"));
    let message = answer
        .message
        .as_deref()
        .and_then(|m| clean_label(Some(m.to_string())))
        .unwrap_or_else(|| format!("The pool answered HTTP {status}."));
    let app_code = match status {
        404 => AppErrorCode::NotFound,
        403 => AppErrorCode::PermissionDenied,
        400 => AppErrorCode::InvalidInput,
        409 | 429 => AppErrorCode::InvalidInput,
        503 => AppErrorCode::NetworkError,
        _ => AppErrorCode::TaskExecutionFailed,
    };
    let mut params = std::collections::BTreeMap::new();
    params.insert("reason".to_string(), code.clone());
    AppCommandError::new(app_code, message).with_i18n(refusal_key(&code), params)
}

fn no_routes() -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::DependencyMissing,
        "This account pool can't use resets from codeg. Update maxpool.",
    )
    .with_i18n("pool.resets.error.unsupported", Default::default())
}

fn unreachable_pool() -> AppCommandError {
    AppCommandError::network("The account pool isn't answering.")
        .with_i18n("pool.resets.error.unreachable", Default::default())
}

/// The config, and that the running pool has the routes (as its last
/// reading showed).
async fn pool_with_routes() -> Result<PoolConfig, AppCommandError> {
    let super::Discovery::Found(config) = super::discover() else {
        return Err(AppCommandError::configuration_missing(
            "No account pool is configured on this machine.",
        ));
    };
    let reading = super::refresh(Duration::from_secs(30)).await;
    match reading {
        Some(pool) if pool.resets_supported => Ok(config),
        Some(pool) if pool.stale => Err(unreachable_pool()),
        _ => Err(no_routes()),
    }
}

/// `POST` a route; `Ok((status, answer))` for any answer the pool gave.
async fn post(
    config: &PoolConfig,
    path: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<(u16, RawAnswer), reqwest::Error> {
    let Some(client) = CLIENT.as_ref() else {
        // Built once at start; without it nothing reaches the pool.
        return Ok((503, RawAnswer::default()));
    };
    let mut request = with_key(client.post(config.route_url(path)), config).timeout(timeout);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let answer = read_capped(response, ANSWER_MAX_BYTES)
        .await
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .filter(Value::is_object)
        .and_then(|v| serde_json::from_value::<RawAnswer>(v).ok())
        .unwrap_or_default();
    Ok((status, answer))
}

/// An account name the pool reports now (Claude, not an API provider).
fn checked_name(raw: &str) -> Result<String, AppCommandError> {
    clean_label(Some(raw.to_string()))
        .filter(|n| n == raw.trim())
        .ok_or_else(|| AppCommandError::invalid_input("Unknown account name."))
}

pub(super) async fn redeem_with(
    config: &PoolConfig,
    name: &str,
    grant_id: Option<&str>,
) -> Result<PoolResetOutcome, AppCommandError> {
    let mut body = serde_json::json!({ "account": name });
    if let Some(id) = grant_id {
        body["grantId"] = Value::String(id.to_string());
    }
    match post(config, "/maxpool/resets/redeem", Some(body), REDEEM_TIMEOUT).await {
        Ok((200, answer)) if answer.ok == Some(true) => Ok(if answer.already_used == Some(true) {
            PoolResetOutcome::AlreadyUsed
        } else {
            PoolResetOutcome::Reset
        }),
        // The pool's own wait for the provider ran out: it may have landed.
        // (A listing that timed out used nothing.)
        Ok((504, answer)) if answer.error.as_deref() != Some("listing_timeout") => {
            Ok(PoolResetOutcome::Unconfirmed)
        }
        Ok((status, answer)) => Err(pool_error(status, &answer)),
        // Sent, but no answer came back in time.
        Err(error) if error.is_timeout() => Ok(PoolResetOutcome::Unconfirmed),
        Err(_) => Err(unreachable_pool()),
    }
}

pub(super) async fn recheck_with(config: &PoolConfig, name: &str) -> Result<(bool, bool), AppCommandError> {
    let path = format!(
        "/maxpool/accounts/{}/recheck",
        url::form_urlencoded::byte_serialize(name.as_bytes())
            .collect::<String>()
            .replace('+', "%20")
    );
    match post(config, &path, None, RECHECK_TIMEOUT).await {
        Ok((200, answer)) => {
            let read = answer.probe.and_then(|p| p.ok).unwrap_or(false);
            let lifted = answer.recovered.as_ref().is_some_and(|r| !r.is_null());
            Ok((read, lifted))
        }
        Ok((status, answer)) => Err(pool_error(status, &answer)),
        Err(_) => Err(unreachable_pool()),
    }
}

/// Use one of a pool account's resets (`grant_id`, or the provider's next).
/// It can't be undone. With `conversation_id`, that session — paused at its
/// limit — continues once the reset landed.
pub async fn redeem_reset(
    db: &AppDatabase,
    name: &str,
    grant_id: Option<String>,
    conversation_id: Option<i32>,
) -> Result<PoolRedeemResult, AppCommandError> {
    let name = checked_name(name)?;
    let grant_id = grant_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    if grant_id.as_deref().is_some_and(grant_id_is_bad) {
        return Err(AppCommandError::invalid_input("Unknown reset."));
    }
    let config = pool_with_routes().await?;
    let outcome = redeem_with(&config, &name, grant_id.as_deref()).await?;
    tracing::info!("[usage-pool] a pool reset was used from codeg: {outcome:?}");
    let pool = super::refresh(Duration::ZERO).await;
    let mut continued = None;
    if outcome == PoolResetOutcome::Reset {
        if let Some(conversation_id) = conversation_id {
            let sent =
                crate::acp::limit_continue::continue_limit_now_core(&db.conn, conversation_id)
                    .await
                    .unwrap_or(false);
            continued = sent.then_some(conversation_id);
        }
    }
    Ok(PoolRedeemResult {
        account: name,
        outcome,
        pool,
        continued,
    })
}

fn grant_id_is_bad(id: &str) -> bool {
    id.chars().count() > GRANT_ID_MAX_CHARS || id.chars().any(char::is_control)
}

/// Have the pool read an account's usage now; a hold the new reading no
/// longer justifies is lifted. Never uses a reset.
pub async fn recheck_account(name: &str) -> Result<PoolRecheckResult, AppCommandError> {
    let name = checked_name(name)?;
    let config = pool_with_routes().await?;
    let (read, lifted) = recheck_with(&config, &name).await?;
    let pool = super::refresh(Duration::ZERO).await;
    Ok(PoolRecheckResult {
        account: name,
        read,
        lifted,
        pool,
    })
}

// ─── Desktop commands ───────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_redeem_reset(
    db: tauri::State<'_, AppDatabase>,
    name: String,
    grant_id: Option<String>,
    conversation_id: Option<i32>,
) -> Result<PoolRedeemResult, AppCommandError> {
    redeem_reset(&db, &name, grant_id, conversation_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_recheck(name: String) -> Result<PoolRecheckResult, AppCommandError> {
    recheck_account(&name).await
}

#[cfg(test)]
mod tests;
