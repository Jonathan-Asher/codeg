//! The account pool the agent's requests go through, when one runs locally.
//!
//! The plan-usage reading for the agent comes from the rate-limit events it
//! reports during a turn, and those describe whichever account served the
//! last request. Behind a local pool proxy (maxpool) that spreads requests
//! over several subscription accounts and fails over between them, that one
//! reading misleads: one account can sit at its limit while another serves
//! freely. This module reads the pool's own status instead, so the usage
//! screen can show every account and limit-continue can wait for the pool as
//! a whole rather than for one account.
//!
//! Discovery is automatic, with nothing to set up in the app: the config at
//! `$CODEG_MAXPOOL_CONFIG`, else `~/.config/maxpool.json`. No config, or one
//! that cannot be read, means no pool, and everything behaves as before. While
//! a pool is configured, [`run_usage_pool`] polls its status every minute and
//! pushes each reading on [`PLAN_USAGE_POOL_CHANGED_EVENT`]; the screen's
//! refresh re-reads it on demand ([`report_reading`]). A failed poll keeps the
//! last good reading, marked stale with the error.
//!
//! Secrets: the config holds the proxy's API key, which the status endpoint
//! requires. The key is read here, sent only as the `x-api-key` header (marked
//! sensitive, no redirects followed) to the address the config names, and is
//! never logged, serialized or handed to a client. The status body is parsed
//! into the allow-listed structs below; everything else in it, credentials and
//! free-form error text included, is dropped on parse.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::de::{DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::plan_usage::{
    clamp_percent, claude_window, now_secs, PlanUsageAgent, PlanUsageWindow,
};
use crate::web::event_bridge::{emit_event, EventEmitter, PLAN_USAGE_POOL_CHANGED_EVENT};

/// Overrides where the pool's config is looked for.
pub const MAXPOOL_CONFIG_ENV: &str = "CODEG_MAXPOOL_CONFIG";

const DEFAULT_PROXY_PORT: u16 = 3456;
/// maxpool's own default: an account at this share of its 5-hour window is
/// benched and new requests go to another.
const DEFAULT_SWITCH_THRESHOLD: f64 = 0.9;
/// maxpool's weekly bench: an account (or one model's weekly window) this
/// full takes no more requests until the window resets.
const WEEKLY_EXHAUSTED_PERCENT: f64 = 99.9;

const CONFIG_MAX_BYTES: u64 = 1024 * 1024;
const STATUS_MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACCOUNTS: usize = 32;
const NAME_MAX_CHARS: usize = 64;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
/// How often the poll task reads the pool.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// A reading this fresh is reused by the poll task instead of fetched again
/// (the screen's refresh may just have fetched one).
const POLL_MIN_AGE: Duration = Duration::from_secs(20);
/// A reading this fresh answers the screen's refresh button.
const FORCE_MIN_AGE: Duration = Duration::from_secs(5);
/// A reading this fresh answers limit-continue; older ones are re-read first.
const RESUME_MAX_AGE: Duration = Duration::from_secs(30);
/// How long limit-continue waits for that re-read before using what it has.
const RESUME_REFRESH_TIMEOUT: Duration = Duration::from_secs(6);
/// When some account still has headroom, limit-continue tries again this
/// soon: the pool routes the continuation to that account.
pub(crate) const POOL_HEADROOM_RETRY_SECS: i64 = 60;

// ─── Lenient parsing ────────────────────────────────────────────────────

/// A field of the wrong type reads as its default instead of failing the
/// whole status: a newer pool version must not blank the screen.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// A list whose unreadable entries are skipped.
fn lenient_list<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
        _ => Vec::new(),
    })
}

/// A map whose unreadable entries are skipped.
fn lenient_map<'de, D, T>(deserializer: D) -> Result<BTreeMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Object(entries) => entries
            .into_iter()
            .filter_map(|(key, value)| Some((key, serde_json::from_value(value).ok()?)))
            .collect(),
        _ => BTreeMap::new(),
    })
}

/// A point in time as epoch seconds, from epoch milliseconds, epoch seconds
/// or an RFC 3339 string — the pool uses all three.
fn epoch_from(value: &Value) -> Option<i64> {
    fn from_number(n: f64) -> Option<i64> {
        if !n.is_finite() || n <= 0.0 {
            return None;
        }
        // Anything past the year 5138 in seconds is milliseconds.
        Some(if n > 1e11 {
            (n / 1000.0) as i64
        } else {
            n as i64
        })
    }
    match value {
        Value::Number(n) => from_number(n.as_f64()?),
        Value::String(s) => {
            let s = s.trim();
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|t| t.timestamp())
                .filter(|t| *t > 0)
                .or_else(|| from_number(s.parse().ok()?))
        }
        _ => None,
    }
}

