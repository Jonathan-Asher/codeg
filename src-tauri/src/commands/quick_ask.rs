//! Quick Ask: a small floating window, opened from anywhere with a global
//! shortcut (⌥Space by default), for asking an agent one quick question.
//!
//! Two halves live here:
//!
//! * **Desktop only** (`tauri-runtime`): the persisted shortcut settings, the
//!   global-shortcut registration, and the window itself — pre-created hidden
//!   so the shortcut opens it instantly, toggled, centred on the screen the
//!   pointer is on, and pointed at whichever backend (local or a remote
//!   workspace) the user was last working in.
//! * **Every runtime**: the cleanup of a *private* question. A private question
//!   runs in a throwaway scratch directory with no conversation row, and its
//!   agent is asked not to keep a transcript; discarding it removes the scratch
//!   directory and anything the agent wrote about the session anyway. It runs
//!   on whichever backend hosted the session, so the server has it too.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::db::service::folder_service;
use crate::models::AgentType;

// ─── Settings ────────────────────────────────────────────────────────────

/// `app_metadata` key of the persisted [`QuickAskSettings`]. Deliberately not
/// in the config-sync allowlist: a global shortcut belongs to one machine.
pub const QUICK_ASK_SETTINGS_KEY: &str = "quick_ask_settings";

/// ⌥Space on macOS, Alt+Space elsewhere.
pub const DEFAULT_QUICK_ASK_SHORTCUT: &str = "Alt+Space";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct QuickAskSettings {
    /// Whether the global shortcut is registered at all.
    pub enabled: bool,
    /// Accelerator in the global-shortcut plugin's syntax (`Alt+Space`,
    /// `Control+Shift+KeyK`, …).
    pub shortcut: String,
    /// Hide the window when it loses focus (a click outside it).
    pub hide_on_blur: bool,
}

impl Default for QuickAskSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_QUICK_ASK_SHORTCUT.to_string(),
            hide_on_blur: true,
        }
    }
}

/// What the settings screen shows: the saved settings plus whether the
/// shortcut is actually live. `registration_error` carries the OS refusal
/// (typically another app already owns the combination).
#[derive(Debug, Clone, Serialize)]
pub struct QuickAskSettingsView {
    pub enabled: bool,
    pub shortcut: String,
    pub hide_on_blur: bool,
    pub registered: bool,
    pub registration_error: Option<String>,
}

/// Normalize a shortcut typed or recorded in the settings screen: trimmed,
/// `+`-separated, at least one modifier and exactly one key. A bare key would
/// swallow that key in every other application, so it is refused here rather
/// than left to the OS. The final word on the key name belongs to the plugin's
/// parser at registration time.
pub fn normalize_shortcut(raw: &str) -> Result<String, String> {
    let parts: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("empty shortcut".to_string());
    }
    let (key, modifiers) = parts.split_last().expect("non-empty");
    if modifiers.is_empty() {
        return Err("a global shortcut needs at least one modifier".to_string());
    }
    for modifier in modifiers {
        if !is_modifier_token(modifier) {
            return Err(format!("\"{modifier}\" is not a modifier key"));
        }
    }
    if is_modifier_token(key) {
        return Err("a global shortcut needs a non-modifier key".to_string());
    }
    Ok(parts.join("+"))
}

fn is_modifier_token(token: &str) -> bool {
    matches!(
        token.to_ascii_uppercase().as_str(),
        "ALT"
            | "OPTION"
            | "SHIFT"
            | "CONTROL"
            | "CTRL"
            | "SUPER"
            | "META"
            | "CMD"
            | "COMMAND"
            | "CMDORCTRL"
            | "CMDORCONTROL"
            | "COMMANDORCTRL"
            | "COMMANDORCONTROL"
    )
}

// ─── Window placement and toggling (pure) ───────────────────────────────

/// What a shortcut press does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    Show,
    Hide,
}

/// Show and focus the window, or hide it when it is already frontmost. A
/// window that is visible but NOT focused (the user clicked elsewhere with
/// click-outside hiding turned off) is brought forward, not hidden.
pub fn toggle_action(visible: bool, focused: bool) -> ToggleAction {
    if visible && focused {
        ToggleAction::Hide
    } else {
        ToggleAction::Show
    }
}

/// Top-left origin that centres a `width`×`height` window in a work area,
/// clamped so the window never starts above or left of it. All in one unit
/// system (logical px).
pub fn centered_origin(
    area_x: f64,
    area_y: f64,
    area_w: f64,
    area_h: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let x = area_x + ((area_w - width) / 2.0).max(0.0);
    let y = area_y + ((area_h - height) / 2.0).max(0.0);
    (x.round(), y.round())
}

/// The backend a workspace window is bound to: `Some(None)` for the local
/// workspace (`main`), `Some(Some(id))` for a `remote-workspace-{id}` window,
/// `None` for any window that is not a workspace.
pub fn workspace_backend_of(label: &str) -> Option<Option<i32>> {
    if label == "main" {
        return Some(None);
    }
    let id = label.strip_prefix("remote-workspace-")?;
    id.parse::<i32>().ok().map(Some)
}

