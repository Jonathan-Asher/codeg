//! Settings → Agents → Claude Code: the CLI's sign-in, and signing it in or
//! out from codeg — including from a browser on another device, which is the
//! normal case when codeg runs on a remote host. See
//! [`crate::acp::claude_auth`] for how, and for what never leaves the host.

use std::path::Path;

#[cfg(feature = "tauri-runtime")]
use tauri::{Manager, State};

use crate::acp::claude_auth::{
    self, ClaudeAuthStatus, ClaudeCli, ClaudeLoginStart, LoginOutcome, LoginState,
};
use crate::acp::error::AcpError;
use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;

/// The CLI with the environment a Claude Code session launches with. Claude
/// Code switched off in settings still has a sign-in, so that case falls back
/// to the stored settings alone.
async fn claude_cli(db: &AppDatabase, data_dir: &Path) -> Result<ClaudeCli, AcpError> {
    let runtime_env = match crate::commands::acp::build_session_runtime_env(
        db,
        AgentType::ClaudeCode,
        None,
        data_dir,
    )
    .await
    {
        Ok(env) => env,
        Err(_) => {
            let setting = agent_setting_service::get_by_agent_type(&db.conn, AgentType::ClaudeCode)
                .await
                .ok()
                .flatten();
            let local = crate::commands::acp::load_agent_local_config_json(AgentType::ClaudeCode);
            crate::commands::acp::build_runtime_env_from_setting(
                AgentType::ClaudeCode,
                setting.as_ref(),
                local.as_deref(),
            )
        }
    };
    ClaudeCli::for_runtime_env(&runtime_env).await
}

/// Whether the CLI is signed in, how, and as whom.
pub(crate) async fn claude_auth_status_core(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<ClaudeAuthStatus, AcpError> {
    let cli = claude_cli(db, data_dir).await?;
    claude_auth::read_status(&cli)
        .await
        .map_err(AcpError::protocol)
}

/// Start `claude auth login` on the host and return the link to open.
pub(crate) async fn claude_auth_login_start_core(
    db: &AppDatabase,
    data_dir: &Path,
    console: bool,
) -> Result<ClaudeLoginStart, AcpError> {
    let cli = claude_cli(db, data_dir).await?;
    claude_auth::login_start(&cli, console).await
}

/// Type the code the consent page showed into the pending sign-in.
pub(crate) async fn claude_auth_login_finish_core(handle: String, code: String) -> LoginOutcome {
    claude_auth::login_finish(handle.trim(), &code).await
}

/// Where a pending sign-in stands.
pub(crate) async fn claude_auth_login_state_core(handle: String) -> LoginState {
    claude_auth::login_state(handle.trim()).await
}

/// Abandon a pending sign-in.
pub(crate) async fn claude_auth_login_cancel_core(handle: String) {
    claude_auth::login_cancel(handle.trim()).await;
}

/// Sign the CLI out.
pub(crate) async fn claude_auth_logout_core(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<(), AcpError> {
    let cli = claude_cli(db, data_dir).await?;
    claude_auth::logout(&cli).await
}

#[cfg(feature = "tauri-runtime")]
fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AcpError> {
    app.path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|e| AcpError::protocol(e.to_string()))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn claude_auth_status(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<ClaudeAuthStatus, AcpError> {
    claude_auth_status_core(&db, &app_data_dir(&app)?).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn claude_auth_login_start(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    console: Option<bool>,
) -> Result<ClaudeLoginStart, AcpError> {
    claude_auth_login_start_core(&db, &app_data_dir(&app)?, console.unwrap_or(false)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn claude_auth_login_finish(
    handle: String,
    code: String,
) -> Result<LoginOutcome, AcpError> {
    Ok(claude_auth_login_finish_core(handle, code).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn claude_auth_login_state(handle: String) -> Result<LoginState, AcpError> {
    Ok(claude_auth_login_state_core(handle).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn claude_auth_login_cancel(handle: String) -> Result<(), AcpError> {
    claude_auth_login_cancel_core(handle).await;
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn claude_auth_logout(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<(), AcpError> {
    claude_auth_logout_core(&db, &app_data_dir(&app)?).await
}
