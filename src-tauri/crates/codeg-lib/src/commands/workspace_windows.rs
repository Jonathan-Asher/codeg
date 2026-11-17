//! Reopening the workspace windows that were open when codeg last quit.
//!
//! A workspace window is the local `main` window or a remote workspace window
//! (`remote-workspace-{id}`, at most one per saved remote connection). The
//! window-state plugin puts each of them back where it was, but only once
//! something builds it again — and at launch the only thing that did was the
//! setup hook building `main`. Every launch therefore came back to the local
//! workspace alone, however many remote workspaces had been open.
//!
//! So this module keeps the list of open workspace windows, least recently
//! focused first, writes it to `app_metadata` whenever a window joins or leaves
//! it and once more at quit, and replays it at the next launch:
//!
//!   * `main` is always built — the tray, the dock, deep links and the close
//!     prompt all hang off it — but it starts hidden when it had been closed
//!     (hidden to the tray) at quit and something else is coming back instead.
//!   * Remote windows reopen even while their server is offline. Their
//!     transport reconnects in the background; network availability must not
//!     erase the window session. The remembered front window is raised last.
//!   * A remote workspace that cannot be reopened brings `main` up with a toast
//!     saying why ([`take_workspace_restore_failures`]), rather than leaving a
//!     window silently missing — or no window at all.
//!
//! "Open" means "not closed by the user": a minimized window is open, and so
//! is every window of an app hidden with ⌘H, while `main` hidden to the tray is
//! closed. `is_visible()` cannot tell those apart (it is false for all three),
//! which is why the list is kept from the hide / show / focus / destroy events
//! as they happen instead of being read back from the windows at quit.
//!
//! Two launch rules sit on top of that list. Someone who always works on
//! another machine can have a launch lead with a remote workspace (Settings ›
//! System, "When codeg starts, open"): it comes back in front of whatever else
//! does, with `main` built hidden behind it ([`Restore::lead_with_remote`]).
//! And a windowless launch (`crate::windowless`) builds no window at all and
//! reopens nothing; the Dock or the menu bar icon builds `main` when asked
//! ([`plan_startup`], [`activate_workspace`]).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::app_error::AppCommandError;
use crate::commands::windows;
use crate::db::service::{app_metadata_service, remote_workspace_connection_service};
use crate::db::AppDatabase;
use crate::models::RemoteWorkspaceConnectionInfo;

/// Where the list is kept in `app_metadata`.
const SESSION_KEY: &str = "workspace_windows_session";

/// Format of the stored list. Nothing reads it yet: it is there for a later
/// format to recognise this one by.
const SESSION_VERSION: u32 = 1;

/// Label of the local workspace window.
pub const LOCAL_WORKSPACE_LABEL: &str = "main";

/// Label prefix of the remote workspace windows; the connection id follows.
pub const REMOTE_WORKSPACE_LABEL_PREFIX: &str = "remote-workspace-";

/// Sent to `main` once a remote workspace that could not be reopened has been
/// parked for it. Carries nothing: the failures are taken with
/// [`take_workspace_restore_failures`], so one sent before the webview was
/// listening loses nothing. Mirrored by `WORKSPACE_RESTORE_FAILED_EVENT` in
/// `src/lib/workspace-restore.ts`.
pub const RESTORE_FAILED_EVENT: &str = "workspace://restore-failed";

/// A workspace window, as the stored list names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceWindow {
    /// `main`.
    Local,
    /// The window of one saved remote connection.
    Remote { connection_id: i32 },
}

impl WorkspaceWindow {
    /// The workspace window `label` names, if it names one.
    pub fn from_label(label: &str) -> Option<Self> {
        if label == LOCAL_WORKSPACE_LABEL {
            return Some(Self::Local);
        }
        let id = label.strip_prefix(REMOTE_WORKSPACE_LABEL_PREFIX)?;
        let connection_id: i32 = id.parse().ok()?;
        // Only the spelling `label()` produces: `+3` and `03` parse, but no
        // window of this app is called that.
        (connection_id.to_string() == id).then_some(Self::Remote { connection_id })
    }

    pub fn label(self) -> String {
        match self {
            Self::Local => LOCAL_WORKSPACE_LABEL.to_string(),
            Self::Remote { connection_id } => {
                format!("{REMOTE_WORKSPACE_LABEL_PREFIX}{connection_id}")
            }
        }
    }
}

/// A remote workspace that was open at the last quit and did not come back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestoreFailure {
    pub connection_id: i32,
    pub name: String,
    pub error: AppCommandError,
}

#[derive(Serialize)]
struct StoredSession<'a> {
    version: u32,
    windows: &'a [WorkspaceWindow],
}

fn encode_session(windows: &[WorkspaceWindow]) -> Option<String> {
    serde_json::to_string(&StoredSession {
        version: SESSION_VERSION,
        windows,
    })
    .ok()
}

/// The stored list, least recently focused first. Entries this build does not
/// recognise are skipped one by one rather than costing the whole list, and a
/// window listed twice keeps its later place.
fn decode_session(raw: &str) -> Vec<WorkspaceWindow> {
    #[derive(Deserialize)]
    struct Stored {
        #[serde(default)]
        windows: Vec<serde_json::Value>,
    }

    let stored: Stored = match serde_json::from_str(raw) {
        Ok(stored) => stored,
        Err(err) => {
            tracing::warn!("[workspace-windows] ignoring unreadable window list: {err}");
            return Vec::new();
        }
    };
    let mut windows: Vec<WorkspaceWindow> = Vec::new();
    for value in stored.windows {
        if let Ok(window) = serde_json::from_value::<WorkspaceWindow>(value) {
            windows.retain(|w| *w != window);
            windows.push(window);
        }
    }
    windows
}

/// What a launch reopens.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RestorePlan {
    /// Whether `main` is shown. It is built either way.
    show_local: bool,
    /// Remote connections to reopen, least recently focused first.
    remotes: Vec<i32>,
    /// The window to leave in front once everything is back.
    front: WorkspaceWindow,
}

