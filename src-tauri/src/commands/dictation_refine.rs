//! Dictation clean-up and translation (`crate::dictation_refine`). The `_core`
//! functions are shared by the desktop commands below and the web handlers in
//! `web/handlers/dictation_refine.rs`, so both runtimes compile them.

use sea_orm::DatabaseConnection;

use crate::app_error::AppCommandError;
use crate::dictation_refine::{
    self, DictationRefineSettingsUpdate, DictationRefineSettingsView, KeyringKeys, RefineRequest,
    RefineResult, Refiner,
};

pub async fn refine_dictation_core(
    conn: &DatabaseConnection,
    request: RefineRequest,
) -> Result<RefineResult, AppCommandError> {
    let settings = dictation_refine::load_settings(conn).await;
    dictation_refine::refine(&settings, &KeyringKeys, Refiner::shared(), &request)
        .await
        .map_err(AppCommandError::from)
}

pub async fn get_dictation_refine_settings_core(
    conn: &DatabaseConnection,
) -> Result<DictationRefineSettingsView, AppCommandError> {
    Ok(dictation_refine::get_settings(conn, &KeyringKeys).await)
}

pub async fn update_dictation_refine_settings_core(
    conn: &DatabaseConnection,
    update: DictationRefineSettingsUpdate,
) -> Result<DictationRefineSettingsView, AppCommandError> {
    dictation_refine::save_settings(conn, &KeyringKeys, update).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn refine_dictation(
    text: String,
    translate: Option<bool>,
    refine: Option<bool>,
    target_language: Option<String>,
    source_language: Option<String>,
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<RefineResult, AppCommandError> {
    refine_dictation_core(
        &db.conn,
        RefineRequest {
            text,
            translate,
            refine,
            target_language,
            source_language,
        },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_dictation_refine_settings(
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<DictationRefineSettingsView, AppCommandError> {
    get_dictation_refine_settings_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn update_dictation_refine_settings(
    provider: Option<String>,
    model: Option<String>,
    endpoint: Option<String>,
    target_language: Option<String>,
    refine: Option<bool>,
    translate: Option<bool>,
    instructions: Option<String>,
    api_key: Option<String>,
    key_provider: Option<String>,
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<DictationRefineSettingsView, AppCommandError> {
    update_dictation_refine_settings_core(
        &db.conn,
        DictationRefineSettingsUpdate {
            provider,
            model,
            endpoint,
            target_language,
            refine,
            translate,
            instructions,
            api_key,
            key_provider,
        },
    )
    .await
}
