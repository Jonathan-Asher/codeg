use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// The scheduler lists the paused rows; few rows ever are.
const IDX_LIMIT_RESUME: &str = "idx_conversation_limit_resume_state";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The continue-after-the-usage-limit pause (`acp::limit_continue`).
        // A turn that ended because the account hit its usage limit leaves
        // the conversation paused until the limit resets; the backend then
        // sends a continuation prompt by itself. Persisted so the schedule
        // survives a restart and runs with no window open.
        //
        // * `limit_resume_at` — when the limit resets (UTC). NULL: no pause.
        // * `limit_resume_state` — `scheduled` (waiting for the reset),
        //   `claimed` (the continuation is being sent), `continuing` (the
        //   continuation's turn runs). NULL: no pause.
        // * `limit_resume_attempts` — continuations sent for this pause; the
        //   cap turns a limit that keeps coming back into a plain
        //   interruption.
        // * `limit_auto_continue` — the per-session switch. On by default;
        //   the global setting still has to be on too.
        //
        // SQLite adds one column per ALTER TABLE, hence four statements.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::LimitResumeAt)
                            .timestamp_with_time_zone()
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
                        ColumnDef::new(Conversation::LimitResumeState)
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
                        ColumnDef::new(Conversation::LimitResumeAttempts)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::LimitAutoContinue)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name(IDX_LIMIT_RESUME)
                    .table(Conversation::Table)
                    .col(Conversation::LimitResumeState)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite refuses to drop a column an index still covers.
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name(IDX_LIMIT_RESUME)
                    .table(Conversation::Table)
                    .to_owned(),
            )
            .await?;
        for column in [
            Conversation::LimitAutoContinue,
            Conversation::LimitResumeAttempts,
            Conversation::LimitResumeState,
            Conversation::LimitResumeAt,
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
    LimitResumeAt,
    LimitResumeState,
    LimitResumeAttempts,
    LimitAutoContinue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// `up` adds the four columns with their defaults to existing rows, and
    /// `down` removes them again.
    #[tokio::test]
    async fn up_adds_limit_resume_columns_and_down_drops_them() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE conversation (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT)",
        )
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
                "SELECT limit_resume_at, limit_resume_state, limit_resume_attempts, \
                 limit_auto_continue FROM conversation"
                    .to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let state: Option<String> = rows[0]
            .try_get("", "limit_resume_state")
            .expect("state col");
        let attempts: i32 = rows[0]
            .try_get("", "limit_resume_attempts")
            .expect("attempts col");
        let auto: bool = rows[0]
            .try_get("", "limit_auto_continue")
            .expect("auto col");
        assert_eq!(state, None, "an existing row is not paused");
        assert_eq!(attempts, 0);
        assert!(auto, "the per-session switch defaults on");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        let cols = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM pragma_table_info('conversation') WHERE name LIKE 'limit_%'"
                    .to_owned(),
            ))
            .await
            .expect("pragma query");
        assert!(cols.is_empty(), "down drops every column");
    }

    /// The full chain applies on a fresh database, with this migration in it.
    #[tokio::test]
    async fn full_migrator_applies_with_limit_resume_columns() {
        use crate::db::migration::Migrator;
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        Migrator::up(&conn, None)
            .await
            .expect("all migrations apply");
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM pragma_table_info('conversation') WHERE name LIKE 'limit_%'"
                    .to_owned(),
            ))
            .await
            .expect("pragma query");
        assert_eq!(rows.len(), 4, "all four columns exist");
    }
}
