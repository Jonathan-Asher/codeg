//! Managing the account pool's accounts from codeg: add one, sign a failed
//! one in again, rename, switch off and on, choose the preferred one, and
//! remove.
//!
//! Everything goes through maxpool's own tools — its CLI (`login`, `rename`,
//! `remove`) and, for the on/off switch and the routing it has no command
//! for, its own config module's `atomicConfigUpdate` (the writer its TUI
//! uses) — always pointed at the config codeg reads
//! (`MAXPOOL_CONFIG`). codeg never parses and rewrites `maxpool.json` itself:
//! the file holds every account's single-use refresh token, and maxpool's
//! writers are the ones that know how not to lose one.
//!
//! # Signing an account in
//!
//! `maxpool login` runs an OAuth flow with a loopback callback and, when its
//! stdin is a terminal, also takes the callback address (or the bare code)
//! pasted at its prompt. codeg runs it on a pseudo-terminal
//! ([`crate::pty_flow`]), shows the link, and types the pasted address in. On
//! a remote host the browser lands on a `localhost` page that can't load; its
//! address is what the user pastes. The host's own browser is never opened.
//!
//! # When the running pool sees a change
//!
//! The server re-reads its config every 15 s and picks up new accounts, new
//! credentials (which also revive one whose refresh had died), the enabled
//! flag and the routing live. A new preferred account takes every request
//! routed after that re-read; requests already running finish where they
//! are. It does NOT drop a removed account or rename one: those
//! need the server restarted, which its service manager does after `SIGHUP`
//! (maxpool's reload trigger when it runs headless: it drains in-flight token
//! refreshes, persists, and exits for a fresh start). codeg sends it only when
//! no request is in flight and only to a server that something restarts — a
//! launchd job or a systemd unit (or `CODEG_MAXPOOL_SUPERVISED=1`); otherwise
//! it says a restart is needed instead of stopping the pool.
//!
//! # Secrets
//!
//! The pool's API key stays where `usage_pool` keeps it. Accounts are named
//! by the names the pool's status reports; the CLI's output is matched
//! against and never returned or logged (a terminal echoes the paste).

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::pty_flow::{self, FlowSpec, Peeked, PendingFlows, PtyFlow, Waited};

/// Overrides which `maxpool` runs (tests, unusual installs).
pub const MAXPOOL_BIN_ENV: &str = "CODEG_MAXPOOL_BIN";
/// Declares that something restarts the pool's server when it exits, for a
/// setup codeg can't recognize as a launchd job or a systemd unit.
pub const MAXPOOL_SUPERVISED_ENV: &str = "CODEG_MAXPOOL_SUPERVISED";

const NAME_MAX_CHARS: usize = 64;
const LINK_WAIT: Duration = Duration::from_secs(60);
const FINISH_WAIT: Duration = Duration::from_secs(90);
/// maxpool's own login waits 5 minutes for the callback.
const PENDING_TTL: Duration = Duration::from_secs(5 * 60);
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// The server's own config re-read interval, plus a margin.
const SYNC_DELAY: Duration = Duration::from_secs(17);
/// How long a restart waits for the pool to have nothing in flight.
const IDLE_WAIT: Duration = Duration::from_secs(5 * 60);
const IDLE_POLL: Duration = Duration::from_secs(3);
/// How long the pool gets to come back after the restart signal.
const RESTART_WAIT: Duration = Duration::from_secs(60);

const LINK_MARKER: &str = "visit:";
const PROMPT_MARKER: &str = "Paste authorization code";

// ─── Finding maxpool ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Maxpool {
    bin: PathBuf,
    config: PathBuf,
}

impl Maxpool {
    fn locate() -> Result<Self, AppCommandError> {
        let config = match super::discover() {
            super::Discovery::Found(_) => super::config_path().ok_or_else(no_pool)?,
            _ => return Err(no_pool()),
        };
        let bin = match std::env::var_os(MAXPOOL_BIN_ENV) {
            Some(path) if !path.is_empty() => PathBuf::from(path),
            _ => crate::commands::acp::resolve_command_on_path("maxpool").ok_or_else(|| {
                AppCommandError::dependency_missing(
                    "The maxpool command isn't on this machine's PATH, so codeg can't change \
                     the pool's accounts.",
                )
            })?,
        };
        Ok(Self { bin, config })
    }

    fn env(&self) -> Vec<(String, String)> {
        vec![(
            "MAXPOOL_CONFIG".to_string(),
            self.config.to_string_lossy().into_owned(),
        )]
    }

    async fn run(&self, args: &[&str]) -> Result<CliRun, AppCommandError> {
        let mut command = crate::process::tokio_command(&self.bin);
        command
            .args(args)
            .envs(self.env())
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let child = command.spawn().map_err(|e| {
            AppCommandError::external_command("Could not run maxpool.", e.to_string())
        })?;
        let output = tokio::time::timeout(CLI_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| AppCommandError::task_execution_failed("maxpool did not finish in time."))?
            .map_err(AppCommandError::io)?;
        Ok(CliRun {
            ok: output.status.success(),
            text: format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
        })
    }
}

struct CliRun {
    ok: bool,
    /// Matched against only.
    text: String,
}

