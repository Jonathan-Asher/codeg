//! Claude Code's own sign-in: reading it, recovering from a stale one, and
//! signing in or out from codeg.
//!
//! # Why codeg needs any of this
//!
//! Claude Code keeps one OAuth login per machine user (the macOS keychain, or
//! a file under the config dir) and every `claude` process reads it. A process
//! that hits a sign-in it cannot refresh marks it dead **in its own memory**
//! and keeps saying "Not logged in" for the rest of its life, even after the
//! login is repaired from somewhere else — seen on the remote box on
//! 2026-10-15, where a turn kept failing after a fresh `claude auth login`
//! until the session's process was replaced. Behind a subscription pool
//! (maxpool) the CLI's own login must stay valid too: the pool swaps in its
//! accounts upstream, but the CLI refuses to send anything while it thinks it
//! is signed out.
//!
//! So when claude-agent-acp refuses a prompt with `authRequired`, the turn
//! loop asks the CLI — a NEW process, with the connection's environment —
//! whether it is signed in ([`read_status`]). Signed in means the refusing
//! process is the stale one: the connection driver restarts the agent and
//! sends the prompt once more ([`decide_auth_retry`]). Signed out means it is
//! real, and the user gets the sign-in flow below.
//!
//! # Running the CLI
//!
//! Every command goes through the adapter's own `--cli` passthrough
//! (`claude-agent-acp --cli auth …`), which runs exactly the Claude Code
//! binary the agent runs (the SDK's bundled one, or `CLAUDE_CODE_EXECUTABLE`)
//! with the same environment codeg launches the agent with, so the answer is
//! about the login the agent actually uses.
//!
//! # Signing in
//!
//! `claude auth login` prints a link whose consent page shows a code, and
//! reads that code (`code#state`) from its terminal. codeg runs it on a
//! pseudo-terminal ([`crate::pty_flow`]), hands the link to the UI for the
//! user to open on whatever device they are on, and types the pasted code in
//! for them. The host's browser is never opened (`BROWSER` points at a no-op):
//! codeg is often not running where its user is.
//!
//! # Secrets
//!
//! Nothing that grants access leaves this module: the status is reduced to an
//! allow-list (signed in or not, the method, the account email, the plan),
//! the CLI's output is only matched against, and a finished sign-in reports a
//! verdict and a fixed reason code — never the CLI's words, which echo the
//! pasted code.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::acp::error::AcpError;
use crate::acp::registry::{self, AgentDistribution};
use crate::models::agent::AgentType;
use crate::pty_flow::{self, FlowSpec, Peeked, PendingFlows, PtyFlow, Waited};

/// One `claude auth status` run. The adapter allows the same 5 s for its own
/// probe; a loaded machine gets more here because a wrong "unknown" costs a
/// failed turn.
pub(crate) const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
/// The pause before the agent is restarted for a retry. Long enough for a
/// sibling process that is mid-refresh to finish writing the new token.
pub(crate) const RETRY_BACKOFF: Duration = Duration::from_millis(1500);
/// How long `auth login` gets to print its link.
const LINK_WAIT: Duration = Duration::from_secs(60);
/// How long the token exchange gets after the code is typed.
const FINISH_WAIT: Duration = Duration::from_secs(90);
/// A pending sign-in is abandoned after this. The consent page's code is
/// short-lived too.
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);
/// `auth logout`: local, plus one revoke request.
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_OUTPUT_MAX: usize = 64 * 1024;
const FIELD_MAX_CHARS: usize = 200;

const LINK_MARKER: &str = "visit:";
const PROMPT_MARKER: &str = "Paste code here";
const SUCCESS_MARKER: &str = "Login successful";
const INVALID_CODE_MARKER: &str = "Invalid code";
const FAILURE_MARKER: &str = "Login failed";

// ─── Running the CLI ────────────────────────────────────────────────────

/// How to run Claude Code's CLI the way the agent runs it.
#[derive(Clone)]
pub struct ClaudeCli {
    program: PathBuf,
    /// Leading arguments before the CLI's own (the adapter's `--cli`).
    prefix: Vec<String>,
    env: Vec<(String, String)>,
}

impl std::fmt::Debug for ClaudeCli {
    // The env can carry an API key or a model-provider token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeCli")
            .field("program", &self.program)
            .field("env_keys", &self.env.len())
            .finish()
    }
}

