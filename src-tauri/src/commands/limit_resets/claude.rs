//! Claude Code's usage-limit resets.
//!
//! The CLI offers them only in its interactive app: `/limit-reset` and the
//! rate-limit menu (program `cedar_ember`, Claude Code 2.1.303 through
//! 2.1.321). No Agent SDK control request, CLI subcommand or adapter
//! extension lists or uses them. The CLI itself:
//!
//! * lists them with `GET /api/oauth/usage?cedar_ember=1&skip_spend=1`. The
//!   answer's `cedar_ember` block holds the grants (id, label, resets left,
//!   end date, which windows each one clears);
//! * uses one with `POST /api/organizations/{org}/reset_rate_limits`, body
//!   `{program: "cedar_ember", grant_id, request_id}`. The request id names
//!   the attempt, so a retry of an attempt whose answer was lost cannot use
//!   a second reset.
//!
//! Both go to `https://api.anthropic.com`, never to `ANTHROPIC_BASE_URL`, so
//! a local account pool is not involved, and both carry the CLI's own OAuth
//! login. codeg makes the same two calls with the same login:
//!
//! * **Which login.** The one `claude auth status --json` reports, run
//!   through the adapter's `--cli` passthrough with the environment a
//!   Claude Code session launches with. That gives the organization and the
//!   config dir.
//! * **The token.** Read from where the CLI keeps it. On macOS that is the
//!   login keychain item `Claude Code-credentials`, suffixed by a hash of the
//!   config dir when `CLAUDE_CONFIG_DIR` is set, read with `security` the way
//!   the CLI reads it. Elsewhere it is `<config dir>/.credentials.json`. It
//!   is read for one request and dropped: never logged, stored, copied or
//!   refreshed. An expired token is reported instead, and the CLI refreshes
//!   it on its next request.
//!
//! The server decides who is offered a reset from the request's User-Agent
//! ([`USER_AGENT_ENTRYPOINT`]).

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    LimitResetError, LimitResetErrorCode, LimitResetItem, LimitResetKind, LimitResetOutcome,
};

/// Where the CLI sends both calls (its `BASE_API_URL`).
pub(crate) const API_BASE: &str = "https://api.anthropic.com";
const USAGE_PATH: &str = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
/// The reset program the CLI's `/limit-reset` redeems from.
const PROGRAM: &str = "cedar_ember";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// `security`'s exit code for "no such item".
const KEYCHAIN_ITEM_NOT_FOUND: i32 = 44;
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);
const USAGE_TIMEOUT: Duration = Duration::from_secs(15);
/// The CLI allows a claim 25 s.
const CLAIM_TIMEOUT: Duration = Duration::from_secs(25);
/// A token this close to its expiry counts as expired.
const EXPIRY_SLACK_SECS: i64 = 60;

/// The entrypoint codeg names in the User-Agent of both calls: the one its
/// Claude Code sessions run under (`sdk-ts`, the Agent SDK), plus codeg as
/// the client app. The server reads the surface from this value, and as of
/// Claude Code 2.1.321 it offers resets only to the interactive terminal
/// app (`cli`). For the SDK it answers `eligible: false,
/// ineligible_reason: "surface"` and lists no grants. codeg states what it
/// is and shows that answer rather than claiming the terminal app's surface.
pub(crate) const USER_AGENT_ENTRYPOINT: &str = "sdk-ts";

/// The CLI's own User-Agent format, with [`USER_AGENT_ENTRYPOINT`].
pub(crate) fn user_agent(cli_version: &str) -> String {
    format!("claude-cli/{cli_version} (external, {USER_AGENT_ENTRYPOINT}, client-app/codeg)")
}

/// The version out of `claude --version` ("2.1.303 (Claude Code)").
pub(crate) fn parse_cli_version(stdout: &str) -> Option<String> {
    stdout.split_whitespace().find_map(|word| {
        let parts: Vec<&str> = word.split('.').collect();
        (parts.len() >= 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())))
        .then(|| word.to_string())
    })
}

// ─── The stored login ───────────────────────────────────────────────────

/// The CLI's stored OAuth login, reduced to what one request needs. `Debug`
/// never shows the token.
pub(crate) struct StoredLogin {
    access_token: String,
    /// Epoch seconds.
    pub expires_at: Option<i64>,
    pub scopes: Vec<String>,
}

