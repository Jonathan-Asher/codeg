use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // `archived` moves a workspace folder, or a whole folder group, out of
        // the sidebar's main folder list into its "Archived" section, and keeps
        // its sessions out of the Recent lists. Purely presentational: nothing
        // that resolves a cwd, an agent or a conversation reads it, and it never
        // touches a session, a file or git. Existing rows start unarchived.
        //
        // A folder inside an archived group is archived through the group; its
        // own flag stays as it was, so unarchiving the group restores exactly
        // what was there before.
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .add_column(
                        ColumnDef::new(Folder::Archived)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(FolderGroup::Table)
                    .add_column(
                        ColumnDef::new(FolderGroup::Archived)
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
                    .table(FolderGroup::Table)
                    .drop_column(FolderGroup::Archived)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .drop_column(Folder::Archived)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    Archived,
}

#[derive(DeriveIden)]
enum FolderGroup {
    Table,
    Archived,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    async fn bool_column(
        conn: &sea_orm_migration::sea_orm::DatabaseConnection,
        table: &str,
    ) -> Vec<bool> {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            format!("SELECT archived FROM {table} ORDER BY id"),
        ))
        .await
        .expect("select archived")
        .iter()
        .map(|row| row.try_get::<bool>("", "archived").expect("archived col"))
        .collect()
    }

    /// `up` adds `archived` (false) to both tables, existing rows included, and
    /// `down` takes it away again.
    #[tokio::test]
    async fn up_adds_unarchived_flags_and_down_drops_them() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE folder (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT)",
        )
        .await
        .expect("create folder stub");
        conn.execute_unprepared(
            "CREATE TABLE folder_group (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
        )
        .await
        .expect("create group stub");
        conn.execute_unprepared("INSERT INTO folder (path) VALUES ('/a'), ('/b')")
            .await
            .expect("insert folders");
        conn.execute_unprepared("INSERT INTO folder_group (name) VALUES ('Work')")
            .await
            .expect("insert group");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        assert_eq!(
            bool_column(&conn, "folder").await,
            vec![false, false],
            "existing folders start unarchived"
        );
        assert_eq!(
            bool_column(&conn, "folder_group").await,
            vec![false],
            "existing groups start unarchived"
        );

        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("run migration down");
        for table in ["folder", "folder_group"] {
            let cols = conn
                .query_all(Statement::from_string(
                    DbBackend::Sqlite,
                    format!(
                        "SELECT name FROM pragma_table_info('{table}') WHERE name = 'archived'"
                    ),
                ))
                .await
                .expect("pragma query");
            assert!(cols.is_empty(), "down drops {table}.archived");
        }
    }

    /// The full chain applies on a fresh database with this migration in it.
    #[tokio::test]
    async fn full_migrator_applies_with_archived_columns() {
        use crate::db::migration::Migrator;
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        Migrator::up(&conn, None)
            .await
            .expect("all migrations apply");
        for table in ["folder", "folder_group"] {
            let cols = conn
                .query_all(Statement::from_string(
                    DbBackend::Sqlite,
                    format!(
                        "SELECT name FROM pragma_table_info('{table}') WHERE name = 'archived'"
                    ),
                ))
                .await
                .expect("pragma query");
            assert_eq!(cols.len(), 1, "{table}.archived exists");
        }
    }
}