/// `remembered` is the stored list; `connection_exists` weeds out the remote
/// connections deleted since. `local_requested` is a launch that asked for the
/// local workspace itself (a `codeg://` link on the command line), and
/// `local_can_hide` whether `main` can be hidden at all this launch — where it
/// cannot, a hidden `main` would have nothing to bring it back.
fn plan_restore(
    remembered: &[WorkspaceWindow],
    connection_exists: impl Fn(i32) -> bool,
    local_requested: bool,
    local_can_hide: bool,
) -> RestorePlan {
    let restorable: Vec<WorkspaceWindow> = remembered
        .iter()
        .copied()
        .filter(|window| match window {
            WorkspaceWindow::Local => true,
            WorkspaceWindow::Remote { connection_id } => connection_exists(*connection_id),
        })
        .collect();
    let remotes: Vec<i32> = restorable
        .iter()
        .filter_map(|window| match window {
            WorkspaceWindow::Remote { connection_id } => Some(*connection_id),
            WorkspaceWindow::Local => None,
        })
        .collect();
    let show_local = local_requested
        || !local_can_hide
        || remotes.is_empty()
        || restorable.contains(&WorkspaceWindow::Local);
    let front = if local_requested {
        WorkspaceWindow::Local
    } else {
        restorable.last().copied().unwrap_or(WorkspaceWindow::Local)
    };
    RestorePlan {
        show_local,
        remotes,
        front,
    }
}

/// How a recorded event changed the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Change {
    None,
    /// Same windows, another one in front. Kept in memory until the next
    /// write: focus moves far more often than windows open and close.
    Order,
    /// A window joined or left the list, which is written right away.
    Membership,
}

#[derive(Debug, Default)]
struct SessionState {
    /// Open workspace windows, least recently focused first.
    open: Vec<WorkspaceWindow>,
    /// Remembered windows this launch is still reopening. Listed ahead of the
    /// open ones, so a quit that lands before they settle keeps them.
    pending: Vec<WorkspaceWindow>,
    /// The launch is still reopening windows. The list is only kept in memory
    /// meanwhile, so a crash halfway through cannot replace the remembered
    /// list with the part of it that had come back.
    restoring: bool,
    /// The remembered front window, or a window explicitly raised by the user
    /// while restoration was running. Building a background window cannot
    /// override an explicit request to open the local workspace.
    restore_front: Option<WorkspaceWindow>,
    /// Quitting has begun: the windows going away now are not being closed by
    /// the user, and the list written at quit is final.
    frozen: bool,
    /// What the stored list holds, as far as this process knows.
    last_written: Option<String>,
    /// Reopening failures waiting for `main` to take them.
    failures: Vec<WorkspaceRestoreFailure>,
}

impl SessionState {
    /// `window` is open and the most recently focused.
    fn mark_open(&mut self, window: WorkspaceWindow) -> Change {
        self.pending.retain(|w| *w != window);
        match self.open.iter().position(|w| *w == window) {
            Some(index) if index + 1 == self.open.len() => Change::None,
            Some(index) => {
                self.open.remove(index);
                self.open.push(window);
                Change::Order
            }
            None => {
                self.open.push(window);
                Change::Membership
            }
        }
    }

    fn mark_closed(&mut self, window: WorkspaceWindow) -> Change {
        let before = self.open.len() + self.pending.len();
        self.open.retain(|w| *w != window);
        self.pending.retain(|w| *w != window);
        if self.restore_front == Some(window) {
            self.restore_front = self.open.last().or_else(|| self.pending.last()).copied();
        }
        if self.open.len() + self.pending.len() == before {
            Change::None
        } else {
            Change::Membership
        }
    }

    fn mark_shown(&mut self, window: WorkspaceWindow) -> Change {
        if self.restoring {
            self.restore_front = Some(window);
        }
        self.mark_open(window)
    }

    /// Dock / second-launch activation selects an existing workspace, never
    /// an auxiliary window or a local window closed to the tray. During startup
    /// it can wait for the remembered front window instead of opening `main`.
    fn activation_target(
        &self,
        exists: impl Fn(WorkspaceWindow) -> bool,
    ) -> Option<WorkspaceWindow> {
        if self.restoring {
            if let Some(front) = self.restore_front {
                if exists(front) {
                    return Some(front);
                }
                if self.pending.contains(&front) {
                    return None;
                }
            }
        }
        self.open
            .iter()
            .rev()
            .copied()
            .find(|window| exists(*window))
            .or_else(|| exists(WorkspaceWindow::Local).then_some(WorkspaceWindow::Local))
    }

    fn complete_restore(&mut self) {
        self.restoring = false;
        self.restore_front = None;
    }

    fn should_reopen(&self, window: WorkspaceWindow) -> bool {
        !self.frozen && (self.pending.contains(&window) || self.open.contains(&window))
    }

    /// The list to store, least recently focused first.
    fn snapshot(&self) -> Vec<WorkspaceWindow> {
        self.pending.iter().chain(&self.open).copied().collect()
    }
}

/// The open workspace windows of this run. Managed state of the desktop app.
pub struct WorkspaceWindowSession {
    state: Mutex<SessionState>,
    /// Held across a whole write, so that an older list can never land after
    /// a newer one.
    write: tokio::sync::Mutex<()>,
}

impl Default for WorkspaceWindowSession {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceWindowSession {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SessionState::default()),
            write: tokio::sync::Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SessionState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Apply one event. `true` when the stored list should be rewritten.
    fn apply(&self, event: impl FnOnce(&mut SessionState) -> Change) -> bool {
        let mut state = self.lock();
        if state.frozen {
            return false;
        }
        event(&mut state) == Change::Membership && !state.restoring
    }

    /// Stop recording, for the quit. `false` if a quit already did.
    fn freeze(&self) -> bool {
        let mut state = self.lock();
        !std::mem::replace(&mut state.frozen, true)
    }

    /// Store the list as it is now, unless that is what is stored already.
    async fn write_latest(&self, conn: &DatabaseConnection) {
        let _serial = self.write.lock().await;
        let value = {
            let state = self.lock();
            match encode_session(&state.snapshot()) {
                Some(value) if state.last_written.as_deref() != Some(value.as_str()) => value,
                _ => return,
            }
        };
        match app_metadata_service::upsert_value(conn, SESSION_KEY, &value).await {
            Ok(()) => self.lock().last_written = Some(value),
            Err(err) => {
                tracing::warn!("[workspace-windows] failed to remember the open windows: {err}")
            }
        }
    }
}

fn record(app: &AppHandle, event: impl FnOnce(&mut SessionState) -> Change) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    if session.apply(event) {
        schedule_write(app);
    }
}

fn schedule_write(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(session), Some(db)) = (
            app.try_state::<WorkspaceWindowSession>(),
            app.try_state::<AppDatabase>(),
        ) else {
            return;
        };
        session.write_latest(&db.conn).await;
    });
}

/// A workspace window was opened, or brought forward: it is open, and the
/// most recently focused.
pub fn note_opened(app: &AppHandle, window: WorkspaceWindow) {
    record(app, |state| state.mark_open(window));
}