impl ClaudeCli {
    /// The adapter on this machine, with the environment a launch from
    /// `runtime_env` gets.
    pub(crate) async fn for_runtime_env(
        runtime_env: &BTreeMap<String, String>,
    ) -> Result<Self, AcpError> {
        let meta = registry::get_agent_meta(AgentType::ClaudeCode);
        let AgentDistribution::Npx { cmd, env, .. } = meta.distribution else {
            return Err(AcpError::protocol(
                "Claude Code is not distributed as an npm adapter here".to_string(),
            ));
        };
        let program = crate::commands::acp::resolve_npx_command(cmd)
            .await
            .ok_or_else(|| {
                AcpError::SdkNotInstalled(format!(
                    "{} is not installed. Please install it in Agent Settings.",
                    meta.name
                ))
            })?;
        Ok(Self {
            program,
            prefix: vec!["--cli".to_string()],
            env: crate::acp::connection::merge_agent_env(env, runtime_env, None),
        })
    }

    /// A CLI at `program`, run as-is with `env` on top of codeg's own.
    #[cfg(test)]
    pub(crate) fn direct(program: PathBuf, env: Vec<(String, String)>) -> Self {
        Self {
            program,
            prefix: Vec::new(),
            env,
        }
    }

    fn args(&self, args: &[&str]) -> Vec<String> {
        self.prefix
            .iter()
            .cloned()
            .chain(args.iter().map(|a| (*a).to_string()))
            .collect()
    }

    fn command(&self, args: &[&str]) -> tokio::process::Command {
        let mut command = crate::process::tokio_command(&self.program);
        command
            .args(self.args(args))
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        command
    }

    fn flow_spec(&self, args: &[&str]) -> FlowSpec {
        let mut env = self.env.clone();
        // Never open a browser on the host: the user is often elsewhere, and
        // the link is shown in codeg instead.
        if let Some(noop) = noop_browser() {
            env.push(("BROWSER".to_string(), noop));
        }
        FlowSpec {
            program: self.program.clone(),
            args: self.args(args),
            env,
            env_remove: Vec::new(),
            cwd: None,
        }
    }
}

/// A command that accepts a URL and does nothing.
fn noop_browser() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    ["/usr/bin/true", "/bin/true"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(str::to_string)
}

// ─── Status ─────────────────────────────────────────────────────────────

/// How the CLI is signed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeAuthMethod {
    /// A Claude subscription (claude.ai).
    ClaudeAi,
    /// An Anthropic Console account.
    Console,
    ApiKey,
    /// A long-lived token in the environment (`CLAUDE_CODE_OAUTH_TOKEN`).
    OauthToken,
    /// A cloud provider or gateway holds the credentials.
    ThirdParty,
    None,
    Other,
}

impl ClaudeAuthMethod {
    fn from_raw(raw: Option<&str>) -> Self {
        match raw.unwrap_or_default() {
            "claude.ai" => Self::ClaudeAi,
            "console" | "console_login" => Self::Console,
            "api_key" | "apiKey" => Self::ApiKey,
            "oauth_token" | "CLAUDE_CODE_OAUTH_TOKEN" => Self::OauthToken,
            "third_party" | "bedrock" | "vertex" | "foundry" => Self::ThirdParty,
            "none" | "" => Self::None,
            _ => Self::Other,
        }
    }
}

/// What the settings page shows of the CLI's sign-in. Allow-listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub logged_in: bool,
    pub method: ClaudeAuthMethod,
    pub email: Option<String>,
    /// The subscription plan (`max`, `pro`, …), for a claude.ai sign-in.
    pub subscription: Option<String>,
    /// Where requests go (`firstParty`, `bedrock`, …).
    pub provider: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStatus {
    logged_in: Option<bool>,
    auth_method: Option<String>,
    email: Option<String>,
    subscription_type: Option<String>,
    api_provider: Option<String>,
}

fn clean_field(raw: Option<String>) -> Option<String> {
    let value = raw?;
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.chars().take(FIELD_MAX_CHARS).collect())
}

/// Parse `claude auth status --json`. `None` for anything that isn't its
/// answer (the CLI exits 1 when signed out, so the exit code says nothing).
pub(crate) fn parse_status(stdout: &str) -> Option<ClaudeAuthStatus> {
    // The JSON is the whole output; a warning line before it (a Node
    // deprecation notice) must not hide it.
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    let raw: RawStatus = serde_json::from_str(stdout.get(start..=end)?).ok()?;
    let logged_in = raw.logged_in?;
    let method = ClaudeAuthMethod::from_raw(raw.auth_method.as_deref());
    Some(ClaudeAuthStatus {
        logged_in,
        method: if logged_in {
            method
        } else {
            ClaudeAuthMethod::None
        },
        email: clean_field(raw.email).filter(|_| logged_in),
        subscription: clean_field(raw.subscription_type).filter(|_| logged_in),
        provider: clean_field(raw.api_provider),
    })
}

