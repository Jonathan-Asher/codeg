use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A device that receives codeg's notifications through APNs (see
/// `crate::push`). One row per device token; hard-deleted. See
/// `m20261002_000001_push_devices`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "push_device")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// Hex APNs device token, lowercase.
    #[sea_orm(column_type = "Text", unique)]
    pub token: String,
    /// `"sandbox"` or `"production"`: which APNs host serves this token.
    #[sea_orm(column_type = "Text")]
    pub environment: String,
    /// The app's bundle id, sent as `apns-topic`.
    #[sea_orm(column_type = "Text")]
    pub bundle_id: String,
    /// What the device calls itself ("Jonathan's iPhone").
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub platform: String,
    /// `push::prefs::DevicePrefs` as JSON.
    #[sea_orm(column_type = "Text")]
    pub prefs: String,
    pub created_at: DateTimeUtc,
    pub last_seen_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
