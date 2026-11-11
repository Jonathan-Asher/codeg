use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // What stopped the turn behind a usage-limit pause
        // (`acp::limit_continue`): `usage_limit` (the account's own limit) or
        // `pool_capacity` (the local account pool answered 429 because no
        // account behind it could take the request). Set with the pause and
        // kept once it ends without continuing (the continuations gave up, or
        // the user cancelled them), so the session still says why it
        // stopped; cleared when the next turn starts. NULL on existing rows:
        // they read as before.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::LimitResumeReason)
                            .string()
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
                    .drop_column(Conversation::LimitResumeReason)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    LimitResumeReason,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn reason_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('conversation') \
             WHERE name = 'limit_resume_reason'"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the column (NULL on existing rows: they read as before), and
    /// `down` drops it again; the full chain applies with it.
    #[tokio::test]
    async fn up_adds_the_reason_and_down_drops_it() {
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
                "SELECT limit_resume_reason FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        let reason: Option<String> = rows[0]
            .try_get("", "limit_resume_reason")
            .expect("reason col");
        assert_eq!(reason, None, "an existing row has no reason");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(reason_columns(&conn).await, 0, "down drops the column");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(reason_columns(&fresh).await, 1);
    }
}