/// Ask a new CLI process whether it is signed in.
pub(crate) async fn read_status(cli: &ClaudeCli) -> Result<ClaudeAuthStatus, String> {
    read_status_within(cli, STATUS_TIMEOUT).await
}

pub(crate) async fn read_status_within(
    cli: &ClaudeCli,
    timeout: Duration,
) -> Result<ClaudeAuthStatus, String> {
    let child = cli
        .command(&["auth", "status", "--json"])
        .spawn()
        .map_err(|e| format!("could not run the Claude Code CLI: {e}"))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "the Claude Code CLI did not answer in time".to_string())?
        .map_err(|e| format!("the Claude Code CLI failed: {e}"))?;
    let stdout = &output.stdout[..output.stdout.len().min(STATUS_OUTPUT_MAX)];
    parse_status(&String::from_utf8_lossy(stdout))
        .ok_or_else(|| "the Claude Code CLI gave no readable sign-in status".to_string())
}

// ─── The retry decision ─────────────────────────────────────────────────

/// What to do with a prompt the agent refused with `authRequired`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthRetry {
    /// Restart the agent process and send the prompt once more.
    Respawn,
    /// End the turn and ask the user to sign in.
    Surface(SurfaceReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SurfaceReason {
    /// Only Claude Code's CLI has the stale-process failure this answers.
    NotClaude,
    /// This prompt already is the retry: never loop.
    RetryAlsoFailed,
    /// The connection has nothing to restart with (a test or detached path).
    NoRestart,
    /// A new CLI process says it is signed out: a real sign-out.
    LoggedOut,
    /// The CLI's status could not be read, so a restart is no better bet.
    StatusUnknown,
}

/// Pure, so each branch is tested without an agent. `status` is a new CLI
/// process's answer, `Err` when it could not be read; it is only consulted
/// when nothing else rules the retry out (it costs a process).
pub(crate) fn decide_auth_retry(
    agent_type: AgentType,
    already_retried: bool,
    can_restart: bool,
    status: impl FnOnce() -> Result<bool, ()>,
) -> AuthRetry {
    if agent_type != AgentType::ClaudeCode {
        return AuthRetry::Surface(SurfaceReason::NotClaude);
    }
    if already_retried {
        return AuthRetry::Surface(SurfaceReason::RetryAlsoFailed);
    }
    if !can_restart {
        return AuthRetry::Surface(SurfaceReason::NoRestart);
    }
    match status() {
        Ok(true) => AuthRetry::Respawn,
        Ok(false) => AuthRetry::Surface(SurfaceReason::LoggedOut),
        Err(()) => AuthRetry::Surface(SurfaceReason::StatusUnknown),
    }
}

// ─── Signing in ─────────────────────────────────────────────────────────

/// The first half of a sign-in: the link to open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLoginStart {
    pub handle: String,
    pub url: String,
}

/// Why a sign-in did not complete. Fixed codes, never the CLI's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginFailure {
    /// The paste is not a code the CLI accepts; it is still waiting for one.
    InvalidCode,
    /// The code was refused by the sign-in service.
    Rejected,
    /// No answer from the CLI in time.
    Timeout,
    /// No such sign-in: finished, cancelled, or expired.
    Expired,
    Failed,
}

/// The second half: whether it worked. `retry` means the same sign-in is
/// still waiting and another paste may be sent to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub ok: bool,
    pub reason: Option<LoginFailure>,
    pub retry: bool,
}

impl LoginOutcome {
    pub(crate) fn success() -> Self {
        Self {
            ok: true,
            reason: None,
            retry: false,
        }
    }
    pub(crate) fn failure(reason: LoginFailure, retry: bool) -> Self {
        Self {
            ok: false,
            reason: Some(reason),
            retry,
        }
    }
}

/// Where a pending sign-in stands, for a client polling it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginState {
    Waiting,
    Succeeded,
    Failed,
    Expired,
}

static PENDING: LazyLock<PendingFlows<()>> = LazyLock::new(|| PendingFlows::new(1, PENDING_TTL));

