use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The conversation's Talk mode (a voice conversation held from the
        // phone, see `crate::talk`): `on` while it lasts, `ending` once it was
        // turned off and the agent has not been told yet (the next message
        // carries the Off note, then the column clears), NULL otherwise.
        // A preference, not activity: writing it never moves `updated_at`.
        //
        // Nullable with no default: every existing row is off.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::TalkState).string().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::TalkState)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    TalkState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn talk_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('conversation') \
             WHERE name = 'talk_state'"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the column (NULL on existing rows: Talk is off), and `down`
    /// drops it again; the full chain applies with it.
    #[tokio::test]
    async fn up_adds_talk_state_and_down_drops_it() {
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
                "SELECT talk_state FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        let state: Option<String> = rows[0].try_get("", "talk_state").expect("talk_state col");
        assert_eq!(state, None, "an existing row is not in Talk mode");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(talk_columns(&conn).await, 0, "down drops the column");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(talk_columns(&fresh).await, 1);
    }
}
