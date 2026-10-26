use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // When the user last opened this conversation (made it the active
        // tab) on any client. Stored on the server so every client orders its
        // session lists by the same views: the sidebar's Recent section by
        // the later of this and `updated_at`, the session switcher by this
        // alone. A view is not activity, so it never touches `updated_at`.
        // NULL on existing rows: never viewed since the column exists.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::LastViewedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::LastViewedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    LastViewedAt,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn viewed_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('conversation') \
             WHERE name = 'last_viewed_at'"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the column (NULL on existing rows: never viewed), and `down`
    /// drops it again; the full chain applies with it.
    #[tokio::test]
    async fn up_adds_last_viewed_at_and_down_drops_it() {
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
                "SELECT last_viewed_at FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        let viewed: Option<String> = rows[0]
            .try_get("", "last_viewed_at")
            .expect("last_viewed_at col");
        assert_eq!(viewed, None, "an existing row was never viewed");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(viewed_columns(&conn).await, 0, "down drops the column");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(viewed_columns(&fresh).await, 1);
    }
}
