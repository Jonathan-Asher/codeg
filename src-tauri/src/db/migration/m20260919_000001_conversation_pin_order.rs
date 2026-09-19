use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Manual position within the sidebar's "Pinned" section, written by the
        // drag-reorder flow (`reorder_conversation_pins`). Nullable with no
        // default: rows pinned before this migration (and rows pinned later
        // without an explicit reorder) keep NULL and sort after explicitly
        // ordered ones by their `pinned_at` — the exact pre-migration order.
        // Unpinning leaves a stale value behind on purpose: the sidebar
        // comparator only consults `pin_order` for pinned rows, so a re-pin
        // without a reorder keeps the pre-migration behaviour.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::PinOrder).integer().null())
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::PinOrder)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    PinOrder,
}
