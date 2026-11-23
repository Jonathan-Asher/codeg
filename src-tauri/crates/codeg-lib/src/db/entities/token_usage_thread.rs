use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A thread of a Claude session: the main thread (`thread_key = ""`) or one
/// sub-agent. The main thread's row doubles as the call sync's stamp: the
/// transcript it read (`source_path`), what the tree looked like then
/// (`source_fingerprint`) and the accounting it was read under
/// (`schema_version`).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "token_usage_thread")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub conversation_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub thread_key: String,
    /// The sub-agent's task description.
    pub label: Option<String>,
    pub agent_type: Option<String>,
    pub parent_key: Option<String>,
    pub source_path: Option<String>,
    pub source_fingerprint: Option<String>,
    pub schema_version: i32,
    pub synced_at: DateTimeUtc,
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