/// `label` was shown (and focused). No-op unless it is a workspace window.
pub fn note_shown(app: &AppHandle, label: &str) {
    if let Some(window) = WorkspaceWindow::from_label(label) {
        record(app, |state| state.mark_shown(window));
    }
}

/// Activate the most recently used workspace: a Dock click (macOS), a second
/// launch (Windows, Linux). With no workspace window left at all — a
/// windowless launch never built one, a close destroyed `main` while remote
/// windows kept the app alive and those are gone too — `main` is built and
/// shown, so the gesture always lands on a window. While a restore is still
/// building the window it will raise, nothing is done here.
pub fn activate_workspace(app: &AppHandle) {
    let (target, restoring) = match app.try_state::<WorkspaceWindowSession>() {
        Some(session) => {
            let state = session.lock();
            (
                state.activation_target(|window| app.get_webview_window(&window.label()).is_some()),
                state.restoring,
            )
        }
        None => (Some(WorkspaceWindow::Local), false),
    };
    match target {
        Some(WorkspaceWindow::Local) => show_local_workspace_window(app),
        Some(remote) => windows::show_and_focus_window(app, &remote.label()),
        None if !restoring => show_local_workspace_window(app),
        None => {}
    }
}

/// `label` was hidden — the close button sending `main` to the tray — which
/// closes it as far as the next launch is concerned.
pub fn note_hidden(app: &AppHandle, label: &str) {
    if let Some(window) = WorkspaceWindow::from_label(label) {
        record(app, |state| state.mark_closed(window));
    }
}

/// Keep the list in step with the window events: focus orders it, and a
/// destroyed window leaves it.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(workspace) = WorkspaceWindow::from_label(window.label()) else {
        return;
    };
    match event {
        tauri::WindowEvent::Focused(true) => {
            // Focus means the window is open — unless it was hidden again
            // before the event got here, which is how a `main` that the
            // window-state plugin showed while it was built, and the launch
            // then hid, reports in.
            if window.is_visible().unwrap_or(false) {
                note_opened(window.app_handle(), workspace);
            }
        }
        tauri::WindowEvent::Destroyed => {
            record(window.app_handle(), |state| state.mark_closed(workspace));
        }
        _ => {}
    }
}

/// Write the final list, and stop recording: the windows about to go away are
/// torn down by the quit, not closed by the user.
///
/// The first thing a quit does (`shut_down` in `lib.rs`), whichever way it
/// arrives, while every window is still standing. Calling it again does
/// nothing.
pub fn remember_on_quit(app: &AppHandle) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    if !session.freeze() {
        return;
    }
    let Some(db) = app.try_state::<AppDatabase>() else {
        return;
    };
    tauri::async_runtime::block_on(session.write_latest(&db.conn));
}

/// What this launch reopens, as read from the database.
pub struct Restore {
    plan: RestorePlan,
    /// The remote connections to reopen, in `plan.remotes` order.
    connections: Vec<RemoteWorkspaceConnectionInfo>,
}

impl Restore {
    /// Whether `main` is shown at launch.
    pub fn show_local(&self) -> bool {
        self.plan.show_local
    }

    /// Lead this launch with `connection`, the remote workspace the launch
    /// preference names (Settings › System, "When codeg starts, open"); see
    /// [`plan_lead_with_remote`].
    pub fn lead_with_remote(
        &mut self,
        connection: RemoteWorkspaceConnectionInfo,
        local_requested: bool,
        local_can_hide: bool,
    ) {
        let id = connection.id;
        let plan = std::mem::replace(
            &mut self.plan,
            RestorePlan {
                show_local: true,
                remotes: Vec::new(),
                front: WorkspaceWindow::Local,
            },
        );
        self.plan = plan_lead_with_remote(plan, id, local_requested, local_can_hide);
        if !local_requested {
            self.connections.retain(|c| c.id != id);
            self.connections.push(connection);
        }
    }
}

/// The launch preference names the remote workspace `connection_id`: it comes
/// back with the rest of the list, last, so it is raised in front, and `main`
/// is built hidden behind it — it still hosts the local workspace, and the
/// tray, the Dock and the remote window's quick actions bring it back. Two
/// things keep `main` on screen and in front: a `codeg://` link that named the
/// local workspace (`local_requested`, which then leaves the plan alone), and
/// a tray that cannot bring a hidden `main` back (`local_can_hide` false).
fn plan_lead_with_remote(
    mut plan: RestorePlan,
    connection_id: i32,
    local_requested: bool,
    local_can_hide: bool,
) -> RestorePlan {
    if local_requested {
        return plan;
    }
    plan.remotes.retain(|id| *id != connection_id);
    plan.remotes.push(connection_id);
    plan.front = WorkspaceWindow::Remote { connection_id };
    plan.show_local = !local_can_hide;
    plan
}

/// Read the remembered list and work out what this launch reopens. See
/// [`plan_restore`] for `local_requested` and `local_can_hide`.
pub async fn load_restore(
    conn: &DatabaseConnection,
    local_requested: bool,
    local_can_hide: bool,
) -> Restore {
    let remembered = match app_metadata_service::get_value(conn, SESSION_KEY).await {
        Ok(Some(raw)) => decode_session(&raw),
        Ok(None) => Vec::new(),
        Err(err) => {
            tracing::warn!("[workspace-windows] failed to read the remembered windows: {err}");
            Vec::new()
        }
    };
    let mut connections: HashMap<i32, RemoteWorkspaceConnectionInfo> = HashMap::new();
    if remembered
        .iter()
        .any(|window| matches!(window, WorkspaceWindow::Remote { .. }))
    {
        match remote_workspace_connection_service::list(conn).await {
            Ok(list) => {
                connections = list.into_iter().map(|c| (c.id, c)).collect();
            }
            Err(err) => {
                tracing::warn!("[workspace-windows] failed to load remote connections: {err}")
            }
        }
    }
    let plan = plan_restore(
        &remembered,
        |id| connections.contains_key(&id),
        local_requested,
        local_can_hide,
    );
    let connections = plan
        .remotes
        .iter()
        .filter_map(|id| connections.remove(id))
        .collect();
    Restore { plan, connections }
}

/// Start reopening what `restore` lists. Called by the setup hook once `main`
/// is built — shown or not, as [`Restore::show_local`] said.
pub fn begin_restore(app: &AppHandle, restore: Restore) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    let Restore { plan, connections } = restore;
    {
        let mut state = session.lock();
        if plan.show_local {
            state.mark_open(WorkspaceWindow::Local);
        }
        state.pending = connections
            .iter()
            .map(|connection| WorkspaceWindow::Remote {
                connection_id: connection.id,
            })
            .collect();
        state.restoring = !connections.is_empty();
        state.restore_front = Some(plan.front);
    }
    if connections.is_empty() {
        session.lock().complete_restore();
        schedule_write(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        reopen_remote_windows(&app, connections, plan.front).await;
    });
}

