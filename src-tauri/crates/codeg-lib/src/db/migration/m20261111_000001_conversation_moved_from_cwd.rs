use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The working directory a session ran in before it was moved to
        // another project, while the agent has not been told yet: the next
        // message carries a one-line note naming the old and the new folder,
        // then the column clears (see `crate::session_move`). NULL otherwise.
        // Not activity: writing it never moves `updated_at`.
        //
        // Nullable with no default: no existing row has a pending note.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::MovedFromCwd).string().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::MovedFromCwd)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    MovedFromCwd,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn note_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('conversation') \
             WHERE name = 'moved_from_cwd'"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the column (NULL on existing rows: nothing pending), `down`
    /// drops it again, and the full chain applies with it.
    #[tokio::test]
    async fn up_adds_moved_from_cwd_and_down_drops_it() {
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
                "SELECT moved_from_cwd FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        let from: Option<String> = rows[0]
            .try_get("", "moved_from_cwd")
            .expect("moved_from_cwd col");
        assert_eq!(from, None, "an existing row has no pending move note");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(note_columns(&conn).await, 0, "down drops the column");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(note_columns(&fresh).await, 1);
    }
}