fn no_pool() -> AppCommandError {
    AppCommandError::configuration_missing("No account pool is configured on this machine.")
}

/// What the pool section may offer, and whether a change is waiting for the
/// server to restart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolManageInfo {
    /// A pool is configured here and maxpool can be run.
    pub available: bool,
    pub reload: ReloadState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReloadState {
    /// Nothing is waiting.
    Idle,
    /// A removal or rename is on disk; the server restarts once nothing is
    /// in flight.
    Waiting,
    /// A change is on disk that only a restart applies, and codeg can't
    /// restart this server.
    NeedsRestart,
}

static RELOAD: Mutex<ReloadState> = Mutex::new(ReloadState::Idle);
/// One restart task at a time.
static RELOAD_TASK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

fn set_reload(state: ReloadState) {
    *RELOAD.lock().unwrap_or_else(|e| e.into_inner()) = state;
}

fn reload_state() -> ReloadState {
    *RELOAD.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn manage_info() -> PoolManageInfo {
    PoolManageInfo {
        available: Maxpool::locate().is_ok(),
        reload: reload_state(),
    }
}

// ─── Names ──────────────────────────────────────────────────────────────

/// A name maxpool's CLI will read as one positional value.
pub(crate) fn valid_new_name(raw: &str) -> Result<String, AppCommandError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppCommandError::invalid_input("An account needs a name."));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(AppCommandError::invalid_input(format!(
            "An account name is at most {NAME_MAX_CHARS} characters."
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(AppCommandError::invalid_input(
            "An account name can't contain line breaks or control characters.",
        ));
    }
    // A leading dash reads as an option; all digits as a list position.
    if name.starts_with('-') || name.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppCommandError::invalid_input(
            "An account name can't start with a dash or be only digits.",
        ));
    }
    Ok(name.to_string())
}

/// `name` as an account the pool reports now.
async fn existing_account(name: &str) -> Result<String, AppCommandError> {
    let name = name.trim();
    let reading = super::refresh(Duration::from_secs(5))
        .await
        .ok_or_else(no_pool)?;
    reading
        .accounts
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.name.clone())
        .ok_or_else(|| {
            AppCommandError::not_found(format!("The pool has no account named \"{name}\"."))
        })
}

// ─── Signing an account in ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolLoginStart {
    pub handle: String,
    pub url: String,
}

pub use crate::acp::claude_auth::{LoginFailure, LoginOutcome, LoginState};

/// A parked sign-in and what keeps it working: the directory whose no-op
/// `open` keeps the host's browser shut.
struct LoginMeta {
    _shim: Option<ShimDir>,
}

/// A directory removed when the sign-in it served is over.
struct ShimDir(PathBuf);

impl ShimDir {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ShimDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

static PENDING: LazyLock<PendingFlows<LoginMeta>> =
    LazyLock::new(|| PendingFlows::new(1, PENDING_TTL));

/// A directory holding `open` and `xdg-open` that do nothing, to go first on
/// the CLI's PATH: maxpool opens the browser through whichever the platform
/// has, and the user is not at this machine.
fn browser_shim() -> Option<ShimDir> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = ShimDir(
            std::env::temp_dir().join(format!("codeg-noopen-{}", uuid::Uuid::new_v4().simple())),
        );
        std::fs::create_dir(dir.path()).ok()?;
        for name in ["open", "xdg-open"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "#!/bin/sh\nexit 0\n").ok()?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).ok()?;
        }
        Some(dir)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn path_with(first: &Path) -> String {
    let rest = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![first.to_path_buf()];
    paths.extend(std::env::split_paths(&rest));
    std::env::join_paths(paths)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| first.to_string_lossy().into_owned())
}

/// Start `maxpool login` for a new account (`name`, or the email it signs in
/// as) or to sign `reconnect` in again, and return the link to open.
pub(crate) async fn login_start(
    name: Option<String>,
    reconnect: Option<String>,
) -> Result<PoolLoginStart, AppCommandError> {
    let pool = Maxpool::locate()?;
    let name = match (reconnect, name) {
        (Some(existing), _) => Some(existing_account(&existing).await?),
        (None, Some(name)) if !name.trim().is_empty() => Some(valid_new_name(&name)?),
        (None, _) => None,
    };
    login_start_with(&pool, name).await
}

async fn login_start_with(
    pool: &Maxpool,
    name: Option<String>,
) -> Result<PoolLoginStart, AppCommandError> {
    let mut args = vec!["login".to_string(), "--oauth".to_string()];
    if let Some(name) = &name {
        args.push("--name".to_string());
        args.push(name.clone());
    }
    let shim = browser_shim();
    let mut env = pool.env();
    if let Some(dir) = &shim {
        env.push(("PATH".to_string(), path_with(dir.path())));
    }
    let spec = FlowSpec {
        program: pool.bin.clone(),
        args,
        env,
        env_remove: Vec::new(),
        cwd: None,
    };
    let mut flow = PtyFlow::spawn(&spec)
        .map_err(|e| AppCommandError::external_command("Could not start maxpool's sign-in.", e))?;
    match flow
        .wait_for(LINK_WAIT, |text| {
            pty_flow::https_link_after(text, LINK_MARKER).filter(|_| text.contains(PROMPT_MARKER))
        })
        .await
    {
        Waited::Found(url) => {
            let handle = PENDING.insert(flow, LoginMeta { _shim: shim }).await;
            tracing::info!("[usage-pool] account sign-in started; waiting for the pasted address");
            Ok(PoolLoginStart { handle, url })
        }
        Waited::Exited(code) => Err(AppCommandError::external_command(
            "maxpool's sign-in ended before it showed a link.",
            format!(
                "exit code {}",
                code.map_or_else(|| "unknown".to_string(), |c| c.to_string())
            ),
        )),
        Waited::TimedOut => {
            flow.kill().await;
            Err(AppCommandError::task_execution_failed(
                "maxpool's sign-in did not show a link in time.",
            ))
        }
    }
}

