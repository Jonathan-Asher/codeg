use sea_orm_migration::prelude::*;

/// Rebuild `message_fts` with the trigram tokenizer. Databases that ran
/// `m20260919_000002_message_fts` before it switched to trigram still hold the
/// earlier unicode61 table, which matches whole words only. The table is
/// dropped and created again, and every stamp in `message_fts_state` is
/// forgotten, so the indexer rebuilds the whole index on its next pass. On a
/// fresh database the table is already trigram and empty, and this changes
/// nothing.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP TABLE IF EXISTS message_fts")
            .await?;
        db.execute_unprepared(
            "CREATE VIRTUAL TABLE message_fts USING fts5(
                content,
                conversation_id UNINDEXED,
                turn_idx UNINDEXED,
                role UNINDEXED,
                tokenize = 'trigram remove_diacritics 1'
            )",
        )
        .await?;
        db.execute_unprepared("DELETE FROM message_fts_state")
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Nothing to undo: the table stays trigram, and the earlier migration's
        // `down` drops it.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::migration::Migrator;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    async fn count(conn: &sea_orm::DatabaseConnection, table: &str) -> i64 {
        conn.query_one(sql(&format!("SELECT COUNT(*) FROM {table}")))
            .await
            .expect("query")
            .expect("row")
            .try_get_by_index::<i64>(0)
            .expect("count")
    }

    #[tokio::test]
    async fn replaces_an_index_built_before_trigrams() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let this = migrations
            .iter()
            .position(|m| m.name().contains("message_fts_trigram"))
            .expect("trigram migration is registered");
        Migrator::up(&conn, Some(this as u32))
            .await
            .expect("earlier migrations");

        // The index as it was before trigrams, with a row and a stamp in it.
        for statement in [
            "DROP TABLE message_fts",
            "CREATE VIRTUAL TABLE message_fts USING fts5(\
                content, conversation_id UNINDEXED, turn_idx UNINDEXED, role UNINDEXED)",
            "INSERT INTO message_fts (content, conversation_id, turn_idx, role) \
             VALUES ('the retry loop', 1, 0, 'user')",
            "INSERT INTO message_fts_state (conversation_id, indexed_updated_at, indexed_at) \
             VALUES (1, 'a', 'b')",
        ] {
            conn.execute(sql(statement)).await.expect(statement);
        }

        Migrator::up(&conn, None).await.expect("trigram migration");

        assert_eq!(count(&conn, "message_fts").await, 0);
        assert_eq!(count(&conn, "message_fts_state").await, 0);
        conn.execute(sql(
            "INSERT INTO message_fts (content, conversation_id, turn_idx, role) \
             VALUES ('the retry loop', 1, 0, 'user')",
        ))
        .await
        .expect("insert");
        let hits = conn
            .query_all(sql(
                "SELECT rowid FROM message_fts WHERE message_fts MATCH '\"retr\"'",
            ))
            .await
            .expect("match");
        assert_eq!(
            hits.len(),
            1,
            "part of a word matches: the table is trigram"
        );
    }
}
