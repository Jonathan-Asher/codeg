use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The automatic resume after a restart, extended to the background
        // work a session leaves running once its turn has ended (see
        // `acp::background_snapshot` and `acp::auto_resume`):
        //
        // * `background_snapshot` — what the session's live connection runs in
        //   the background right now (sub-agents, background shells,
        //   monitors, workflows, codeg delegations, a turn of its own), as
        //   JSON with the time it was taken. Kept current while codeg runs and
        //   written once more by a graceful quit, so the next start knows what
        //   the exit stopped. NULL: nothing runs.
        // * `auto_resume_reason` — why an `auto_resume = pending` row is due a
        //   resume: `turn` (a turn was cut off) or `background` (the turn had
        //   ended, its background work was stopped). NULL on rows marked
        //   before this column existed, which read as `turn`.
        // * `auto_resume_count` — automatic resumes since the user last sent a
        //   turn. Bounds a resume that keeps re-launching work a crash keeps
        //   stopping.
        //
        // SQLite adds one column per ALTER TABLE, hence three statements.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::BackgroundSnapshot)
                            .text()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::AutoResumeReason)
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::AutoResumeCount)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            Conversation::AutoResumeCount,
            Conversation::AutoResumeReason,
            Conversation::BackgroundSnapshot,
        ] {
            manager
                .alter_table(
                    Table::alter()
                        .table(Conversation::Table)
                        .drop_column(column)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    BackgroundSnapshot,
    AutoResumeReason,
    AutoResumeCount,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn new_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('conversation') \
             WHERE name IN ('background_snapshot', 'auto_resume_reason', 'auto_resume_count')"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the three columns (nothing recorded on existing rows, no
    /// resumes counted), `down` drops them, and the full chain applies.
    #[tokio::test]
    async fn up_adds_the_background_resume_columns_and_down_drops_them() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared("CREATE TABLE conversation (id INTEGER PRIMARY KEY, title TEXT)")
            .await
            .expect("create stub table");
        conn.execute_unprepared("INSERT INTO conversation (title) VALUES ('x')")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT background_snapshot, auto_resume_reason, auto_resume_count \
                 FROM conversation"
                    .to_owned(),
            ))
            .await
            .expect("query rows");
        let snapshot: Option<String> = rows[0].try_get("", "background_snapshot").unwrap();
        let reason: Option<String> = rows[0].try_get("", "auto_resume_reason").unwrap();
        let count: i32 = rows[0].try_get("", "auto_resume_count").unwrap();
        assert_eq!(snapshot, None);
        assert_eq!(reason, None);
        assert_eq!(count, 0);

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(new_columns(&conn).await, 0, "down drops the columns");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(new_columns(&fresh).await, 3);
    }
}