/// How `maxpool login` ended, from what it printed after the paste.
fn login_verdict(after: &str) -> Option<Result<(), LoginFailure>> {
    if after.contains("Added account") || after.contains("Updated account") {
        Some(Ok(()))
    } else if after.contains("state mismatch") {
        Some(Err(LoginFailure::InvalidCode))
    } else if after.contains("OAuth login failed")
        || after.contains("Token exchange failed")
        || after.contains("Login cancelled")
    {
        Some(Err(LoginFailure::Rejected))
    } else {
        None
    }
}

/// Type the pasted callback address (or code) into the pending sign-in and
/// wait for maxpool to save the account.
pub(crate) async fn login_finish(handle: &str, pasted: &str) -> LoginOutcome {
    let Some(mut taken) = PENDING.take(handle.trim()).await else {
        return LoginOutcome::failure(LoginFailure::Expired, false);
    };
    let answer = match pty_flow::clean_paste(pasted) {
        // maxpool reads a quit word as "cancel".
        Ok(answer)
            if !matches!(
                answer.to_ascii_lowercase().as_str(),
                "q" | "quit" | "cancel" | "abort" | ":q"
            ) =>
        {
            answer
        }
        _ => {
            PENDING.put_back(taken).await;
            return LoginOutcome::failure(LoginFailure::InvalidCode, true);
        }
    };
    let flow = &mut taken.flow;
    let before = flow.output().len();
    if flow.send_line(&answer).is_err() {
        flow.kill().await;
        return LoginOutcome::failure(LoginFailure::Failed, false);
    }
    let verdict = flow
        .wait_for(FINISH_WAIT, |text| {
            login_verdict(text.get(before..).unwrap_or(text))
        })
        .await;
    let outcome = match verdict {
        Waited::Found(Ok(())) => {
            let _ = flow.wait_exit(Duration::from_secs(10)).await;
            LoginOutcome::success()
        }
        Waited::Found(Err(reason)) => {
            flow.kill().await;
            LoginOutcome::failure(reason, false)
        }
        Waited::Exited(Some(0)) => LoginOutcome::success(),
        Waited::Exited(_) => LoginOutcome::failure(LoginFailure::Rejected, false),
        Waited::TimedOut => {
            flow.kill().await;
            LoginOutcome::failure(LoginFailure::Timeout, false)
        }
    };
    if outcome.ok {
        tracing::info!("[usage-pool] account signed in from codeg");
        refresh_after_sync();
    }
    outcome
}

/// Where a pending sign-in stands. A browser on the host reaching the
/// loopback callback finishes it with no paste at all; one being answered
/// right now is still waiting as far as a poller is concerned.
pub(crate) async fn login_state(handle: &str) -> LoginState {
    let handle = handle.trim();
    let state = match PENDING
        .peek(handle, |flow| match flow.try_exit() {
            Some(0) => LoginState::Succeeded,
            Some(_) => LoginState::Failed,
            None => match login_verdict(&flow.output()) {
                Some(Ok(())) => LoginState::Succeeded,
                _ => LoginState::Waiting,
            },
        })
        .await
    {
        Peeked::Parked(state) => state,
        Peeked::Busy => LoginState::Waiting,
        Peeked::Gone => LoginState::Expired,
    };
    if matches!(state, LoginState::Succeeded | LoginState::Failed) {
        PENDING.cancel(handle).await;
        if state == LoginState::Succeeded {
            refresh_after_sync();
        }
    }
    state
}

pub(crate) async fn login_cancel(handle: &str) {
    PENDING.cancel(handle.trim()).await;
}

// ─── Renaming, switching, removing ─────────────────────────────────────

/// How a change reaches the running pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PoolApply {
    /// The server picks it up on its next config read (within ~15 s).
    Live,
    /// The server restarts to apply it once nothing is in flight.
    Restarting,
    /// It applies when the pool's server is next restarted.
    NeedsRestart,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolChange {
    pub applied: PoolApply,
}

pub(crate) async fn rename(name: &str, new_name: &str) -> Result<PoolChange, AppCommandError> {
    let pool = Maxpool::locate()?;
    let name = existing_account(name).await?;
    let new_name = valid_new_name(new_name)?;
    if new_name == name {
        return Ok(PoolChange {
            applied: PoolApply::Live,
        });
    }
    let run = pool.run(&["rename", &name, &new_name]).await?;
    if !run.ok {
        return Err(if run.text.contains("already exists") {
            AppCommandError::already_exists(format!(
                "An account named \"{new_name}\" already exists."
            ))
        } else {
            AppCommandError::task_execution_failed("maxpool could not rename the account.")
        });
    }
    tracing::info!("[usage-pool] renamed a pool account from codeg");
    Ok(PoolChange {
        applied: schedule_restart(pool).await,
    })
}

