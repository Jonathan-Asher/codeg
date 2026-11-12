use sea_orm::entity::prelude::*;

/// One `/btw` exchange of a conversation (see `crate::acp::side_question`).
/// Hard-deleted. See `m20261112_000002_side_question`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "side_question")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub question: String,
    /// `None` when the agent answered with nothing at all.
    #[sea_orm(column_type = "Text", nullable)]
    pub answer: Option<String>,
    /// The answer is a notice from Claude Code, not the model's own words.
    pub synthetic: bool,
    /// Claude Code's note that a fallback model answered after a refusal.
    #[sea_orm(column_type = "Text", nullable)]
    pub fallback_notice: Option<String>,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
