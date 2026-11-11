//! Codex's usage-limit resets, through Codex's own app-server.
//!
//! The app-server is the JSON-RPC interface Codex's TUI and IDE extensions
//! run on: `codex app-server`, newline-delimited JSON over stdio. It owns
//! the ChatGPT sign-in and refreshes its tokens itself. Two of its methods
//! (app-server protocol v2, codex 0.154 and later) cover the resets, and the
//! TUI's `/usage` menu uses the same two:
//!
//! * `account/rateLimits/read` `{excludeResetCreditDetails: false}` answers
//!   `rateLimitResetCredits: {availableCount, credits: [{id, resetType,
//!   status, grantedAt, expiresAt, title, description}] | null} | null` next
//!   to the account's current windows (`rateLimits`). `credits` is `null`
//!   when only the count is known.
//! * `account/rateLimitResetCredit/consume` `{idempotencyKey, creditId?}`
//!   answers `{outcome: reset | nothingToReset | noCredit | alreadyRedeemed}`.
//!   Without `creditId` the backend picks the next credit. The key names one
//!   attempt: a retry of an attempt whose answer was lost reuses it, so it
//!   cannot redeem twice.
//!
//! codeg starts the app-server as `codex-acp cli app-server`. codex-acp's
//! passthrough runs exactly the codex binary its sessions run (`CODEX_PATH`,
//! or the one it bundles), with the environment codeg's Codex sessions get.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines};

use super::{
    LimitResetError, LimitResetErrorCode, LimitResetItem, LimitResetKind, LimitResetOutcome,
};
use crate::commands::plan_usage::{self, PlanUsageSnapshot, PlanUsageSource};

/// How long the app-server gets to start and answer `initialize`.
pub(crate) const INIT_TIMEOUT: Duration = Duration::from_secs(30);
/// One read: the usage call plus the credit-detail lookup (the app-server
/// gives the latter 5 s and then falls back to the count alone).
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// One redeem. The app-server gives the backend 10 s.
pub(crate) const CONSUME_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a closed app-server gets to exit before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(3);
/// JSON-RPC "invalid request" / "invalid params": an older app-server that
/// takes no params for the read.
const INVALID_REQUEST: i64 = -32600;
const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;

// ─── JSON-RPC over a pipe ───────────────────────────────────────────────

/// Why a request got no result.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RpcError {
    /// The server answered with a JSON-RPC error.
    Server { code: i64, message: String },
    /// The server did not answer in time.
    Timeout,
    /// The server closed its output (it exited).
    Closed,
    /// Reading or writing the pipe failed.
    Io(String),
}

/// A client for one app-server connection. Generic over the pipe so tests
/// can stand a scripted server on the other end.
pub(crate) struct AppServer<R, W> {
    lines: Lines<BufReader<R>>,
    writer: W,
    next_id: i64,
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> AppServer<R, W> {
    pub(crate) fn new(reader: R, writer: W) -> Self {
        Self {
            lines: BufReader::new(reader).lines(),
            writer,
            next_id: 0,
        }
    }

    async fn send(&mut self, message: &Value) -> Result<(), RpcError> {
        let mut line = serde_json::to_vec(message).map_err(|e| RpcError::Io(e.to_string()))?;
        line.push(b'\n');
        self.writer
            .write_all(&line)
            .await
            .map_err(|e| RpcError::Io(e.to_string()))?;
        self.writer
            .flush()
            .await
            .map_err(|e| RpcError::Io(e.to_string()))
    }

    pub(crate) async fn notify(&mut self, method: &str) -> Result<(), RpcError> {
        self.send(&json!({ "method": method })).await
    }

    /// Send a request and wait up to `timeout` for its answer.
    pub(crate) async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut message = json!({ "id": id, "method": method });
        if !params.is_null() {
            message["params"] = params;
        }
        self.send(&message).await?;
        tokio::time::timeout(timeout, self.answer(id))
            .await
            .map_err(|_| RpcError::Timeout)?
    }