pub(crate) async fn remove(name: &str) -> Result<PoolChange, AppCommandError> {
    let pool = Maxpool::locate()?;
    let name = existing_account(name).await?;
    let run = pool.run(&["remove", &name]).await?;
    if !run.ok {
        return Err(AppCommandError::task_execution_failed(
            "maxpool could not remove the account.",
        ));
    }
    tracing::info!("[usage-pool] removed a pool account from codeg");
    Ok(PoolChange {
        applied: schedule_restart(pool).await,
    })
}

/// maxpool has no command for the switch; its own config module does it,
/// the way its TUI does. Name and value travel in the environment, never in
/// the script.
const SET_ENABLED_SCRIPT: &str = r#"
const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(process.env.CODEG_MAXPOOL_CONFIG_MODULE).href);
if (typeof mod.atomicConfigUpdate !== 'function') process.exit(3);
const name = process.env.CODEG_MAXPOOL_ACCOUNT;
const enabled = process.env.CODEG_MAXPOOL_ENABLED === '1';
let found = false;
await mod.atomicConfigUpdate((config) => {
  const account = (config.accounts || []).find((a) => a.name === name);
  if (!account) return;
  found = true;
  if (enabled) delete account.enabled; else account.enabled = false;
});
process.exit(found ? 0 : 4);
"#;

/// maxpool's `config.js`, next to the entry point the `maxpool` command
/// links to.
fn config_module(bin: &Path) -> Option<PathBuf> {
    let entry = std::fs::canonicalize(bin).ok()?;
    let module = entry.parent()?.join("config.js");
    module.is_file().then_some(module)
}

/// Run one of the scripts above against maxpool's config module; its exit
/// code.
async fn config_update(
    pool: &Maxpool,
    script: &str,
    env: &[(&str, &str)],
) -> Result<Option<i32>, AppCommandError> {
    let module = config_module(&pool.bin).ok_or_else(|| {
        AppCommandError::dependency_missing(
            "This maxpool install doesn't expose the config module codeg changes the pool with.",
        )
    })?;
    let node = crate::commands::acp::resolve_command_on_path("node").ok_or_else(|| {
        AppCommandError::dependency_missing("Node.js isn't on this machine's PATH.")
    })?;
    let mut command = crate::process::tokio_command(node);
    command
        .args(["--input-type=module", "-e", script])
        .envs(pool.env())
        .env("CODEG_MAXPOOL_CONFIG_MODULE", &module)
        .envs(env.iter().copied())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(CLI_TIMEOUT, command.status())
        .await
        .map_err(|_| {
            AppCommandError::task_execution_failed(
                "maxpool's config update did not finish in time.",
            )
        })?
        .map_err(AppCommandError::io)?;
    Ok(status.code())
}

pub(crate) async fn set_enabled(name: &str, enabled: bool) -> Result<PoolChange, AppCommandError> {
    let pool = Maxpool::locate()?;
    let name = existing_account(name).await?;
    let code = config_update(
        &pool,
        SET_ENABLED_SCRIPT,
        &[
            ("CODEG_MAXPOOL_ACCOUNT", name.as_str()),
            ("CODEG_MAXPOOL_ENABLED", if enabled { "1" } else { "0" }),
        ],
    )
    .await?;
    match code {
        Some(0) => {
            tracing::info!(
                "[usage-pool] switched a pool account {} from codeg",
                if enabled { "on" } else { "off" }
            );
            refresh_after_sync();
            Ok(PoolChange {
                applied: PoolApply::Live,
            })
        }
        Some(3) => Err(AppCommandError::dependency_missing(
            "This maxpool version can't be updated from codeg.",
        )),
        Some(4) => Err(AppCommandError::not_found(format!(
            "The pool's config has no account named \"{name}\"."
        ))),
        _ => Err(AppCommandError::task_execution_failed(
            "maxpool's config update failed.",
        )),
    }
}

/// Point the pool's routing at `name` (`routing.mode = "preferred"`), or back
/// to automatic balancing (`None`), the way maxpool's TUI does: the one
/// `routing` object in its config, which the running server applies on its
/// next re-read. maxpool prefers only an enabled Claude account; the script
/// refuses any other rather than leave a choice the server would drop.
const SET_PREFERRED_SCRIPT: &str = r#"
const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(process.env.CODEG_MAXPOOL_CONFIG_MODULE).href);
if (typeof mod.atomicConfigUpdate !== 'function') process.exit(3);
const name = process.env.CODEG_MAXPOOL_ACCOUNT || '';
class Refused extends Error {
  constructor(code) { super('refused'); this.code = code; }
}
try {
  await mod.atomicConfigUpdate((config) => {
    if (!name) {
      config.routing = { ...(config.routing || {}), mode: 'automatic', preferredAccount: null };
      return;
    }
    const account = (config.accounts || []).find((a) => a.name === name);
    if (!account) throw new Refused(4);
    if (account.enabled === false || account.type === 'provider') throw new Refused(5);
    config.routing = { ...(config.routing || {}), mode: 'preferred', preferredAccount: name };
  });
} catch (error) {
  process.exit(error instanceof Refused ? error.code : 1);
}
process.exit(0);
"#;

