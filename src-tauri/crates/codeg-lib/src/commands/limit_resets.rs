//! Usage-limit resets: the free "refill my limits" credits a Codex
//! subscription hands out. They are listed and used from the Subscription
//! usage screen and from a Codex session paused at its limit.
//!
//! Codex is driven through its own app-server, the way its TUI does it
//! ([`codex`]). Claude Code is deliberately not driven at all: it offers its
//! resets only in its interactive terminal app (`/limit-reset`) and on
//! claude.ai, so the screen points there instead. codeg makes no Claude
//! call and never reads Claude's stored sign-in.
//!
//! A used reset cannot be given back, so the flow is careful:
//! * one attempt at a time ([`InFlight`]);
//! * the attempt's `idempotencyKey` is kept while its answer is unknown and
//!   reused on the retry ([`ATTEMPTS`]), so a lost answer can never cost a
//!   second reset.

pub(crate) mod codex;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::acp::registry::{self, AgentDistribution};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::plan_usage::{self, now_secs, PlanUsageAgent};
use crate::db::service::{agent_setting_service, conversation_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

/// How long a listing is reused before Codex is asked again.
const CACHE_TTL: Duration = Duration::from_secs(60);

// ─── Shapes (mirrored in `src/lib/types.ts`) ────────────────────────────

/// What a reset refills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetKind {
    /// The short rolling window.
    Session,
    /// The weekly window.
    Weekly,
    /// One model family's own weekly window only (a pool grant that refills
    /// Fable's weekly limit), not the account's general weekly one.
    ModelWeekly,
    /// Every limit at once (Codex's "Full reset").
    Full,
    /// What it refills isn't known.
    Other,
}

/// One reset credit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitResetItem {
    /// The provider's id for it, which `use_limit_reset` takes. `None` when
    /// only a count is known and the provider picks.
    pub id: Option<String>,
    pub kind: LimitResetKind,
    /// The provider's own name for it ("Full reset").
    pub label: Option<String>,
    pub description: Option<String>,
    /// Resets it holds. A Codex credit is one.
    pub count: u32,
    /// Epoch seconds it expires at, when it does.
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetSource {
    /// Codex's app-server.
    CodexAppServer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetErrorCode {
    /// The agent's adapter isn't installed.
    NotInstalled,
    /// The agent has no subscription sign-in on this machine.
    NotLoggedIn,
    /// The provider doesn't offer resets to this account or app (`reason`).
    NotEligible,
    /// The installed agent is too old for resets.
    UnsupportedVersion,
    /// The provider couldn't be reached, or answered with a server error.
    Network,
    /// A reset is already being used.
    Busy,
    Failed,
}

impl LimitResetErrorCode {
    /// The `PlanUsage` i18n key the UI renders it with.
    pub(crate) fn i18n_key(self) -> &'static str {
        match self {
            Self::NotInstalled => "resets.error.notInstalled",
            Self::NotLoggedIn => "resets.error.notLoggedIn",
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
            Self::NotLoggedIn => AppErrorCode::AuthenticationFailed,
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
    /// The provider's reason code (e.g. the sign-in type that has none).
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
    /// Resets left (Codex's `availableCount`).
    pub available: u32,
    /// Soonest to expire first.
    pub items: Vec<LimitResetItem>,
    pub source: LimitResetSource,
    /// The account they belong to, when known.
    pub account: Option<String>,
    pub error: Option<LimitResetError>,
    /// Epoch seconds.
    pub fetched_at: i64,
}

impl ProviderLimitResets {
    fn empty(fetched_at: i64) -> Self {
        Self {
            provider: PlanUsageAgent::Codex,
            available: 0,
            items: Vec::new(),
            source: LimitResetSource::CodexAppServer,
            account: None,
            error: None,
            fetched_at,
        }
    }

    fn failed(fetched_at: i64, error: LimitResetError) -> Self {
        Self {
            error: Some(error),
            ..Self::empty(fetched_at)
        }
    }
}

/// Every provider codeg lists resets for: Codex only (see the module docs
/// for why Claude Code isn't one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct LimitResetsReport {
    pub providers: Vec<ProviderLimitResets>,
}

/// What an attempt to use a reset came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitResetOutcome {
    /// It went through: the limits are refilled.
    Reset,
    /// Nothing was used: usage doesn't need a reset right now.
    NothingToReset,
    /// Nothing was used: no reset is left, or that one is gone.
    NoReset,
    /// That reset had already been used (an earlier try went through).
    AlreadyUsed,
    /// No confirmation came. It may have gone through. A retry reuses the
    /// same attempt, so it can't use a second one.
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UseLimitResetResult {
    pub provider: PlanUsageAgent,
    pub outcome: LimitResetOutcome,
    /// The resets read again after the attempt, when that worked.
    pub resets: Option<ProviderLimitResets>,
    /// Codex sessions paused at their limit, which could continue now (ids),
    /// not counting the one continued below.
    pub paused_conversations: Vec<i32>,
    /// The paused session asked to continue, when its continuation went out.
    pub continued: Option<i32>,
}

// ─── Process-wide state ─────────────────────────────────────────────────

static CACHE: Mutex<Option<(Instant, ProviderLimitResets)>> = Mutex::new(None);

fn cached() -> Option<ProviderLimitResets> {
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
        .map(|(_, resets)| resets.clone())
}

fn remember(resets: &ProviderLimitResets) {
    *CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), resets.clone()));
}