    async fn answer(&mut self, id: i64) -> Result<Value, RpcError> {
        loop {
            let line = self
                .lines
                .next_line()
                .await
                .map_err(|e| RpcError::Io(e.to_string()))?
                .ok_or(RpcError::Closed)?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(message_id) = message.get("id") else {
                // A notification (`account/updated`, …).
                continue;
            };
            if message.get("method").is_some() {
                // A request from the server (an approval, a token refresh).
                // codeg starts no turn and owns no tokens: decline it rather
                // than leave the server waiting.
                let reply = json!({
                    "id": message_id.clone(),
                    "error": { "code": METHOD_NOT_FOUND, "message": "not supported by this client" },
                });
                self.send(&reply).await?;
                continue;
            }
            if message_id.as_i64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(RpcError::Server {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                });
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// `initialize`, then `initialized`, as every app-server client starts.
    pub(crate) async fn initialize(&mut self, version: &str) -> Result<(), RpcError> {
        self.request(
            "initialize",
            json!({
                "clientInfo": { "name": "codeg", "title": "codeg", "version": version },
                "capabilities": null,
            }),
            INIT_TIMEOUT,
        )
        .await?;
        self.notify("initialized").await
    }
}

// ─── The account and its credits ────────────────────────────────────────

/// Whose credits these are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexAccount {
    pub email: Option<String>,
}

/// `account/read`: a ChatGPT sign-in, or why there are no credits to read.
pub(crate) fn parse_account(result: &Value) -> Result<CodexAccount, LimitResetError> {
    let account = result.get("account").filter(|a| a.is_object());
    let Some(account) = account else {
        return Err(LimitResetError::new(
            LimitResetErrorCode::NotLoggedIn,
            "Codex isn't signed in on this machine.",
        ));
    };
    match account.get("type").and_then(Value::as_str) {
        Some("chatgpt") => Ok(CodexAccount {
            email: account
                .get("email")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(str::to_string),
        }),
        other => Err(LimitResetError::new(
            LimitResetErrorCode::NotEligible,
            "Usage-limit resets come with a ChatGPT sign-in; Codex is signed in another way.",
        )
        .with_reason(other.map(str::to_string))),
    }
}

/// What one `account/rateLimits/read` says.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CodexReading {
    pub available: u32,
    pub items: Vec<LimitResetItem>,
    /// The account's windows, for the plan-usage screen.
    pub snapshot: Option<PlanUsageSnapshot>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .map(|s| s.chars().take(300).collect())
}

/// The reset credits of a read. Codex's credits refill every limit at once
/// ("Full reset"). `credits: null` means only the count is known, so the
/// count becomes one item the backend picks from.
pub(crate) fn parse_credits(summary: Option<&Value>, now: i64) -> (u32, Vec<LimitResetItem>) {
    let Some(summary) = summary.filter(|s| s.is_object()) else {
        return (0, Vec::new());
    };
    let available = summary
        .get("availableCount")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0);
    let Some(credits) = summary.get("credits").and_then(Value::as_array) else {
        let items = if available > 0 {
            vec![LimitResetItem {
                id: None,
                kind: LimitResetKind::Full,
                label: None,
                description: None,
                count: available,
                expires_at: None,
                usable_now: true,
                requires_limit: false,
                clears: Vec::new(),
                unavailable_reason: None,
            }]
        } else {
            Vec::new()
        };
        return (available, items);
    };
    let mut items: Vec<LimitResetItem> = credits
        .iter()
        .filter(|c| c.get("status").and_then(Value::as_str) == Some("available"))
        .filter_map(|credit| {
            let id = credit
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())?;
            let expires_at = credit.get("expiresAt").and_then(Value::as_i64);
            if expires_at.is_some_and(|at| at <= now) {
                return None;
            }
            let kind = match credit.get("resetType").and_then(Value::as_str) {
                Some("codexRateLimits") => LimitResetKind::Full,
                _ => LimitResetKind::Other,
            };
            Some(LimitResetItem {
                id: Some(id.to_string()),
                kind,
                label: text(credit.get("title")),
                description: text(credit.get("description")),
                count: 1,
                expires_at,
                usable_now: true,
                requires_limit: false,
                clears: Vec::new(),
                unavailable_reason: None,
            })
        })
        .collect();
    items.sort_by_key(|item| item.expires_at.unwrap_or(i64::MAX));
    // The backend may cap the detail list below the count.
    let listed = items.len() as u32;
    (available.max(listed), items)
}