/// Make `name` the account the pool sends new requests to first, or (`None`)
/// go back to automatic balancing.
pub(crate) async fn set_preferred(name: Option<&str>) -> Result<PoolChange, AppCommandError> {
    let pool = Maxpool::locate()?;
    let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => {
            let reading = super::refresh(Duration::from_secs(5))
                .await
                .ok_or_else(no_pool)?;
            let account = reading
                .accounts
                .iter()
                .find(|a| a.name == name)
                .ok_or_else(|| {
                    AppCommandError::not_found(format!("The pool has no account named \"{name}\"."))
                })?;
            if account.provider {
                return Err(AppCommandError::invalid_input(
                    "The pool can only prefer a Claude subscription account.",
                ));
            }
            if !account.enabled {
                return Err(AppCommandError::invalid_input(format!(
                    "Switch \"{name}\" on before making it the preferred account."
                )));
            }
            Some(account.name.clone())
        }
        None => None,
    };
    let change = set_preferred_with(&pool, name.as_deref()).await?;
    tracing::info!(
        "[usage-pool] {} from codeg",
        if name.is_some() {
            "set the pool's preferred account"
        } else {
            "set the pool's routing to automatic"
        }
    );
    refresh_after_sync();
    Ok(change)
}

async fn set_preferred_with(
    pool: &Maxpool,
    name: Option<&str>,
) -> Result<PoolChange, AppCommandError> {
    let code = config_update(
        pool,
        SET_PREFERRED_SCRIPT,
        &[("CODEG_MAXPOOL_ACCOUNT", name.unwrap_or(""))],
    )
    .await?;
    match code {
        Some(0) => Ok(PoolChange {
            applied: PoolApply::Live,
        }),
        Some(3) => Err(AppCommandError::dependency_missing(
            "This maxpool version can't be updated from codeg.",
        )),
        Some(4) => Err(AppCommandError::not_found(format!(
            "The pool's config has no account named \"{}\".",
            name.unwrap_or_default()
        ))),
        Some(5) => Err(AppCommandError::invalid_input(
            "The pool can only prefer an enabled Claude subscription account.",
        )),
        _ => Err(AppCommandError::task_execution_failed(
            "maxpool's config update failed.",
        )),
    }
}

/// Re-read the pool now and again once its server has re-read its config, so
/// every client sees the change land.
fn refresh_after_sync() {
    tokio::spawn(async {
        let _ = super::refresh(Duration::ZERO).await;
        tokio::time::sleep(SYNC_DELAY).await;
        let _ = super::refresh(Duration::ZERO).await;
    });
}

// ─── Restarting the server ──────────────────────────────────────────────

/// The pool's listening port, from the status address codeg reads.
fn pool_port() -> Option<u16> {
    let super::Discovery::Found(config) = super::discover() else {
        return None;
    };
    url::Url::parse(&config.status_url).ok()?.port()
}

/// The pid listening on `port`, when it is a maxpool process.
async fn server_pid(port: u16) -> Option<u32> {
    let output = crate::process::tokio_command("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    let &[pid] = pids.as_slice() else {
        return None;
    };
    let command = crate::process::tokio_command("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&command.stdout)
        .contains("maxpool")
        .then_some(pid)
}

/// Whether something restarts `pid` when it exits: a launchd job, a systemd
/// unit, or the user said so.
async fn is_supervised(pid: u32) -> bool {
    if std::env::var(MAXPOOL_SUPERVISED_ENV)
        .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    {
        return true;
    }
    if cfg!(target_os = "macos") {
        let Ok(output) = crate::process::tokio_command("launchctl")
            .arg("list")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .await
        else {
            return false;
        };
        let pid = pid.to_string();
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.split_whitespace().next() == Some(pid.as_str()));
    }
    if cfg!(target_os = "linux") {
        return std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
            .is_ok_and(|cgroup| cgroup.contains(".service"));
    }
    false
}

#[cfg(unix)]
fn send_reload_signal(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: `kill` with a pid read from lsof and checked to be maxpool's,
    // and a signal number; no memory is shared.
    unsafe { libc::kill(pid, libc::SIGHUP) == 0 }
}

#[cfg(not(unix))]
fn send_reload_signal(_pid: u32) -> bool {
    false
}

fn in_flight(reading: &super::PlanUsagePool) -> u32 {
    reading.accounts.iter().map(|a| a.in_flight).sum()
}