async fn reopen_remote_windows(
    app: &AppHandle,
    connections: Vec<RemoteWorkspaceConnectionInfo>,
    front: WorkspaceWindow,
) {
    let mut failures = Vec::new();
    for connection in connections {
        // The saved connection already passed validation when it was created.
        // Build its window without a network preflight; its transport owns
        // recovery and authentication, including an offline cold start.
        if let Err(error) = reopen_remote_window(app, &connection) {
            let window = WorkspaceWindow::Remote {
                connection_id: connection.id,
            };
            // A manual open may have raced the background build.
            if app.get_webview_window(&window.label()).is_some() {
                continue;
            }
            tracing::warn!(
                "[workspace-windows] could not reopen remote workspace {}: {} {}",
                connection.id,
                error.message,
                error.detail.as_deref().unwrap_or_default()
            );
            // Keep the pending entry for the next launch if even the native
            // window could not be built. A failed restore never erases it.
            failures.push(WorkspaceRestoreFailure {
                connection_id: connection.id,
                name: connection.name,
                error,
            });
        }
    }
    finish_restore(app, front, failures);
}

fn reopen_remote_window(
    app: &AppHandle,
    connection: &RemoteWorkspaceConnectionInfo,
) -> Result<(), AppCommandError> {
    let window = WorkspaceWindow::Remote {
        connection_id: connection.id,
    };
    if let Some(session) = app.try_state::<WorkspaceWindowSession>() {
        // A quit or a user close during restoration cancels this build.
        if !session.lock().should_reopen(window) {
            return Ok(());
        }
    }
    // Opened by hand while restoration was still running. Building it
    // recorded it, and the user may have moved on to another window since, so
    // it is not brought forward in the list again here.
    if app.get_webview_window(&window.label()).is_some() {
        return Ok(());
    }
    crate::commands::remote_workspace::build_remote_workspace_window(app, connection, false)
}

fn finish_restore(app: &AppHandle, front: WorkspaceWindow, failures: Vec<WorkspaceRestoreFailure>) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    let (nothing_open, front) = {
        let state = session.lock();
        if state.frozen {
            return;
        }
        let front = state.restore_front.unwrap_or(front);
        let front = if app.get_webview_window(&front.label()).is_some() {
            front
        } else {
            state
                .activation_target(|window| app.get_webview_window(&window.label()).is_some())
                .unwrap_or(WorkspaceWindow::Local)
        };
        (state.open.is_empty(), front)
    };
    if !failures.is_empty() || nothing_open {
        // The toast saying why a window did not come back is shown in `main`;
        // and with nothing reopened, `main` is all there is.
        crate::commands::windows::show_main_window(app);
    } else if app.get_webview_window(&front.label()).is_some() {
        crate::commands::windows::show_and_focus_window(app, &front.label());
    }
    if !failures.is_empty() {
        session.lock().failures.extend(failures);
        if let Err(err) = app.emit_to(LOCAL_WORKSPACE_LABEL, RESTORE_FAILED_EVENT, ()) {
            tracing::warn!("[workspace-windows] failed to signal the local workspace: {err}");
        }
    }
    session.lock().complete_restore();
    schedule_write(app);
}

/// Take the remote workspaces this launch could not reopen, for the local
/// workspace to report. Each is handed out once.
#[tauri::command]
pub fn take_workspace_restore_failures(
    session: tauri::State<'_, WorkspaceWindowSession>,
) -> Vec<WorkspaceRestoreFailure> {
    std::mem::take(&mut session.lock().failures)
}

// ---------------------------------------------------------------------------
// Building `main`, the launch plan, and keeping `main` reachable.
// ---------------------------------------------------------------------------

/// Route `main` loads when no `codeg://` link picked a conversation for it.
pub(crate) const MAIN_WORKSPACE_PATH: &str = "workspace";

/// Every window flag the window-state plugin persists and restores, except
/// decorations. Decorations are a per-platform decision made by
/// `apply_platform_window_style` (undecorated on Windows/Linux so the app
/// draws its own chrome), not a user preference. Restoring a stale
/// `decorated: true` saved by an older build would call `set_decorations(true)`
/// after the window is built and re-add the native title bar on top of the
/// app's own toolbar — the Linux "double title bar".
pub(crate) const WINDOW_STATE_FLAGS: StateFlags =
    StateFlags::all().difference(StateFlags::DECORATIONS);

/// What a launch builds by itself, besides the workspace windows the
/// remembered list brings back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StartupPlan {
    /// Whether `main` is built (and the remembered workspace windows
    /// reopened) at all. False only for a windowless launch
    /// (`crate::windowless`): a Dock click or the menu bar icon builds `main`
    /// on demand instead.
    pub build_main: bool,
    /// Whether Quick Ask's hidden window is pre-built a few seconds after
    /// launch, so the first shortcut press opens it instantly.
    pub prebuild_quick_ask: bool,
    /// Whether the global shortcuts (Quick Ask, Talk on this Mac) are
    /// registered. Each opens a window or acts on one.
    pub register_shortcuts: bool,
}

impl StartupPlan {
    /// Whether the launch builds any window by itself. Quick Ask's pre-built
    /// window counts: it is a webview like any other, hidden or not.
    pub(crate) fn builds_any_window(&self) -> bool {
        self.build_main || self.prebuild_quick_ask
    }
}

/// Decide what a launch builds by itself. A windowless launch
/// (`crate::windowless`) builds nothing, pre-builds nothing and registers no
/// shortcut; every other launch builds `main` (shown or hidden, as the
/// [`Restore`] says) with Quick Ask and the shortcuts.
pub(crate) fn plan_startup(windowless: bool) -> StartupPlan {
    StartupPlan {
        build_main: !windowless,
        prebuild_quick_ask: !windowless,
        register_shortcuts: !windowless,
    }
}

/// How a workspace window sits on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowPresence {
    Visible,
    Minimized,
    /// Hidden with `hide()`, or built hidden.
    Hidden,
}

/// Whether closing a remote workspace window stranded `main`: hidden, with no
/// other workspace window left to come back through. The app would then keep
/// running with nothing on screen and no obvious way back, so `main` is shown.
///
/// A minimized `main` already has its way back (the dock, the taskbar), and a
/// destroyed one was closed on purpose, so neither is brought back.
pub(crate) fn main_needs_resurfacing(
    remaining_remote_windows: usize,
    main: Option<WindowPresence>,
) -> bool {
    remaining_remote_windows == 0 && main == Some(WindowPresence::Hidden)
}