/// Start `claude auth login` and wait for its link.
pub(crate) async fn login_start(
    cli: &ClaudeCli,
    console: bool,
) -> Result<ClaudeLoginStart, AcpError> {
    let method = if console { "--console" } else { "--claudeai" };
    let mut flow =
        PtyFlow::spawn(&cli.flow_spec(&["auth", "login", method])).map_err(AcpError::protocol)?;
    match flow
        .wait_for(LINK_WAIT, |text| {
            pty_flow::https_link_after(text, LINK_MARKER).filter(|_| text.contains(PROMPT_MARKER))
        })
        .await
    {
        Waited::Found(url) => {
            let handle = PENDING.insert(flow, ()).await;
            tracing::info!("[claude-auth] sign-in started; waiting for the pasted code");
            Ok(ClaudeLoginStart { handle, url })
        }
        Waited::Exited(code) => {
            let gateway = flow.output().contains("Cloud gateway");
            Err(AcpError::protocol(if gateway {
                "This machine's managed settings sign Claude Code in through a Cloud gateway, \
                 which codeg cannot drive. Sign in with `claude` in a terminal on the host."
                    .to_string()
            } else {
                format!(
                    "Claude Code's sign-in ended before it showed a link (exit code {}).",
                    code.map_or_else(|| "unknown".to_string(), |c| c.to_string())
                )
            }))
        }
        Waited::TimedOut => {
            flow.kill().await;
            Err(AcpError::protocol(
                "Claude Code's sign-in did not show a link in time.".to_string(),
            ))
        }
    }
}

/// Type the pasted code into the pending sign-in and wait for its verdict.
pub(crate) async fn login_finish(handle: &str, pasted: &str) -> LoginOutcome {
    let Some(mut taken) = PENDING.take(handle).await else {
        return LoginOutcome::failure(LoginFailure::Expired, false);
    };
    let code = match pty_flow::clean_paste(pasted) {
        // `code#state`: the CLI rejects anything else locally, so say so
        // without spending a round trip.
        Ok(code) if code.contains('#') => code,
        _ => {
            PENDING.put_back(taken).await;
            return LoginOutcome::failure(LoginFailure::InvalidCode, true);
        }
    };
    let flow = &mut taken.flow;
    let before = flow.output().len();
    if flow.send_line(&code).is_err() {
        flow.kill().await;
        return LoginOutcome::failure(LoginFailure::Failed, false);
    }
    let verdict = flow
        .wait_for(FINISH_WAIT, |text| {
            let after = text.get(before..).unwrap_or(text);
            if after.contains(SUCCESS_MARKER) {
                Some(Ok(()))
            } else if after.contains(INVALID_CODE_MARKER) {
                Some(Err(LoginFailure::InvalidCode))
            } else if after.contains(FAILURE_MARKER) {
                Some(Err(LoginFailure::Rejected))
            } else {
                None
            }
        })
        .await;
    match verdict {
        Waited::Found(Ok(())) => {
            let _ = flow.wait_exit(Duration::from_secs(10)).await;
            tracing::info!("[claude-auth] signed in from codeg");
            LoginOutcome::success()
        }
        Waited::Found(Err(LoginFailure::InvalidCode)) => {
            PENDING.put_back(taken).await;
            LoginOutcome::failure(LoginFailure::InvalidCode, true)
        }
        Waited::Found(Err(reason)) => {
            flow.kill().await;
            tracing::info!("[claude-auth] sign-in refused ({reason:?})");
            LoginOutcome::failure(reason, false)
        }
        Waited::Exited(Some(0)) => LoginOutcome::success(),
        Waited::Exited(_) => LoginOutcome::failure(LoginFailure::Rejected, false),
        Waited::TimedOut => {
            flow.kill().await;
            LoginOutcome::failure(LoginFailure::Timeout, false)
        }
    }
}

/// Where a pending sign-in stands, without answering it. A sign-in can
/// finish on its own (a browser on the host reached its callback); one being
/// answered right now is still waiting as far as a poller is concerned.
pub(crate) async fn login_state(handle: &str) -> LoginState {
    let state = match PENDING
        .peek(handle, |flow| match flow.try_exit() {
            Some(0) => LoginState::Succeeded,
            Some(_) => LoginState::Failed,
            None if flow.output().contains(SUCCESS_MARKER) => LoginState::Succeeded,
            None => LoginState::Waiting,
        })
        .await
    {
        Peeked::Parked(state) => state,
        Peeked::Busy => LoginState::Waiting,
        Peeked::Gone => LoginState::Expired,
    };
    // A finished one has nothing left to answer.
    if matches!(state, LoginState::Succeeded | LoginState::Failed) {
        PENDING.cancel(handle).await;
    }
    state
}