/// Restart the server once nothing is in flight (or right away, `now`), and
/// wait for it to answer again. The new reading reaches every client.
async fn restart_when_idle(port: u16, now: bool) -> ReloadState {
    let _one = RELOAD_TASK.lock().await;
    let Some(pid) = server_pid(port).await else {
        return ReloadState::NeedsRestart;
    };
    if !is_supervised(pid).await {
        return ReloadState::NeedsRestart;
    }
    if !now {
        let deadline = Instant::now() + IDLE_WAIT;
        loop {
            let busy = super::refresh(Duration::ZERO)
                .await
                .map_or(0, |reading| in_flight(&reading));
            if busy == 0 {
                break;
            }
            if Instant::now() >= deadline {
                tracing::info!("[usage-pool] the pool stayed busy; its restart is waiting");
                return ReloadState::Waiting;
            }
            tokio::time::sleep(IDLE_POLL).await;
        }
    }
    if !send_reload_signal(pid) {
        return ReloadState::NeedsRestart;
    }
    tracing::info!("[usage-pool] asked the pool's server to restart and apply an account change");
    let deadline = Instant::now() + RESTART_WAIT;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if server_pid(port).await.is_some_and(|next| next != pid) {
            let _ = super::refresh(Duration::ZERO).await;
            return ReloadState::Idle;
        }
        if Instant::now() >= deadline {
            return ReloadState::NeedsRestart;
        }
    }
}

/// Apply a change only a restart applies: in the background, once idle.
async fn schedule_restart(_pool: Maxpool) -> PoolApply {
    let Some(port) = pool_port() else {
        set_reload(ReloadState::NeedsRestart);
        return PoolApply::NeedsRestart;
    };
    let Some(pid) = server_pid(port).await else {
        set_reload(ReloadState::NeedsRestart);
        return PoolApply::NeedsRestart;
    };
    if !is_supervised(pid).await {
        set_reload(ReloadState::NeedsRestart);
        let _ = super::refresh(Duration::ZERO).await;
        return PoolApply::NeedsRestart;
    }
    set_reload(ReloadState::Waiting);
    tokio::spawn(async move {
        let state = restart_when_idle(port, false).await;
        set_reload(state);
        let _ = super::refresh(Duration::ZERO).await;
    });
    PoolApply::Restarting
}

/// "Restart now": apply a waiting change without waiting for idle.
pub(crate) async fn restart_now() -> Result<PoolManageInfo, AppCommandError> {
    Maxpool::locate()?;
    let port = pool_port().ok_or_else(no_pool)?;
    let state = restart_when_idle(port, true).await;
    set_reload(state);
    let _ = super::refresh(Duration::ZERO).await;
    Ok(manage_info())
}

