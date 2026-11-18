use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // "Continue in another agent": the conversation this one picked the
        // work up from (another agent wrote it a handoff). Written once, when
        // the new conversation's row is created; NULL for every other row.
        // Not a delegation link: `parent_id` stays reserved for sub-sessions
        // (`kind = delegate`), and the two can never mean the same thing.
        //
        // Nullable with no default and no foreign key: no existing row
        // continues another, and a deleted source only loses its banner.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::ContinuedFromId)
                            .integer()
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
                    .drop_column(Conversation::ContinuedFromId)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    ContinuedFromId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn link_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('conversation') \
             WHERE name = 'continued_from_id'"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the column (NULL on existing rows: none continues another),
    /// `down` drops it again, and the full chain applies with it.
    #[tokio::test]
    async fn up_adds_continued_from_id_and_down_drops_it() {
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
                "SELECT continued_from_id FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        let from: Option<i32> = rows[0]
            .try_get("", "continued_from_id")
            .expect("continued_from_id col");
        assert_eq!(from, None, "an existing row continues nothing");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(link_columns(&conn).await, 0, "down drops the column");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(link_columns(&fresh).await, 1);
    }
}