/// The account's windows from a read's `rateLimits`, in the shape the
/// rollouts carry them, so plan usage reads both the same way.
pub(crate) fn snapshot_from_rate_limits(
    rate_limits: Option<&Value>,
    observed_at: i64,
) -> Option<PlanUsageSnapshot> {
    let limits = rate_limits.filter(|r| r.is_object())?;
    let window = |key: &str| {
        limits.get(key).filter(|w| w.is_object()).map(|w| {
            json!({
                "used_percent": w.get("usedPercent").cloned().unwrap_or(Value::Null),
                "window_minutes": w.get("windowDurationMins").cloned().unwrap_or(Value::Null),
                "resets_at": w.get("resetsAt").cloned().unwrap_or(Value::Null),
            })
        })
    };
    let rollout_shape = json!({
        "primary": window("primary"),
        "secondary": window("secondary"),
        "plan_type": limits.get("planType").cloned().unwrap_or(Value::Null),
        "rate_limit_reached_type": limits.get("rateLimitReachedType").cloned().unwrap_or(Value::Null),
    });
    let mut snapshot = plan_usage::codex_snapshot_from_rate_limits(&rollout_shape, observed_at)?;
    snapshot.source = PlanUsageSource::Live;
    Some(snapshot)
}

/// One `account/rateLimits/read` answer.
pub(crate) fn parse_reading(result: &Value, now: i64) -> CodexReading {
    let (available, items) = parse_credits(result.get("rateLimitResetCredits"), now);
    CodexReading {
        available,
        items,
        snapshot: snapshot_from_rate_limits(result.get("rateLimits"), now),
    }
}

/// What an app-server error means for the screen.
pub(crate) fn error_from_rpc(error: &RpcError) -> LimitResetError {
    match error {
        RpcError::Server { code, .. } if *code == METHOD_NOT_FOUND => LimitResetError::new(
            LimitResetErrorCode::UnsupportedVersion,
            "This Codex version has no usage-limit resets. Update Codex.",
        ),
        RpcError::Server { message, .. } if message.contains("authentication required") => {
            LimitResetError::new(
                LimitResetErrorCode::NotLoggedIn,
                "Usage-limit resets need Codex signed in with ChatGPT.",
            )
        }
        RpcError::Server { message, .. } => {
            let lower = message.to_ascii_lowercase();
            let network = [
                "timed out",
                "timeout",
                "connect",
                "network",
                "dns",
                "sending request",
            ]
            .iter()
            .any(|needle| lower.contains(needle));
            LimitResetError::new(
                if network {
                    LimitResetErrorCode::Network
                } else {
                    LimitResetErrorCode::Failed
                },
                format!("Codex couldn't read your usage: {message}"),
            )
        }
        RpcError::Timeout => {
            LimitResetError::new(LimitResetErrorCode::Network, "Codex didn't answer in time.")
        }
        RpcError::Closed | RpcError::Io(_) => LimitResetError::new(
            LimitResetErrorCode::Failed,
            "Codex's app-server stopped before it answered.",
        ),
    }
}

/// `account/read` then `account/rateLimits/read` on an initialized server.
pub(crate) async fn read<R, W>(
    server: &mut AppServer<R, W>,
    now: i64,
) -> Result<(CodexAccount, CodexReading), LimitResetError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let account = server
        .request(
            "account/read",
            json!({ "refreshToken": false }),
            READ_TIMEOUT,
        )
        .await
        .map_err(|e| error_from_rpc(&e))?;
    let account = parse_account(&account)?;
    let params = json!({ "excludeResetCreditDetails": false });
    let result = match server
        .request("account/rateLimits/read", params, READ_TIMEOUT)
        .await
    {
        // An older app-server takes no params here (the TUI falls back the
        // same way).
        Err(RpcError::Server { code, .. }) if code == INVALID_REQUEST || code == INVALID_PARAMS => {
            server
                .request("account/rateLimits/read", Value::Null, READ_TIMEOUT)
                .await
        }
        other => other,
    }
    .map_err(|e| error_from_rpc(&e))?;
    Ok((account, parse_reading(&result, now)))
}