/// The workspace window that serves a backend.
pub fn workspace_label_for(remote_connection_id: Option<i32>) -> String {
    match remote_connection_id {
        Some(id) => format!("remote-workspace-{id}"),
        None => "main".to_string(),
    }
}

/// Route the Quick Ask window loads for a backend. A remote route carries the
/// window's stable instance id, like every other remote-bound window.
pub fn quick_ask_route(remote_connection_id: Option<i32>, remote_window_id: &str) -> String {
    match remote_connection_id {
        Some(id) => format!("quick-ask?remoteConnectionId={id}&remoteWindowId={remote_window_id}"),
        None => "quick-ask".to_string(),
    }
}

// ─── Private question cleanup (every runtime) ───────────────────────────

/// What a discard removed, and what it could not. Paths are reported so the
/// user (and the tests) can see exactly what a private question left.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct PrivateSessionCleanup {
    pub removed: Vec<String>,
    pub failed: Vec<String>,
}

impl PrivateSessionCleanup {
    fn remove_path(&mut self, path: &Path) {
        let result = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else if path.exists() {
            std::fs::remove_file(path)
        } else {
            return;
        };
        match result {
            Ok(()) => self.removed.push(path.to_string_lossy().to_string()),
            Err(err) => {
                tracing::warn!("[quick-ask] could not remove {}: {err}", path.display());
                self.failed.push(path.to_string_lossy().to_string());
            }
        }
    }
}

/// Session ids end up in file names below; only the characters agents use
/// for them (UUIDs, slugs) are accepted.
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Check that `working_dir` is a chat scratch directory minted by
/// `create_chat_dir_core` — `<data_dir>/chat-sessions/<YYYY-MM-DD>/<uuid>` —
/// and return its `(date, uuid)` tail. Anything else is refused: the discard
/// deletes the directory recursively, so it must never be pointed at a real
/// project.
pub fn private_scratch_tail(data_dir: &Path, working_dir: &Path) -> Option<(String, String)> {
    if !working_dir.is_absolute() {
        return None;
    }
    if working_dir
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return None;
    }
    let rest = working_dir
        .strip_prefix(data_dir.join("chat-sessions"))
        .ok()?;
    let parts: Vec<String> = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let [date, uuid] = parts.as_slice() else {
        return None;
    };
    let date_ok = date.len() == 10
        && date.chars().enumerate().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        });
    let uuid_ok = uuid.len() == 32 && uuid.chars().all(|c| c.is_ascii_hexdigit());
    (date_ok && uuid_ok).then(|| (date.clone(), uuid.clone()))
}