/// Abandon a pending sign-in.
pub(crate) async fn login_cancel(handle: &str) {
    PENDING.cancel(handle).await;
}

/// Sign the CLI out. Every Claude Code process on the machine shares this
/// login, so running sessions fail their next refresh too.
pub(crate) async fn logout(cli: &ClaudeCli) -> Result<(), AcpError> {
    let child = cli
        .command(&["auth", "logout"])
        .spawn()
        .map_err(|e| AcpError::protocol(format!("could not run the Claude Code CLI: {e}")))?;
    let output = tokio::time::timeout(LOGOUT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            AcpError::protocol("Claude Code's sign-out did not finish in time".to_string())
        })?
        .map_err(|e| AcpError::protocol(format!("Claude Code's sign-out failed: {e}")))?;
    if output.status.success() {
        tracing::info!("[claude-auth] signed out from codeg");
        Ok(())
    } else {
        Err(AcpError::protocol(format!(
            "Claude Code's sign-out failed (exit code {}).",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |c| c.to_string())
        )))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pty_flow::tests::script;

    #[test]
    fn status_parsing_keeps_only_the_allow_list() {
        let json = r#"{
          "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
          "email": "someone@example.com", "orgId": "secret-org", "orgName": "Org",
          "subscriptionType": "max", "configDirectory": "/home/x/.claude"
        }"#;
        let status = parse_status(json).unwrap();
        assert_eq!(
            status,
            ClaudeAuthStatus {
                logged_in: true,
                method: ClaudeAuthMethod::ClaudeAi,
                email: Some("someone@example.com".into()),
                subscription: Some("max".into()),
                provider: Some("firstParty".into()),
            }
        );
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("secret-org"));
        assert!(!serialized.contains("/home/x"));
    }

    #[test]
    fn status_parsing_reads_signed_out_and_ignores_noise() {
        let out = "(node:1) Warning: something\n{\"loggedIn\": false, \"authMethod\": \"none\", \"apiProvider\": \"firstParty\"}\n";
        let status = parse_status(out).unwrap();
        assert!(!status.logged_in);
        assert_eq!(status.method, ClaudeAuthMethod::None);
        assert_eq!(status.email, None);
        assert_eq!(parse_status("Not logged in"), None);
        assert_eq!(parse_status("{\"authMethod\": \"none\"}"), None);
        assert_eq!(
            parse_status("{\"loggedIn\": true, \"authMethod\": \"api_key\"}")
                .unwrap()
                .method,
            ClaudeAuthMethod::ApiKey
        );
    }

    #[test]
    fn retry_decision_covers_every_branch() {
        let never = || -> Result<bool, ()> { panic!("status must not be read here") };
        assert_eq!(
            decide_auth_retry(AgentType::Codex, false, true, never),
            AuthRetry::Surface(SurfaceReason::NotClaude)
        );
        assert_eq!(
            decide_auth_retry(AgentType::ClaudeCode, true, true, never),
            AuthRetry::Surface(SurfaceReason::RetryAlsoFailed)
        );
        assert_eq!(
            decide_auth_retry(AgentType::ClaudeCode, false, false, never),
            AuthRetry::Surface(SurfaceReason::NoRestart)
        );
        assert_eq!(
            decide_auth_retry(AgentType::ClaudeCode, false, true, || Ok(true)),
            AuthRetry::Respawn
        );
        assert_eq!(
            decide_auth_retry(AgentType::ClaudeCode, false, true, || Ok(false)),
            AuthRetry::Surface(SurfaceReason::LoggedOut)
        );
        assert_eq!(
            decide_auth_retry(AgentType::ClaudeCode, false, true, || Err(())),
            AuthRetry::Surface(SurfaceReason::StatusUnknown)
        );
    }

    #[tokio::test]
    async fn status_comes_from_a_fresh_cli_process() {
        let dir = tempfile::tempdir().unwrap();
        let flag = dir.path().join("signed-in");
        let cli = script(
            dir.path(),
            "claude",
            &format!(
                r#"[ "$1 $2 $3" = "auth status --json" ] || exit 9
if [ -f '{}' ]; then echo '{{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c"}}'; exit 0; fi
echo '{{"loggedIn": false, "authMethod": "none"}}'; exit 1"#,
                flag.display()
            ),
        );
        let cli = ClaudeCli::direct(cli, Vec::new());
        assert!(!read_status(&cli).await.unwrap().logged_in);
        std::fs::write(&flag, "").unwrap();
        let status = read_status(&cli).await.unwrap();
        assert!(status.logged_in);
        assert_eq!(status.email.as_deref(), Some("a@b.c"));
    }

    #[tokio::test]
    async fn status_that_never_answers_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let cli = ClaudeCli::direct(script(dir.path(), "claude", "sleep 30"), Vec::new());
        assert!(read_status_within(&cli, Duration::from_millis(300))
            .await
            .is_err());
    }

    /// Mimics `claude auth login`: the prompts, the `code#state` check the
    /// CLI makes locally, and the token exchange's two verdicts.
    const FAKE_LOGIN: &str = r#"[ "$1 $2" = "auth login" ] || exit 9
