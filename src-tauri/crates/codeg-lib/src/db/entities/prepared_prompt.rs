use sea_orm::entity::prelude::*;

/// A message the user prepared for one conversation, sent from the right-hand
/// panel's Prompts tab. See `m20261123_000001_prepared_prompt`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "prepared_prompt")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    /// Position in the conversation's list, top to bottom.
    pub sort_order: i32,
    /// When it was last sent; `None` until then.
    pub last_sent_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