impl std::fmt::Debug for StoredLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredLogin")
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

impl StoredLogin {
    #[cfg(test)]
    pub(crate) fn for_test(token: &str, expires_at: Option<i64>) -> Self {
        Self {
            access_token: token.to_string(),
            expires_at,
            scopes: vec!["user:inference".into(), "user:profile".into()],
        }
    }

    /// Whether the token is past (or within a minute of) its expiry.
    pub(crate) fn is_expired(&self, now: i64) -> bool {
        self.expires_at
            .is_some_and(|at| at <= now + EXPIRY_SLACK_SECS)
    }

    /// The CLI reads usage only with the `user:profile` scope (a token made
    /// with `claude setup-token` has inference alone).
    pub(crate) fn can_read_usage(&self) -> bool {
        self.scopes.iter().any(|s| s == "user:profile")
    }
}

/// The CLI's credentials document: `{claudeAiOauth: {accessToken,
/// expiresAt (ms), scopes}}`. `None` without an access token.
pub(crate) fn parse_stored_login(body: &str) -> Option<StoredLogin> {
    let doc: Value = serde_json::from_str(body.trim()).ok()?;
    let oauth = doc.get("claudeAiOauth")?;
    let access_token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())?
        .to_string();
    let expires_at = oauth.get("expiresAt").and_then(Value::as_f64).map(|raw| {
        if raw > 1.0e12 {
            (raw / 1000.0) as i64
        } else {
            raw as i64
        }
    });
    let scopes = oauth
        .get("scopes")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(StoredLogin {
        access_token,
        expires_at,
        scopes,
    })
}

/// The keychain item the CLI keeps its login under (2.1.x, `D1("-credentials")`).
/// With `CLAUDE_SECURESTORAGE_CONFIG_DIR` set, the name is suffixed by that
/// dir's hash, or not at all when it is empty. Otherwise it is suffixed by
/// the config dir's hash only when `CLAUDE_CONFIG_DIR` is set. The hash is
/// the first 8 hex digits of its SHA-256.
pub(crate) fn keychain_service(
    secure_storage_dir: Option<&str>,
    config_dir_env_set: bool,
    config_dir: Option<&str>,
) -> String {
    let hashed = match secure_storage_dir {
        Some(dir) => (!dir.is_empty()).then_some(dir),
        None if config_dir_env_set => config_dir,
        None => None,
    };
    match hashed {
        Some(dir) => {
            let digest = Sha256::digest(dir.as_bytes());
            let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("{KEYCHAIN_SERVICE}-{hex}")
        }
        None => KEYCHAIN_SERVICE.to_string(),
    }
}

/// The keychain account the CLI files the item under: `$USER` when it is a
/// plain name, else the CLI's own fallback.
pub(crate) fn keychain_account(user: Option<&str>) -> String {
    match user {
        Some(name)
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) =>
        {
            name.to_string()
        }
        _ => "claude-code-user".to_string(),
    }
}

/// The login document from the macOS keychain. `Ok(None)` when there is
/// no such item.
async fn read_keychain(service: &str, account: &str) -> Result<Option<String>, String> {
    let mut command = crate::process::tokio_command("security");
    command
        .args(["find-generic-password", "-a", account, "-w", "-s", service])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|e| format!("could not run security: {e}"))?;
    let output = tokio::time::timeout(KEYCHAIN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "the keychain did not answer in time".to_string())?
        .map_err(|e| format!("security failed: {e}"))?;
    match output.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned())),
        Some(KEYCHAIN_ITEM_NOT_FOUND) => Ok(None),
        code => Err(format!("security exited with {code:?}")),
    }
}

/// Where the CLI keeps its login when it is not in the keychain.
async fn read_credentials_file(config_dir: &Path) -> Option<String> {
    tokio::fs::read_to_string(config_dir.join(".credentials.json"))
        .await
        .ok()
}

/// What the launch environment says about where the login is stored.
pub(crate) struct LoginLocation<'a> {
    pub secure_storage_dir: Option<&'a str>,
    pub config_dir_env_set: bool,
    /// The config dir as the CLI reports it (`configDirectory`).
    pub config_dir: Option<&'a str>,
    pub user: Option<&'a str>,
}

