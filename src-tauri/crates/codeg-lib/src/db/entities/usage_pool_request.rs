use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One request the local account pool (maxpool) served, from its usage
/// records (`GET /maxpool/usage/requests`): metadata only — never a body.
///
/// `pct` is the share of the account's weekly limit the request used, and
/// `pct_source` how it was arrived at (see
/// `commands::token_usage_accounts::meter`): 0 an estimate from its price
/// that the next meter step revises, 1 its share of a meter step, 2 a final
/// estimate. `meter_level` is the account's level after it, where a
/// recomputation resumes.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "usage_pool_request")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(unique)]
    pub record_id: String,
    pub occurred_at: DateTimeUtc,
    pub account: String,
    /// `claude`, `provider` or `link` (served through a linked pool).
    pub account_kind: String,
    pub link_row: Option<String>,
    pub model: Option<String>,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub session_id: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    #[sea_orm(column_name = "cache_write_5m_tokens")]
    pub cache_write_5m_tokens: i64,
    #[sea_orm(column_name = "cache_write_1h_tokens")]
    pub cache_write_1h_tokens: i64,
    #[sea_orm(column_name = "util7d")]
    pub util7d: Option<f64>,
    #[sea_orm(column_name = "util7d_prev")]
    pub util7d_prev: Option<f64>,
    #[sea_orm(column_name = "reset7d_ms")]
    pub reset7d_ms: Option<i64>,
    pub cost_usd: Option<f64>,
    pub pct: Option<f64>,
    pub pct_source: i32,
    pub meter_level: Option<f64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
