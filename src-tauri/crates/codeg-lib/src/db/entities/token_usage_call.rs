use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One API call of a Claude session — the main thread's or a sub-agent's —
/// for the usage page's per-thread and per-account split.
///
/// Written only by the call sync in `commands::token_usage_accounts`, which
/// replaces a conversation's whole set in one transaction. `message_id` and
/// `request_id` are the upstream ids the transcript recorded: the account
/// pool's request records (`usage_pool_request`) are joined on them.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "token_usage_call")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub conversation_id: i32,
    /// `""` for the main thread, else the sub-agent's agent id.
    pub thread_key: String,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub occurred_at: DateTimeUtc,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    #[sea_orm(column_name = "cache_write_5m_tokens")]
    pub cache_write_5m_tokens: i64,
    #[sea_orm(column_name = "cache_write_1h_tokens")]
    pub cache_write_1h_tokens: i64,
    /// List price of the call; `None` for a model without a known price.
    pub cost_usd: Option<f64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::conversation::Entity",
        from = "Column::ConversationId",
        to = "super::conversation::Column::Id"
    )]
    Conversation,
}

impl Related<super::conversation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversation.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
