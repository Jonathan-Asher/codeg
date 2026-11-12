use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::quick_ask::{self, PrivateSessionCleanup};
use crate::models::AgentType;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardPrivateQuickAskParams {
    pub working_dir: String,
    #[serde(default)]
    pub agent_type: Option<AgentType>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// The `quick-ask-…` bucket the question's images were uploaded to.
    #[serde(default)]
    pub upload_bucket: Option<String>,
}

/// Web twin of the `discard_private_quick_ask` Tauri command. A desktop Quick
/// Ask bound to this server sends its private questions here, so the cleanup
/// runs on the machine that hosted the session.
pub async fn discard_private_quick_ask(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DiscardPrivateQuickAskParams>,
) -> Result<Json<PrivateSessionCleanup>, AppCommandError> {
    let report = quick_ask::discard_private_session_default(
        &state.db.conn,
        &state.data_dir,
        &params.working_dir,
        params.agent_type,
        params.session_id.as_deref(),
        params.upload_bucket.as_deref(),
    )
    .await?;
    Ok(Json(report))
}
