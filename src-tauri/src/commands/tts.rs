//! Natural read-aloud (`crate::tts`). The `_core` functions are shared by the
//! desktop commands below and the web handlers in `web/handlers/tts.rs`.
//!
//! Where synthesis runs follows who calls: the desktop app (a remote-workspace
//! window included) invokes its own local backend, so the voice is made on the
//! machine whose speakers play it; a browser calls the server it is served by.

use std::path::Path;
use std::sync::Arc;

use crate::app_error::AppCommandError;
use crate::tts::{
    self, PollRequest, PollResult, SpeakRequest, SpeakStarted, TtsError, TtsService, TtsStatus,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Sent with the new [`TtsStatus`] whenever a download starts, finishes,
/// fails or is cancelled, or the models are deleted: every window (and every
/// client of a server) keeps its own copy of the status, and the one that
/// asked for the change is only one of them.
pub const TTS_STATUS_EVENT: &str = "tts://status";

/// Error keys the read-aloud UI branches on (`src/lib/read-aloud/natural-api.ts`).
pub const TTS_I18N_KEY_NOT_INSTALLED: &str = "tts.notInstalled";
pub const TTS_I18N_KEY_UNSUPPORTED: &str = "tts.unsupported";

impl From<TtsError> for AppCommandError {
    fn from(err: TtsError) -> Self {
        let message = err.to_string();
        match err {
            TtsError::Unsupported(_) => AppCommandError::dependency_missing(message)
                .with_i18n(TTS_I18N_KEY_UNSUPPORTED, Default::default()),
            TtsError::NotInstalled => AppCommandError::configuration_missing(message)
                .with_i18n(TTS_I18N_KEY_NOT_INSTALLED, Default::default()),
            TtsError::InvalidInput(_) => AppCommandError::invalid_input(message),
            TtsError::StreamNotFound => AppCommandError::not_found(message),
            TtsError::Engine(_) => AppCommandError::task_execution_failed(message),
            TtsError::Io(e) => AppCommandError::io(e),
        }
    }
}

/// The service, announcing its status changes through `emitter`.
fn announcing_service(data_dir: &Path, emitter: &EventEmitter) -> Arc<TtsService> {
    let service = tts::service_for(data_dir);
    service.on_status_change(|| {
        let emitter = emitter.clone();
        Arc::new(move |status: TtsStatus| emit_event(&emitter, TTS_STATUS_EVENT, &status))
    });
    service
}

pub fn tts_status_core(data_dir: &Path) -> TtsStatus {
    tts::service_for(data_dir).status()
}

pub fn tts_download_models_core(
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<TtsStatus, AppCommandError> {
    Ok(announcing_service(data_dir, emitter).start_download()?)
}

pub async fn tts_cancel_download_core(data_dir: &Path, emitter: &EventEmitter) -> TtsStatus {
    announcing_service(data_dir, emitter).cancel_download().await
}

pub async fn tts_delete_models_core(
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<TtsStatus, AppCommandError> {
    Ok(announcing_service(data_dir, emitter).delete_models().await?)
}

pub async fn tts_speak_core(
    data_dir: &Path,
    request: SpeakRequest,
) -> Result<SpeakStarted, AppCommandError> {
    Ok(tts::service_for(data_dir).speak(request).await?)
}

pub async fn tts_poll_core(
    data_dir: &Path,
    request: PollRequest,
) -> Result<PollResult, AppCommandError> {
    Ok(tts::service_for(data_dir).poll(request).await?)
}

pub async fn tts_cancel_core(data_dir: &Path, stream_id: &str) {
    tts::service_for(data_dir).cancel(stream_id).await
}

#[cfg(feature = "tauri-runtime")]
fn desktop_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app.path().app_data_dir().unwrap_or_default();
    crate::paths::resolve_effective_data_dir(&base)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_status(app: tauri::AppHandle) -> Result<TtsStatus, AppCommandError> {
    Ok(tts_status_core(&desktop_data_dir(&app)))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_download_models(app: tauri::AppHandle) -> Result<TtsStatus, AppCommandError> {
    let data_dir = desktop_data_dir(&app);
    tts_download_models_core(&data_dir, &EventEmitter::Tauri(app))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_cancel_download(app: tauri::AppHandle) -> Result<TtsStatus, AppCommandError> {
    let data_dir = desktop_data_dir(&app);
    Ok(tts_cancel_download_core(&data_dir, &EventEmitter::Tauri(app)).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_delete_models(app: tauri::AppHandle) -> Result<TtsStatus, AppCommandError> {
    let data_dir = desktop_data_dir(&app);
    tts_delete_models_core(&data_dir, &EventEmitter::Tauri(app)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_speak(
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
    speed: Option<f64>,
) -> Result<SpeakStarted, AppCommandError> {
    tts_speak_core(&desktop_data_dir(&app), SpeakRequest { text, voice, speed }).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_poll(
    app: tauri::AppHandle,
    stream_id: String,
    wait_ms: Option<u64>,
) -> Result<PollResult, AppCommandError> {
    tts_poll_core(&desktop_data_dir(&app), PollRequest { stream_id, wait_ms }).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn tts_cancel(app: tauri::AppHandle, stream_id: String) -> Result<(), AppCommandError> {
    tts_cancel_core(&desktop_data_dir(&app), &stream_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    #[test]
    fn errors_map_to_codes_the_ui_can_branch_on() {
        let e = AppCommandError::from(TtsError::NotInstalled);
        assert!(matches!(e.code, AppErrorCode::ConfigurationMissing));
        assert_eq!(e.i18n_key.as_deref(), Some(TTS_I18N_KEY_NOT_INSTALLED));
        let e = AppCommandError::from(TtsError::Unsupported("platform".into()));
        assert!(matches!(e.code, AppErrorCode::DependencyMissing));
        assert_eq!(e.i18n_key.as_deref(), Some(TTS_I18N_KEY_UNSUPPORTED));
        assert!(matches!(
            AppCommandError::from(TtsError::StreamNotFound).code,
            AppErrorCode::NotFound
        ));
        assert!(matches!(
            AppCommandError::from(TtsError::InvalidInput("x".into())).code,
            AppErrorCode::InvalidInput
        ));
    }
}
