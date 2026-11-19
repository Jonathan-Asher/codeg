//! HTTP handlers for session links — the web-mode mirror of
//! `instance_identity::get_instance_identity` and
//! `deep_link::resolve_session_link`. A remote workspace window reaches its
//! server through these: to learn which instance it is talking to, and to look
//! up a session a `codeg://` link handed it.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::deep_link::FocusTarget;
use crate::instance_identity::InstanceIdentity;

pub async fn get_instance_identity() -> Json<Option<InstanceIdentity>> {
    Json(crate::instance_identity::get_instance_identity())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSessionLinkParams {
    pub session_ref: String,
    #[serde(default)]
    pub folder_id: Option<i32>,
    #[serde(default)]
    pub agent: Option<String>,
}

pub async fn resolve_session_link(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ResolveSessionLinkParams>,
) -> Result<Json<Option<FocusTarget>>, AppCommandError> {
    let target = crate::deep_link::resolve_session_link_core(
        &state.db,
        &params.session_ref,
        params.folder_id,
        params.agent.as_deref(),
    )
    .await?;
    Ok(Json(target))
}
