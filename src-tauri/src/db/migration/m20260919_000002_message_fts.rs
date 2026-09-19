use sea_orm_migration::prelude::*;

/// Full-text index over conversation message content, powering the ⌘K
/// "message content" search. A standalone FTS5 virtual table (no external
/// content table): rows are (re)written wholesale per conversation whenever
/// the indexer runs — app start, on-demand refresh, and turn completion —
/// which keeps write complexity at one DELETE + batch INSERT per
/// conversation and lets agents' parsers change freely without schema
/// churn. `conversation_id` is UNINDEXED metadata (retrieved, not matched);
/// matching happens on `content` only.
///
/// The table is created with raw SQL — SeaORM's schema builder has no FTS5
/// virtual-table concept.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
                content,
                conversation_id UNINDEXED,
                turn_idx UNINDEXED,
                role UNINDEXED
            )",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS message_fts")
            .await?;
        Ok(())
    }
}