// ─── Redeeming one ──────────────────────────────────────────────────────

/// A consume answer's outcome.
pub(crate) fn parse_outcome(result: &Value) -> Option<LimitResetOutcome> {
    match result.get("outcome").and_then(Value::as_str)? {
        "reset" => Some(LimitResetOutcome::Reset),
        "nothingToReset" => Some(LimitResetOutcome::NothingToReset),
        "noCredit" => Some(LimitResetOutcome::NoReset),
        "alreadyRedeemed" => Some(LimitResetOutcome::AlreadyUsed),
        _ => None,
    }
}

/// What a consume that got no outcome means. A request the app-server
/// rejected before it reached the backend (no sign-in, a bad id) is a plain
/// failure. Anything after that (a timeout, a backend error, a lost pipe)
/// may have gone through: unconfirmed, retried under the same key.
pub(crate) fn consume_failure(error: &RpcError) -> Result<LimitResetOutcome, LimitResetError> {
    match error {
        RpcError::Server { code, .. } if *code == INVALID_REQUEST || *code == METHOD_NOT_FOUND => {
            Err(error_from_rpc(error))
        }
        _ => Ok(LimitResetOutcome::Unconfirmed),
    }
}

/// Redeem one credit (`credit_id`, or the backend's pick).
pub(crate) async fn consume<R, W>(
    server: &mut AppServer<R, W>,
    credit_id: Option<&str>,
    idempotency_key: &str,
) -> Result<LimitResetOutcome, LimitResetError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut params = json!({ "idempotencyKey": idempotency_key });
    if let Some(id) = credit_id {
        params["creditId"] = json!(id);
    }
    match server
        .request(
            "account/rateLimitResetCredit/consume",
            params,
            CONSUME_TIMEOUT,
        )
        .await
    {
        Ok(result) => Ok(parse_outcome(&result).unwrap_or(LimitResetOutcome::Unconfirmed)),
        Err(error) => consume_failure(&error),
    }
}

// ─── The process ────────────────────────────────────────────────────────

/// A running `codex-acp cli app-server`, initialized.
pub(crate) struct CodexProcess {
    child: tokio::process::Child,
    pub server: AppServer<tokio::process::ChildStdout, tokio::process::ChildStdin>,
}

impl CodexProcess {
    /// Start the app-server the way codex-acp would and initialize it.
    pub(crate) async fn start(
        program: &Path,
        env: &[(String, String)],
    ) -> Result<Self, LimitResetError> {
        let mut command = crate::process::tokio_command(program);
        command
            .args(["cli", "app-server"])
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| {
            LimitResetError::new(
                LimitResetErrorCode::NotInstalled,
                format!("Couldn't start Codex: {e}"),
            )
        })?;
        let (Some(stdout), Some(stdin)) = (child.stdout.take(), child.stdin.take()) else {
            return Err(LimitResetError::new(
                LimitResetErrorCode::Failed,
                "Couldn't talk to Codex's app-server.",
            ));
        };
        let mut process = Self {
            child,
            server: AppServer::new(stdout, stdin),
        };
        if let Err(error) = process.server.initialize(env!("CARGO_PKG_VERSION")).await {
            process.close().await;
            return Err(error_from_rpc(&error));
        }
        Ok(process)
    }

    /// Close the app-server's input (it exits on end of input), then make
    /// sure it is gone.
    pub(crate) async fn close(self) {
        let Self { mut child, server } = self;
        drop(server);
        if tokio::time::timeout(EXIT_GRACE, child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}