/// The flags `main` is restored with when it is built.
///
/// A visible `main` gets the full set. A hidden one leaves out every flag whose
/// restore puts a window on screen: VISIBLE is the plugin's `show()` +
/// `set_focus()`, MAXIMIZED is a `ShowWindow(SW_MAXIMIZE)` on Windows, and
/// FULLSCREEN is a native Space of its own on macOS. Size and position are safe
/// on a window nobody can see, and they are what it comes back with.
pub(crate) fn main_window_restore_flags(visible: bool) -> StateFlags {
    if visible {
        WINDOW_STATE_FLAGS
    } else {
        WINDOW_STATE_FLAGS.difference(
            StateFlags::VISIBLE
                .union(StateFlags::MAXIMIZED)
                .union(StateFlags::FULLSCREEN),
        )
    }
}

/// Create `main` if it is gone — at launch, or after a close destroyed it
/// while remote workspace windows kept the app alive. Workspace state (open
/// folders, opened tabs, active tab) is restored by the frontend inside the
/// window via `list_open_folder_details` / `list_opened_tabs`.
///
/// `visible: false` builds it hidden, for a launch that leads with a remote
/// workspace. The window-state plugin skips `main` on creation (see its
/// registration in `lib.rs`), because its restore would `show()` a window
/// meant to stay hidden; the restore runs here instead, with
/// [`main_window_restore_flags`].
pub(crate) fn ensure_main_window(app: &AppHandle, workspace_path: &Path, visible: bool) {
    if app.get_webview_window("main").is_some() {
        return;
    }
    let url = WebviewUrl::App(workspace_path.to_path_buf());
    let builder = WebviewWindowBuilder::new(app, "main", url)
        .title("Codeg")
        .inner_size(1260.0, 860.0)
        .min_inner_size(400.0, 600.0)
        .visible(visible);
    let builder = windows::apply_platform_window_style(builder);
    // The workspace title bar is taller than the shared default (it hosts
    // the tab strips), so nudge the native macOS traffic lights down to
    // stay vertically centred.
    #[cfg(target_os = "macos")]
    let builder =
        builder.traffic_light_position(windows::workspace_window_traffic_light_position());
    let window = match builder.build() {
        Ok(window) => window,
        Err(err) => {
            tracing::error!("[window] failed to create the main window: {err}");
            return;
        }
    };
    // On the main thread, like the plugin's own restore. Launch, the dock and
    // the tray already run there, so the restore happens right away — before
    // the window is first drawn, as the plugin's on-creation restore did, so
    // it never shows at the default size and then jumps. From any other thread
    // (a remote window's "Local workspace" command) it is posted instead:
    // there `restore_state` would hold the plugin's state cache while it waits
    // on the main thread for the monitor list — and the main thread,
    // registering this very window with the plugin, would be waiting on that
    // cache.
    let flags = main_window_restore_flags(visible);
    if std::thread::current().name() == Some("main") {
        let _ = window.restore_state(flags);
    } else {
        let restored = window.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = restored.restore_state(flags);
        });
    }
    windows::post_window_setup(&window);
}

/// Bring the local workspace forward, rebuilding `main` first if a close
/// destroyed it. What the tray's "Show Workspace" does, what a remote window's
/// "Local workspace" action asks for, and where a reopen lands on `main`.
pub(crate) fn show_local_workspace_window(app: &AppHandle) {
    ensure_main_window(app, Path::new(MAIN_WORKSPACE_PATH), true);
    windows::show_main_window(app);
}

/// Runs once the remote workspace window `closed` is gone: shows `main` when
/// [`main_needs_resurfacing`] finds it stranded. `closed` is left out of the
/// count by name rather than trusting it to have left the window registry
/// already.
pub(crate) fn resurface_main_if_stranded(app: &AppHandle, closed: &str) {
    let remaining = remote_workspace_windows(app)
        .iter()
        .filter(|(label, _)| label != closed)
        .count();
    let main = app
        .get_webview_window("main")
        .map(|window| presence(&window));
    if main_needs_resurfacing(remaining, main) {
        windows::show_main_window(app);
    }
}

/// Bring the local workspace forward from a remote workspace window — the way
/// back to `main` once a launch opened a remote workspace and kept `main`
/// hidden, or after a close destroyed it. Always the LOCAL app's command: a
/// remote window reaches it through the shell transport.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn show_local_workspace(app: AppHandle) -> Result<(), AppCommandError> {
    show_local_workspace_window(&app);
    Ok(())
}

/// The open remote workspace windows, ordered by label.
fn remote_workspace_windows(app: &AppHandle) -> Vec<(String, tauri::WebviewWindow)> {
    let mut open: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(REMOTE_WORKSPACE_LABEL_PREFIX))
        .collect();
    open.sort_by(|(a, _), (b, _)| a.cmp(b));
    open
}