/// Claude Code's project-directory name for a cwd, as its SDK derives it:
/// every UTF-16 unit that is not `[A-Za-z0-9]` becomes `-`, and a name longer
/// than 200 units is cut to 200 and suffixed with a base-36 hash of the path.
pub fn claude_project_dir_name(cwd: &str) -> String {
    const MAX: usize = 200;
    let units: Vec<u16> = cwd.encode_utf16().collect();
    let sanitized: String = units
        .iter()
        .map(|&u| {
            let c = char::from_u32(u as u32).unwrap_or('-');
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.len() <= MAX {
        return sanitized;
    }
    let mut hash: i32 = 0;
    for &u in &units {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(u as i32);
    }
    format!(
        "{}-{}",
        &sanitized[..MAX],
        to_base36((hash as i64).unsigned_abs())
    )
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

/// Remove what Claude Code keeps about one session under its config dir. All
/// of these are keyed by the (unique) session id, so nothing else is touched;
/// the project directory itself is removed only when it is the scratch dir's
/// own and nothing is left in it.
pub fn remove_claude_session_leftovers(
    claude_config_dir: &Path,
    cwd: &str,
    session_id: &str,
    report: &mut PrivateSessionCleanup,
) {
    if !is_safe_session_id(session_id) {
        return;
    }
    let projects = claude_config_dir.join("projects");
    let own_project = projects.join(claude_project_dir_name(cwd));
    let mut project_dirs = vec![own_project.clone()];
    // The transcript normally sits in the cwd's own project dir, but the
    // encoding differs between versions (NFC, long-path hashing), so look it
    // up by name as well.
    if let Some(found) = crate::parsers::claude::find_session_file_in(&projects, session_id) {
        if let Some(dir) = found.parent() {
            if dir != own_project {
                project_dirs.push(dir.to_path_buf());
            }
        }
    }
    for dir in &project_dirs {
        report.remove_path(&dir.join(format!("{session_id}.jsonl")));
        // Sub-agent transcripts and tool results live next to the transcript.
        report.remove_path(&dir.join(session_id));
    }
    if own_project.is_dir()
        && std::fs::read_dir(&own_project)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
    {
        report.remove_path(&own_project);
    }
    for dir_name in ["session-env", "file-history"] {
        report.remove_path(&claude_config_dir.join(dir_name).join(session_id));
    }
    report.remove_path(
        &claude_config_dir
            .join("debug")
            .join(format!("{session_id}.txt")),
    );
    if let Ok(entries) = std::fs::read_dir(claude_config_dir.join("todos")) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(session_id) {
                report.remove_path(&entry.path());
            }
        }
    }
}

/// Remove codeg's own per-session records (turn timings, ACP transcripts of
/// custom agents) for one session id, under each `<root>/<agent>/` directory.
pub fn remove_codeg_session_records(
    roots: &[PathBuf],
    session_id: &str,
    report: &mut PrivateSessionCleanup,
) {
    if !is_safe_session_id(session_id) {
        return;
    }
    for root in roots {
        let Ok(agent_dirs) = std::fs::read_dir(root) else {
            continue;
        };
        for agent_dir in agent_dirs.flatten() {
            let path = agent_dir.path().join(format!("{session_id}.jsonl"));
            report.remove_path(&path);
        }
    }
}

/// Discard a private Quick Ask question. The caller has already disconnected
/// its agent. Removes the scratch directory (and its date directory when that
/// is left empty), then whatever the agent and codeg recorded about the
/// session. Refuses any directory that is not an unbound chat scratch dir.
pub async fn discard_private_session_core(
    conn: &sea_orm::DatabaseConnection,
    data_dir: &Path,
    claude_config_dir: &Path,
    codeg_record_roots: &[PathBuf],
    working_dir: &str,
    agent_type: Option<AgentType>,
    session_id: Option<&str>,
) -> Result<PrivateSessionCleanup, AppCommandError> {
    let dir = PathBuf::from(working_dir);
    let tail = private_scratch_tail(data_dir, &dir).ok_or_else(|| {
        AppCommandError::invalid_input("Not a private Quick Ask scratch directory")
            .with_detail(working_dir.to_string())
    })?;
    // A chat conversation that exists in the sidebar owns its directory; a
    // private question never creates one, so a match means a wrong path.
    let bound = folder_service::list_live_chat_folder_paths(conn)
        .await
        .map_err(AppCommandError::from)?
        .iter()
        .any(|path| {
            let path = Path::new(path);
            let uuid = path.file_name().map(|n| n.to_string_lossy().to_string());
            let date = path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string());
            date.as_deref() == Some(tail.0.as_str()) && uuid.as_deref() == Some(tail.1.as_str())
        });
    if bound {
        return Err(AppCommandError::invalid_input(
            "The directory belongs to a saved chat conversation",
        ));
    }

    let mut report = PrivateSessionCleanup::default();
    report.remove_path(&dir);
    if let Some(date_dir) = dir.parent() {
        if std::fs::read_dir(date_dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
        {
            report.remove_path(date_dir);
        }
    }

    if let Some(session_id) = session_id.filter(|id| is_safe_session_id(id)) {
        if agent_type == Some(AgentType::ClaudeCode) {
            remove_claude_session_leftovers(
                claude_config_dir,
                working_dir,
                session_id,
                &mut report,
            );
        }
        remove_codeg_session_records(codeg_record_roots, session_id, &mut report);
    }
    tracing::info!(
        removed = report.removed.len(),
        failed = report.failed.len(),
        "[quick-ask] discarded a private question"
    );
    Ok(report)
}

/// [`discard_private_session_core`] against the real Claude config dir and
/// codeg record roots.
pub async fn discard_private_session_default(
    conn: &sea_orm::DatabaseConnection,
    data_dir: &Path,
    working_dir: &str,
    agent_type: Option<AgentType>,
    session_id: Option<&str>,
) -> Result<PrivateSessionCleanup, AppCommandError> {
    let roots = [
        crate::paths::codeg_turn_timings_root(),
        crate::paths::codeg_acp_transcripts_root(),
    ];
    discard_private_session_core(
        conn,
        data_dir,
        &crate::parsers::claude::resolve_claude_config_dir(),
        &roots,
        working_dir,
        agent_type,
        session_id,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn discard_private_quick_ask(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    working_dir: String,
    agent_type: Option<AgentType>,
    session_id: Option<String>,
) -> Result<PrivateSessionCleanup, AppCommandError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|e| AppCommandError::io_error(e.to_string()))?;
    discard_private_session_default(
        &db.conn,
        &data_dir,
        &working_dir,
        agent_type,
        session_id.as_deref(),
    )
    .await
}

// ─── Desktop: settings, shortcut, window ────────────────────────────────

#[cfg(feature = "tauri-runtime")]
pub mod desktop {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    use sea_orm::DatabaseConnection;
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

    use super::{
        centered_origin, normalize_shortcut, quick_ask_route, toggle_action, workspace_backend_of,
        workspace_label_for, QuickAskSettings, QuickAskSettingsView, ToggleAction,
        QUICK_ASK_SETTINGS_KEY,
    };
    use crate::app_error::AppCommandError;
    use crate::db::service::{app_metadata_service, remote_workspace_connection_service};
    use crate::db::AppDatabase;

    pub const QUICK_ASK_WINDOW_LABEL: &str = "quick-ask";
    /// How long after launch the hidden window is built.
    const PRECREATE_DELAY: std::time::Duration = std::time::Duration::from_secs(3);
    /// Logical size of the window.
    const QUICK_ASK_WIDTH: f64 = 640.0;
    const QUICK_ASK_HEIGHT: f64 = 420.0;
    /// Matches the card's `rounded-xl` in the page, so the native vibrancy
    /// and shadow follow the same outline.
    #[cfg(target_os = "macos")]
    const QUICK_ASK_CORNER_RADIUS: f64 = 12.0;

    /// Emitted to the Quick Ask window each time it is shown.
    pub const QUICK_ASK_SHOWN_EVENT: &str = "quick-ask://shown";
    /// Poke to a workspace window: a conversation is waiting for it in
    /// [`quick_ask_take_pending_focus`].
    pub const QUICK_ASK_FOCUS_PENDING_EVENT: &str = "quick-ask://focus-pending";

    /// Read by the window-event handler on every blur, which is synchronous.
    static HIDE_ON_BLUR: AtomicBool = AtomicBool::new(true);
    /// The most recently focused workspace window (`main` /
    /// `remote-workspace-{id}`): the backend the next question goes to.
    static LAST_WORKSPACE: Mutex<Option<String>> = Mutex::new(None);
    /// Registration state of the shortcut: what is registered, or why not.
    static SHORTCUT: Mutex<ShortcutRuntime> = Mutex::new(ShortcutRuntime {
        registered: None,
        error: None,
    });
    /// Conversations "Open in codeg" handed to a workspace window, keyed by
    /// that window's label, until its bridge takes them.
    static PENDING_FOCUS: Mutex<Option<HashMap<String, Vec<QuickAskFocusRequest>>>> =
        Mutex::new(None);
    /// The Quick Ask window's remote instance id, stable for the process.
    static REMOTE_WINDOW_ID: OnceLock<String> = OnceLock::new();

    struct ShortcutRuntime {
        registered: Option<String>,
        error: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct QuickAskFocusRequest {
        pub folder_id: i32,
        pub conversation_id: i32,
        pub agent: String,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ShownPayload {
        remote_connection_id: Option<i32>,
        route: String,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct QuickAskContext {
        pub remote_connection_id: Option<i32>,
        pub route: String,
    }

    fn remote_window_id() -> &'static str {
        REMOTE_WINDOW_ID
            .get_or_init(crate::commands::remote_workspace::new_remote_window_instance_id)
    }

    /// Never errors: a row this build cannot read falls back to the defaults.
    pub async fn load_quick_ask_settings(conn: &DatabaseConnection) -> QuickAskSettings {
        match app_metadata_service::get_value(conn, QUICK_ASK_SETTINGS_KEY).await {
            Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|err| {
                tracing::warn!("[quick-ask] unreadable settings, using defaults: {err}");
                QuickAskSettings::default()
            }),
            Ok(None) => QuickAskSettings::default(),
            Err(err) => {
                tracing::warn!("[quick-ask] could not read settings, using defaults: {err}");
                QuickAskSettings::default()
            }
        }
    }

    async fn save_quick_ask_settings(
        conn: &DatabaseConnection,
        settings: &QuickAskSettings,
    ) -> Result<(), AppCommandError> {
        let raw = serde_json::to_string(settings).map_err(|e| {
            AppCommandError::invalid_input("Failed to serialize Quick Ask settings")
                .with_detail(e.to_string())
        })?;
        app_metadata_service::upsert_value(conn, QUICK_ASK_SETTINGS_KEY, &raw)
            .await
            .map_err(AppCommandError::from)
    }

    fn view_of(settings: &QuickAskSettings) -> QuickAskSettingsView {
        let runtime = SHORTCUT.lock().unwrap_or_else(|e| e.into_inner());
        QuickAskSettingsView {
            enabled: settings.enabled,
            shortcut: settings.shortcut.clone(),
            hide_on_blur: settings.hide_on_blur,
            registered: runtime.registered.is_some(),
            registration_error: runtime.error.clone(),
        }
    }

    /// Register (or unregister) the shortcut to match `settings`, replacing
    /// whatever this process registered before. A refusal — another app owns
    /// the combination, or the key name does not parse — is recorded for the
    /// settings screen instead of failing the caller.
    pub fn apply_quick_ask_settings(app: &AppHandle, settings: &QuickAskSettings) {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

        HIDE_ON_BLUR.store(settings.hide_on_blur, Ordering::Relaxed);
        let manager = app.global_shortcut();
        let mut runtime = SHORTCUT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = runtime.registered.take() {
            if let Err(err) = manager.unregister(previous.as_str()) {
                tracing::warn!("[quick-ask] could not unregister {previous}: {err}");
            }
        }
        runtime.error = None;
        if !settings.enabled {
            return;
        }
        let shortcut = settings.shortcut.clone();
        let registered = manager.on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
            // Runs with the plugin's shortcut table locked: it must never
            // register or unregister anything itself.
            if event.state == ShortcutState::Pressed {
                toggle_quick_ask(app);
            }
        });
        match registered {
            Ok(()) => {
                tracing::info!("[quick-ask] shortcut {shortcut} registered");
                runtime.registered = Some(shortcut);
            }
            Err(err) => {
                tracing::warn!("[quick-ask] shortcut {shortcut} not registered: {err}");
                runtime.error = Some(err.to_string());
            }
        }
    }

    /// Startup, from `setup` with the settings already loaded: register the
    /// saved shortcut, and pre-create the hidden window so the first press
    /// opens it instantly. The window is built a few seconds later so it does
    /// not compete with the workspace window for the first paint.
    pub fn init_quick_ask(app: &AppHandle, settings: &QuickAskSettings) {
        apply_quick_ask_settings(app, settings);
        if !settings.enabled {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PRECREATE_DELAY).await;
            if let Err(err) = ensure_quick_ask_window(&app) {
                tracing::warn!("[quick-ask] could not pre-create the window: {err:?}");
            }
        });
    }

    /// Record the workspace window the user is working in. Called for every
    /// `Focused(true)` event; non-workspace windows are ignored.
    pub fn note_window_focused(label: &str) {
        if workspace_backend_of(label).is_some() {
            *LAST_WORKSPACE.lock().unwrap_or_else(|e| e.into_inner()) = Some(label.to_string());
        }
    }

    pub fn hide_on_blur() -> bool {
        HIDE_ON_BLUR.load(Ordering::Relaxed)
    }

    /// The backend the next question goes to: the last focused workspace
    /// window if it is still open, otherwise any open workspace (local first),
    /// otherwise local.
    fn current_backend(app: &AppHandle) -> Option<i32> {
        let last = LAST_WORKSPACE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(label) = last {
            if app.get_webview_window(&label).is_some() {
                if let Some(backend) = workspace_backend_of(&label) {
                    return backend;
                }
            }
        }
        if app.get_webview_window("main").is_some() {
            return None;
        }
        let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
        labels.sort();
        labels
            .iter()
            .find_map(|label| workspace_backend_of(label).flatten())
    }

    /// Build the window, hidden, if it does not exist yet.
    fn ensure_quick_ask_window(app: &AppHandle) -> Result<tauri::WebviewWindow, AppCommandError> {
        if let Some(window) = app.get_webview_window(QUICK_ASK_WINDOW_LABEL) {
            return Ok(window);
        }
        let backend = current_backend(app);
        let route = quick_ask_route(backend, remote_window_id());
        let builder =
            WebviewWindowBuilder::new(app, QUICK_ASK_WINDOW_LABEL, WebviewUrl::App(route.into()))
                .title("Quick Ask")
                .inner_size(QUICK_ASK_WIDTH, QUICK_ASK_HEIGHT)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(true)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .visible(false)
                .focused(false)
                .accept_first_mouse(true);
        #[cfg(target_os = "macos")]
        let builder = {
            use tauri::window::{Effect, EffectState, EffectsBuilder};
            builder.effects(
                EffectsBuilder::new()
                    .effect(Effect::Popover)
                    .state(EffectState::Active)
                    .radius(QUICK_ASK_CORNER_RADIUS)
                    .build(),
            )
        };
        let window = builder.build().map_err(|e| {
            AppCommandError::window("Failed to create the Quick Ask window", e.to_string())
        })?;
        if let Some(proxy) =
            app.try_state::<std::sync::Arc<crate::commands::remote_proxy::RemoteProxyState>>()
        {
            proxy
                .inner()
                .register_window_instance_cleanup(&window, remote_window_id().to_string());
        }
        crate::commands::windows::post_window_setup(&window);
        Ok(window)
    }

    /// Centre the window on the work area of the screen the pointer is on.
    fn place_on_active_screen(app: &AppHandle, window: &tauri::WebviewWindow) {
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else {
            let _ = window.center();
            return;
        };
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let (x, y) = centered_origin(
            area.position.x as f64 / scale,
            area.position.y as f64 / scale,
            area.size.width as f64 / scale,
            area.size.height as f64 / scale,
            QUICK_ASK_WIDTH,
            QUICK_ASK_HEIGHT,
        );
        let _ = window.set_position(LogicalPosition::new(x, y));
    }

    fn show_quick_ask(app: &AppHandle, window: &tauri::WebviewWindow) {
        #[cfg(target_os = "macos")]
        frontmost::remember();
        place_on_active_screen(app, window);
        let _ = window.show();
        let _ = window.set_focus();
        let backend = current_backend(app);
        let payload = ShownPayload {
            remote_connection_id: backend,
            route: quick_ask_route(backend, remote_window_id()),
        };
        let _ = app.emit_to(QUICK_ASK_WINDOW_LABEL, QUICK_ASK_SHOWN_EVENT, payload);
    }

    /// Hide the window. `return_focus` hands focus back to the app that was
    /// frontmost before the window opened (macOS), which is what a dismissal
    /// means; "Open in codeg" passes `false` because it just focused codeg.
    fn hide_quick_ask(window: &tauri::WebviewWindow, return_focus: bool) {
        let _ = window.hide();
        #[cfg(target_os = "macos")]
        {
            if return_focus {
                frontmost::restore();
            } else {
                frontmost::forget();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = return_focus;
    }

    /// The shortcut's action: show and focus the window, or hide it when it
    /// is already frontmost.
    pub fn toggle_quick_ask(app: &AppHandle) {
        let window = match ensure_quick_ask_window(app) {
            Ok(window) => window,
            Err(err) => {
                tracing::warn!("[quick-ask] cannot open the window: {err:?}");
                return;
            }
        };
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        match toggle_action(visible, focused) {
            ToggleAction::Show => show_quick_ask(app, &window),
            ToggleAction::Hide => hide_quick_ask(&window, true),
        }
    }

    /// Click-outside dismissal, from the window-event handler.
    pub fn hide_quick_ask_on_blur(app: &AppHandle) {
        if !hide_on_blur() {
            return;
        }
        if let Some(window) = app.get_webview_window(QUICK_ASK_WINDOW_LABEL) {
            // Focus already went where the user clicked: nothing to hand back.
            let _ = window.hide();
            #[cfg(target_os = "macos")]
            frontmost::forget();
        }
    }

    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn get_quick_ask_settings(
        db: tauri::State<'_, AppDatabase>,
    ) -> Result<QuickAskSettingsView, AppCommandError> {
        let settings = load_quick_ask_settings(&db.conn).await;
        Ok(view_of(&settings))
    }

    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn update_quick_ask_settings(
        app: AppHandle,
        db: tauri::State<'_, AppDatabase>,
        enabled: bool,
        shortcut: String,
        hide_on_blur: bool,
    ) -> Result<QuickAskSettingsView, AppCommandError> {
        let shortcut = normalize_shortcut(&shortcut).map_err(|reason| {
            AppCommandError::invalid_input("Invalid shortcut").with_detail(reason)
        })?;
        let settings = QuickAskSettings {
            enabled,
            shortcut,
            hide_on_blur,
        };
        save_quick_ask_settings(&db.conn, &settings).await?;
        apply_quick_ask_settings(&app, &settings);
        if settings.enabled {
            let _ = ensure_quick_ask_window(&app);
        } else if let Some(window) = app.get_webview_window(QUICK_ASK_WINDOW_LABEL) {
            let _ = window.hide();
        }
        Ok(view_of(&settings))
    }

    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn toggle_quick_ask_window(app: AppHandle) -> Result<(), AppCommandError> {
        toggle_quick_ask(&app);
        Ok(())
    }

    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn hide_quick_ask_window(app: AppHandle) -> Result<(), AppCommandError> {
        if let Some(window) = app.get_webview_window(QUICK_ASK_WINDOW_LABEL) {
            hide_quick_ask(&window, true);
        }
        Ok(())
    }

    /// The backend the window should be on right now, for a page that mounts
    /// without having seen a `shown` event.
    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn quick_ask_context(app: AppHandle) -> Result<QuickAskContext, AppCommandError> {
        let backend = current_backend(&app);
        Ok(QuickAskContext {
            remote_connection_id: backend,
            route: quick_ask_route(backend, remote_window_id()),
        })
    }

    /// "Open in codeg": bring the workspace window of the question's backend
    /// forward (rebuilding it if it was closed) and hand it the conversation.
    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn quick_ask_open_conversation(
        app: AppHandle,
        db: tauri::State<'_, AppDatabase>,
        remote_connection_id: Option<i32>,
        folder_id: i32,
        conversation_id: i32,
        agent: String,
    ) -> Result<(), AppCommandError> {
        let label = workspace_label_for(remote_connection_id);
        {
            let mut pending = PENDING_FOCUS.lock().unwrap_or_else(|e| e.into_inner());
            pending
                .get_or_insert_with(HashMap::new)
                .entry(label.clone())
                .or_default()
                .push(QuickAskFocusRequest {
                    folder_id,
                    conversation_id,
                    agent,
                });
        }
        match remote_connection_id {
            None => crate::commands::workspace_windows::show_local_workspace_window(&app),
            Some(id) => {
                if app.get_webview_window(&label).is_some() {
                    crate::commands::windows::show_and_focus_window(&app, &label);
                } else {
                    let connection = remote_workspace_connection_service::get(&db.conn, id)
                        .await
                        .map_err(AppCommandError::db)?
                        .ok_or_else(|| {
                            AppCommandError::not_found(format!("Remote connection {id} not found"))
                        })?;
                    crate::commands::remote_workspace::show_remote_workspace_window(
                        &app,
                        &connection,
                    )?;
                }
            }
        }
        if let Some(window) = app.get_webview_window(QUICK_ASK_WINDOW_LABEL) {
            hide_quick_ask(&window, false);
        }
        // A window already running takes it now; one still loading drains the
        // slot when its bridge mounts.
        let _ = app.emit_to(label.as_str(), QUICK_ASK_FOCUS_PENDING_EVENT, ());
        Ok(())
    }

    /// Take the conversations waiting for the calling workspace window.
    #[cfg_attr(feature = "tauri-runtime", tauri::command)]
    pub async fn quick_ask_take_pending_focus(
        window: tauri::WebviewWindow,
    ) -> Result<Vec<QuickAskFocusRequest>, AppCommandError> {
        let mut pending = PENDING_FOCUS.lock().unwrap_or_else(|e| e.into_inner());
        Ok(pending
            .as_mut()
            .and_then(|map| map.remove(window.label()))
            .unwrap_or_default())
    }

    /// Hand focus back to the app that was frontmost before the window opened.
    #[cfg(target_os = "macos")]
    mod frontmost {
        use std::sync::Mutex;

        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

        static PREVIOUS: Mutex<Option<i32>> = Mutex::new(None);

        pub fn remember() {
            let front = NSWorkspace::sharedWorkspace().frontmostApplication();
            let own = NSRunningApplication::currentApplication().processIdentifier();
            let previous = front
                .map(|app| app.processIdentifier())
                .filter(|pid| *pid > 0 && *pid != own);
            let mut slot = PREVIOUS.lock().unwrap_or_else(|e| e.into_inner());
            // A press while the window is already up (not focused) keeps the
            // app recorded by the first one.
            if previous.is_some() {
                *slot = previous;
            }
        }

        pub fn restore() {
            let pid = PREVIOUS.lock().unwrap_or_else(|e| e.into_inner()).take();
            let Some(pid) = pid else { return };
            if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
                let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
            }
        }

        pub fn forget() {
            *PREVIOUS.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_on_with_option_space() {
        let settings = QuickAskSettings::default();
        assert!(settings.enabled);
        assert!(settings.hide_on_blur);
        assert_eq!(settings.shortcut, "Alt+Space");
    }

    #[test]
    fn partial_settings_rows_fill_in_defaults() {
        let parsed: QuickAskSettings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!parsed.enabled);
        assert_eq!(parsed.shortcut, DEFAULT_QUICK_ASK_SHORTCUT);
        assert!(parsed.hide_on_blur);
    }

    #[test]
    fn shortcuts_need_a_modifier_and_one_key() {
        assert_eq!(normalize_shortcut(" Alt + Space ").unwrap(), "Alt+Space");
        assert_eq!(
            normalize_shortcut("Control+Shift+KeyK").unwrap(),
            "Control+Shift+KeyK"
        );
        assert!(normalize_shortcut("").is_err());
        assert!(normalize_shortcut("Space").is_err());
        assert!(normalize_shortcut("Alt+Shift").is_err());
        assert!(normalize_shortcut("KeyA+Space").is_err());
    }

    #[test]
    fn toggle_hides_only_a_frontmost_window() {
        assert_eq!(toggle_action(false, false), ToggleAction::Show);
        assert_eq!(toggle_action(true, false), ToggleAction::Show);
        assert_eq!(toggle_action(true, true), ToggleAction::Hide);
        // A hidden window cannot be focused, but a stale focus flag must not
        // turn a press into a hide.
        assert_eq!(toggle_action(false, true), ToggleAction::Show);
    }

    #[test]
    fn centers_in_the_work_area() {
        assert_eq!(
            centered_origin(0.0, 25.0, 1440.0, 875.0, 640.0, 420.0),
            (400.0, 253.0)
        );
        // Second monitor to the left of the primary one.
        assert_eq!(
            centered_origin(-1920.0, 0.0, 1920.0, 1080.0, 640.0, 420.0),
            (-1280.0, 330.0)
        );
        // Never starts outside a work area smaller than the window.
        assert_eq!(
            centered_origin(100.0, 50.0, 500.0, 300.0, 640.0, 420.0),
            (100.0, 50.0)
        );
    }

    #[test]
    fn workspace_labels_map_to_backends() {
        assert_eq!(workspace_backend_of("main"), Some(None));
        assert_eq!(workspace_backend_of("remote-workspace-7"), Some(Some(7)));
        assert_eq!(workspace_backend_of("remote-workspace-x"), None);
        assert_eq!(workspace_backend_of("settings"), None);
        assert_eq!(workspace_backend_of("quick-ask"), None);
        assert_eq!(workspace_label_for(None), "main");
        assert_eq!(workspace_label_for(Some(3)), "remote-workspace-3");
    }

    #[test]
    fn routes_carry_the_remote_identity() {
        assert_eq!(quick_ask_route(None, "rw-1"), "quick-ask");
        assert_eq!(
            quick_ask_route(Some(4), "rw-1"),
            "quick-ask?remoteConnectionId=4&remoteWindowId=rw-1"
        );
    }

    #[test]
    fn session_ids_are_file_name_safe() {
        assert!(is_safe_session_id("0b7c4e52-9a1f-4d7e-8c3b-2f6a1d9e0c11"));
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("../etc"));
        assert!(!is_safe_session_id("a/b"));
        assert!(!is_safe_session_id(&"a".repeat(129)));
    }

    #[test]
    fn only_chat_scratch_dirs_are_accepted() {
        let data = Path::new("/data/app.codeg");
        let ok = data.join("chat-sessions/2026-09-29/0123456789abcdef0123456789abcdef");
        assert_eq!(
            private_scratch_tail(data, &ok),
            Some((
                "2026-09-29".to_string(),
                "0123456789abcdef0123456789abcdef".to_string()
            ))
        );
        for bad in [
            "/data/app.codeg/chat-sessions/2026-09-29",
            "/data/app.codeg/chat-sessions/2026-09-29/not-a-uuid",
            "/data/app.codeg/chat-sessions/2026-9-29/0123456789abcdef0123456789abcdef",
            "/data/app.codeg/chat-sessions/2026-09-29/0123456789abcdef0123456789abcdef/sub",
            "/data/app.codeg/chat-sessions/2026-09-29/../../../home",
            "/Users/me/project",
            "relative/chat-sessions/2026-09-29/0123456789abcdef0123456789abcdef",
        ] {
            assert_eq!(private_scratch_tail(data, Path::new(bad)), None, "{bad}");
        }
    }

    #[test]
    fn claude_project_names_follow_the_sdk_encoding() {
        assert_eq!(
            claude_project_dir_name("/Users/me/Library/Application Support/app.codeg"),
            "-Users-me-Library-Application-Support-app-codeg"
        );
        // Expected values computed with the SDK's own `sh()`.
        assert_eq!(claude_project_dir_name("/tmp/é-x"), "-tmp---x");
        let long = format!("/tmp/{}", "a".repeat(250));
        assert_eq!(
            claude_project_dir_name(&long),
            format!("-tmp-{}-bxbzwn", "a".repeat(195))
        );
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn claude_leftovers_are_removed_by_session_id_only() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path();
        let cwd = "/data/app.codeg/chat-sessions/2026-09-29/0123456789abcdef0123456789abcdef";
        let sid = "11111111-2222-3333-4444-555555555555";
        let project = config.join("projects").join(claude_project_dir_name(cwd));
        touch(&project.join(format!("{sid}.jsonl")));
        touch(&project.join(sid).join("subagents/agent-1.jsonl"));
        touch(&config.join("todos").join(format!("{sid}-agent-{sid}.json")));
        touch(&config.join("session-env").join(sid).join("env"));
        // Someone else's session and a real project stay.
        let other = config.join("projects/-Users-me-project/other.jsonl");
        touch(&other);
        touch(&config.join("todos/other-agent-other.json"));

        let mut report = PrivateSessionCleanup::default();
        remove_claude_session_leftovers(config, cwd, sid, &mut report);

        assert!(!project.exists(), "empty scratch project dir is removed");
        assert!(!config
            .join("todos")
            .join(format!("{sid}-agent-{sid}.json"))
            .exists());
        assert!(!config.join("session-env").join(sid).exists());
        assert!(other.exists());
        assert!(config.join("todos/other-agent-other.json").exists());
        assert!(report.failed.is_empty());
        assert!(report.removed.len() >= 4);
    }

    #[tokio::test]
    async fn discarding_a_private_question_removes_its_scratch_dir() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let dir = crate::commands::conversations::create_chat_dir_core(data.path()).unwrap();
        std::fs::write(Path::new(&dir).join("notes.txt"), b"scratch").unwrap();
        let sid = "11111111-2222-3333-4444-555555555555";
        let project = config
            .path()
            .join("projects")
            .join(claude_project_dir_name(&dir));
        touch(&project.join(format!("{sid}.jsonl")));

        let report = discard_private_session_core(
            &db.conn,
            data.path(),
            config.path(),
            &[],
            &dir,
            Some(AgentType::ClaudeCode),
            Some(sid),
        )
        .await
        .expect("discard succeeds");

        assert!(!Path::new(&dir).exists());
        // The date directory held only this question, so it goes too.
        assert!(!Path::new(&dir).parent().unwrap().exists());
        assert!(!project.exists());
        assert!(report.failed.is_empty());
        assert!(report.removed.iter().any(|p| p == &dir));
    }

    #[tokio::test]
    async fn discard_refuses_a_saved_chat_and_any_other_directory() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let data = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        let saved = crate::commands::conversations::create_chat_conversation_core(
            &db.conn,
            data.path(),
            AgentType::ClaudeCode,
            Some("kept".to_string()),
            None,
        )
        .await
        .unwrap();
        let saved_dir = saved.folder.path.clone();
        let refused = discard_private_session_core(
            &db.conn,
            data.path(),
            config.path(),
            &[],
            &saved_dir,
            Some(AgentType::ClaudeCode),
            None,
        )
        .await;
        assert!(refused.is_err());
        assert!(Path::new(&saved_dir).exists());

        let project = tempfile::tempdir().unwrap();
        let refused = discard_private_session_core(
            &db.conn,
            data.path(),
            config.path(),
            &[],
            &project.path().to_string_lossy(),
            None,
            None,
        )
        .await;
        assert!(refused.is_err());
        assert!(project.path().exists());
    }

    #[test]
    fn codeg_records_are_removed_per_agent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("turn-timings");
        let sid = "abc-123";
        touch(&root.join("cursor").join(format!("{sid}.jsonl")));
        touch(&root.join("cursor").join("keep.jsonl"));
        let mut report = PrivateSessionCleanup::default();
        remove_codeg_session_records(std::slice::from_ref(&root), sid, &mut report);
        assert!(!root.join("cursor").join(format!("{sid}.jsonl")).exists());
        assert!(root.join("cursor/keep.jsonl").exists());
        assert_eq!(report.removed.len(), 1);
    }
}
