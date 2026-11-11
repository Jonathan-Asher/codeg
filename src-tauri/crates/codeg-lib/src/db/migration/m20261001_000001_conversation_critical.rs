use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// The watchdog lists the critical rows once a second; few rows ever are.
const IDX_CRITICAL: &str = "idx_conversation_critical";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `critical` marks a conversation the user wants watched: when it sits
        // idle (its turn ended, it waits on the user, or it was interrupted)
        // with nothing happening for the idle threshold, the backend's critical
        // session watchdog raises an alert, and repeats it until the user acts
        // (see `acp::critical_watch`). New and existing rows are not critical.
        //
        // SQLite adds one column per ALTER TABLE, hence two statements.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::Critical)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        // `critical_stall` is the per-session switch for stall detection: a
        // critical session whose turn is working but has streamed nothing for
        // the stall threshold raises a "may be stuck" alert. On by default, so
        // marking a session critical watches for both; it means nothing while
        // `critical` is false.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::CriticalStall)
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
                    .name(IDX_CRITICAL)
                    .table(Conversation::Table)
                    .col(Conversation::Critical)
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
                    .name(IDX_CRITICAL)
                    .table(Conversation::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::CriticalStall)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::Critical)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Critical,
    CriticalStall,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// `up` adds `critical` (default false) and `critical_stall` (default
    /// true) to existing rows, and `down` removes both again.
    #[tokio::test]
    async fn up_adds_critical_columns_with_defaults_and_down_drops_them() {
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
                "SELECT critical, critical_stall FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let critical: bool = rows[0].try_get("", "critical").expect("critical col");
        let stall: bool = rows[0]
            .try_get("", "critical_stall")
            .expect("critical_stall col");
        assert!(!critical, "an existing row is not critical");
        assert!(stall, "stall detection defaults on");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        let cols = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM pragma_table_info('conversation') WHERE name LIKE 'critical%'"
                    .to_owned(),
            ))
            .await
            .expect("pragma query");
        assert!(cols.is_empty(), "down drops both columns");
    }

    /// The full chain applies on a fresh database, with this migration in it.
    #[tokio::test]
    async fn full_migrator_applies_with_critical_columns() {
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
                "SELECT name FROM pragma_table_info('conversation') WHERE name IN ('critical', 'critical_stall')"
                    .to_owned(),
            ))
            .await
            .expect("pragma query");
        assert_eq!(rows.len(), 2, "both critical columns exist");
        let indexes = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversation_critical'"
                    .to_owned(),
            ))
            .await
            .expect("index query");
        assert_eq!(indexes.len(), 1, "the watchdog's lookup is indexed");
    }
}