printf 'Opening browser to sign in\n'
printf "If the browser didn't open, visit: \033]8;;https://claude.test/oauth/authorize?code=true&state=st\007https://claude.test/oauth/authorize?code=true&state=st\033]8;;\007\n"
printf 'Paste code here if prompted > '
while read line; do
  case "$line" in
    *'#'*) ;;
    *) printf 'Invalid code. Please make sure the full code was copied.\n' >&2; continue ;;
  esac
  if [ "$line" = "good#st" ]; then printf 'Login successful.\n'; exit 0; fi
  printf 'Login failed: Request failed with status code 400\n' >&2; exit 1
done"#;

    // The pending slot is shared, so the flow tests run one after another.
    static SERIAL: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

    #[tokio::test]
    async fn sign_in_shows_the_link_and_takes_the_pasted_code() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let cli = ClaudeCli::direct(script(dir.path(), "claude", FAKE_LOGIN), Vec::new());
        let start = login_start(&cli, false).await.unwrap();
        assert_eq!(
            start.url,
            "https://claude.test/oauth/authorize?code=true&state=st"
        );
        assert_eq!(login_state(&start.handle).await, LoginState::Waiting);

        // Not `code#state`: refused locally, the same sign-in keeps waiting.
        let outcome = login_finish(&start.handle, "no-hash-here").await;
        assert_eq!(outcome.reason, Some(LoginFailure::InvalidCode));
        assert!(outcome.retry);

        let outcome = login_finish(&start.handle, "good#st").await;
        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(
            login_finish(&start.handle, "good#st").await.reason,
            Some(LoginFailure::Expired),
            "a finished sign-in can't be answered again"
        );
    }

    #[tokio::test]
    async fn sign_in_with_a_refused_code_fails() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let cli = ClaudeCli::direct(script(dir.path(), "claude", FAKE_LOGIN), Vec::new());
        let start = login_start(&cli, false).await.unwrap();
        let outcome = login_finish(&start.handle, "bad#st").await;
        assert!(!outcome.ok);
        assert_eq!(outcome.reason, Some(LoginFailure::Rejected));
        assert!(!outcome.retry);
    }

    #[tokio::test]
    async fn sign_in_can_be_cancelled() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let cli = ClaudeCli::direct(script(dir.path(), "claude", FAKE_LOGIN), Vec::new());
        let start = login_start(&cli, false).await.unwrap();
        login_cancel(&start.handle).await;
        assert_eq!(login_state(&start.handle).await, LoginState::Expired);
        assert_eq!(
            login_finish(&start.handle, "good#st").await.reason,
            Some(LoginFailure::Expired)
        );
    }

    #[tokio::test]
    async fn sign_in_that_never_shows_a_link_is_an_error() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let cli = ClaudeCli::direct(
            script(
                dir.path(),
                "claude",
                "echo 'Managed settings on this machine configure a Cloud gateway sign-in'; exit 1",
            ),
            Vec::new(),
        );
        let err = login_start(&cli, false).await.unwrap_err().to_string();
        assert!(err.contains("Cloud gateway"), "{err}");
    }

    #[tokio::test]
    async fn sign_out_reports_the_cli_exit() {
        let dir = tempfile::tempdir().unwrap();
        let ok = ClaudeCli::direct(
            script(
                dir.path(),
                "ok",
                "[ \"$1 $2\" = 'auth logout' ] && exit 0; exit 2",
            ),
            Vec::new(),
        );
        assert!(logout(&ok).await.is_ok());
        let bad = ClaudeCli::direct(script(dir.path(), "bad", "exit 4"), Vec::new());
        assert!(logout(&bad)
            .await
            .unwrap_err()
            .to_string()
            .contains("exit code 4"));
    }
}