/// The CLI's stored login, read where the CLI reads it.
pub(crate) async fn read_stored_login(
    location: &LoginLocation<'_>,
) -> Result<StoredLogin, LimitResetError> {
    let not_signed_in = || {
        LimitResetError::new(
            LimitResetErrorCode::NotLoggedIn,
            "Claude Code has no stored sign-in on this machine",
        )
    };
    let mut body = None;
    if cfg!(target_os = "macos") {
        let service = keychain_service(
            location.secure_storage_dir,
            location.config_dir_env_set,
            location.config_dir,
        );
        let account = keychain_account(location.user);
        body = read_keychain(&service, &account).await.map_err(|e| {
            LimitResetError::new(
                LimitResetErrorCode::Failed,
                format!("Couldn't read Claude Code's sign-in from the keychain: {e}"),
            )
        })?;
    }
    if body.is_none() {
        if let Some(dir) = location.config_dir {
            body = read_credentials_file(Path::new(dir)).await;
        }
    }
    body.as_deref()
        .and_then(parse_stored_login)
        .ok_or_else(not_signed_in)
}

// ─── The two calls ──────────────────────────────────────────────────────

/// Why a call got no usable answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HttpFailure {
    /// The server answered with this status.
    Status(u16),
    /// The request never got an answer (DNS, TLS, timeout, connection).
    Network(String),
    /// The answer was not JSON.
    Unreadable,
}

/// The two Anthropic endpoints, at `base` (tests point it at a mock).
pub(crate) struct ClaudeApi {
    base: String,
    http: reqwest::Client,
}

impl ClaudeApi {
    pub(crate) fn new(base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            // A redirect would carry the bearer somewhere else.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    fn authorized(
        &self,
        builder: reqwest::RequestBuilder,
        login: &StoredLogin,
        user_agent: &str,
    ) -> reqwest::RequestBuilder {
        builder
            .bearer_auth(&login.access_token)
            .header("anthropic-beta", OAUTH_BETA)
            .header(reqwest::header::USER_AGENT, user_agent)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
    }

    async fn send(builder: reqwest::RequestBuilder) -> Result<Value, HttpFailure> {
        let response = builder
            .send()
            .await
            .map_err(|e| HttpFailure::Network(e.without_url().to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(HttpFailure::Status(status.as_u16()));
        }
        response
            .json::<Value>()
            .await
            .map_err(|_| HttpFailure::Unreadable)
    }

    /// The usage read `/limit-reset` makes when not at a limit.
    pub(crate) async fn usage(
        &self,
        login: &StoredLogin,
        user_agent: &str,
    ) -> Result<Value, HttpFailure> {
        let url = format!("{}{USAGE_PATH}", self.base);
        let builder = self.http.get(url).timeout(USAGE_TIMEOUT);
        Self::send(self.authorized(builder, login, user_agent)).await
    }

    /// Use one reset of `grant_id`. `request_id` names the attempt.
    pub(crate) async fn claim(
        &self,
        login: &StoredLogin,
        user_agent: &str,
        org_id: &str,
        grant_id: &str,
        request_id: &str,
    ) -> Result<Value, HttpFailure> {
        let url = format!("{}/api/organizations/{org_id}/reset_rate_limits", self.base);
        let builder = self.http.post(url).timeout(CLAIM_TIMEOUT).json(&json!({
            "program": PROGRAM,
            "grant_id": grant_id,
            "request_id": request_id,
        }));
        Self::send(self.authorized(builder, login, user_agent)).await
    }
}

/// The error a failed usage read (or a claim the server refused) means.
pub(crate) fn error_for_failure(failure: &HttpFailure) -> LimitResetError {
    match failure {
        HttpFailure::Status(401) => LimitResetError::new(
            LimitResetErrorCode::LoginExpired,
            "Claude Code's sign-in has expired. It renews on the next Claude Code request; try again after one.",
        ),
        HttpFailure::Status(403) => LimitResetError::new(
            LimitResetErrorCode::NotLoggedIn,
            "Claude refused Claude Code's sign-in. Sign in again in Settings, Agents, Claude Code.",
        ),
        HttpFailure::Status(429) => LimitResetError::new(
            LimitResetErrorCode::Network,
            "Claude is limiting these requests right now. Nothing was used; try again in a minute.",
        ),
        HttpFailure::Status(status) => LimitResetError::new(
            LimitResetErrorCode::Network,
            format!("Claude answered HTTP {status}."),
        ),
        HttpFailure::Network(message) => LimitResetError::new(
            LimitResetErrorCode::Network,
            format!("Couldn't reach Claude: {message}"),
        ),
        HttpFailure::Unreadable => LimitResetError::new(
            LimitResetErrorCode::Failed,
            "Claude's answer could not be read.",
        ),
    }
}

// ─── Reading the grants ─────────────────────────────────────────────────

/// Window ids a grant may clear, as the CLI knows them.
const KNOWN_WINDOWS: &[&str] = &[
    "five_hour",
    "seven_day",
    "seven_day_overage_included",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_cowork",
    "seven_day_omelette",
    "seven_day_oauth_apps",
];

/// The `cedar_ember` block of a usage read.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeResets {
    pub eligible: bool,
    pub ineligible_reason: Option<String>,
    /// A window the grants cover is at its limit now.
    pub at_limit: bool,
    pub items: Vec<LimitResetItem>,
    /// The grant the server offers first.
    pub next_grant_id: Option<String>,
}

