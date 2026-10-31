//! Talk on this Mac (`crate::talk::voice`): the commands of the window that
//! holds a Talk, the speech models and the preferences, and the desktop glue
//! around the relay: the helper's messages go to the window that holds the
//! Talk, a Talk ends when that window closes or reloads, read-aloud steps
//! aside while one runs, a local session reports `talking` presence, and the
//! global shortcut mutes, pushes to talk, or starts a Talk.
//!
//! Desktop only. The microphone and the speakers are this Mac's, and a session
//! on a remote server is driven by its window here, so every call goes to this
//! Mac's own backend (`getShellTransport()` in `src/lib/talk-voice/api.ts`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::presence::{self, PresenceReport};
use crate::talk::voice::models::{ModelsError, TalkModelsStatus};
use crate::talk::voice::prefs::{load_prefs, save_prefs, TalkVoicePrefs};
use crate::talk::voice::{
    self, StartRequest, TalkHost, TalkStarted, TalkVoiceError, TalkVoiceService, TalkVoiceStatus,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// The models' status, to every window, when a download starts or stops or
/// a pack is deleted.
pub const TALK_MODELS_EVENT: &str = "talk-voice://models";

/// Error keys the Talk UI branches on (`src/lib/talk-voice/api.ts`).
pub const TALK_VOICE_I18N_KEY_UNSUPPORTED: &str = "talkVoice.unsupported";
pub const TALK_VOICE_I18N_KEY_MODELS_MISSING: &str = "talkVoice.modelsMissing";

/// A shortcut press shorter than this is a tap (mute), longer is push to talk.
const TAP: Duration = Duration::from_millis(300);

impl From<TalkVoiceError> for AppCommandError {
    fn from(err: TalkVoiceError) -> Self {
        let message = err.to_string();
        match err {
            TalkVoiceError::Unsupported(_) => AppCommandError::dependency_missing(message)
                .with_i18n(TALK_VOICE_I18N_KEY_UNSUPPORTED, Default::default()),
            TalkVoiceError::ModelsMissing => AppCommandError::configuration_missing(message)
                .with_i18n(TALK_VOICE_I18N_KEY_MODELS_MISSING, Default::default()),
            TalkVoiceError::NotRunning => AppCommandError::not_found(message),
            TalkVoiceError::NotOwner => AppCommandError::permission_denied(message),
            TalkVoiceError::InvalidInput(_) => AppCommandError::invalid_input(message),
            TalkVoiceError::Helper(_) => AppCommandError::task_execution_failed(message),
        }
    }
}

impl From<ModelsError> for AppCommandError {
    fn from(err: ModelsError) -> Self {
        let message = err.to_string();
        match err {
            ModelsError::Catalog(_) => AppCommandError::configuration_invalid(message),
            ModelsError::UnknownPack(_) => AppCommandError::not_found(message),
            ModelsError::Io(e) => AppCommandError::io(e),
        }
    }
}

fn desktop_data_dir(app: &AppHandle) -> PathBuf {
    let base = app.path().app_data_dir().unwrap_or_default();
    crate::paths::resolve_effective_data_dir(&base)
}

/// The app around the relay.
struct DesktopHost {
    app: AppHandle,
    data_dir: PathBuf,
}

impl TalkHost for DesktopHost {
    fn deliver(&self, window: &str, payload: &Value) {
        if let Err(e) =
            self.app
                .emit_to(EventTarget::webview(window), voice::MESSAGE_EVENT, payload)
        {
            tracing::warn!("[talk-voice] could not deliver to {window}: {e}");
        }
    }

    fn talk_active(&self, active: bool) {
        let tts = crate::tts::service_for(&self.data_dir);
        tts.set_talk_active(active);
        if active {
            // Its ~0.9 GB go back before Talk loads its own models.
            tauri::async_runtime::spawn(async move { tts.stop_engine().await });
        }
    }

    fn presence(&self, key: &str, conversation_id: i32, talking: bool) {
        if talking {
            presence::report_window(
                key,
                PresenceReport {
                    visible: false,
                    focused: false,
                    idle_secs: 0,
                    conversation_ids: vec![conversation_id],
                    talking: true,
                },
            );
        } else {
            presence::forget_window(key);
        }
    }

    fn status_changed(&self, status: &TalkVoiceStatus) {
        emit_event(
            &EventEmitter::Tauri(self.app.clone()),
            voice::STATUS_EVENT,
            status,
        );
    }

    fn set_talk_mode(
        &self,
        conversation_id: i32,
        enabled: bool,
    ) -> BoxFuture<'static, Result<(), String>> {
        let app = self.app.clone();
        Box::pin(async move {
            let db = app.state::<AppDatabase>().conn.clone();
            let manager = app
                .state::<crate::acp::manager::ConnectionManager>()
                .clone_ref();
            crate::talk::set_conversation_talk_mode_core(
                &db,
                &EventEmitter::Tauri(app.clone()),
                &manager,
                conversation_id,
                enabled,
            )
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn store_report(&self, report: Value) -> Result<(), String> {
        crate::commands::client_diagnostics::report_client_diagnostic_core(
            &crate::paths::codeg_client_diagnostics_root(),
            report,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }
}

/// The service, with this app as its host.
pub fn desktop_service(app: &AppHandle) -> Arc<TalkVoiceService> {
    let data_dir = desktop_data_dir(app);
    let service = voice::service_for(&data_dir);
    service.set_host(|| {
        Arc::new(DesktopHost {
            app: app.clone(),
            data_dir: data_dir.clone(),
        })
    });
    service.models().on_change(|| {
        let emitter = EventEmitter::Tauri(app.clone());
        Arc::new(move |status: TalkModelsStatus| emit_event(&emitter, TALK_MODELS_EVENT, &status))
    });
    service
}

// ── Windows ──

/// The windows a conversation can be talked to from.
fn is_workspace_window(label: &str) -> bool {
    label == "main"
        || label.starts_with(crate::commands::remote_workspace::REMOTE_WORKSPACE_LABEL_PREFIX)
}

/// The workspace window last focused: where the shortcut starts a Talk.
static LAST_WORKSPACE: Mutex<Option<String>> = Mutex::new(None);

/// Called for every `Focused(true)`.
pub fn note_window_focused(label: &str) {
    if is_workspace_window(label) {
        *LAST_WORKSPACE.lock().unwrap_or_else(|e| e.into_inner()) = Some(label.to_string());
    }
}

/// A window was destroyed, or its page started loading again: the Talk it
/// holds ends.
pub fn window_gone(label: &str) {
    let Some(service) = voice::running_service() else {
        return;
    };
    if !service.active().is_some_and(|talk| talk.window == label) {
        return;
    }
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        service.window_gone(&label).await;
    });
}

/// The workspace window in front, else the one last focused, else `main`.
fn workspace_in_front(app: &AppHandle) -> Option<String> {
    let windows = app.webview_windows();
    if let Some(label) = windows
        .iter()
        .find(|(label, window)| is_workspace_window(label) && window.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone())
    {
        return Some(label);
    }
    let last = LAST_WORKSPACE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    last.filter(|label| windows.contains_key(label))
        .or_else(|| windows.contains_key("main").then(|| "main".to_string()))
}

// ── The global shortcut ──

struct ShortcutRuntime {
    registered: Option<String>,
    error: Option<String>,
}

/// What is registered, or why not. Never locked by the shortcut's handler,
/// which runs under the plugin's own lock.
static SHORTCUT: Mutex<ShortcutRuntime> = Mutex::new(ShortcutRuntime {
    registered: None,
    error: None,
});

/// When the key went down while a Talk ran.
static PRESSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn shortcut_runtime() -> std::sync::MutexGuard<'static, ShortcutRuntime> {
    SHORTCUT.lock().unwrap_or_else(|e| e.into_inner())
}

fn pressed_at() -> std::sync::MutexGuard<'static, Option<Instant>> {
    PRESSED_AT.lock().unwrap_or_else(|e| e.into_inner())
}