fn lenient_time<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(epoch_from(&Value::deserialize(deserializer)?))
}

/// A short display label: control characters dropped, trimmed, capped.
fn clean_label(raw: Option<String>) -> Option<String> {
    let cleaned: String = raw?
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(NAME_MAX_CHARS)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// An identifier-like value (a version, a routing mode): only the characters
/// such values are made of, or nothing.
fn clean_word(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let raw = raw.trim();
    let ok = !raw.is_empty()
        && raw.len() <= 32
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'));
    ok.then(|| raw.to_string())
}

/// A threshold given as a fraction (0.9) as a percentage (90).
fn threshold_percent(fraction: Option<f64>) -> Option<f64> {
    fraction
        .filter(|t| t.is_finite() && *t > 0.0 && *t <= 1.0)
        .map(|t| t * 100.0)
}

// ─── Config ─────────────────────────────────────────────────────────────

/// The proxy's API key. Deserialize-only, and its `Debug` prints nothing of
/// it, so it can't reach a log line or a serialized report by accident.
#[derive(Clone, Default, Deserialize)]
#[serde(transparent)]
struct ProxyKey(String);

impl ProxyKey {
    fn header_value(&self) -> Option<reqwest::header::HeaderValue> {
        if self.0.is_empty() {
            return None;
        }
        let mut value = reqwest::header::HeaderValue::from_str(&self.0).ok()?;
        value.set_sensitive(true);
        Some(value)
    }
}

impl std::fmt::Debug for ProxyKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProxyKey(<redacted>)")
    }
}

/// The parts of the pool's config this module reads; the rest (the
/// accounts' credentials among it) is skipped on parse.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawConfig {
    #[serde(deserialize_with = "lenient")]
    proxy: Option<RawProxy>,
    #[serde(deserialize_with = "lenient")]
    switch_threshold: Option<f64>,
    #[serde(deserialize_with = "lenient")]
    routing: Option<RawRouting>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawProxy {
    #[serde(deserialize_with = "lenient")]
    host: Option<String>,
    #[serde(deserialize_with = "lenient")]
    port: Option<u16>,
    #[serde(deserialize_with = "lenient")]
    api_key: Option<ProxyKey>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawRouting {
    #[serde(deserialize_with = "lenient")]
    mode: Option<String>,
    #[serde(deserialize_with = "lenient")]
    preferred_account: Option<String>,
}

#[derive(Debug, Clone)]
struct PoolConfig {
    status_url: String,
    key: Option<ProxyKey>,
    /// Percent.
    switch_threshold: Option<f64>,
    preferred_account: Option<String>,
    routing_mode: Option<String>,
}

/// The status endpoint on the proxy's own address. A wildcard bind address
/// is reached on loopback; anything that isn't a plain host name or address
/// falls back to loopback too, so the key never goes somewhere unexpected.
fn status_url(host: Option<&str>, port: Option<u16>) -> String {
    let host = host.map(str::trim).unwrap_or_default();
    let plain = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'));
    let host = match host {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_string(),
        _ if !plain => "127.0.0.1".to_string(),
        h if h.contains(':') && !h.starts_with('[') => format!("[{h}]"),
        h => h.to_string(),
    };
    let port = port.filter(|p| *p != 0).unwrap_or(DEFAULT_PROXY_PORT);
    format!("http://{host}:{port}/maxpool/status")
}

impl PoolConfig {
    fn from_raw(raw: RawConfig) -> Self {
        let proxy = raw.proxy.unwrap_or_default();
        let routing = raw.routing.unwrap_or_default();
        PoolConfig {
            status_url: status_url(proxy.host.as_deref(), proxy.port),
            key: proxy.api_key.filter(|k| !k.0.is_empty()),
            switch_threshold: threshold_percent(raw.switch_threshold),
            preferred_account: clean_label(routing.preferred_account),
            routing_mode: clean_word(routing.mode),
        }
    }
}

#[derive(Debug)]
enum Discovery {
    /// No config: no pool.
    Absent,
    /// A config that can't be read or parsed.
    Unreadable,
    Found(PoolConfig),
}

fn config_path() -> Option<PathBuf> {
    match std::env::var_os(MAXPOOL_CONFIG_ENV) {
        Some(path) if !path.is_empty() => Some(PathBuf::from(path)),
        _ => dirs::home_dir().map(|home| home.join(".config").join("maxpool.json")),
    }
}

fn discover_at(path: &Path) -> Discovery {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Discovery::Absent,
        Err(_) => return Discovery::Unreadable,
    };
    let mut text = String::new();
    if file
        .take(CONFIG_MAX_BYTES + 1)
        .read_to_string(&mut text)
        .is_err()
        || text.len() as u64 > CONFIG_MAX_BYTES
    {
        return Discovery::Unreadable;
    }
    // Only an object is a config: serde would also read a struct out of a
    // JSON array, field by field.
    match serde_json::from_str::<Value>(&text) {
        Ok(value @ Value::Object(_)) => match serde_json::from_value::<RawConfig>(value) {
            Ok(raw) => Discovery::Found(PoolConfig::from_raw(raw)),
            Err(_) => Discovery::Unreadable,
        },
        _ => Discovery::Unreadable,
    }
}

