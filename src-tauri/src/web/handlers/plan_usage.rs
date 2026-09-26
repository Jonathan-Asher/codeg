use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::plan_usage::{get_plan_usage_core, PlanUsageReport};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetPlanUsageParams {
    /// Skip the Codex rollout cache (the screen's refresh button).
    #[serde(default)]
    pub force: Option<bool>,
}

pub async fn get_plan_usage(
    Json(params): Json<GetPlanUsageParams>,
) -> Result<Json<PlanUsageReport>, AppCommandError> {
    let report = get_plan_usage_core(params.force.unwrap_or(false)).await?;
    Ok(Json(report))
}