/// Down: push to talk in the Talk running; with none, the window in front
/// starts one on its session.
fn shortcut_pressed(app: &AppHandle) {
    let service = desktop_service(app);
    if service.active().is_some() {
        *pressed_at() = Some(Instant::now());
        service.control(json!({"type": "control", "op": "press", "down": true}));
        return;
    }
    *pressed_at() = None;
    match workspace_in_front(app) {
        Some(label) => {
            if let Err(e) = app.emit_to(
                EventTarget::webview(&label),
                voice::SHORTCUT_EVENT,
                json!({"action": "start"}),
            ) {
                tracing::warn!("[talk-voice] could not ask {label} to start a Talk: {e}");
            }
        }
        None => tracing::info!("[talk-voice] shortcut pressed with no workspace window"),
    }
}

/// Up: the end of push to talk; a tap also mutes or unmutes.
fn shortcut_released(app: &AppHandle) {
    let Some(down_at) = pressed_at().take() else {
        return;
    };
    let service = desktop_service(app);
    service.control(json!({"type": "control", "op": "press", "down": false}));
    if down_at.elapsed() < TAP {
        service.control(json!({"type": "control", "op": "toggleMute"}));
    }
}

/// Register (or unregister) the shortcut to match `prefs`, replacing what was
/// registered before. A refusal (another app owns the combination) is kept
/// for the settings screen.
pub fn apply_shortcut(app: &AppHandle, prefs: &TalkVoicePrefs) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let manager = app.global_shortcut();
    let mut runtime = shortcut_runtime();
    if let Some(previous) = runtime.registered.take() {
        if let Err(e) = manager.unregister(previous.as_str()) {
            tracing::warn!("[talk-voice] could not unregister {previous}: {e}");
        }
    }
    runtime.error = None;
    *pressed_at() = None;
    if !prefs.shortcut_enabled {
        return;
    }
    // Where Talk can't run, the combination stays free for other apps.
    let status = desktop_service(app).status();
    if !status.supported {
        runtime.error = status.unsupported_reason;
        return;
    }
    let shortcut = prefs.shortcut.clone();
    let registered = manager.on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
        // Runs with the plugin's table locked: never (un)register from here.
        match event.state {
            ShortcutState::Pressed => shortcut_pressed(app),
            ShortcutState::Released => shortcut_released(app),
        }
    });
    match registered {
        Ok(()) => {
            tracing::info!("[talk-voice] shortcut {shortcut} registered");
            runtime.registered = Some(shortcut);
        }
        Err(e) => {
            tracing::warn!("[talk-voice] shortcut {shortcut} not registered: {e}");
            runtime.error = Some(e.to_string());
        }
    }
}

