//! Web-mode handlers for iPhone push (`crate::push`). Behind the same token
//! auth as every other `/api` route; the iOS app registers through these.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::push::prefs::DevicePrefs;
use crate::push::{
    self, PushDeviceView, PushSettings, PushSettingsView, RegisterDevice, RegisteredDevice,
    TestPushResult,
};

pub async fn get_push_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PushSettingsView>, AppCommandError> {
    Ok(Json(push::push_settings_view(&state.db.conn).await))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePushSettingsParams {
    pub settings: PushSettings,
    /// Absent keeps the stored key; `""` removes it; a `.p8` replaces it.
    #[serde(default)]
    pub auth_key: Option<String>,
}

pub async fn update_push_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdatePushSettingsParams>,
) -> Result<Json<PushSettingsView>, AppCommandError> {
    push::save_push_settings(&state.db.conn, params.settings, params.auth_key)
        .await
        .map(Json)
}

pub async fn register_push_device(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RegisterDevice>,
) -> Result<Json<RegisteredDevice>, AppCommandError> {
    push::register_device(&state.db.conn, params)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnregisterPushDeviceParams {
    #[serde(default)]
    pub id: Option<i32>,
    #[serde(default)]
    pub token: Option<String>,
}

pub async fn unregister_push_device(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UnregisterPushDeviceParams>,
) -> Result<Json<bool>, AppCommandError> {
    push::unregister_device(&state.db.conn, params.id, params.token)
        .await
        .map(Json)
}

pub async fn list_push_devices(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<PushDeviceView>>, AppCommandError> {
    push::list_devices(&state.db.conn).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePushDevicePrefsParams {
    pub id: i32,
    pub prefs: DevicePrefs,
}

pub async fn update_push_device_prefs(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdatePushDevicePrefsParams>,
) -> Result<Json<PushDeviceView>, AppCommandError> {
    push::update_device_prefs(&state.db.conn, params.id, params.prefs)
        .await
        .map(Json)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SendTestPushParams {
    #[serde(default)]
    pub device_id: Option<i32>,
}

pub async fn send_test_push(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SendTestPushParams>,
) -> Result<Json<Vec<TestPushResult>>, AppCommandError> {
    push::send_test(&state.db.conn, params.device_id)
        .await
        .map(Json)
}
