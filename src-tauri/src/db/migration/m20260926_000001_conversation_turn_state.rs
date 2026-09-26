use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Whether this conversation's latest turn is still running
        // (`running`), was cut off before it finished (`interrupted`), or has
        // ended normally (NULL). Written by the lifecycle subscriber at the
        // turn's edges; `running` rows left behind by a process that died
        // mid-turn are converted to `interrupted` on the next start (see
        // `conversation_service::interrupt_orphaned_turns`).
        //
        // Nullable with no default: NULL is "no turn in flight", which is the
        // right reading for almost every existing row.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::TurnState).string().null())
                    .to_owned(),
            )
            .await?;

        // The one exception is a row still sitting at `in_progress` with a
        // bound agent session. Before this column existed, every turn flipped
        // its row to `in_progress` on send and away from it when the turn
        // ended (`pending_review` on success, `cancelled` on failure, cancel or
        // disconnect) — so a row still there at startup is one whose turn was
        // cut off when the previous process exited, and nothing ever recorded
        // it. Mark those interrupted so they can be continued. Rows never
        // prompted (no `external_id`) and soft-deleted rows are left alone.
        manager
            .exec_stmt(
                Query::update()
                    .table(Conversation::Table)
                    .value(Conversation::TurnState, "interrupted")
                    .and_where(Expr::col(Conversation::Status).eq("in_progress"))
                    .and_where(Expr::col(Conversation::ExternalId).is_not_null())
                    .and_where(Expr::col(Conversation::DeletedAt).is_null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::TurnState)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    TurnState,
    Status,
    ExternalId,
    DeletedAt,
}