// ─── Desktop commands (the web handlers call the functions above) ──────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_manage_info() -> Result<PoolManageInfo, AppCommandError> {
    Ok(manage_info())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_login_start(
    name: Option<String>,
    reconnect: Option<String>,
) -> Result<PoolLoginStart, AppCommandError> {
    login_start(name, reconnect).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_login_finish(
    handle: String,
    pasted: String,
) -> Result<LoginOutcome, AppCommandError> {
    Ok(login_finish(&handle, &pasted).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_login_state(handle: String) -> Result<LoginState, AppCommandError> {
    Ok(login_state(&handle).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_login_cancel(handle: String) -> Result<(), AppCommandError> {
    login_cancel(&handle).await;
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_rename(
    name: String,
    new_name: String,
) -> Result<PoolChange, AppCommandError> {
    rename(&name, &new_name).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_set_enabled(
    name: String,
    enabled: bool,
) -> Result<PoolChange, AppCommandError> {
    set_enabled(&name, enabled).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_set_preferred(name: Option<String>) -> Result<PoolChange, AppCommandError> {
    set_preferred(name.as_deref()).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_remove(name: String) -> Result<PoolChange, AppCommandError> {
    remove(&name).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn usage_pool_restart_now() -> Result<PoolManageInfo, AppCommandError> {
    restart_now().await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn new_names_must_read_as_one_value() {
        assert_eq!(valid_new_name("  work  ").unwrap(), "work");
        assert_eq!(valid_new_name("me@example.com").unwrap(), "me@example.com");
        assert!(valid_new_name("").is_err());
        assert!(valid_new_name("--api").is_err());
        assert!(valid_new_name("12").is_err());
        assert!(valid_new_name("a\nb").is_err());
        assert!(valid_new_name(&"x".repeat(NAME_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn login_verdicts_read_maxpools_own_lines() {
        assert_eq!(
            login_verdict("Exchanging…\nAdded account \"x\"\nSaved to /p"),
            Some(Ok(()))
        );
        assert_eq!(login_verdict("Updated account \"x\""), Some(Ok(())));
        assert_eq!(
            login_verdict("OAuth login failed: Token exchange failed (400)"),
            Some(Err(LoginFailure::Rejected))
        );
        assert_eq!(
            login_verdict("OAuth login failed: OAuth state mismatch"),
            Some(Err(LoginFailure::InvalidCode))
        );
        assert_eq!(
            login_verdict("Exchanging authorization code for tokens..."),
            None
        );
    }

    #[test]
    fn the_browser_shim_shadows_open() {
        let shim = browser_shim().unwrap();
        let path = path_with(shim.path());
        assert!(path.starts_with(shim.path().to_str().unwrap()));
        let found = which::which_in("open", Some(&path), "/").unwrap();
        assert_eq!(found, shim.path().join("open"));
    }

    /// Mimics `maxpool login --oauth --name x`: its link, the paste prompt it
    /// shows on a terminal, the callback address or bare code it accepts,
    /// and the lines it prints when the exchange works or fails.
    const FAKE_MAXPOOL: &str = r#"[ "$1 $2" = "login --oauth" ] || exit 9
[ -n "$MAXPOOL_CONFIG" ] || exit 8
case "$(command -v open)" in */codeg-noopen-*) ;; *) exit 7 ;; esac
echo 'Starting OAuth login...'
echo "If it doesn't open, visit:"
echo '  https://claude.test/oauth/authorize?code=true&state=st'
echo
printf 'Paste authorization code here (q or Ctrl+C to cancel): '
read answer
echo 'Exchanging authorization code for tokens...'
case "$answer" in
  *code=good*|good) echo "Added account \"$4\""; echo "Saved to $MAXPOOL_CONFIG"; exit 0 ;;
  *) echo 'OAuth login failed: Token exchange failed (400): {}' >&2; exit 1 ;;
esac"#;

    static SERIAL: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

    fn fake_pool(dir: &Path) -> Maxpool {
        Maxpool {
            bin: crate::pty_flow::tests::script(dir, "maxpool", FAKE_MAXPOOL),
            config: dir.join("maxpool.json"),
        }
    }

    #[tokio::test]
    async fn adding_an_account_takes_the_pasted_callback_address() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let start = login_start_with(&fake_pool(dir.path()), Some("work".into()))
            .await
            .unwrap();
        assert_eq!(
            start.url,
            "https://claude.test/oauth/authorize?code=true&state=st"
        );
        assert_eq!(login_state(&start.handle).await, LoginState::Waiting);
        // A quit word would cancel maxpool's prompt: refused, still waiting.
        let outcome = login_finish(&start.handle, "q").await;
        assert_eq!(outcome.reason, Some(LoginFailure::InvalidCode));
        assert!(outcome.retry);
        let outcome = login_finish(
            &start.handle,
            "http://localhost:4242/callback?code=good&state=st",
        )
        .await;
        assert!(outcome.ok, "{outcome:?}");
    }

    #[tokio::test]
    async fn a_refused_code_fails_the_sign_in() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let start = login_start_with(&fake_pool(dir.path()), None)
            .await
            .unwrap();
        let outcome = login_finish(&start.handle, "bad-code").await;
        assert!(!outcome.ok);
        assert_eq!(outcome.reason, Some(LoginFailure::Rejected));
        assert_eq!(
            login_finish(&start.handle, "good").await.reason,
            Some(LoginFailure::Expired)
        );
    }

    #[tokio::test]
    async fn a_sign_in_can_be_cancelled() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let start = login_start_with(&fake_pool(dir.path()), None)
            .await
            .unwrap();
        login_cancel(&start.handle).await;
        assert_eq!(login_state(&start.handle).await, LoginState::Expired);
    }

    #[tokio::test]
    async fn a_cli_that_shows_no_link_is_an_error() {
        let _serial = SERIAL.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let pool = Maxpool {
            bin: crate::pty_flow::tests::script(
                dir.path(),
                "maxpool",
                "echo 'Unknown command: login'; exit 1",
            ),
            config: dir.path().join("maxpool.json"),
        };
        assert!(login_start_with(&pool, None).await.is_err());
    }

    /// A config module with maxpool's `atomicConfigUpdate` contract: load the
    /// JSON at `MAXPOOL_CONFIG`, hand it to the updater, write it back with
    /// the generation bumped — and write nothing when the updater throws.
    const FAKE_CONFIG_MODULE: &str = r#"
import { readFileSync, writeFileSync } from 'node:fs';
export async function atomicConfigUpdate(updater) {
  const path = process.env.MAXPOOL_CONFIG;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const result = await updater(config);
  config._generation = (Number(config._generation) || 0) + 1;
  writeFileSync(path, JSON.stringify(config, null, 2));
  return result === undefined ? config : result;
}
"#;

    /// A maxpool install whose `config.js` is the fake module above, and its
    /// config with `alpha` (on), `beta` (switched off) and a GLM provider.
    fn fake_config_pool(dir: &Path) -> Option<Maxpool> {
        crate::commands::acp::resolve_command_on_path("node")?;
        let src = dir.join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("index.js"), "").unwrap();
        std::fs::write(src.join("config.js"), FAKE_CONFIG_MODULE).unwrap();
        std::fs::write(src.join("package.json"), r#"{"type":"module"}"#).unwrap();
        let config = dir.join("maxpool.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "proxy": { "port": 3466, "apiKey": "not-a-real-key" },
                "routing": { "mode": "automatic", "preferredAccount": null },
                "accounts": [
                    { "name": "alpha", "type": "oauth", "refreshToken": "fake-r1" },
                    { "name": "beta", "type": "oauth", "enabled": false, "refreshToken": "fake-r2" },
                    { "name": "glm", "type": "provider" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        Some(Maxpool {
            bin: src.join("index.js"),
            config,
        })
    }

    fn routing_of(pool: &Maxpool) -> (serde_json::Value, serde_json::Value) {
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pool.config).unwrap()).unwrap();
        // Every account's credentials stay as they were.
        assert_eq!(config["accounts"][0]["refreshToken"], "fake-r1");
        assert_eq!(config["accounts"][1]["refreshToken"], "fake-r2");
        (
            config["routing"]["mode"].clone(),
            config["routing"]["preferredAccount"].clone(),
        )
    }

    #[tokio::test]
    async fn preferring_an_account_writes_maxpools_routing() {
        let dir = tempfile::tempdir().unwrap();
        let Some(pool) = fake_config_pool(dir.path()) else {
            eprintln!("node isn't on PATH; skipping");
            return;
        };
        let change = set_preferred_with(&pool, Some("alpha")).await.unwrap();
        assert_eq!(change.applied, PoolApply::Live);
        assert_eq!(routing_of(&pool), ("preferred".into(), "alpha".into()));

        // Back to automatic balancing.
        set_preferred_with(&pool, None).await.unwrap();
        assert_eq!(
            routing_of(&pool),
            ("automatic".into(), serde_json::Value::Null)
        );
    }

    #[tokio::test]
    async fn only_an_enabled_claude_account_can_be_preferred() {
        let dir = tempfile::tempdir().unwrap();
        let Some(pool) = fake_config_pool(dir.path()) else {
            eprintln!("node isn't on PATH; skipping");
            return;
        };
        for name in ["beta", "glm", "nobody"] {
            assert!(
                set_preferred_with(&pool, Some(name)).await.is_err(),
                "{name}"
            );
        }
        // Nothing was written for a refused choice.
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pool.config).unwrap()).unwrap();
        assert!(config.get("_generation").is_none());
        assert_eq!(
            routing_of(&pool),
            ("automatic".into(), serde_json::Value::Null)
        );
    }

    /// The live pickup against a REAL maxpool server with its own config and
    /// port: after the routing change its next config re-read reports the new
    /// preferred account as the one serving. Opt-in: point
    /// `CODEG_TEST_MAXPOOL_SRC` at a maxpool `src/` directory.
    #[tokio::test]
    async fn a_running_maxpool_picks_the_preferred_account_up_live() {
        let Some(src) = std::env::var_os("CODEG_TEST_MAXPOOL_SRC").map(PathBuf::from) else {
            return;
        };
        let Some(node) = crate::commands::acp::resolve_command_on_path("node") else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let far = (chrono::Utc::now().timestamp() + 365 * 86_400) * 1000;
        let account = |name: &str| {
            serde_json::json!({
                "name": name, "type": "oauth", "source": "login",
                "accountUuid": uuid::Uuid::new_v4().to_string(),
                "accessToken": format!("fake-a-{name}"),
                "refreshToken": format!("fake-r-{name}"),
                "expiresAt": far
            })
        };
        let config = dir.path().join("maxpool.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "proxy": { "port": port, "host": "127.0.0.1", "apiKey": "mp-test-key-not-secret" },
                "upstream": "http://127.0.0.1:9",
                "preventSleep": false, "updateCheck": false, "autoUpdate": false,
                "quotaProbeSeconds": 0,
                "sync": { "accountsIntervalMs": 1000 },
                "routing": { "mode": "preferred", "preferredAccount": "primary" },
                "accounts": [account("primary"), account("backup")]
            })
            .to_string(),
        )
        .unwrap();
        let mut server = crate::process::tokio_command(&node)
            .arg(src.join("index.js"))
            .arg("server")
            .env("MAXPOOL_CONFIG", &config)
            .env("MAXPOOL_DISABLE_QUOTA_PROBE", "1")
            .env("MAXPOOL_DISABLE_SLEEP_GUARD", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let client = reqwest::Client::new();
        let status = || async {
            let response = client
                .get(format!("http://127.0.0.1:{port}/maxpool/status"))
                .header("x-api-key", "mp-test-key-not-secret")
                .send()
                .await
                .ok()?;
            response.json::<serde_json::Value>().await.ok()
        };
        let wait_for = |want: &'static str| async move {
            for _ in 0..60 {
                if let Some(value) = status().await {
                    if value["routing"]["preferredAccount"] == want {
                        return Some(value);
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            None
        };
        assert!(wait_for("primary").await.is_some(), "the test pool came up");

        let pool = Maxpool {
            bin: src.join("index.js"),
            config: config.clone(),
        };
        set_preferred_with(&pool, Some("backup")).await.unwrap();
        let value = wait_for("backup")
            .await
            .expect("picked up without a restart");
        assert_eq!(value["routing"]["mode"], "preferred");
        // New requests route to it from here: the pool serves from it now.
        assert_eq!(value["currentAccount"], "backup");
        let _ = server.kill().await;
    }

    #[test]
    fn the_config_module_sits_next_to_the_entry_point() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir(&src).unwrap();
        std::fs::write(src.join("index.js"), "").unwrap();
        std::fs::write(src.join("config.js"), "").unwrap();
        let link = dir.path().join("maxpool");
        std::os::unix::fs::symlink(src.join("index.js"), &link).unwrap();
        assert_eq!(
            config_module(&link).unwrap(),
            std::fs::canonicalize(src.join("config.js")).unwrap()
        );
        std::fs::remove_file(src.join("config.js")).unwrap();
        assert!(config_module(&link).is_none());
    }
}