/// Startup: the host, and the saved shortcut.
pub fn init_talk_voice(app: &AppHandle, prefs: &TalkVoicePrefs) {
    desktop_service(app);
    apply_shortcut(app, prefs);
}

/// The preferences, and whether the shortcut is registered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkVoicePrefsView {
    #[serde(flatten)]
    pub prefs: TalkVoicePrefs,
    pub shortcut_registered: bool,
    pub shortcut_error: Option<String>,
}

fn prefs_view(prefs: TalkVoicePrefs) -> TalkVoicePrefsView {
    let runtime = shortcut_runtime();
    TalkVoicePrefsView {
        prefs,
        shortcut_registered: runtime.registered.is_some(),
        shortcut_error: runtime.error.clone(),
    }
}

// ── Commands ──

/// The status; `refreshProbe` runs the helper's check again (after the
/// microphone was allowed, say) and waits for it. Otherwise the first call
/// starts the check in the background and its result arrives as a status
/// event.
#[tauri::command]
pub async fn talk_voice_status(
    app: AppHandle,
    refresh_probe: Option<bool>,
) -> Result<TalkVoiceStatus, AppCommandError> {
    let service = desktop_service(&app);
    if refresh_probe.unwrap_or(false) {
        return Ok(service.probe(true).await);
    }
    service.ensure_probe();
    Ok(service.status())
}

/// Start a Talk held by the calling window (replacing any Talk running).
#[tauri::command]
pub async fn talk_voice_start(
    app: AppHandle,
    webview: tauri::Webview,
    conversation_id: i32,
    local: bool,
    message: Value,
) -> Result<TalkStarted, AppCommandError> {
    let service = desktop_service(&app);
    Ok(service
        .start(StartRequest {
            window: webview.label().to_string(),
            conversation_id,
            local,
            message,
        })
        .await?)
}

/// Messages for the helper, in order, from the window that holds Talk
/// `talk_id`. One call carries a batch: separate invokes are not handled in
/// the order they were made, so the window queues its messages and sends
/// what gathered while the previous call was in flight.
#[tauri::command]
pub async fn talk_voice_send(
    app: AppHandle,
    webview: tauri::Webview,
    talk_id: u64,
    messages: Vec<Value>,
) -> Result<(), AppCommandError> {
    let service = desktop_service(&app);
    for message in messages {
        service.send(webview.label(), talk_id, message)?;
    }
    Ok(())
}

