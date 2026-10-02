//! Desktop commands for iPhone push (`crate::push`) and client presence
//! (`crate::presence`). The web handlers in `web/handlers/push.rs` call the
//! same functions.

use tauri::State;

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::presence::PresenceReport;
use crate::push::prefs::DevicePrefs;
use crate::push::{
    self, PushDeviceView, PushSettings, PushSettingsView, RegisterDevice, RegisteredDevice,
    TestPushResult,
};

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_push_settings(
    db: State<'_, AppDatabase>,
) -> Result<PushSettingsView, AppCommandError> {
    Ok(push::push_settings_view(&db.conn).await)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_push_settings(
    settings: PushSettings,
    auth_key: Option<String>,
    db: State<'_, AppDatabase>,
) -> Result<PushSettingsView, AppCommandError> {
    push::save_push_settings(&db.conn, settings, auth_key).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn register_push_device(
    token: String,
    environment: Option<String>,
    bundle_id: Option<String>,
    name: Option<String>,
    platform: Option<String>,
    db: State<'_, AppDatabase>,
) -> Result<RegisteredDevice, AppCommandError> {
    push::register_device(
        &db.conn,
        RegisterDevice {
            token,
            environment,
            bundle_id,
            name,
            platform,
        },
    )
    .await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn unregister_push_device(
    id: Option<i32>,
    token: Option<String>,
    db: State<'_, AppDatabase>,
) -> Result<bool, AppCommandError> {
    push::unregister_device(&db.conn, id, token).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_push_devices(
    db: State<'_, AppDatabase>,
) -> Result<Vec<PushDeviceView>, AppCommandError> {
    push::list_devices(&db.conn).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_push_device_prefs(
    id: i32,
    prefs: DevicePrefs,
    db: State<'_, AppDatabase>,
) -> Result<PushDeviceView, AppCommandError> {
    push::update_device_prefs(&db.conn, id, prefs).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn send_test_push(
    device_id: Option<i32>,
    db: State<'_, AppDatabase>,
) -> Result<Vec<TestPushResult>, AppCommandError> {
    push::send_test(&db.conn, device_id).await
}

/// A window of this app reports whether the user is looking at it (see
/// `crate::presence`). Remote and browser windows report over their event
/// WebSocket instead.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn report_client_presence(
    window: tauri::Window,
    presence: PresenceReport,
) -> Result<(), AppCommandError> {
    crate::presence::report_window(window.label(), presence);
    Ok(())
}
