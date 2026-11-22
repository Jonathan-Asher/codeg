use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `is_anchored` is the tab strip's "Pin tab": the tab is shown first,
        // compact, whatever the grouping or sort, and the bulk close commands
        // leave it open. Synced with the rest of the open-tab set, so every
        // window on this server shows the same pinned tabs. Not `is_pinned`,
        // which says the tab is kept open rather than being the preview the
        // next opened session replaces. Existing rows are not pinned.
        manager
            .alter_table(
                Table::alter()
                    .table(OpenedTab::Table)
                    .add_column(
                        ColumnDef::new(OpenedTab::IsAnchored)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(OpenedTab::Table)
                    .drop_column(OpenedTab::IsAnchored)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum OpenedTab {
    Table,
    IsAnchored,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{
        ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };

    async fn anchored_columns(conn: &DatabaseConnection) -> usize {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT name FROM pragma_table_info('opened_tab') WHERE name = 'is_anchored'"
                .to_owned(),
        ))
        .await
        .expect("pragma query")
        .len()
    }

    /// `up` adds the column (false on existing rows: nothing was pinned
    /// before), `down` drops it again, and the full chain applies with it.
    #[tokio::test]
    async fn up_adds_is_anchored_false_and_down_drops_it() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE opened_tab (id INTEGER PRIMARY KEY AUTOINCREMENT, position INTEGER)",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared("INSERT INTO opened_tab (position) VALUES (0)")
            .await
            .expect("insert row");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT is_anchored FROM opened_tab".to_owned(),
            ))
            .await
            .expect("query rows");
        let anchored: bool = rows[0].try_get("", "is_anchored").expect("is_anchored col");
        assert!(!anchored, "an existing tab is not pinned");

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        assert_eq!(anchored_columns(&conn).await, 0, "down drops the column");

        let fresh = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        crate::db::migration::Migrator::up(&fresh, None)
            .await
            .expect("all migrations apply");
        assert_eq!(anchored_columns(&fresh).await, 1);
    }
}
