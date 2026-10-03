//! Web-mode handlers for dictation clean-up and translation
//! (`crate::dictation_refine`). Behind the same token auth as every other
//! `/api` route; the iOS app calls `refine_dictation` through here.

use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::dictation_refine::{
    get_dictation_refine_settings_core, refine_dictation_core,
    update_dictation_refine_settings_core,
};
use crate::dictation_refine::{
    DictationRefineSettingsUpdate, DictationRefineSettingsView, RefineRequest, RefineResult,
};

pub async fn refine_dictation(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RefineRequest>,
) -> Result<Json<RefineResult>, AppCommandError> {
    refine_dictation_core(&state.db.conn, params)
        .await
        .map(Json)
}

pub async fn get_dictation_refine_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<DictationRefineSettingsView>, AppCommandError> {
    get_dictation_refine_settings_core(&state.db.conn)
        .await
        .map(Json)
}

pub async fn update_dictation_refine_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DictationRefineSettingsUpdate>,
) -> Result<Json<DictationRefineSettingsView>, AppCommandError> {
    update_dictation_refine_settings_core(&state.db.conn, params)
        .await
        .map(Json)
}
