use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The composer selectors (permission mode, model, effort, fast, …) this
        // conversation's agent session last had in effect, as JSON:
        // `{"modeId": "...", "configValues": {"model": "...", ...}}`. Written by
        // the lifecycle subscriber whenever the agent confirms a selector
        // (and once when a session first attaches), read by `acp_connect` when
        // it resumes the session, so every conversation reopens with its OWN
        // selectors instead of the last pick made in any conversation of the
        // same agent (see `conversation_service::ConversationSelectorState`).
        //
        // Nullable with no default: NULL is "nothing recorded yet", which is
        // true of every existing row. Such a row keeps the old behaviour on its
        // first reconnect (the client's saved per-agent picks) and is recorded
        // from then on.
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(ColumnDef::new(Conversation::SelectorState).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::SelectorState)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    SelectorState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// `up` adds a nullable `selector_state` column; existing rows read NULL
    /// ("nothing recorded yet") and the column takes a JSON document.
    #[tokio::test]
    async fn up_adds_nullable_selector_state_defaulting_null() {
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
                "SELECT selector_state FROM conversation".to_owned(),
            ))
            .await
            .expect("query rows");
        assert_eq!(rows.len(), 1);
        let value: Option<String> = rows[0]
            .try_get("", "selector_state")
            .expect("selector_state col");
        assert!(value.is_none(), "new column must default to NULL");

        conn.execute_unprepared(
            r#"UPDATE conversation SET selector_state = '{"modeId":"plan","configValues":{"effort":"max"}}'"#,
        )
        .await
        .expect("column accepts a JSON document");
    }

    /// The full chain applies on a fresh database, with this migration last.
    #[tokio::test]
    async fn full_migrator_applies_with_selector_state() {
        use crate::db::migration::Migrator;
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        Migrator::up(&conn, None).await.expect("all migrations apply");
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT name FROM pragma_table_info('conversation') WHERE name = 'selector_state'"
                    .to_owned(),
            ))
            .await
            .expect("pragma query");
        assert_eq!(rows.len(), 1, "conversation.selector_state exists");
    }
}
