//! Web-mode handlers for usage-limit resets (`commands::limit_resets`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::limit_resets::{
    get_limit_resets_core, use_limit_reset_core, LimitResetsReport, UseLimitResetResult,
};
use crate::commands::plan_usage::PlanUsageAgent;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetLimitResetsParams {
    /// Ask the providers again rather than reuse the last minute's listing.
    #[serde(default)]
    pub force: Option<bool>,
}

pub async fn get_limit_resets(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GetLimitResetsParams>,
) -> Result<Json<LimitResetsReport>, AppCommandError> {
    get_limit_resets_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        params.force.unwrap_or(false),
    )
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseLimitResetParams {
    pub provider: PlanUsageAgent,
    /// The reset to use; the provider's next one when absent.
    #[serde(default)]
    pub id: Option<String>,
    /// A session paused at the limit, to continue once the reset lands.
    #[serde(default)]
    pub conversation_id: Option<i32>,
}

pub async fn use_limit_reset(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UseLimitResetParams>,
) -> Result<Json<UseLimitResetResult>, AppCommandError> {
    use_limit_reset_core(
        &state.db,
        &state.data_dir,
        &state.emitter,
        params.provider,
        params.id,
        params.conversation_id,
    )
    .await
    .map(Json)
}