impl ClaudeResets {
    /// Resets left across every grant still in date.
    pub(crate) fn available(&self) -> u32 {
        self.items.iter().map(|i| i.count).sum()
    }

    /// The grant a "use" without an id takes: the server's next one when it
    /// can be used now, else the first usable one.
    pub(crate) fn default_grant(&self) -> Option<&LimitResetItem> {
        self.next_grant_id
            .as_deref()
            .and_then(|id| self.find(id))
            .filter(|item| item.usable_now)
            .or_else(|| self.items.iter().find(|item| item.usable_now))
    }

    pub(crate) fn find(&self, id: &str) -> Option<&LimitResetItem> {
        self.items
            .iter()
            .find(|item| item.id.as_deref() == Some(id))
    }
}

fn is_grant_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn rfc3339_secs(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| dt.timestamp())
}

fn window_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|id| KNOWN_WINDOWS.contains(id))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// What kind of reset a grant is: its `type` (2.1.321+), a Fable-only grant
/// by its label, else from the windows it clears.
pub(crate) fn grant_kind(grant: &Value, clears: &[String]) -> LimitResetKind {
    let label = grant
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if label.to_ascii_lowercase().contains("fable") {
        return LimitResetKind::Fable;
    }
    match grant.get("type").and_then(Value::as_str) {
        Some("session") => return LimitResetKind::Session,
        Some("weekly") => return LimitResetKind::Weekly,
        Some("full") => return LimitResetKind::Full,
        _ => {}
    }
    let session = clears.iter().any(|w| w == "five_hour");
    let weekly = clears.iter().any(|w| w.starts_with("seven_day"));
    match (session, weekly) {
        (true, true) => LimitResetKind::Full,
        (true, false) => LimitResetKind::Session,
        (false, true) => LimitResetKind::Weekly,
        (false, false) => LimitResetKind::Other,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .map(|s| s.chars().take(200).collect())
}

/// One grant as a reset item; `None` for one that is malformed, used up or
/// past its end.
fn grant_item(grant: &Value, now: i64) -> Option<LimitResetItem> {
    let id = grant
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_grant_id(id))?;
    let count = grant
        .get("resets_left")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())?;
    let expires_at = rfc3339_secs(grant.get("ends_at"));
    if count == 0 || expires_at.is_some_and(|at| at <= now) {
        return None;
    }
    let starts_at = rfc3339_secs(grant.get("starts_at"));
    let clears = window_list(grant.get("clears"));
    let paused = grant
        .get("paused")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let unavailable_reason = text(grant.get("unavailable_reason"))
        .or_else(|| paused.then(|| "paused".to_string()))
        .or_else(|| {
            starts_at
                .filter(|at| *at > now)
                .map(|_| "not_started".to_string())
        });
    let usable_now = grant
        .get("usable_now")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && unavailable_reason.is_none();
    Some(LimitResetItem {
        id: Some(id.to_string()),
        kind: grant_kind(grant, &clears),
        label: text(grant.get("label")),
        description: None,
        count,
        expires_at,
        usable_now,
        requires_limit: grant
            .get("use_requires_limit")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        clears,
        unavailable_reason,
    })
}

