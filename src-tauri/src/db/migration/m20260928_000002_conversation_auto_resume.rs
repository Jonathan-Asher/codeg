use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Where this conversation's cut-off turn stands with respect to the
        // automatic resume after a restart (see
        // `conversation::ConversationAutoResume` and `acp::auto_resume`):
        //
        // * `pending`   — the turn was cut off by codeg itself exiting (a quit,
        //                 a crash, an update restart); resume it on the next
        //                 start.
        // * `claimed`   — this start is resuming it right now.
        // * `attempted` — the running (or cut-off) turn IS the automatic
        //                 resume, so a second exit during it must not resume
        //                 it again.
        // * `cancelled` — the user stopped the running turn; an exit before
        //                 the stop landed must not bring it back.
        //
        // Nullable with no default: NULL is "nothing to resume", which is true
        // of every existing row. A row already marked interrupted by the
        // previous build stays a plain interruption with a manual Continue —
        // nothing recorded that codeg's exit is what cut it off.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::AutoResume).string().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::AutoResume)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    AutoResume,
}
