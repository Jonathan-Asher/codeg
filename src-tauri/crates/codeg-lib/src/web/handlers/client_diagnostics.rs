use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::commands::client_diagnostics::{
    self as diagnostics, ClientDiagnosticReceipt, ClientDiagnosticSummary,
};

// Named parameters, as the Tauri commands take them: `{ report }`,
// `{ limit }`, `{ id }`.

#[derive(Deserialize)]
pub struct ReportParams {
    pub report: Value,
}

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct GetParams {
    pub id: String,
}

/// A crash report from the iPhone app (see `commands::client_diagnostics`).
pub async fn report_client_diagnostic(
    Json(params): Json<ReportParams>,
) -> Result<Json<ClientDiagnosticReceipt>, AppCommandError> {
    let dir = crate::paths::codeg_client_diagnostics_root();
    let receipt = tokio::task::spawn_blocking(move || {
        diagnostics::report_client_diagnostic_core(&dir, params.report)
    })
    .await
    .map_err(|e| {
        AppCommandError::io_error("Storing the crash report failed").with_detail(e.to_string())
    })??;
    Ok(Json(receipt))
}

pub async fn list_client_diagnostics(
    Json(params): Json<ListParams>,
) -> Result<Json<Vec<ClientDiagnosticSummary>>, AppCommandError> {
    let dir = crate::paths::codeg_client_diagnostics_root();
    let list = tokio::task::spawn_blocking(move || {
        diagnostics::list_client_diagnostics_core(&dir, params.limit)
    })
    .await
    .map_err(|e| {
        AppCommandError::io_error("Listing crash reports failed").with_detail(e.to_string())
    })?;
    Ok(Json(list))
}

pub async fn get_client_diagnostic(
    Json(params): Json<GetParams>,
) -> Result<Json<Value>, AppCommandError> {
    let dir = crate::paths::codeg_client_diagnostics_root();
    let report = tokio::task::spawn_blocking(move || {
        diagnostics::get_client_diagnostic_core(&dir, &params.id)
    })
    .await
    .map_err(|e| {
        AppCommandError::io_error("Reading the crash report failed").with_detail(e.to_string())
    })??;
    Ok(Json(report))
}