/// The grants in a usage read. `None` when the read has no `cedar_ember`
/// block: the server does not run the program for this client.
pub(crate) fn parse_resets(body: &Value, now: i64) -> Option<ClaudeResets> {
    let block = body.get("cedar_ember").filter(|b| b.is_object())?;
    let mut items: Vec<LimitResetItem> = block
        .get("grants")
        .and_then(Value::as_array)
        .map(|grants| grants.iter().filter_map(|g| grant_item(g, now)).collect())
        .unwrap_or_default();
    items.sort_by_key(|item| item.expires_at.unwrap_or(i64::MAX));
    let next_grant_id = block
        .get("next_grant_id")
        .and_then(Value::as_str)
        .filter(|id| items.iter().any(|i| i.id.as_deref() == Some(*id)))
        .map(str::to_string);
    Some(ClaudeResets {
        eligible: block
            .get("eligible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ineligible_reason: text(block.get("ineligible_reason")),
        at_limit: block
            .get("at_limit")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        items,
        next_grant_id,
    })
}

/// What an ineligible answer means for the screen. `Ok(())` for the reasons
/// that just mean there is nothing to use (no grant, the program is off).
pub(crate) fn ineligible_error(reason: Option<&str>) -> Result<(), LimitResetError> {
    let (code, message) = match reason {
        Some("no_grant") | Some("config_off") => return Ok(()),
        Some("cli_version") => (
            LimitResetErrorCode::UnsupportedVersion,
            "Claude doesn't offer resets to this Claude Code version. Update Claude Code.",
        ),
        Some("surface") => (
            LimitResetErrorCode::NotEligible,
            "Claude offers resets only in Claude Code's terminal app (/limit-reset) and on claude.ai, not to apps built on the Agent SDK.",
        ),
        Some("tier") | Some("seat") => (
            LimitResetErrorCode::NotEligible,
            "This Claude plan doesn't include usage-limit resets.",
        ),
        _ => (
            LimitResetErrorCode::NotEligible,
            "Claude doesn't offer usage-limit resets to this account right now.",
        ),
    };
    Err(LimitResetError::new(code, message).with_reason(reason.map(str::to_string)))
}

// ─── Using one ──────────────────────────────────────────────────────────

/// What a claim's answer says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaimAnswer {
    pub outcome: LimitResetOutcome,
    /// Windows the server says it refilled.
    pub cleared: Vec<String>,
    /// Resets left in the grant afterwards, when the server says.
    pub resets_left: Option<u32>,
}

/// A claim's `{result, reason, resets_left, cleared}`. An answer that is not
/// one of the results the CLI knows counts as unconfirmed, as the CLI counts
/// it.
pub(crate) fn parse_claim(body: &Value) -> ClaimAnswer {
    let outcome = match body.get("result").and_then(Value::as_str) {
        Some("reset") => LimitResetOutcome::Reset,
        Some("already_used") => LimitResetOutcome::AlreadyUsed,
        Some("not_limited") => LimitResetOutcome::NothingToReset,
        Some("cooldown") => LimitResetOutcome::Cooldown,
        Some("ineligible") => LimitResetOutcome::NoReset,
        _ => LimitResetOutcome::Unconfirmed,
    };
    ClaimAnswer {
        outcome,
        cleared: window_list(body.get("cleared")),
        resets_left: body
            .get("resets_left")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
    }
}

/// What a claim that got no answer means: the CLI keeps the attempt (and
/// retries it under the same request id) unless the server plainly refused.
pub(crate) fn claim_failure(failure: &HttpFailure) -> Result<LimitResetOutcome, LimitResetError> {
    match failure {
        HttpFailure::Status(401 | 403 | 429) => Err(error_for_failure(failure)),
        HttpFailure::Status(_) | HttpFailure::Network(_) | HttpFailure::Unreadable => {
            Ok(LimitResetOutcome::Unconfirmed)
        }
    }
}
