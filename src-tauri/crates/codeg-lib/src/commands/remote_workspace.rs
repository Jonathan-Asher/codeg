#[cfg(feature = "tauri-runtime")]
use reqwest::StatusCode;
#[cfg(feature = "tauri-runtime")]
use serde::Deserialize;
#[cfg(feature = "tauri-runtime")]
use std::time::Duration;
#[cfg(feature = "tauri-runtime")]
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(feature = "tauri-runtime")]
use crate::app_error::AppCommandError;
#[cfg(feature = "tauri-runtime")]
use crate::commands::workspace_windows::WorkspaceWindow;
#[cfg(feature = "tauri-runtime")]
use crate::db::service::remote_workspace_connection_service;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
#[cfg(feature = "tauri-runtime")]
use crate::instance_identity::InstanceIdentity;
#[cfg(feature = "tauri-runtime")]
use crate::models::{RemoteWorkspaceConnectionInfo, RemoteWorkspaceHeader, ToHeaderMap};

#[cfg(feature = "tauri-runtime")]
const REMOTE_HEALTH_TIMEOUT: Duration = Duration::from_secs(8);

/// How long a deep link waits for a saved connection's server to say who it
/// is ([`relearn_remote_identities`]): a link to a server that is asleep must
/// not hold the click for the full health check.
#[cfg(feature = "tauri-runtime")]
const IDENTITY_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Label prefix of the window that hosts a saved connection's workspace —
/// `remote-workspace-{id}`, one per connection. Defined with the other
/// workspace window labels; re-exported for the callers that reach it here.
#[cfg(feature = "tauri-runtime")]
pub(crate) use crate::commands::workspace_windows::REMOTE_WORKSPACE_LABEL_PREFIX;

#[cfg(feature = "tauri-runtime")]
pub(crate) fn new_remote_window_instance_id() -> String {
    format!("rw-{}", uuid::Uuid::new_v4().simple())
}

#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceConnectionInput {
    pub name: String,
    #[serde(alias = "baseUrl")]
    pub base_url: String,
    pub token: String,
    #[serde(default)]
    pub headers: Vec<RemoteWorkspaceHeader>,
}

/// The check a connection has to pass before it is saved or tested, and before
/// the "Open remote workspace" menus open its window. The launch reopening the
/// windows that were open at the last quit (`workspace_windows`) skips it on
/// purpose: a server that is offline at launch comes back through the window's
/// own transport instead of costing the window its place in the session.
///
/// Returns who the server says it is, which the callers that have a saved
/// connection keep beside it (`instance_identity`): what a `codeg://` link's
/// `server=` is matched against. `None` from a server that does not say.
#[cfg(feature = "tauri-runtime")]
pub(crate) async fn validate_remote_health(
    base_url: &str,
    token: &str,
    headers: &[RemoteWorkspaceHeader],
) -> Result<Option<InstanceIdentity>, AppCommandError> {
    remote_health(base_url, token, headers, REMOTE_HEALTH_TIMEOUT).await
}

#[cfg(feature = "tauri-runtime")]
async fn remote_health(
    base_url: &str,
    token: &str,
    headers: &[RemoteWorkspaceHeader],
    timeout: Duration,
) -> Result<Option<InstanceIdentity>, AppCommandError> {
    let normalized = remote_workspace_connection_service::normalize_base_url(base_url)?;
    let url = format!("{normalized}/api/health");
    let client = reqwest::Client::builder()
        .timeout(timeout)
        // The health check is the first request to carry the connection's
        // custom headers, and the one the user runs to prove the setup works.
        // It gets the same host pinning as every later request, or "test
        // succeeded" would mean something weaker than "save succeeded".
        .redirect(crate::commands::remote_proxy::connection_redirect_policy())
        .build()
        .map_err(|e| {
            AppCommandError::configuration_invalid("Failed to create remote health client")
                .with_detail(e.to_string())
        })?;
    let headers = remote_workspace_connection_service::validate_headers(headers)?;
    let response = client
        .post(url)
        .bearer_auth(token.trim())
        .headers(headers.to_header_map())
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Unable to connect to remote workspace")
                .with_detail(crate::commands::remote_proxy::request_error_detail(&e))
        })?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }

    if !response.status().is_success() {
        return Err(
            AppCommandError::network("Remote Workspace health check failed")
                .with_detail(format!("HTTP {}", response.status())),
        );
    }

    // The answer is JSON from every server that has one to give; a body that
    // is not (an older server, a proxy's page) only means it did not say.
    let body: Option<serde_json::Value> = response.json().await.ok();
    Ok(body
        .as_ref()
        .and_then(crate::instance_identity::identity_from_health))
}