fn forget() {
    *CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

static IN_FLIGHT_FLAG: Mutex<bool> = Mutex::new(false);

/// The one attempt allowed at a time; released when dropped.
pub(crate) struct InFlight;

impl InFlight {
    pub(crate) fn take() -> Option<Self> {
        let mut flag = IN_FLIGHT_FLAG
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *flag {
            return None;
        }
        *flag = true;
        Some(Self)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        *IN_FLIGHT_FLAG
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
    }
}

/// Attempts whose answer never came: the reset id (`None` when Codex picks)
/// and the key they went out under.
static ATTEMPTS: Mutex<Vec<(Option<String>, String)>> = Mutex::new(Vec::new());

/// The key to send an attempt under: the unanswered one for the same reset,
/// or a fresh one.
pub(crate) fn attempt_key(reset_id: Option<&str>) -> String {
    ATTEMPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .find(|(id, _)| id.as_deref() == reset_id)
        .map(|(_, key)| key.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

/// Record how an attempt ended: an unconfirmed one is kept for its retry,
/// any other answer settles it.
pub(crate) fn settle_attempt(
    reset_id: Option<&str>,
    key: &str,
    outcome: Option<LimitResetOutcome>,
) {
    let mut attempts = ATTEMPTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attempts.retain(|(id, _)| id.as_deref() != reset_id);
    if outcome == Some(LimitResetOutcome::Unconfirmed) {
        attempts.push((reset_id.map(str::to_string), key.to_string()));
    }
}

// ─── Codex's app-server ─────────────────────────────────────────────────

/// The environment a Codex session launches with. Codex switched off in
/// settings still has a sign-in, so that case falls back to the stored
/// settings alone.
async fn launch_env(db: &AppDatabase, data_dir: &Path) -> BTreeMap<String, String> {
    let agent = AgentType::Codex;
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

fn not_installed() -> LimitResetError {
    LimitResetError::new(
        LimitResetErrorCode::NotInstalled,
        "Codex isn't installed. Install it in Settings, Agents.",
    )
}

/// `codex-acp cli app-server` with the environment a Codex session gets.
async fn start_codex(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<codex::CodexProcess, LimitResetError> {
    let runtime_env = launch_env(db, data_dir).await;
    let meta = registry::get_agent_meta(AgentType::Codex);
    let AgentDistribution::Npx { cmd, env, .. } = meta.distribution else {
        return Err(not_installed());
    };
    let program = crate::commands::acp::resolve_npx_command(cmd)
        .await
        .ok_or_else(not_installed)?;
    let env = crate::acp::connection::merge_agent_env(env, &runtime_env, None);
    codex::CodexProcess::start(&program, &env).await
}

// ─── Listing ────────────────────────────────────────────────────────────

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
        ..ProviderLimitResets::empty(now)
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
        Err(error) => return ProviderLimitResets::failed(now, error),
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
        Err(error) => ProviderLimitResets::failed(now, error),
    }
}

/// Codex's resets. `force` asks Codex again rather than reusing a listing
/// from the last minute.
pub async fn get_limit_resets_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    force: bool,
) -> Result<LimitResetsReport, AppCommandError> {
    let resets = match cached().filter(|_| !force) {
        Some(resets) => resets,
        None => {
            let resets = list_codex(db, data_dir, emitter).await;
            remember(&resets);
            resets
        }
    };
    Ok(LimitResetsReport {
        providers: vec![resets],
    })
}

// ─── Using one ──────────────────────────────────────────────────────────

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
    let key = attempt_key(requested);
    let outcome = match codex::consume(server, requested, &key).await {
        Ok(outcome) => outcome,
        Err(error) => {
            settle_attempt(requested, &key, None);
            return Err(error);
        }
    };
    settle_attempt(requested, &key, Some(outcome));
    tracing::info!("[limit-resets] Codex reset: {outcome:?}");
    let after = codex::read(server, now_secs()).await.ok();
    Ok(CodexRedeemed { outcome, after })
}

/// This provider's sessions paused at their limit, waiting for the reset.
async fn paused_conversations(db: &AppDatabase) -> Vec<i32> {
    let wire = AgentType::Codex.as_wire();
    conversation_service::list_scheduled_limit_resumes(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.agent_type == wire)
        .map(|row| row.id)
        .collect()
}

/// What `use_limit_reset` answers for Claude Code without doing anything:
/// its resets are used in its own apps.
pub(crate) fn claude_resets_elsewhere() -> LimitResetError {
    LimitResetError::new(
        LimitResetErrorCode::NotEligible,
        "Claude offers its usage resets in Claude Code's terminal app or on claude.ai.",
    )
    .with_reason(Some("claude_app".to_string()))
}

/// Use one Codex reset (`id`, or Codex's next) and read the resets and plan
/// usage again. When `conversation_id` names a session paused at the limit
/// and the reset went through, its continuation goes out right away. Claude
/// Code is refused before anything runs.
pub async fn use_limit_reset_core(
    db: &AppDatabase,
    data_dir: &Path,
    emitter: &EventEmitter,
    provider: PlanUsageAgent,
    id: Option<String>,
    conversation_id: Option<i32>,
) -> Result<UseLimitResetResult, AppCommandError> {
    if provider != PlanUsageAgent::Codex {
        return Err(claude_resets_elsewhere().into_app_error());
    }
    let Some(_in_flight) = InFlight::take() else {
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
    let mut process = start_codex(db, data_dir)
        .await
        .map_err(LimitResetError::into_app_error)?;
    let redeemed = redeem_codex(&mut process.server, requested.as_deref()).await;
    process.close().await;
    forget();
    let CodexRedeemed { outcome, after } = redeemed.map_err(LimitResetError::into_app_error)?;
    let now = now_secs();
    let resets = after.map(|(account, reading)| {
        if let Some(snapshot) = reading.snapshot.clone() {
            plan_usage::observe_codex_live_snapshot(emitter, snapshot);
        }
        codex_listing(account.email, &reading, now)
    });
    if let Some(resets) = &resets {
        remember(resets);
    }
    let mut continued = None;
    if outcome == LimitResetOutcome::Reset {
        if let Some(conversation_id) = conversation_id {
            let sent =
                crate::acp::limit_continue::continue_limit_now_core(&db.conn, conversation_id)
                    .await
                    .unwrap_or(false);
            continued = sent.then_some(conversation_id);
        }
    }
    let paused_conversations = paused_conversations(db)
        .await
        .into_iter()
        .filter(|id| Some(*id) != continued)
        .collect();
    Ok(UseLimitResetResult {
        provider,
        outcome,
        resets,
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