/// End Talk `talk_id`. A Talk that already ended is not an error.
#[tauri::command]
pub async fn talk_voice_stop(
    app: AppHandle,
    webview: tauri::Webview,
    talk_id: u64,
) -> Result<(), AppCommandError> {
    match desktop_service(&app).stop(webview.label(), talk_id).await {
        Ok(()) | Err(TalkVoiceError::NotRunning) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub async fn talk_models_status(app: AppHandle) -> Result<TalkModelsStatus, AppCommandError> {
    Ok(desktop_service(&app).models().status())
}

/// Download the packs named (the required ones when none is).
#[tauri::command]
pub async fn talk_models_download(
    app: AppHandle,
    packs: Option<Vec<String>>,
) -> Result<TalkModelsStatus, AppCommandError> {
    let service = desktop_service(&app);
    Ok(service
        .models()
        .start_download(&packs.unwrap_or_default())?)
}

/// Stop downloading the packs named (all when none is).
#[tauri::command]
pub async fn talk_models_cancel(
    app: AppHandle,
    packs: Option<Vec<String>>,
) -> Result<TalkModelsStatus, AppCommandError> {
    let service = desktop_service(&app);
    Ok(service
        .models()
        .cancel_download(&packs.unwrap_or_default())
        .await?)
}

/// Delete the packs named (all when none is).
#[tauri::command]
pub async fn talk_models_delete(
    app: AppHandle,
    packs: Option<Vec<String>>,
) -> Result<TalkModelsStatus, AppCommandError> {
    let service = desktop_service(&app);
    Ok(service.models().delete(&packs.unwrap_or_default()).await?)
}

#[tauri::command]
pub async fn talk_voice_prefs_get(
    db: State<'_, AppDatabase>,
) -> Result<TalkVoicePrefsView, AppCommandError> {
    Ok(prefs_view(load_prefs(&db.conn).await))
}

/// Store the preferences and register the shortcut they name.
#[tauri::command]
pub async fn talk_voice_prefs_update(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    prefs: TalkVoicePrefs,
) -> Result<TalkVoicePrefsView, AppCommandError> {
    let saved = save_prefs(&db.conn, prefs).await?;
    apply_shortcut(&app, &saved);
    Ok(prefs_view(saved))
}

/// System Settings › Privacy & Security › Microphone, where codeg's access
/// is switched on when it was refused.
pub const MIC_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

#[tauri::command]
pub async fn talk_voice_open_mic_settings() -> Result<(), AppCommandError> {
    #[cfg(target_os = "macos")]
    {
        let status = crate::process::std_command("open")
            .arg(MIC_SETTINGS_URL)
            .status()
            .map_err(AppCommandError::io)?;
        if !status.success() {
            return Err(AppCommandError::task_execution_failed(
                "Could not open the microphone settings",
            ));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(AppCommandError::dependency_missing(
            "Talk on this Mac runs on macOS only",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    #[test]
    fn errors_map_to_codes_the_ui_can_branch_on() {
        let e = AppCommandError::from(TalkVoiceError::ModelsMissing);
        assert!(matches!(e.code, AppErrorCode::ConfigurationMissing));
        assert_eq!(
            e.i18n_key.as_deref(),
            Some(TALK_VOICE_I18N_KEY_MODELS_MISSING)
        );
        let e = AppCommandError::from(TalkVoiceError::Unsupported("protocol".into()));
        assert!(matches!(e.code, AppErrorCode::DependencyMissing));
        assert_eq!(e.i18n_key.as_deref(), Some(TALK_VOICE_I18N_KEY_UNSUPPORTED));
        assert!(matches!(
            AppCommandError::from(TalkVoiceError::NotOwner).code,
            AppErrorCode::PermissionDenied
        ));
        assert!(matches!(
            AppCommandError::from(ModelsError::UnknownPack("x".into())).code,
            AppErrorCode::NotFound
        ));
    }

    #[test]
    fn talk_runs_from_workspace_windows_only() {
        assert!(is_workspace_window("main"));
        assert!(is_workspace_window("remote-workspace-4"));
        assert!(!is_workspace_window("settings"));
        assert!(!is_workspace_window("quick-ask"));
    }
}