/// Keep who connection `connection_id`'s server said it is. Failing to is not
/// worth failing the save or the open over: a link to it is matched by name
/// and host meanwhile, and the next check tries again.
#[cfg(feature = "tauri-runtime")]
async fn remember_identity(
    db: &AppDatabase,
    connection_id: i32,
    identity: Option<&InstanceIdentity>,
) {
    if let Err(err) =
        crate::instance_identity::remember_remote_identity(&db.conn, connection_id, identity).await
    {
        tracing::warn!("[remote-workspace] cannot keep the identity of {connection_id}: {err}");
    }
}

/// Ask every saved connection's server who it is, at once and briefly, and
/// keep the answers. For a `codeg://` link whose `server` matched none of them:
/// a connection saved before servers said who they are, or one whose server's
/// identity changed since. A server that does not answer keeps what it said
/// last.
#[cfg(feature = "tauri-runtime")]
pub(crate) async fn relearn_remote_identities(conn: &sea_orm::DatabaseConnection) {
    let connections = match remote_workspace_connection_service::list(conn).await {
        Ok(connections) => connections,
        Err(err) => {
            tracing::warn!("[remote-workspace] cannot list the saved connections: {err}");
            return;
        }
    };
    let answers = futures_util::future::join_all(connections.iter().map(|connection| async move {
        let answer = remote_health(
            &connection.base_url,
            &connection.token,
            &connection.headers,
            IDENTITY_PROBE_TIMEOUT,
        )
        .await;
        (connection.id, answer)
    }))
    .await;
    for (connection_id, answer) in answers {
        match answer {
            Ok(identity) => {
                if let Err(err) = crate::instance_identity::remember_remote_identity(
                    conn,
                    connection_id,
                    identity.as_ref(),
                )
                .await
                {
                    tracing::warn!(
                        "[remote-workspace] cannot keep the identity of {connection_id}: {err}"
                    );
                }
            }
            Err(err) => tracing::info!(
                "[remote-workspace] {connection_id} did not say who it is: {}",
                err.message
            ),
        }
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_remote_workspace_connections(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<RemoteWorkspaceConnectionInfo>, AppCommandError> {
    remote_workspace_connection_service::list(&db.conn)
        .await
        .map_err(AppCommandError::db)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_remote_workspace_connection(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    remote_workspace_connection_service::get(&db.conn, id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Remote connection {id} not found")))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn test_remote_workspace_connection(
    input: RemoteWorkspaceConnectionInput,
) -> Result<(), AppCommandError> {
    validate_remote_health(&input.base_url, &input.token, &input.headers)
        .await
        .map(|_| ())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_remote_workspace_connection(
    db: tauri::State<'_, AppDatabase>,
    input: RemoteWorkspaceConnectionInput,
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    let identity = validate_remote_health(&input.base_url, &input.token, &input.headers).await?;
    let created = remote_workspace_connection_service::create(
        &db.conn,
        &input.name,
        &input.base_url,
        &input.token,
        &input.headers,
    )
    .await?;
    remember_identity(&db, created.id, identity.as_ref()).await;
    Ok(created)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_remote_workspace_connection(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    input: RemoteWorkspaceConnectionInput,
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    let identity = validate_remote_health(&input.base_url, &input.token, &input.headers).await?;
    let before = remote_workspace_connection_service::get(&db.conn, id)
        .await
        .map_err(AppCommandError::db)?;
    let updated = remote_workspace_connection_service::update(
        &db.conn,
        id,
        &input.name,
        &input.base_url,
        &input.token,
        &input.headers,
    )
    .await?;
    remember_identity(&db, id, identity.as_ref()).await;
    // The built-in browser's tunnel follows the connection to where it now
    // points, rather than staying on the old address until it drops. A
    // rename leaves it be: closing it would cut every live stream of the
    // connection's tabs (a dev server's reload socket among them).
    let moved = before.is_none_or(|before| {
        before.base_url != updated.base_url
            || before.token != updated.token
            || before.headers != updated.headers
    });
    if moved {
        crate::browser::remote::connection_changed(&app, id).await;
    }
    Ok(updated)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_remote_workspace_connection(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    remote_workspace_connection_service::delete(&db.conn, id)
        .await
        .map_err(AppCommandError::db)?;
    remember_identity(&db, id, None).await;
    // What the remote host's pages stored in the built-in browser goes with
    // the connection they were opened through.
    crate::browser::remote::forget_connection(&app, id).await;
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn reorder_remote_workspace_connections(
    db: tauri::State<'_, AppDatabase>,
    ids: Vec<i32>,
) -> Result<(), AppCommandError> {
    remote_workspace_connection_service::reorder(&db.conn, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_remote_workspace(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    let connection = remote_workspace_connection_service::get(&db.conn, id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Remote connection {id} not found")))?;

    // The pre-flight of a user-initiated open: a server that does not answer,
    // or rejects the token, gets an error where the user clicked instead of a
    // window that cannot load. A window that is already open is only brought
    // forward, so it needs none.
    let label = WorkspaceWindow::Remote { connection_id: id }.label();
    if app.get_webview_window(&label).is_some() {
        crate::commands::windows::show_and_focus_window(&app, &label);
        return Ok(());
    }

    let identity =
        validate_remote_health(&connection.base_url, &connection.token, &connection.headers)
            .await?;
    remember_identity(&db, id, identity.as_ref()).await;

    // An overlapping open / restore may have built it during the health check.
    if app.get_webview_window(&label).is_some() {
        crate::commands::windows::show_and_focus_window(&app, &label);
        return Ok(());
    }
    build_remote_workspace_window(&app, &connection, true)
}

/// Bring the connection's workspace window forward, building it if it is not
/// open. No health check: `open_remote_workspace` runs one first, and the other
/// callers (a launch into the startup workspace, a notification click, Quick
/// Ask) have nowhere to show that error — waiting out the check would hold
/// them for up to `REMOTE_HEALTH_TIMEOUT` only to open nothing. The window
/// reports an unreachable server itself.
#[cfg(feature = "tauri-runtime")]
pub(crate) fn show_remote_workspace_window(
    app: &AppHandle,
    connection: &RemoteWorkspaceConnectionInfo,
) -> Result<(), AppCommandError> {
    let label = WorkspaceWindow::Remote {
        connection_id: connection.id,
    }
    .label();
    if app.get_webview_window(&label).is_some() {
        crate::commands::windows::show_and_focus_window(app, &label);
        return Ok(());
    }
    build_remote_workspace_window(app, connection, true)
}

/// Build a workspace for a saved connection. Manual opens validate health;
/// startup restoration also opens offline connections and lets the transport
/// recover. Restored windows stay in the background until the session is back.
#[cfg(feature = "tauri-runtime")]
pub(crate) fn build_remote_workspace_window(
    app: &AppHandle,
    connection: &RemoteWorkspaceConnectionInfo,
    focus: bool,
) -> Result<(), AppCommandError> {
    let id = connection.id;
    let window = WorkspaceWindow::Remote { connection_id: id };
    let label = window.label();
    let window_instance_id = new_remote_window_instance_id();
    let url = WebviewUrl::App(
        format!("workspace?remoteConnectionId={id}&remoteWindowId={window_instance_id}").into(),
    );
    let builder = WebviewWindowBuilder::new(app, &label, url)
        .title(format!("Codeg - {}", connection.name))
        .inner_size(1260.0, 860.0)
        .min_inner_size(400.0, 600.0)
        .focused(focus)
        .center();
    let builder = crate::commands::windows::apply_platform_window_style(builder);
    // Remote workspace windows load the same `/workspace` route with the taller
    // h-10 title bar, so they get the workspace traffic-light position (not the
    // shorter auxiliary-window default).
    #[cfg(target_os = "macos")]
    let builder = builder.traffic_light_position(
        crate::commands::windows::workspace_window_traffic_light_position(),
    );
    let built = builder
        .build()
        .map_err(|e| AppCommandError::window("Failed to open remote workspace", e.to_string()))?;
    if let Some(proxy) =
        app.try_state::<std::sync::Arc<crate::commands::remote_proxy::RemoteProxyState>>()
    {
        proxy
            .inner()
            .register_window_instance_cleanup(&built, window_instance_id);
    }
    crate::commands::windows::post_window_setup(&built);
    if focus {
        crate::commands::workspace_windows::note_shown(app, &label);
    } else {
        crate::commands::workspace_windows::note_opened(app, window);
    }
    Ok(())
}
