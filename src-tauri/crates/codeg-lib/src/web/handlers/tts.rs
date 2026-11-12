//! Web-mode handlers for natural read-aloud (`crate::tts`). A browser client
//! reads aloud through the server it is served by, so these synthesize on the
//! server; nothing is downloaded or started there until a client asks.

use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::tts::{
    tts_cancel_core, tts_cancel_download_core, tts_delete_models_core, tts_download_models_core,
    tts_poll_core, tts_speak_core, tts_status_core,
};
use crate::tts::{PollRequest, PollResult, SpeakRequest, SpeakStarted, StreamRef, TtsStatus};

pub async fn tts_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TtsStatus>, AppCommandError> {
    Ok(Json(tts_status_core(&state.data_dir)))
}

pub async fn tts_download_models(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TtsStatus>, AppCommandError> {
    tts_download_models_core(&state.data_dir, &state.emitter).map(Json)
}

pub async fn tts_cancel_download(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TtsStatus>, AppCommandError> {
    Ok(Json(tts_cancel_download_core(&state.data_dir, &state.emitter).await))
}

pub async fn tts_delete_models(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TtsStatus>, AppCommandError> {
    tts_delete_models_core(&state.data_dir, &state.emitter).await.map(Json)
}

pub async fn tts_speak(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SpeakRequest>,
) -> Result<Json<SpeakStarted>, AppCommandError> {
    tts_speak_core(&state.data_dir, params).await.map(Json)
}

pub async fn tts_poll(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PollRequest>,
) -> Result<Json<PollResult>, AppCommandError> {
    tts_poll_core(&state.data_dir, params).await.map(Json)
}

pub async fn tts_cancel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<StreamRef>,
) -> Result<Json<()>, AppCommandError> {
    tts_cancel_core(&state.data_dir, &params.stream_id).await;
    Ok(Json(()))
}
