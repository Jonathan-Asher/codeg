//! Usage-limit resets: the free "refill my limits" grants that Claude and
//! Codex subscriptions hand out. They are listed and used from the
//! Subscription usage screen and from a session paused at its limit.
//!
//! Each provider is driven through its own client's mechanism. [`claude`]
//! and [`codex`] describe exactly how. Nothing here enumerates, rotates or
//! touches the accounts of a local account pool. A reset acts on the one
//! account the agent's CLI is signed in with on this machine.
//!
//! A used reset cannot be given back, so the flow is careful:
//! * one attempt per provider at a time ([`InFlight`]);
//! * the attempt's id (Claude's `request_id`, Codex's `idempotencyKey`) is
//!   kept while its answer is unknown and reused on the retry
//!   ([`ATTEMPTS`]), so a lost answer can never cost a second reset;
//! * a Claude grant is checked against a fresh read just before it is
//!   used, as the CLI does.

pub(crate) mod claude;
pub(crate) mod codex;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::acp::claude_auth::{self, ClaudeAuthMethod, ClaudeCli};
use crate::acp::registry::{self, AgentDistribution};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::plan_usage::{self, now_secs, PlanUsageAgent};
use crate::commands::usage_pool;
use crate::db::service::{agent_setting_service, conversation_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

/// How long a listing is reused before the providers are asked again.
const CACHE_TTL: Duration = Duration::from_secs(60);
/// How long a `claude --version` answer is reused.
const CLI_VERSION_TTL: Duration = Duration::from_secs(10 * 60);

// ─── Shapes (mirrored in `src/lib/types.ts`) ────────────────────────────

/// What a reset refills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetKind {
    /// The short rolling window (Claude's 5 hours).
    Session,
    /// The weekly window.
    Weekly,
    /// Every limit at once (Codex's resets, Claude's full ones).
    Full,
    /// Claude's Fable-only reset.
    Fable,
    Other,
}