fn discover() -> Discovery {
    config_path().map_or(Discovery::Absent, |path| discover_at(&path))
}

// ─── The pool's status (allow-listed) ───────────────────────────────────

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawStatus {
    #[serde(deserialize_with = "lenient")]
    running_version: Option<String>,
    #[serde(deserialize_with = "lenient")]
    current_account: Option<String>,
    #[serde(deserialize_with = "lenient")]
    switch_threshold: Option<f64>,
    #[serde(deserialize_with = "lenient")]
    routing: Option<RawRouting>,
    #[serde(deserialize_with = "lenient_list")]
    accounts: Vec<RawAccount>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawAccount {
    #[serde(deserialize_with = "lenient")]
    name: Option<String>,
    #[serde(deserialize_with = "lenient")]
    enabled: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    status: Option<String>,
    #[serde(deserialize_with = "lenient")]
    refresh_dead: Option<bool>,
    #[serde(deserialize_with = "lenient")]
    in_flight: Option<u32>,
    #[serde(deserialize_with = "lenient_time")]
    cooldown_until: Option<i64>,
    #[serde(deserialize_with = "lenient_time")]
    rate_limited_until: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    quota: Option<RawQuota>,
    #[serde(deserialize_with = "lenient")]
    weekly: Option<RawWeekly>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawQuota {
    #[serde(deserialize_with = "lenient")]
    unified5h: Option<f64>,
    #[serde(deserialize_with = "lenient")]
    unified7d: Option<f64>,
    #[serde(deserialize_with = "lenient_time")]
    unified5h_reset: Option<i64>,
    #[serde(deserialize_with = "lenient_time")]
    unified7d_reset: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    unified_status: Option<String>,
    #[serde(deserialize_with = "lenient_map")]
    scoped_weekly: BTreeMap<String, RawScoped>,
    #[serde(deserialize_with = "lenient_time")]
    last_probe_ok_at: Option<i64>,
    #[serde(deserialize_with = "lenient_time")]
    last_header_quota_at: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    last_probe_error_status: Option<u16>,
    #[serde(deserialize_with = "lenient")]
    consecutive_probe_failures: Option<u32>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawScoped {
    #[serde(deserialize_with = "lenient")]
    utilization: Option<f64>,
    #[serde(deserialize_with = "lenient_time")]
    reset_at: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    is_active: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawWeekly {
    #[serde(deserialize_with = "lenient")]
    state: Option<String>,
    #[serde(deserialize_with = "lenient")]
    raw_state: Option<String>,
}

// ─── The reading the screen gets ────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolKind {
    Maxpool,
}

/// What the pool says of an account's own health.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolAccountStatus {
    Active,
    Throttled,
    Exhausted,
    Error,
    Unknown,
}

impl PoolAccountStatus {
    fn from_raw(raw: Option<&str>) -> Self {
        match raw {
            Some("active") => Self::Active,
            Some("throttled") => Self::Throttled,
            Some("exhausted") => Self::Exhausted,
            Some("error") => Self::Error,
            _ => Self::Unknown,
        }
    }
}

/// The provider's verdict on the account's last response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolLimitStatus {
    Allowed,
    AllowedWarning,
    Rejected,
}

impl PoolLimitStatus {
    fn from_raw(raw: Option<&str>) -> Option<Self> {
        match raw? {
            "allowed" => Some(Self::Allowed),
            "allowed_warning" => Some(Self::AllowedWarning),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

/// The pool's weekly verdict on the account (from its raw weekly usage).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolWeeklyState {
    Normal,
    Soft,
    Reserve,
    Critical,
    Exhausted,
    Capped,
    Unknown,
}

impl PoolWeeklyState {
    fn from_raw(raw: Option<&str>) -> Option<Self> {
        match raw? {
            "normal" => Some(Self::Normal),
            "soft" => Some(Self::Soft),
            "reserve" => Some(Self::Reserve),
            "critical" => Some(Self::Critical),
            "exhausted" => Some(Self::Exhausted),
            "capped" => Some(Self::Capped),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

/// Where an account stands for taking requests, most severe first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolAccountState {
    /// Switched off in the pool's config.
    Disabled,
    /// In an error state the pool won't route to (a sign-in that can no
    /// longer be refreshed, among others); needs a person.
    Failing,
    /// At a limit: the 5-hour or weekly window is full, or the provider is
    /// rejecting it.
    Exhausted,
    /// Past the pool's switch threshold: requests go elsewhere until the
    /// window resets.
    AtThreshold,
    /// Benched for a short while after an error or a rate limit.
    CoolingDown,
    Available,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PoolAccount {
    pub name: String,
    pub enabled: bool,
    pub status: PoolAccountStatus,
    pub state: PoolAccountState,
    /// When the account takes requests again, when it's held back and the
    /// pool knows (epoch seconds).
    pub blocked_until: Option<i64>,
    /// The account the pool sends new requests to now.
    pub serving: bool,
    /// The account the pool's routing prefers while it has headroom.
    pub preferred: bool,
    /// 5h, 7d, then each model-scoped weekly window in effect.
    pub windows: Vec<PlanUsageWindow>,
    pub limit_status: Option<PoolLimitStatus>,
    pub weekly_state: Option<PoolWeeklyState>,
    /// Benched after an error or a rate limit until then (epoch seconds).
    pub cooling_until: Option<i64>,
    pub in_flight: u32,
    /// Usage probes failed in a row, and the last one's HTTP status: the
    /// numbers may be older than they look.
    pub probe_failures: u32,
    pub probe_error_status: Option<u16>,
    /// The account's sign-in can no longer be refreshed.
    pub refresh_failed: bool,
    /// The newest of the account's usage readings (epoch seconds).
    pub observed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolError {
    /// Nothing answered at the proxy's address.
    Unreachable,
    Timeout,
    /// The proxy refused the key.
    Unauthorized,
    /// Any other non-success answer (`error_status` says which).
    HttpStatus,
    /// An answer that isn't a pool status.
    InvalidResponse,
    /// The config was there before and can't be read now.
    ConfigUnreadable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanUsagePool {
    pub kind: PoolKind,
    /// The agent whose requests the pool carries.
    pub agent: PlanUsageAgent,
    pub version: Option<String>,
    pub accounts: Vec<PoolAccount>,
    pub current_account: Option<String>,
    pub preferred_account: Option<String>,
    pub routing_mode: Option<String>,
    /// Percent of the 5-hour window at which the pool moves off an account.
    pub switch_threshold: f64,
    /// Every enabled account is held back: the agent can't run until one
    /// frees up (`resumes_at`, when known).
    pub exhausted: bool,
    pub resumes_at: Option<i64>,
    /// The newest of the accounts' usage readings (epoch seconds).
    pub observed_at: Option<i64>,
    /// When the pool was last asked (epoch seconds).
    pub checked_at: i64,
    /// The last ask failed (`error`); `accounts` is the reading before it,
    /// or empty when there never was one.
    pub stale: bool,
    pub error: Option<PoolError>,
    pub error_status: Option<u16>,
}

fn usage_window(
    id: &str,
    utilization: Option<f64>,
    resets_at: Option<i64>,
    observed_at: Option<i64>,
) -> Option<PlanUsageWindow> {
    let utilization = utilization.filter(|u| u.is_finite())?;
    let mut window = claude_window(id, clamp_percent(utilization * 100.0), resets_at);
    window.observed_at = observed_at;
    Some(window)
}

/// A model family as a window-id suffix: lowercase letters, digits and `_`.
fn model_family(raw: &str) -> Option<String> {
    let family = raw.trim().to_ascii_lowercase();
    let ok = !family.is_empty()
        && family.len() <= 32
        && family
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    ok.then_some(family)
}

/// The model family a window is scoped to (`seven_day_<family>` →
/// `<family>`), or `None` for an account-wide window. The one window a
/// family's limit message names without the family in its id,
/// `seven_day_overage_included`, maps to that family's key in the pool.
pub(crate) fn scope_for_window(id: &str) -> Option<&str> {
    match id {
        "seven_day_overage_included" => Some("fable"),
        _ => id.strip_prefix("seven_day_").filter(|s| !s.is_empty()),
    }
}

/// Whether an account can take a request now, as the pool decides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Availability {
    Available,
    Disabled,
    /// Held back until `until` (epoch seconds), or for as long as a person
    /// leaves it (`None`, also when the reset isn't known).
    Blocked {
        until: Option<i64>,
    },
}

/// What blocks an account, and until when. `None` = no blocker; `Some(None)`
/// = blocked with no known end.
fn window_blocker(window: Option<&PlanUsageWindow>, full_at: f64, now: i64) -> Option<Option<i64>> {
    let window = window?;
    if window.used_percent < full_at {
        return None;
    }
    match window.resets_at {
        Some(reset) if reset <= now => None,
        reset => Some(reset),
    }
}

impl PoolAccount {
    fn window(&self, id: &str) -> Option<&PlanUsageWindow> {
        self.windows.iter().find(|w| w.id == id)
    }

    /// The account-wide quota blockers: the 5-hour window past `threshold`,
    /// a full or capped weekly, a provider rejection.
    fn quota_blockers(&self, now: i64, threshold: f64) -> (Vec<Option<i64>>, bool) {
        let mut blockers = Vec::new();
        let mut full = false;
        let five_hour = self.window("five_hour");
        let seven_day = self.window("seven_day");
        if let Some(until) = window_blocker(five_hour, threshold, now) {
            blockers.push(until);
            full |= five_hour.is_some_and(|w| w.used_percent >= 100.0);
        }
        let weekly_full = seven_day.is_some_and(|w| w.used_percent >= WEEKLY_EXHAUSTED_PERCENT);
        let weekly_blocks = match self.weekly_state {
            Some(PoolWeeklyState::Capped) => true,
            // The pool also says "exhausted" when the provider rejects an
            // account whose 5-hour window is full; that clears with the
            // 5-hour window, counted above.
            Some(PoolWeeklyState::Exhausted) => weekly_full,
            Some(_) => false,
            None => {
                weekly_full
                    && !matches!(
                        self.limit_status,
                        Some(PoolLimitStatus::Allowed | PoolLimitStatus::AllowedWarning)
                    )
            }
        };
        if weekly_blocks {
            match seven_day.and_then(|w| w.resets_at) {
                Some(reset) if reset <= now => {}
                reset => {
                    blockers.push(reset);
                    full = true;
                }
            }
        }
        // A rejection with no full window to explain it holds the account
        // with no known end, until a window rolls over and the verdict with
        // it.
        let rolled_over = self
            .windows
            .iter()
            .any(|w| w.resets_at.is_some_and(|reset| reset <= now));
        if blockers.is_empty()
            && self.limit_status == Some(PoolLimitStatus::Rejected)
            && !rolled_over
        {
            blockers.push(None);
            full = true;
        }
        (blockers, full)
    }

    /// Mirrors the pool's own routing gate: switched off, failed, cooling
    /// down, its 5-hour window past `threshold` (percent), its weekly full or
    /// capped, or — for a request to the model family `scope` — that model's
    /// weekly window full.
    pub(crate) fn availability(
        &self,
        now: i64,
        threshold: f64,
        scope: Option<&str>,
    ) -> Availability {
        if !self.enabled {
            return Availability::Disabled;
        }
        // The pool benches these with no reset of their own; a person (or a
        // fresh sign-in) brings them back. A failing sign-in refresh alone
        // doesn't bench an account, so it doesn't count here either.
        if matches!(
            self.status,
            PoolAccountStatus::Error | PoolAccountStatus::Exhausted
        ) {
            return Availability::Blocked { until: None };
        }
        let (mut blockers, _) = self.quota_blockers(now, threshold);
        if let Some(until) = self.cooling_until.filter(|t| *t > now) {
            blockers.push(Some(until));
        }
        if let Some(scope) = scope.and_then(model_family) {
            let id = format!("seven_day_{scope}");
            if let Some(until) = window_blocker(self.window(&id), WEEKLY_EXHAUSTED_PERCENT, now) {
                blockers.push(until);
            }
        }
        if blockers.is_empty() {
            return Availability::Available;
        }
        // Free once every blocker has cleared; unknown if any end is.
        let until = blockers
            .into_iter()
            .try_fold(i64::MIN, |latest, until| until.map(|t| latest.max(t)));
        Availability::Blocked { until }
    }

    fn state_at(&self, now: i64, threshold: f64) -> PoolAccountState {
        if !self.enabled {
            return PoolAccountState::Disabled;
        }
        if self.status == PoolAccountStatus::Error {
            return PoolAccountState::Failing;
        }
        let (blockers, full) = self.quota_blockers(now, threshold);
        if self.status == PoolAccountStatus::Exhausted || full {
            return PoolAccountState::Exhausted;
        }
        if !blockers.is_empty() {
            return PoolAccountState::AtThreshold;
        }
        if self.cooling_until.is_some_and(|t| t > now) {
            return PoolAccountState::CoolingDown;
        }
        PoolAccountState::Available
    }

    fn from_raw(
        raw: RawAccount,
        current: Option<&str>,
        preferred: Option<&str>,
        threshold: f64,
        now: i64,
    ) -> Option<Self> {
        let name = clean_label(raw.name)?;
        let quota = raw.quota.unwrap_or_default();
        let weekly = raw.weekly.unwrap_or_default();
        let observed_at = quota.last_probe_ok_at.max(quota.last_header_quota_at);
        let mut windows: Vec<PlanUsageWindow> = [
            usage_window(
                "five_hour",
                quota.unified5h,
                quota.unified5h_reset,
                observed_at,
            ),
            usage_window(
                "seven_day",
                quota.unified7d,
                quota.unified7d_reset,
                observed_at,
            ),
        ]
        .into_iter()
        .flatten()
        .collect();
        for (family, scoped) in quota.scoped_weekly {
            if scoped.is_active == Some(false) {
                continue;
            }
            let Some(family) = model_family(&family) else {
                continue;
            };
            windows.extend(usage_window(
                &format!("seven_day_{family}"),
                scoped.utilization,
                scoped.reset_at,
                observed_at,
            ));
        }
        let status = PoolAccountStatus::from_raw(raw.status.as_deref());
        let cooling_until = raw
            .cooldown_until
            .max(raw.rate_limited_until)
            .filter(|t| *t > now);
        let mut account = PoolAccount {
            serving: current == Some(name.as_str()),
            preferred: preferred == Some(name.as_str()),
            name,
            enabled: raw.enabled.unwrap_or(true),
            status,
            state: PoolAccountState::Available,
            blocked_until: None,
            windows,
            limit_status: PoolLimitStatus::from_raw(quota.unified_status.as_deref()),
            weekly_state: PoolWeeklyState::from_raw(
                weekly.raw_state.as_deref().or(weekly.state.as_deref()),
            ),
            cooling_until,
            in_flight: raw.in_flight.unwrap_or(0),
            probe_failures: quota.consecutive_probe_failures.unwrap_or(0),
            probe_error_status: quota.last_probe_error_status,
            refresh_failed: raw.refresh_dead.unwrap_or(false),
            observed_at,
        };
        account.state = account.state_at(now, threshold);
        account.blocked_until = match account.availability(now, threshold, None) {
            Availability::Blocked { until } => until,
            _ => None,
        };
        Some(account)
    }
}

/// Whether the pool as a whole can take a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PoolLimit {
    /// Some enabled account has headroom.
    Headroom,
    /// Every enabled account is held back; the first frees up then (epoch
    /// seconds), when known.
    Exhausted { resumes_at: Option<i64> },
}

/// The pool's verdict for a request (to the model family `scope`, if any).
/// `None` when no account is enabled: then the pool decides nothing here.
pub(crate) fn pool_limit(pool: &PlanUsagePool, now: i64, scope: Option<&str>) -> Option<PoolLimit> {
    let mut any_enabled = false;
    let mut earliest: Option<i64> = None;
    for account in &pool.accounts {
        match account.availability(now, pool.switch_threshold, scope) {
            Availability::Available => return Some(PoolLimit::Headroom),
            Availability::Disabled => continue,
            Availability::Blocked { until } => {
                any_enabled = true;
                if let Some(t) = until {
                    earliest = Some(earliest.map_or(t, |e| e.min(t)));
                }
            }
        }
    }
    any_enabled.then_some(PoolLimit::Exhausted {
        resumes_at: earliest,
    })
}

fn build_pool(raw: RawStatus, config: &PoolConfig, now: i64) -> PlanUsagePool {
    let routing = raw.routing.unwrap_or_default();
    let threshold = threshold_percent(raw.switch_threshold)
        .or(config.switch_threshold)
        .unwrap_or(DEFAULT_SWITCH_THRESHOLD * 100.0);
    let preferred_account =
        clean_label(routing.preferred_account).or_else(|| config.preferred_account.clone());
    let routing_mode = clean_word(routing.mode).or_else(|| config.routing_mode.clone());
    let current_account = clean_label(raw.current_account);
    let accounts: Vec<PoolAccount> = raw
        .accounts
        .into_iter()
        .filter_map(|account| {
            PoolAccount::from_raw(
                account,
                current_account.as_deref(),
                preferred_account.as_deref(),
                threshold,
                now,
            )
        })
        .take(MAX_ACCOUNTS)
        .collect();
    let observed_at = accounts.iter().filter_map(|a| a.observed_at).max();
    let mut pool = PlanUsagePool {
        kind: PoolKind::Maxpool,
        agent: PlanUsageAgent::ClaudeCode,
        version: clean_word(raw.running_version),
        accounts,
        current_account,
        preferred_account,
        routing_mode,
        switch_threshold: threshold,
        exhausted: false,
        resumes_at: None,
        observed_at,
        checked_at: now,
        stale: false,
        error: None,
        error_status: None,
    };
    if let Some(PoolLimit::Exhausted { resumes_at }) = pool_limit(&pool, now, None) {
        pool.exhausted = true;
        pool.resumes_at = resumes_at;
    }
    pool
}

impl PlanUsagePool {
    /// The last good reading, kept after a failed ask.
    fn into_stale(self, error: FetchError, now: i64) -> Self {
        PlanUsagePool {
            stale: true,
            error: Some(error.kind),
            error_status: error.status,
            checked_at: now,
            ..self
        }
    }

    /// A configured pool that has never answered.
    fn unanswered(config: &PoolConfig, error: FetchError, now: i64) -> Self {
        PlanUsagePool {
            kind: PoolKind::Maxpool,
            agent: PlanUsageAgent::ClaudeCode,
            version: None,
            accounts: Vec::new(),
            current_account: None,
            preferred_account: config.preferred_account.clone(),
            routing_mode: config.routing_mode.clone(),
            switch_threshold: config
                .switch_threshold
                .unwrap_or(DEFAULT_SWITCH_THRESHOLD * 100.0),
            exhausted: false,
            resumes_at: None,
            observed_at: None,
            checked_at: now,
            stale: true,
            error: Some(error.kind),
            error_status: error.status,
        }
    }
}

// ─── Fetching ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FetchError {
    kind: PoolError,
    status: Option<u16>,
}

impl FetchError {
    fn of(kind: PoolError) -> Self {
        FetchError { kind, status: None }
    }

    fn from_reqwest(error: &reqwest::Error) -> Self {
        Self::of(if error.is_timeout() {
            PoolError::Timeout
        } else {
            PoolError::Unreachable
        })
    }
}

/// Loopback-only in practice, so no system proxy; short timeouts so a hung
/// proxy can't stall the screen; no redirects, so the key goes nowhere else.
static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
});

async fn fetch_status(config: &PoolConfig) -> Result<RawStatus, FetchError> {
    let client = CLIENT
        .as_ref()
        .ok_or(FetchError::of(PoolError::Unreachable))?;
    let mut request = client.get(&config.status_url);
    if let Some(value) = config.key.as_ref().and_then(ProxyKey::header_value) {
        request = request.header("x-api-key", value);
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| FetchError::from_reqwest(&e))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(FetchError {
            kind: PoolError::Unauthorized,
            status: Some(status.as_u16()),
        });
    }
    if !status.is_success() {
        return Err(FetchError {
            kind: PoolError::HttpStatus,
            status: Some(status.as_u16()),
        });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| FetchError::from_reqwest(&e))?
    {
        if body.len() + chunk.len() > STATUS_MAX_BYTES {
            return Err(FetchError::of(PoolError::InvalidResponse));
        }
        body.extend_from_slice(&chunk);
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(value @ Value::Object(_)) => {
            serde_json::from_value(value).map_err(|_| FetchError::of(PoolError::InvalidResponse))
        }
        _ => Err(FetchError::of(PoolError::InvalidResponse)),
    }
}

// ─── The held reading ───────────────────────────────────────────────────

struct PoolStore {
    /// Discovery has run at least once.
    checked: bool,
    /// The poll task runs, so the reading stays fresh; limit-continue only
    /// trusts the pool then.
    polled: bool,
    reading: Option<PlanUsagePool>,
    fetched_at: Option<Instant>,
    /// The clients were last sent a pool (so its going away is news).
    pushed: bool,
}

static STORE: Mutex<PoolStore> = Mutex::new(PoolStore {
    checked: false,
    polled: false,
    reading: None,
    fetched_at: None,
    pushed: false,
});

/// Where new readings go; set once the poll task starts.
static EMITTER: OnceLock<EventEmitter> = OnceLock::new();

/// One ask of the pool at a time: concurrent callers wait for it and share
/// the answer.
static FETCH_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn with_store<R>(f: impl FnOnce(&mut PoolStore) -> R) -> R {
    let mut store = STORE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut store)
}

/// The next reading from the previous one and what discovery and the ask
/// found.
async fn next_reading(previous: Option<PlanUsagePool>, now: i64) -> Option<PlanUsagePool> {
    match discover() {
        Discovery::Absent => None,
        // A config being rewritten in place reads as garbage for a moment:
        // keep what was there, flagged. A config that never parsed is no pool.
        Discovery::Unreadable => previous
            .filter(|p| !p.accounts.is_empty())
            .map(|p| p.into_stale(FetchError::of(PoolError::ConfigUnreadable), now)),
        Discovery::Found(config) => match fetch_status(&config).await {
            Ok(raw) => Some(build_pool(raw, &config, now)),
            Err(error) => Some(match previous.filter(|p| !p.accounts.is_empty()) {
                Some(previous) => previous.into_stale(error, now),
                None => PlanUsagePool::unanswered(&config, error, now),
            }),
        },
    }
}

/// Send a new reading to every client: each pool reading, and `None` once
/// when the pool goes away. Whoever asked for it (the poll, the screen's
/// refresh, limit-continue), every window and the status bar see it at once.
fn publish(emitter: &EventEmitter, reading: Option<&PlanUsagePool>) {
    let send = with_store(|store| match reading {
        Some(_) => {
            store.pushed = true;
            true
        }
        None => std::mem::replace(&mut store.pushed, false),
    });
    if send {
        emit_event(emitter, PLAN_USAGE_POOL_CHANGED_EVENT, reading);
    }
}

/// The current reading, asking the pool again unless the held one is younger
/// than `min_age`.
async fn refresh(min_age: Duration) -> Option<PlanUsagePool> {
    let _guard = FETCH_LOCK.lock().await;
    let (fresh, previous) = with_store(|store| {
        let fresh = store.checked && store.fetched_at.is_some_and(|t| t.elapsed() < min_age);
        (fresh, store.reading.clone())
    });
    if fresh {
        return previous;
    }
    let reading = next_reading(previous, now_secs()).await;
    with_store(|store| {
        store.checked = true;
        store.reading = reading.clone();
        store.fetched_at = Some(Instant::now());
    });
    if let Some(emitter) = EMITTER.get() {
        publish(emitter, reading.as_ref());
    }
    reading
}

/// The pool for the plan-usage report: re-read when `force` (the screen's
/// refresh), otherwise the held reading while it's recent.
pub(crate) async fn report_reading(force: bool) -> Option<PlanUsagePool> {
    refresh(if force { FORCE_MIN_AGE } else { POLL_INTERVAL }).await
}

/// What a reading says for the log: no pool, a pool, or a pool in trouble.
fn log_state(reading: Option<&PlanUsagePool>) -> Option<Option<PoolError>> {
    reading.map(|pool| pool.error)
}

/// Keep the pool's reading fresh while one is configured; each new reading
/// goes to the clients ([`publish`]). Runs for the life of the app (desktop
/// and server alike).
pub async fn run_usage_pool(emitter: EventEmitter) {
    let _ = EMITTER.set(emitter);
    with_store(|store| store.polled = true);
    let mut logged: Option<Option<PoolError>> = None;
    loop {
        let reading = refresh(POLL_MIN_AGE).await;
        let state = log_state(reading.as_ref());
        if state != logged {
            match (&reading, state) {
                (None, _) => tracing::info!("[usage-pool] no account pool configured"),
                (Some(pool), Some(None)) => tracing::info!(
                    accounts = pool.accounts.len(),
                    "[usage-pool] reading the account pool"
                ),
                (Some(_), Some(Some(error))) => {
                    tracing::warn!(?error, "[usage-pool] account pool not readable")
                }
                (Some(_), None) => {}
            }
            logged = state;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// When to continue a session the usage limit paused, as the pool sees it:
/// soon when some account still has headroom (the pool routes the
/// continuation there), else when the first blocked account frees up.
/// `named_window` is the window the agent's message names, so a model's own
/// weekly limit only waits for accounts with that model's headroom. `None`
/// when no pool is polled, its reading is stale, or it can't say.
pub(crate) async fn pool_resume_at(now: i64, named_window: Option<&str>) -> Option<i64> {
    let (polled, fresh) = with_store(|store| {
        (
            store.polled,
            store
                .fetched_at
                .is_some_and(|t| t.elapsed() < RESUME_MAX_AGE),
        )
    });
    if !polled {
        return None;
    }
    let reading = if fresh {
        with_store(|store| store.reading.clone())
    } else {
        match tokio::time::timeout(RESUME_REFRESH_TIMEOUT, refresh(RESUME_MAX_AGE)).await {
            Ok(reading) => reading,
            Err(_) => with_store(|store| store.reading.clone()),
        }
    };
    resume_at_from(reading.as_ref()?, now, named_window)
}

/// [`pool_resume_at`]'s decision on a given reading.
pub(crate) fn resume_at_from(
    pool: &PlanUsagePool,
    now: i64,
    named_window: Option<&str>,
) -> Option<i64> {
    if pool.stale || pool.accounts.is_empty() {
        return None;
    }
    match pool_limit(pool, now, named_window.and_then(scope_for_window))? {
        PoolLimit::Headroom => Some(now + POOL_HEADROOM_RETRY_SECS),
        PoolLimit::Exhausted { resumes_at } => resumes_at,
    }
}

#[cfg(test)]
mod tests;
