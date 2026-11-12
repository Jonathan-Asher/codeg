use sea_orm_migration::prelude::*;

/// What the message search index holds of each conversation, so a changed
/// conversation is indexed by appending its new turns instead of rewriting all
/// of them: `indexed_turns` is how many turns the parse it indexed had, and
/// `prefix_fp` a fingerprint of all of them but the last (the one that can
/// still grow). NULL on existing rows: their next indexing rewrites them once.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE message_fts_state ADD COLUMN indexed_turns INTEGER")
            .await?;
        db.execute_unprepared("ALTER TABLE message_fts_state ADD COLUMN prefix_fp TEXT")
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE message_fts_state DROP COLUMN prefix_fp")
            .await?;
        db.execute_unprepared("ALTER TABLE message_fts_state DROP COLUMN indexed_turns")
            .await?;
        Ok(())
    }
}