/// One reset grant (Claude) or credit (Codex).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitResetItem {
    /// The provider's id for it, which `use_limit_reset` takes. `None` when
    /// only a count is known and the provider picks.
    pub id: Option<String>,
    pub kind: LimitResetKind,
    /// The provider's own name for it ("One full limit reset (November
    /// 2026)", "Full reset").
    pub label: Option<String>,
    pub description: Option<String>,
    /// Resets this grant still holds. A Codex credit is one.
    pub count: u32,
    /// Epoch seconds it expires at, when it does.
    pub expires_at: Option<i64>,
    pub usable_now: bool,
    /// It can only be used while a limit it refills is reached.
    pub requires_limit: bool,
    /// The plan-usage window ids it refills. Empty means every window.
    pub clears: Vec<String>,
    /// Why it can't be used now, as the provider's code (`paused`, …).
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetSource {
    /// The Anthropic endpoints Claude Code itself calls, with its login.
    ClaudeOauth,
    /// Codex's app-server.
    CodexAppServer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetErrorCode {
    /// The agent's adapter isn't installed.
    NotInstalled,
    /// The CLI has no subscription sign-in on this machine.
    NotLoggedIn,
    /// The stored sign-in has expired. The CLI renews it on its next request.
    LoginExpired,
    /// The provider doesn't offer resets to this account or app (`reason`).
    NotEligible,
    /// The installed CLI is too old for resets.
    UnsupportedVersion,
    /// The provider couldn't be reached, or answered with a server error.
    Network,
    /// A reset is already being used for this provider.
    Busy,
    Failed,
}

impl LimitResetErrorCode {
    /// The `PlanUsage` i18n key the UI renders it with.
    pub(crate) fn i18n_key(self) -> &'static str {
        match self {
            Self::NotInstalled => "resets.error.notInstalled",
            Self::NotLoggedIn => "resets.error.notLoggedIn",
            Self::LoginExpired => "resets.error.loginExpired",
            Self::NotEligible => "resets.error.notEligible",
            Self::UnsupportedVersion => "resets.error.unsupportedVersion",
            Self::Network => "resets.error.network",
            Self::Busy => "resets.error.busy",
            Self::Failed => "resets.error.failed",
        }
    }

    fn app_code(self) -> AppErrorCode {
        match self {
            Self::NotInstalled | Self::UnsupportedVersion => AppErrorCode::DependencyMissing,
            Self::NotLoggedIn | Self::LoginExpired => AppErrorCode::AuthenticationFailed,
            Self::NotEligible => AppErrorCode::PermissionDenied,
            Self::Network => AppErrorCode::NetworkError,
            Self::Busy => AppErrorCode::InvalidInput,
            Self::Failed => AppErrorCode::TaskExecutionFailed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitResetError {
    pub code: LimitResetErrorCode,
    /// English. The UI shows its own words for `code`.
    pub message: String,
    /// The provider's reason code, e.g. Claude's `ineligible_reason`
    /// (`surface`, `tier`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl LimitResetError {
    pub(crate) fn new(code: LimitResetErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reason: None,
        }
    }

    pub(crate) fn with_reason(mut self, reason: Option<String>) -> Self {
        self.reason = reason;
        self
    }

    pub(crate) fn into_app_error(self) -> AppCommandError {
        let mut params = BTreeMap::new();
        if let Some(reason) = &self.reason {
            params.insert("reason".to_string(), reason.clone());
        }
        AppCommandError::new(self.code.app_code(), self.message)
            .with_i18n(self.code.i18n_key(), params)
    }
}

/// One provider's resets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderLimitResets {
    pub provider: PlanUsageAgent,
    /// Resets left: Codex's `availableCount`, or the sum over Claude's
    /// grants still in date.
    pub available: u32,
    /// Soonest to expire first.
    pub items: Vec<LimitResetItem>,
    pub source: LimitResetSource,
    /// The account they belong to (the CLI's own sign-in), when known.
    pub account: Option<String>,
    pub error: Option<LimitResetError>,
    /// Epoch seconds.
    pub fetched_at: i64,
}

impl ProviderLimitResets {
    fn empty(provider: PlanUsageAgent, fetched_at: i64) -> Self {
        Self {
            provider,
            available: 0,
            items: Vec::new(),
            source: match provider {
                PlanUsageAgent::ClaudeCode => LimitResetSource::ClaudeOauth,
                PlanUsageAgent::Codex => LimitResetSource::CodexAppServer,
            },
            account: None,
            error: None,
            fetched_at,
        }
    }

    fn failed(provider: PlanUsageAgent, fetched_at: i64, error: LimitResetError) -> Self {
        Self {
            error: Some(error),
            ..Self::empty(provider, fetched_at)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LimitResetsReport {
    pub providers: Vec<ProviderLimitResets>,
}

/// What an attempt to use a reset came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetOutcome {
    /// It went through: the limits it covers are refilled.
    Reset,
    /// Nothing was used: no limit it covers needs it (it needs one reached).
    NothingToReset,
    /// Nothing was used: no reset is left, or that one is gone.
    NoReset,
    /// That reset had already been used (an earlier try went through).
    AlreadyUsed,
    /// Nothing was used: another reset is going through on the account.
    Cooldown,
    /// No confirmation came. It may have gone through. A retry reuses the
    /// same attempt, so it can't use a second one.
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UseLimitResetResult {
    pub provider: PlanUsageAgent,
    pub outcome: LimitResetOutcome,
    /// Windows the provider says it refilled.
    pub cleared: Vec<String>,
    /// The provider's resets read again after the attempt, when that worked.
    pub resets: Option<ProviderLimitResets>,
    /// This provider's sessions paused at their limit, which could continue
    /// now (ids), not counting the one continued below.
    pub paused_conversations: Vec<i32>,
    /// The paused session asked to continue, when its continuation went out.
    pub continued: Option<i32>,
}

// ─── Process-wide state ─────────────────────────────────────────────────

fn slot(provider: PlanUsageAgent) -> usize {
    match provider {
        PlanUsageAgent::ClaudeCode => 0,
        PlanUsageAgent::Codex => 1,
    }
}

static CACHE: Mutex<[Option<(Instant, ProviderLimitResets)>; 2]> = Mutex::new([None, None]);

fn cached(provider: PlanUsageAgent) -> Option<ProviderLimitResets> {
    let guard = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard[slot(provider)]
        .as_ref()
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
        .map(|(_, resets)| resets.clone())
}

fn remember(resets: &ProviderLimitResets) {
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())[slot(resets.provider)] =
        Some((Instant::now(), resets.clone()));
}

fn forget(provider: PlanUsageAgent) {
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())[slot(provider)] = None;
}

static IN_FLIGHT_FLAGS: Mutex<[bool; 2]> = Mutex::new([false, false]);

/// The one attempt allowed per provider; released when dropped.
pub(crate) struct InFlight(usize);

impl InFlight {
    pub(crate) fn take(provider: PlanUsageAgent) -> Option<Self> {
        let index = slot(provider);
        let mut flags = IN_FLIGHT_FLAGS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if flags[index] {
            return None;
        }
        flags[index] = true;
        Some(Self(index))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT_FLAGS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())[self.0] = false;
    }
}

/// Attempts whose answer never came: provider, reset id (`None` when the
/// provider picks) and the attempt id they went out under.
static ATTEMPTS: Mutex<Vec<(PlanUsageAgent, Option<String>, String)>> = Mutex::new(Vec::new());

/// The id to send an attempt under: the unanswered one for the same reset,
/// or a fresh one.
pub(crate) fn attempt_id(provider: PlanUsageAgent, reset_id: Option<&str>) -> String {
    let attempts = ATTEMPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attempts
        .iter()
        .find(|(p, id, _)| *p == provider && id.as_deref() == reset_id)
        .map(|(_, _, key)| key.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

/// Record how an attempt ended: an unconfirmed one is kept for its retry,
/// any other answer settles it.
pub(crate) fn settle_attempt(
    provider: PlanUsageAgent,
    reset_id: Option<&str>,
    key: &str,
    outcome: Option<LimitResetOutcome>,
) {
    let mut attempts = ATTEMPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attempts.retain(|(p, id, _)| !(*p == provider && id.as_deref() == reset_id));
    if outcome == Some(LimitResetOutcome::Unconfirmed) {
        attempts.push((provider, reset_id.map(str::to_string), key.to_string()));
    }
}

static CLI_VERSION: Mutex<Option<(Instant, String)>> = Mutex::new(None);

// ─── Launching the agents' own tools ────────────────────────────────────

/// The environment the agent launches with. An agent switched off in
/// settings still has a sign-in, so that case falls back to the stored
/// settings alone (as Settings → Agents → Claude Code does).
async fn launch_env(
    db: &AppDatabase,
    data_dir: &Path,
    agent: AgentType,
) -> BTreeMap<String, String> {
    match crate::commands::acp::build_session_runtime_env(db, agent, None, data_dir).await {
        Ok(env) => env,
        Err(_) => {
            let setting = agent_setting_service::get_by_agent_type(&db.conn, agent)
                .await
                .ok()
                .flatten();
            let local = crate::commands::acp::load_agent_local_config_json(agent);
            crate::commands::acp::build_runtime_env_from_setting(
                agent,
                setting.as_ref(),
                local.as_deref(),
            )
        }
    }
}

fn not_installed(agent: &str) -> LimitResetError {
    LimitResetError::new(
        LimitResetErrorCode::NotInstalled,
        format!("{agent} isn't installed. Install it in Settings, Agents."),
    )
}

/// Everything a Claude call needs, from the CLI the agent runs.
struct ClaudeContext {
    cli_version: String,
    org_id: String,
    email: Option<String>,
    login: claude::StoredLogin,
}

async fn claude_cli_version(cli: &ClaudeCli) -> String {
    {
        let guard = CLI_VERSION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, version)) = guard.as_ref() {
            if at.elapsed() < CLI_VERSION_TTL {
                return version.clone();
            }
        }
    }
    let version = claude_auth::read_version_output(cli)
        .await
        .ok()
        .and_then(|out| claude::parse_cli_version(&out));
    match version {
        Some(version) => {
            *CLI_VERSION
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some((Instant::now(), version.clone()));
            version
        }
        None => "unknown".to_string(),
    }
}

async fn claude_context(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<ClaudeContext, LimitResetError> {
    let env = launch_env(db, data_dir, AgentType::ClaudeCode).await;
    let cli = ClaudeCli::for_runtime_env(&env)
        .await
        .map_err(|_| not_installed("Claude Code"))?;
    let (status, identity) = claude_auth::read_status_and_identity(&cli)
        .await
        .map_err(|e| {
            LimitResetError::new(
                LimitResetErrorCode::Failed,
                format!("Couldn't ask Claude Code about its sign-in: {e}"),
            )
        })?;
    if !status.logged_in {
        return Err(LimitResetError::new(
            LimitResetErrorCode::NotLoggedIn,
            "Claude Code isn't signed in on this machine.",
        ));
    }
    if status.method != ClaudeAuthMethod::ClaudeAi {
        let method = serde_json::to_value(status.method)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string));
        return Err(LimitResetError::new(
            LimitResetErrorCode::NotEligible,
            "Usage-limit resets come with a Claude subscription sign-in.",
        )
        .with_reason(method));
    }
    let org_id = identity.org_id.clone().ok_or_else(|| {
        LimitResetError::new(
            LimitResetErrorCode::NotLoggedIn,
            "Claude Code's sign-in names no organization.",
        )
    })?;
    let secure_storage_dir = cli.env_var("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    let config_dir_env_set = cli
        .env_var("CLAUDE_CONFIG_DIR")
        .is_some_and(|dir| !dir.is_empty());
    let user = cli.env_var("USER").or_else(|| cli.env_var("LOGNAME"));
    let location = claude::LoginLocation {
        secure_storage_dir: secure_storage_dir.as_deref(),
        config_dir_env_set,
        config_dir: identity.config_dir.as_deref(),
        user: user.as_deref(),
    };
    let login = claude::read_stored_login(&location).await?;
    if login.is_expired(now_secs()) {
        return Err(LimitResetError::new(
            LimitResetErrorCode::LoginExpired,
            "Claude Code's sign-in has expired. It renews on the next Claude Code request; try again after one.",
        ));
    }
    if !login.can_read_usage() {
        return Err(LimitResetError::new(
            LimitResetErrorCode::NotEligible,
            "This Claude Code sign-in can't read plan usage (a long-lived token). Sign in with claude.ai.",
        )
        .with_reason(Some("scope".to_string())));
    }
    Ok(ClaudeContext {
        cli_version: claude_cli_version(&cli).await,
        org_id,
        email: status.email,
        login,
    })
}

/// `codex-acp cli app-server` with the environment a Codex session gets.
async fn start_codex(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<codex::CodexProcess, LimitResetError> {
    let runtime_env = launch_env(db, data_dir, AgentType::Codex).await;
    let meta = registry::get_agent_meta(AgentType::Codex);
    let AgentDistribution::Npx { cmd, env, .. } = meta.distribution else {
        return Err(not_installed("Codex"));
    };
    let program = crate::commands::acp::resolve_npx_command(cmd)
        .await
        .ok_or_else(|| not_installed("Codex"))?;
    let env = crate::acp::connection::merge_agent_env(env, &runtime_env, None);
    codex::CodexProcess::start(&program, &env).await
}

async fn claude_pool_active() -> bool {
    usage_pool::report_reading(false)
        .await
        .is_some_and(|pool| pool.agent == PlanUsageAgent::ClaudeCode)
}

// ─── Listing ────────────────────────────────────────────────────────────

/// A Claude usage read: its grants, and the body (whose windows feed plan
/// usage).
async fn claude_read(
    api: &claude::ClaudeApi,
    context: &ClaudeContext,
    now: i64,
) -> Result<(Option<claude::ClaudeResets>, serde_json::Value), LimitResetError> {
    let user_agent = claude::user_agent(&context.cli_version);
    let body = api
        .usage(&context.login, &user_agent)
        .await
        .map_err(|failure| claude::error_for_failure(&failure))?;
    Ok((claude::parse_resets(&body, now), body))
}

/// The listing a Claude read makes. A read with no reset block (the server
/// doesn't run the program here) lists none.
pub(crate) fn claude_listing(
    resets: Option<&claude::ClaudeResets>,
    account: Option<String>,
    now: i64,
) -> ProviderLimitResets {
    let mut out = ProviderLimitResets::empty(PlanUsageAgent::ClaudeCode, now);
    out.account = account;
    let Some(resets) = resets else {
        return out;
    };
    if !resets.eligible {
        out.error = claude::ineligible_error(resets.ineligible_reason.as_deref()).err();
        return out;
    }
    out.available = resets.available();
    out.items = resets.items.clone();
    out
}

/// Hand a Claude usage read's windows to plan usage, unless a local
/// account pool serves Claude Code: the live reading then describes the
/// pool's accounts, not the CLI's own.
async fn feed_claude_usage(emitter: &EventEmitter, body: &serde_json::Value) {
    if !claude_pool_active().await {
        plan_usage::observe_claude_usage_read(emitter, body);
    }
}

async fn list_claude(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    api: &claude::ClaudeApi,
) -> ProviderLimitResets {
    let now = now_secs();
    let context = match claude_context(db, data_dir).await {
        Ok(context) => context,
        Err(error) => return ProviderLimitResets::failed(PlanUsageAgent::ClaudeCode, now, error),
    };
    match claude_read(api, &context, now).await {
        Ok((resets, body)) => {
            feed_claude_usage(emitter, &body).await;
            claude_listing(resets.as_ref(), context.email.clone(), now)
        }
        Err(error) => {
            let mut out = ProviderLimitResets::failed(PlanUsageAgent::ClaudeCode, now, error);
            out.account = context.email.clone();
            out
        }
    }
}

/// The listing a Codex read makes.
pub(crate) fn codex_listing(
    account: Option<String>,
    reading: &codex::CodexReading,
    now: i64,
) -> ProviderLimitResets {
    ProviderLimitResets {
        available: reading.available,
        items: reading.items.clone(),
        account,
        ..ProviderLimitResets::empty(PlanUsageAgent::Codex, now)
    }
}

async fn list_codex(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> ProviderLimitResets {
    let now = now_secs();
    let mut process = match start_codex(db, data_dir).await {
        Ok(process) => process,
        Err(error) => return ProviderLimitResets::failed(PlanUsageAgent::Codex, now, error),
    };
    let read = codex::read(&mut process.server, now).await;
    process.close().await;
    match read {
        Ok((account, reading)) => {
            if let Some(snapshot) = reading.snapshot.clone() {
                plan_usage::observe_codex_live_snapshot(emitter, snapshot);
            }
            codex_listing(account.email, &reading, now)
        }
        Err(error) => ProviderLimitResets::failed(PlanUsageAgent::Codex, now, error),
    }
}

async fn provider_resets(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    provider: PlanUsageAgent,
    force: bool,
) -> ProviderLimitResets {
    if !force {
        if let Some(resets) = cached(provider) {
            return resets;
        }
    }
    let resets = match provider {
        PlanUsageAgent::ClaudeCode => {
            list_claude(
                db,
                data_dir,
                emitter,
                &claude::ClaudeApi::new(claude::API_BASE),
            )
            .await
        }
        PlanUsageAgent::Codex => list_codex(db, data_dir, emitter).await,
    };
    remember(&resets);
    resets
}

/// Every provider's resets. `force` asks the providers again rather than
/// reusing a listing from the last minute.
pub async fn get_limit_resets_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    force: bool,
) -> Result<LimitResetsReport, AppCommandError> {
    let (claude_resets, codex_resets) = tokio::join!(
        provider_resets(db, data_dir, emitter, PlanUsageAgent::ClaudeCode, force),
        provider_resets(db, data_dir, emitter, PlanUsageAgent::Codex, force),
    );
    Ok(LimitResetsReport {
        providers: vec![claude_resets, codex_resets],
    })
}

// ─── Using one ──────────────────────────────────────────────────────────

/// One attempt's answer, before the paused sessions are looked at.
#[derive(Debug)]
struct Attempt {
    outcome: LimitResetOutcome,
    cleared: Vec<String>,
    resets: Option<ProviderLimitResets>,
}

/// Which Claude grant a "use" takes, or what using it would come to now.
pub(crate) fn choose_claude_grant(
    resets: &claude::ClaudeResets,
    requested: Option<&str>,
) -> Result<String, LimitResetOutcome> {
    let grant = match requested {
        Some(id) => resets.find(id),
        // With none usable, the server's next (or first) grant says why.
        None => resets
            .default_grant()
            .or_else(|| {
                resets
                    .next_grant_id
                    .as_deref()
                    .and_then(|id| resets.find(id))
            })
            .or_else(|| resets.items.first()),
    };
    let Some(grant) = grant else {
        return Err(LimitResetOutcome::NoReset);
    };
    if !grant.usable_now {
        // Saved for a limit, and none is reached: the server would answer
        // `not_limited`, using nothing.
        return Err(if grant.requires_limit && !resets.at_limit {
            LimitResetOutcome::NothingToReset
        } else {
            LimitResetOutcome::NoReset
        });
    }
    grant.id.clone().ok_or(LimitResetOutcome::NoReset)
}

async fn use_claude(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    api: &claude::ClaudeApi,
    requested: Option<&str>,
) -> Result<Attempt, LimitResetError> {
    let context = claude_context(db, data_dir).await?;
    let (attempt, refreshed) = redeem_claude(api, &context, requested).await?;
    if let Some(body) = refreshed {
        feed_claude_usage(emitter, &body).await;
    }
    Ok(attempt)
}

/// Check the grant against a fresh read, use it, and read again. Returns
/// the second read's body too, for plan usage.
async fn redeem_claude(
    api: &claude::ClaudeApi,
    context: &ClaudeContext,
    requested: Option<&str>,
) -> Result<(Attempt, Option<serde_json::Value>), LimitResetError> {
    let (resets, _) = claude_read(api, context, now_secs()).await?;
    let listing = claude_listing(resets.as_ref(), context.email.clone(), now_secs());
    if let Some(error) = listing.error.clone() {
        return Err(error);
    }
    let chosen = resets
        .as_ref()
        .ok_or(LimitResetOutcome::NoReset)
        .and_then(|resets| choose_claude_grant(resets, requested));
    let grant_id = match chosen {
        Ok(id) => id,
        Err(outcome) => {
            let attempt = Attempt {
                outcome,
                cleared: Vec::new(),
                resets: Some(listing),
            };
            return Ok((attempt, None));
        }
    };
    let request_id = attempt_id(PlanUsageAgent::ClaudeCode, Some(&grant_id));
    let user_agent = claude::user_agent(&context.cli_version);
    let answer = api
        .claim(
            &context.login,
            &user_agent,
            &context.org_id,
            &grant_id,
            &request_id,
        )
        .await;
    let (outcome, cleared) = match answer {
        Ok(body) => {
            let answer = claude::parse_claim(&body);
            (answer.outcome, answer.cleared)
        }
        Err(failure) => match claude::claim_failure(&failure) {
            Ok(outcome) => (outcome, Vec::new()),
            Err(error) => {
                settle_attempt(
                    PlanUsageAgent::ClaudeCode,
                    Some(&grant_id),
                    &request_id,
                    None,
                );
                return Err(error);
            }
        },
    };
    settle_attempt(
        PlanUsageAgent::ClaudeCode,
        Some(&grant_id),
        &request_id,
        Some(outcome),
    );
    tracing::info!("[limit-resets] Claude Code reset {grant_id}: {outcome:?}");
    let (resets, refreshed) = match claude_read(api, context, now_secs()).await {
        Ok((resets, body)) => (
            Some(claude_listing(
                resets.as_ref(),
                context.email.clone(),
                now_secs(),
            )),
            Some(body),
        ),
        Err(_) => (None, None),
    };
    let attempt = Attempt {
        outcome,
        cleared,
        resets,
    };
    Ok((attempt, refreshed))
}

/// What redeeming on a running app-server came to, and the read after it.
#[derive(Debug)]
struct CodexRedeemed {
    outcome: LimitResetOutcome,
    after: Option<(codex::CodexAccount, codex::CodexReading)>,
}

/// Make sure the app-server has a ChatGPT sign-in, redeem one credit, and
/// read the credits again.
async fn redeem_codex<R, W>(
    server: &mut codex::AppServer<R, W>,
    requested: Option<&str>,
) -> Result<CodexRedeemed, LimitResetError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let account = server
        .request(
            "account/read",
            json!({ "refreshToken": false }),
            codex::READ_TIMEOUT,
        )
        .await
        .map_err(|e| codex::error_from_rpc(&e))?;
    codex::parse_account(&account)?;
    let key = attempt_id(PlanUsageAgent::Codex, requested);
    let outcome = match codex::consume(server, requested, &key).await {
        Ok(outcome) => outcome,
        Err(error) => {
            settle_attempt(PlanUsageAgent::Codex, requested, &key, None);
            return Err(error);
        }
    };
    settle_attempt(PlanUsageAgent::Codex, requested, &key, Some(outcome));
    tracing::info!("[limit-resets] Codex reset: {outcome:?}");
    let after = codex::read(server, now_secs()).await.ok();
    Ok(CodexRedeemed { outcome, after })
}

async fn use_codex(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    requested: Option<&str>,
) -> Result<Attempt, LimitResetError> {
    let mut process = start_codex(db, data_dir).await?;
    let redeemed = redeem_codex(&mut process.server, requested).await;
    process.close().await;
    let CodexRedeemed { outcome, after } = redeemed?;
    let now = now_secs();
    let resets = after.map(|(account, reading)| {
        if let Some(snapshot) = reading.snapshot.clone() {
            plan_usage::observe_codex_live_snapshot(emitter, snapshot);
        }
        codex_listing(account.email, &reading, now)
    });
    Ok(Attempt {
        outcome,
        cleared: Vec::new(),
        resets,
    })
}

/// This provider's sessions paused at their limit, waiting for the reset.
async fn paused_conversations(db: &AppDatabase, provider: PlanUsageAgent) -> Vec<i32> {
    let agent = match provider {
        PlanUsageAgent::ClaudeCode => AgentType::ClaudeCode,
        PlanUsageAgent::Codex => AgentType::Codex,
    };
    let wire = agent.as_wire();
    conversation_service::list_scheduled_limit_resumes(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.agent_type == wire)
        .map(|row| row.id)
        .collect()
}

/// Use one reset (`id`, or the provider's next) and read the resets and
/// plan usage again. When `conversation_id` names a session paused at the
/// limit and the reset went through, its continuation goes out right away.
pub async fn use_limit_reset_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    provider: PlanUsageAgent,
    id: Option<String>,
    conversation_id: Option<i32>,
) -> Result<UseLimitResetResult, AppCommandError> {
    let Some(_in_flight) = InFlight::take(provider) else {
        return Err(LimitResetError::new(
            LimitResetErrorCode::Busy,
            "A reset is already being used for this account.",
        )
        .into_app_error());
    };
    let requested = id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let attempt = match provider {
        PlanUsageAgent::ClaudeCode => {
            let api = claude::ClaudeApi::new(claude::API_BASE);
            use_claude(db, data_dir, emitter, &api, requested.as_deref()).await
        }
        PlanUsageAgent::Codex => use_codex(db, data_dir, emitter, requested.as_deref()).await,
    };
    forget(provider);
    let attempt = attempt.map_err(LimitResetError::into_app_error)?;
    if let Some(resets) = &attempt.resets {
        remember(resets);
    }
    let mut continued = None;
    if attempt.outcome == LimitResetOutcome::Reset {
        if let Some(conversation_id) = conversation_id {
            let sent =
                crate::acp::limit_continue::continue_limit_now_core(&db.conn, conversation_id)
                    .await
                    .unwrap_or(false);
            continued = sent.then_some(conversation_id);
        }
    }
    let paused_conversations = paused_conversations(db, provider)
        .await
        .into_iter()
        .filter(|id| Some(*id) != continued)
        .collect();
    Ok(UseLimitResetResult {
        provider,
        outcome: attempt.outcome,
        cleared: attempt.cleared,
        resets: attempt.resets,
        paused_conversations,
        continued,
    })
}

// ─── Desktop commands ───────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppCommandError> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|e| AppCommandError::io_error(e.to_string()))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_limit_resets(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    force: Option<bool>,
) -> Result<LimitResetsReport, AppCommandError> {
    let data_dir = app_data_dir(&app)?;
    get_limit_resets_core(
        &db,
        &data_dir,
        &EventEmitter::Tauri(app),
        force.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn use_limit_reset(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    provider: PlanUsageAgent,
    id: Option<String>,
    conversation_id: Option<i32>,
) -> Result<UseLimitResetResult, AppCommandError> {
    let data_dir = app_data_dir(&app)?;
    use_limit_reset_core(
        &db,
        &data_dir,
        &EventEmitter::Tauri(app),
        provider,
        id,
        conversation_id,
    )
    .await
}
