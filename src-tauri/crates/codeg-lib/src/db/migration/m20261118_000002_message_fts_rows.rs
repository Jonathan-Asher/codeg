use sea_orm_migration::prelude::*;

/// `message_fts_rows`: which `message_fts` rowid holds which turn of which
/// conversation, and how many bytes of text that row has.
///
/// `message_fts` keeps `conversation_id` and `turn_idx` as UNINDEXED columns,
/// and FTS5 can filter on those only by reading every row of its content
/// table. A `DELETE … WHERE conversation_id = ?` therefore read the whole
/// index's text with SQLite's write lock held: seconds on a box short of
/// memory, over a minute at worst, while every other writer timed out with
/// "database is locked". Deletes now look the rowids up in this plain table
/// and remove exactly those rows (`message_search_service`); the byte counts
/// let the indexer split a large rewrite into short transactions without
/// reading the text first.
///
/// The rows already indexed are mapped in one pass over the index. Rows
/// without a conversation or turn (never written by codeg) cannot be
/// addressed and stay out.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS message_fts_rows (
                fts_rowid INTEGER PRIMARY KEY NOT NULL,
                conversation_id INTEGER NOT NULL,
                turn_idx INTEGER NOT NULL,
                bytes INTEGER NOT NULL
            )",
        )
        .await?;
        db.execute_unprepared(
            "INSERT OR REPLACE INTO message_fts_rows (fts_rowid, conversation_id, turn_idx, bytes) \
             SELECT rowid, conversation_id, turn_idx, length(CAST(content AS BLOB)) \
             FROM message_fts \
             WHERE conversation_id IS NOT NULL AND turn_idx IS NOT NULL",
        )
        .await?;
        db.execute_unprepared(
            "CREATE INDEX IF NOT EXISTS idx_message_fts_rows_turn \
             ON message_fts_rows (conversation_id, turn_idx)",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE IF EXISTS message_fts_rows")
            .await?;
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

    async fn rows(conn: &sea_orm::DatabaseConnection, query: &str) -> Vec<(i64, i64, i64, i64)> {
        conn.query_all(sql(query))
            .await
            .expect(query)
            .into_iter()
            .map(|row| {
                (
                    row.try_get_by_index(0).unwrap(),
                    row.try_get_by_index(1).unwrap(),
                    row.try_get_by_index(2).unwrap(),
                    row.try_get_by_index(3).unwrap(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn maps_every_row_already_indexed() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let this = migrations
            .iter()
            .position(|m| m.name().contains("message_fts_rows"))
            .expect("the migration is registered");
        Migrator::up(&conn, Some(this as u32))
            .await
            .expect("earlier migrations");

        // An index as the indexer left it before this migration: rowids with
        // gaps from earlier rewrites, several conversations, multi-byte text.
        for statement in [
            "INSERT INTO message_fts (rowid, content, conversation_id, turn_idx, role) \
             VALUES (7, 'the retry loop', 1, 0, 'user')",
            "INSERT INTO message_fts (rowid, content, conversation_id, turn_idx, role) \
             VALUES (9, '修复登录问题', 1, 2, 'assistant')",
            "INSERT INTO message_fts (rowid, content, conversation_id, turn_idx, role) \
             VALUES (40, 'another one', 2, 0, 'user')",
        ] {
            conn.execute(sql(statement)).await.expect(statement);
        }

        Migrator::up(&conn, None).await.expect("this migration");

        assert_eq!(
            rows(
                &conn,
                "SELECT fts_rowid, conversation_id, turn_idx, bytes FROM message_fts_rows \
                 ORDER BY fts_rowid"
            )
            .await,
            [(7, 1, 0, 14), (9, 1, 2, 18), (40, 2, 0, 11)],
            "one entry per row, its byte length counted in UTF-8"
        );
        let plan = conn
            .query_all(sql(
                "EXPLAIN QUERY PLAN SELECT fts_rowid FROM message_fts_rows \
                 WHERE conversation_id = 1 AND turn_idx >= 1",
            ))
            .await
            .expect("plan");
        let detail: Vec<String> = plan
            .iter()
            .map(|row| row.try_get_by_index::<String>(3).unwrap())
            .collect();
        assert!(
            detail
                .iter()
                .any(|d| d.contains("idx_message_fts_rows_turn")),
            "a conversation's rows are found through the index: {detail:?}"
        );
    }
}
