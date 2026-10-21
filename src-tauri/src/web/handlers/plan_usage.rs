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

// ─── Managing the account pool ──────────────────────────────────────────

use crate::commands::usage_pool::manage::{
    self, LoginOutcome, LoginState, PoolChange, PoolLoginStart, PoolManageInfo,
};

pub async fn usage_pool_manage_info() -> Result<Json<PoolManageInfo>, AppCommandError> {
    Ok(Json(manage::manage_info()))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PoolLoginStartParams {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub reconnect: Option<String>,
}

pub async fn usage_pool_login_start(
    Json(params): Json<PoolLoginStartParams>,
) -> Result<Json<PoolLoginStart>, AppCommandError> {
    manage::login_start(params.name, params.reconnect)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolLoginFinishParams {
    pub handle: String,
    pub pasted: String,
}

pub async fn usage_pool_login_finish(
    Json(params): Json<PoolLoginFinishParams>,
) -> Result<Json<LoginOutcome>, AppCommandError> {
    Ok(Json(manage::login_finish(&params.handle, &params.pasted).await))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolLoginHandleParams {
    pub handle: String,
}

pub async fn usage_pool_login_state(
    Json(params): Json<PoolLoginHandleParams>,
) -> Result<Json<LoginState>, AppCommandError> {
    Ok(Json(manage::login_state(&params.handle).await))
}

pub async fn usage_pool_login_cancel(
    Json(params): Json<PoolLoginHandleParams>,
) -> Result<Json<()>, AppCommandError> {
    manage::login_cancel(&params.handle).await;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolRenameParams {
    pub name: String,
    pub new_name: String,
}

pub async fn usage_pool_rename(
    Json(params): Json<PoolRenameParams>,
) -> Result<Json<PoolChange>, AppCommandError> {
    manage::rename(&params.name, &params.new_name).await.map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolSetEnabledParams {
    pub name: String,
    pub enabled: bool,
}

pub async fn usage_pool_set_enabled(
    Json(params): Json<PoolSetEnabledParams>,
) -> Result<Json<PoolChange>, AppCommandError> {
    manage::set_enabled(&params.name, params.enabled)
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolSetPreferredParams {
    /// `None` goes back to automatic balancing.
    pub name: Option<String>,
}

pub async fn usage_pool_set_preferred(
    Json(params): Json<PoolSetPreferredParams>,
) -> Result<Json<PoolChange>, AppCommandError> {
    manage::set_preferred(params.name.as_deref())
        .await
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolAccountParams {
    pub name: String,
}

pub async fn usage_pool_remove(
    Json(params): Json<PoolAccountParams>,
) -> Result<Json<PoolChange>, AppCommandError> {
    manage::remove(&params.name).await.map(Json)
}

pub async fn usage_pool_restart_now() -> Result<Json<PoolManageInfo>, AppCommandError> {
    manage::restart_now().await.map(Json)
}