fn presence(window: &tauri::WebviewWindow) -> WindowPresence {
    // Minimized first: Windows reports a minimized window as visible.
    if window.is_minimized().unwrap_or(false) {
        WindowPresence::Minimized
    } else if window.is_visible().unwrap_or(true) {
        WindowPresence::Visible
    } else {
        WindowPresence::Hidden
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    const LOCAL: WorkspaceWindow = WorkspaceWindow::Local;

    fn remote(connection_id: i32) -> WorkspaceWindow {
        WorkspaceWindow::Remote { connection_id }
    }

    #[test]
    fn labels_name_the_workspace_windows() {
        assert_eq!(WorkspaceWindow::from_label("main"), Some(LOCAL));
        assert_eq!(
            WorkspaceWindow::from_label("remote-workspace-3"),
            Some(remote(3))
        );
        assert_eq!(LOCAL.label(), "main");
        assert_eq!(remote(12).label(), "remote-workspace-12");
        assert_eq!(
            WorkspaceWindow::from_label(&remote(12).label()),
            Some(remote(12))
        );

        for other in [
            "settings",
            "remote-settings-3",
            "remote-workspace-",
            "remote-workspace-x",
            "remote-workspace-+3",
            "remote-workspace-03",
            "commit-1",
            "pet",
        ] {
            assert_eq!(WorkspaceWindow::from_label(other), None, "{other}");
        }
    }

    #[test]
    fn activation_prefers_the_most_recent_existing_workspace() {
        let mut state = SessionState::default();
        state.mark_open(LOCAL);
        state.mark_open(remote(1));
        state.mark_open(remote(2));
        assert_eq!(state.activation_target(|_| true), Some(remote(2)));
        assert_eq!(
            state.activation_target(|window| window != remote(2)),
            Some(remote(1))
        );
        state.mark_open(LOCAL);
        assert_eq!(state.activation_target(|_| true), Some(LOCAL));
    }

    #[test]
    fn activation_does_not_reopen_a_closed_local_workspace() {
        let mut state = SessionState::default();
        state.mark_open(LOCAL);
        state.mark_open(remote(1));
        state.mark_closed(LOCAL);
        // main still physically exists, hidden to tray; it must stay hidden.
        assert_eq!(state.activation_target(|_| true), Some(remote(1)));
        state.mark_closed(remote(1));
        assert_eq!(state.activation_target(|_| true), Some(LOCAL));
    }

    #[test]
    fn activation_waits_for_a_remote_only_restore() {
        // As `begin_restore` leaves it: the remembered front is still pending.
        let mut state = SessionState {
            pending: vec![remote(1)],
            restoring: true,
            restore_front: Some(remote(1)),
            ..SessionState::default()
        };
        assert_eq!(state.activation_target(|window| window == LOCAL), None);
        state.mark_open(remote(1));
        assert_eq!(state.activation_target(|_| true), Some(remote(1)));
        assert_eq!(state.snapshot(), vec![remote(1)]);
        // Still restoring, but nothing is left pending to wait for: with the
        // restored window closed again, local is the only workspace left.
        state.mark_closed(remote(1));
        assert_eq!(state.activation_target(|_| true), Some(LOCAL));
    }

    #[test]
    fn stored_list_round_trips() {
        let windows = [remote(4), LOCAL, remote(2)];
        let raw = encode_session(&windows).unwrap();
        assert_eq!(
            raw,
            r#"{"version":1,"windows":[{"kind":"remote","connection_id":4},{"kind":"local"},{"kind":"remote","connection_id":2}]}"#
        );
        assert_eq!(decode_session(&raw), windows);
    }

    #[test]
    fn stored_list_skips_what_it_cannot_read() {
        assert!(decode_session("not json").is_empty());
        assert!(decode_session("{}").is_empty());
        let raw = r#"{"version":7,"windows":[
            {"kind":"remote","connection_id":1},
            {"kind":"hologram","id":9},
            {"kind":"remote"},
            "main",
            {"kind":"local"},
            {"kind":"remote","connection_id":1}
        ]}"#;
        // A window listed twice keeps its later place.
        assert_eq!(decode_session(raw), vec![LOCAL, remote(1)]);
    }

    #[test]
    fn nothing_remembered_opens_the_local_workspace() {
        let plan = plan_restore(&[], |_| true, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![],
                front: LOCAL,
            }
        );
    }

    #[test]
    fn remote_windows_come_back_with_the_local_one() {
        let plan = plan_restore(&[LOCAL, remote(1), remote(2)], |_| true, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![1, 2],
                front: remote(2),
            }
        );

        let plan = plan_restore(&[remote(1), remote(2), LOCAL], |_| true, false, true);
        assert_eq!(plan.remotes, vec![1, 2]);
        assert_eq!(plan.front, LOCAL);
    }

    #[test]
    fn a_local_workspace_closed_at_quit_stays_closed() {
        let plan = plan_restore(&[remote(1), remote(2)], |_| true, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: false,
                remotes: vec![1, 2],
                front: remote(2),
            }
        );
    }

    #[test]
    fn deleted_connections_are_not_reopened() {
        let plan = plan_restore(&[remote(1), remote(2)], |id| id == 1, false, true);
        assert_eq!(plan.remotes, vec![1]);
        assert_eq!(plan.front, remote(1));

        // With nothing left to reopen, the local workspace opens after all.
        let plan = plan_restore(&[remote(1)], |_| false, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![],
                front: LOCAL,
            }
        );
    }

    #[test]
    fn a_link_on_the_command_line_opens_the_local_workspace_in_front() {
        let plan = plan_restore(&[remote(1)], |_| true, true, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![1],
                front: LOCAL,
            }
        );
    }

    #[test]
    fn the_local_workspace_opens_where_it_could_not_be_brought_back() {
        let plan = plan_restore(&[remote(1)], |_| true, false, false);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![1],
                front: remote(1),
            }
        );
    }

    #[test]
    fn the_list_follows_focus_and_membership() {
        let mut state = SessionState::default();
        assert_eq!(state.mark_open(LOCAL), Change::Membership);
        assert_eq!(state.mark_open(remote(1)), Change::Membership);
        assert_eq!(state.mark_open(remote(1)), Change::None);
        assert_eq!(state.mark_open(LOCAL), Change::Order);
        assert_eq!(state.snapshot(), vec![remote(1), LOCAL]);
        assert_eq!(state.mark_closed(remote(1)), Change::Membership);
        assert_eq!(state.mark_closed(remote(1)), Change::None);
        assert_eq!(state.snapshot(), vec![LOCAL]);
    }

    #[test]
    fn windows_still_being_reopened_are_kept() {
        let mut state = SessionState {
            pending: vec![remote(1), remote(2)],
            ..SessionState::default()
        };
        state.mark_open(LOCAL);
        assert_eq!(state.snapshot(), vec![remote(1), remote(2), LOCAL]);

        state.mark_open(remote(1));
        assert_eq!(state.snapshot(), vec![remote(2), LOCAL, remote(1)]);

        // A user close removes a pending window from the list.
        assert_eq!(state.mark_closed(remote(2)), Change::Membership);
        assert_eq!(state.snapshot(), vec![LOCAL, remote(1)]);
    }

    #[test]
    fn a_failed_reopen_keeps_pending_and_manually_opened_windows() {
        let mut state = SessionState {
            pending: vec![remote(1), remote(2)],
            ..SessionState::default()
        };
        // Remote 2 is opened by hand before its build failure is processed.
        state.mark_open(remote(2));
        state.complete_restore();
        assert_eq!(state.snapshot(), vec![remote(1), remote(2)]);
    }

    #[test]
    fn only_membership_changes_outside_a_restore_are_written() {
        let session = WorkspaceWindowSession::new();
        assert!(session.apply(|state| state.mark_open(LOCAL)));
        assert!(!session.apply(|state| state.mark_open(LOCAL)));
        assert!(session.apply(|state| state.mark_open(remote(1))));
        // Focus alone waits for the next write.
        assert!(!session.apply(|state| state.mark_open(LOCAL)));

        session.lock().restoring = true;
        assert!(!session.apply(|state| state.mark_open(remote(2))));
        assert_eq!(session.lock().snapshot(), vec![remote(1), LOCAL, remote(2)]);
    }

    #[test]
    fn nothing_is_recorded_once_quitting() {
        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(LOCAL));
        session.apply(|state| state.mark_open(remote(1)));

        assert!(session.freeze());
        assert!(!session.freeze(), "the first quit event writes, not both");
        assert!(!session.apply(|state| state.mark_closed(remote(1))));
        assert!(!session.apply(|state| state.mark_closed(LOCAL)));
        assert_eq!(session.lock().snapshot(), vec![LOCAL, remote(1)]);
    }

    #[tokio::test]
    async fn the_list_written_is_the_list_read_back() {
        let db = fresh_in_memory_db().await;
        let one = remote_workspace_connection_service::create(
            &db.conn,
            "one",
            "http://one.example:3080",
            "t1",
            &[],
        )
        .await
        .unwrap();
        let two = remote_workspace_connection_service::create(
            &db.conn,
            "two",
            "http://two.example:3080",
            "t2",
            &[],
        )
        .await
        .unwrap();

        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(remote(two.id)));
        session.apply(|state| state.mark_open(remote(one.id)));
        session.write_latest(&db.conn).await;

        let restore = load_restore(&db.conn, false, true).await;
        assert!(!restore.show_local());
        assert_eq!(restore.plan.remotes, vec![two.id, one.id]);
        assert_eq!(restore.plan.front, remote(one.id));
        let names: Vec<&str> = restore
            .connections
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, vec!["two", "one"]);

        // A connection deleted before the next launch is not reopened.
        remote_workspace_connection_service::delete(&db.conn, one.id)
            .await
            .unwrap();
        let restore = load_restore(&db.conn, false, true).await;
        assert_eq!(restore.plan.remotes, vec![two.id]);
        assert_eq!(restore.plan.front, remote(two.id));
    }

    /// The user opens B while A is still being restored. Completing the
    /// background restore keeps B in front and remembers both for the next run.
    #[tokio::test]
    async fn a_window_opened_by_hand_during_the_restore_is_remembered() {
        let db = fresh_in_memory_db().await;
        let a = remote_workspace_connection_service::create(
            &db.conn,
            "a",
            "http://a.example:3080",
            "ta",
            &[],
        )
        .await
        .unwrap();
        let b = remote_workspace_connection_service::create(
            &db.conn,
            "b",
            "http://b.example:3080",
            "tb",
            &[],
        )
        .await
        .unwrap();

        let session = WorkspaceWindowSession::new();
        {
            let mut state = session.lock();
            state.pending = vec![remote(a.id), remote(b.id)];
            state.restoring = true;
            state.restore_front = Some(remote(a.id));
        }
        // B, opened by hand; then A, reopened. A late failed build cannot
        // remove the successfully opened B.
        session.apply(|state| state.mark_shown(remote(b.id)));
        session.apply(|state| state.mark_open(remote(a.id)));
        let front = session.lock().activation_target(|_| true).unwrap();
        assert_eq!(front, remote(b.id));
        session.apply(|state| state.mark_shown(front));
        session.lock().complete_restore();

        assert!(session.freeze());
        session.write_latest(&db.conn).await;

        let restore = load_restore(&db.conn, false, true).await;
        assert_eq!(restore.plan.remotes, vec![a.id, b.id]);
        assert_eq!(restore.plan.front, remote(b.id));
    }

    #[tokio::test]
    async fn an_offline_remote_shell_survives_quit_but_an_explicit_close_does_not() {
        let db = fresh_in_memory_db().await;
        // Restoring a saved shell must not contact this unreachable host.
        let connection = remote_workspace_connection_service::create(
            &db.conn,
            "offline",
            "http://127.0.0.1:1",
            "token",
            &[],
        )
        .await
        .unwrap();
        let window = remote(connection.id);
        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(window));
        session.freeze();
        session.write_latest(&db.conn).await;
        let restore = load_restore(&db.conn, false, true).await;
        assert!(!restore.show_local());
        assert_eq!(restore.plan.remotes, vec![connection.id]);

        // A shell closing deliberately while the server remains unavailable
        // still leaves the session. We do not revive every saved connection.
        let closed_session = WorkspaceWindowSession::new();
        closed_session.apply(|state| state.mark_open(window));
        closed_session.apply(|state| state.mark_closed(window));
        closed_session.freeze();
        closed_session.write_latest(&db.conn).await;
        let restore = load_restore(&db.conn, false, true).await;
        assert!(restore.show_local());
        assert!(restore.plan.remotes.is_empty());
    }

    #[tokio::test]
    async fn an_unchanged_list_is_not_written_again() {
        let db = fresh_in_memory_db().await;
        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(LOCAL));
        session.write_latest(&db.conn).await;
        let written = session.lock().last_written.clone();
        assert!(written.is_some());

        // Overwrite behind the session's back: a write of the same list
        // would put it back, so finding it untouched proves none happened.
        app_metadata_service::upsert_value(&db.conn, SESSION_KEY, "sentinel")
            .await
            .unwrap();
        session.write_latest(&db.conn).await;
        assert_eq!(
            app_metadata_service::get_value(&db.conn, SESSION_KEY)
                .await
                .unwrap()
                .as_deref(),
            Some("sentinel")
        );

        session.apply(|state| state.mark_open(remote(5)));
        session.write_latest(&db.conn).await;
        let stored = app_metadata_service::get_value(&db.conn, SESSION_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(decode_session(&stored), vec![LOCAL, remote(5)]);
    }

    #[tokio::test]
    async fn a_first_launch_opens_the_local_workspace() {
        let db = fresh_in_memory_db().await;
        let restore = load_restore(&db.conn, false, true).await;
        assert!(restore.show_local());
        assert!(restore.connections.is_empty());
    }

    #[test]
    fn activation_raises_the_last_existing_workspace() {
        let mut state = SessionState::default();
        state.mark_open(LOCAL);
        state.mark_open(remote(1));
        state.mark_open(remote(2));
        assert_eq!(state.activation_target(|_| true), Some(remote(2)));
        // A close event may still be queued for a window that is already gone.
        assert_eq!(
            state.activation_target(|window| window != remote(2)),
            Some(remote(1))
        );
        state.mark_closed(LOCAL);
        assert_eq!(state.activation_target(|_| true), Some(remote(2)));
        state.mark_shown(LOCAL);
        assert_eq!(state.activation_target(|_| true), Some(LOCAL));
        state.mark_closed(remote(1));
        state.mark_closed(remote(2));
        state.mark_closed(LOCAL);
        assert_eq!(state.activation_target(|_| true), Some(LOCAL));
        assert_eq!(state.activation_target(|_| false), None);
    }

    #[test]
    fn activation_during_restore_waits_for_remote_but_honors_explicit_local_open() {
        let mut state = SessionState {
            open: vec![LOCAL],
            pending: vec![remote(1)],
            restoring: true,
            restore_front: Some(remote(1)),
            ..SessionState::default()
        };
        for _ in 0..3 {
            assert_eq!(state.activation_target(|window| window == LOCAL), None);
        }
        state.mark_shown(LOCAL);
        state.mark_open(remote(1)); // background build completes
        assert_eq!(state.activation_target(|_| true), Some(LOCAL));
        state.complete_restore();
    }

    #[test]
    fn closing_local_during_restore_cancels_its_front_window_request() {
        let mut state = SessionState {
            pending: vec![remote(1)],
            restoring: true,
            restore_front: Some(remote(1)),
            ..SessionState::default()
        };
        state.mark_shown(LOCAL);
        state.mark_closed(LOCAL);
        // `main` is still a native window, hidden to the tray. Its previous
        // explicit-open request must not show it again at the end of restore.
        assert_eq!(state.activation_target(|window| window == LOCAL), None);
        state.mark_open(remote(1));
        assert_eq!(state.activation_target(|_| true), Some(remote(1)));
    }

    #[test]
    fn closing_a_window_during_restore_does_not_resurrect_it() {
        let mut state = SessionState {
            pending: vec![remote(1)],
            restoring: true,
            ..SessionState::default()
        };
        assert!(state.should_reopen(remote(1)));
        state.mark_open(remote(1));
        state.mark_closed(remote(1));
        assert!(!state.should_reopen(remote(1)));
        state.pending.push(remote(2));
        state.frozen = true;
        assert!(!state.should_reopen(remote(2)));
    }

    #[tokio::test]
    async fn a_failed_restore_is_retried_after_quit_without_storing_credentials() {
        let db = fresh_in_memory_db().await;
        let remote = remote_workspace_connection_service::create(
            &db.conn,
            "offline",
            "http://offline.example:3080",
            "private-token-sentinel",
            &[],
        )
        .await
        .unwrap();
        let session = WorkspaceWindowSession::new();
        session.lock().pending = vec![WorkspaceWindow::Remote {
            connection_id: remote.id,
        }];
        session.lock().restoring = true;
        session.apply(|state| state.mark_shown(LOCAL)); // native build failed
        session.lock().complete_restore();
        session.freeze();
        session.write_latest(&db.conn).await;
        let raw = app_metadata_service::get_value(&db.conn, SESSION_KEY)
            .await
            .unwrap()
            .unwrap();
        assert!(!raw.contains("private-token-sentinel"));
        assert!(!raw.contains("offline.example"));
        let restored = load_restore(&db.conn, false, true).await;
        assert_eq!(restored.plan.remotes, vec![remote.id]);
    }

    // --- the launch plan, `main`'s restore flags, and resurfacing ---------

    use super::WindowPresence::{Hidden, Minimized, Visible};

    #[test]
    fn a_windowed_launch_builds_main_quick_ask_and_the_shortcuts() {
        let plan = plan_startup(false);
        assert!(plan.build_main && plan.builds_any_window(), "{plan:?}");
        assert!(plan.prebuild_quick_ask);
        assert!(plan.register_shortcuts);
    }

    /// A windowless launch builds no window of any kind and registers no
    /// shortcut.
    #[test]
    fn a_windowless_launch_builds_no_window_at_all() {
        let plan = plan_startup(true);
        assert!(!plan.builds_any_window(), "{plan:?}");
        assert!(!plan.build_main);
        assert!(!plan.prebuild_quick_ask);
        assert!(!plan.register_shortcuts);
    }

    fn plan(show_local: bool, remotes: &[i32], front: WorkspaceWindow) -> RestorePlan {
        RestorePlan {
            show_local,
            remotes: remotes.to_vec(),
            front,
        }
    }

    #[test]
    fn a_startup_workspace_opens_in_front_with_main_hidden_behind_it() {
        assert_eq!(
            plan_lead_with_remote(plan(true, &[], LOCAL), 7, false, true),
            plan(false, &[7], remote(7))
        );
    }

    /// The remembered windows still come back; the startup workspace is
    /// raised last, so it is the one in front.
    #[test]
    fn a_startup_workspace_comes_back_after_the_remembered_windows() {
        assert_eq!(
            plan_lead_with_remote(plan(true, &[7, 3], remote(3)), 7, false, true),
            plan(false, &[3, 7], remote(7))
        );
    }

    /// A `codeg://` link to a local conversation names the local workspace;
    /// opening a remote window over it would bury what the link asked for.
    #[test]
    fn a_link_to_a_local_conversation_wins_over_the_startup_workspace() {
        let restored = plan(true, &[3], LOCAL);
        assert_eq!(
            plan_lead_with_remote(restored.clone(), 7, true, true),
            restored
        );
    }

    /// Linux, or a tray that failed to install: nothing could bring a hidden
    /// `main` back, so it stays on screen under the remote window.
    #[test]
    fn without_a_usable_tray_main_stays_on_screen() {
        assert_eq!(
            plan_lead_with_remote(plan(true, &[], LOCAL), 7, false, false),
            plan(true, &[7], remote(7))
        );
    }

    #[test]
    fn closing_the_last_remote_window_shows_a_hidden_main() {
        assert!(main_needs_resurfacing(0, Some(Hidden)));
    }

    #[test]
    fn main_is_left_alone_while_it_has_another_way_back() {
        // Another remote workspace window is still open.
        assert!(!main_needs_resurfacing(1, Some(Hidden)));
        // Already on screen, or in the dock / taskbar.
        assert!(!main_needs_resurfacing(0, Some(Visible)));
        assert!(!main_needs_resurfacing(0, Some(Minimized)));
        // Closed on purpose.
        assert!(!main_needs_resurfacing(0, None));
    }

    #[test]
    fn a_visible_main_restores_every_persisted_flag() {
        let flags = main_window_restore_flags(true);
        assert_eq!(flags.bits(), WINDOW_STATE_FLAGS.bits());
        assert!(flags.contains(StateFlags::VISIBLE));
        assert!(!flags.contains(StateFlags::DECORATIONS));
    }

    /// Restoring any of these on a hidden `main` would put it on screen.
    #[test]
    fn a_hidden_main_restores_nothing_that_would_show_it() {
        let flags = main_window_restore_flags(false);
        assert!(!flags.intersects(
            StateFlags::VISIBLE
                .union(StateFlags::MAXIMIZED)
                .union(StateFlags::FULLSCREEN)
        ));
        assert!(!flags.contains(StateFlags::DECORATIONS));
        assert!(flags.contains(StateFlags::SIZE.union(StateFlags::POSITION)));
    }
}
