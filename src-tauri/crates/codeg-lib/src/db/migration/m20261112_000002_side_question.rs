use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // side_question: the `/btw` exchanges of a conversation (see
        // `crate::acp::side_question`). A side question is answered from the
        // session's context and never enters the agent's transcript, so this is
        // the only record of it: the composer's panel steps through it, and the
        // newest answered ones go back to the agent as `history` with the next
        // side question. Hard-deleted ("Clear history", and with the
        // conversation through the foreign key).
        manager
            .create_table(
                Table::create()
                    .table(SideQuestion::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SideQuestion::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SideQuestion::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SideQuestion::Question).text().not_null())
                    // NULL when the agent answered with nothing at all.
                    .col(ColumnDef::new(SideQuestion::Answer).text().null())
                    // The answer is a notice from Claude Code ("(API error: …)"),
                    // not the model's own words: shown, never replayed.
                    .col(
                        ColumnDef::new(SideQuestion::Synthetic)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    // Claude Code's note that it answered with a fallback model
                    // after a refusal; NULL otherwise.
                    .col(ColumnDef::new(SideQuestion::FallbackNotice).text().null())
                    .col(
                        ColumnDef::new(SideQuestion::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_side_question_conversation")
                            .from(SideQuestion::Table, SideQuestion::ConversationId)
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade)
                            .on_update(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_side_question_conversation")
                    .table(SideQuestion::Table)
                    .col(SideQuestion::ConversationId)
                    .col(SideQuestion::Id)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SideQuestion::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SideQuestion {
    Table,
    Id,
    ConversationId,
    Question,
    Answer,
    Synthetic,
    FallbackNotice,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
