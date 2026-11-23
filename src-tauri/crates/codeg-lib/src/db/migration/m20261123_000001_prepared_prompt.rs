use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // prepared_prompt: messages the user wrote ahead of time for ONE
        // conversation, listed in the right-hand panel's Prompts tab and sent
        // (or put in the composer) from there. Nothing is shared across
        // conversations. Kept on the server, so every window showing this
        // server's sessions (a remote window included) sees the same list.
        // Sending one leaves it in the list and stamps `last_sent_at`.
        // Hard-deleted: one at a time, all of a conversation's when the
        // conversation is deleted (an explicit scrub, since deleting a
        // conversation only marks it), and through the foreign key when a
        // conversation row is ever removed.
        manager
            .create_table(
                Table::create()
                    .table(PreparedPrompt::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PreparedPrompt::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PreparedPrompt::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PreparedPrompt::Content).text().not_null())
                    // Position in the conversation's list, top to bottom.
                    .col(
                        ColumnDef::new(PreparedPrompt::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    // When it was last sent from the panel; NULL until then.
                    .col(
                        ColumnDef::new(PreparedPrompt::LastSentAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(PreparedPrompt::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PreparedPrompt::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_prepared_prompt_conversation")
                            .from(PreparedPrompt::Table, PreparedPrompt::ConversationId)
                            .to(Conversation::Table, Conversation::Id)
                            .on_delete(ForeignKeyAction::Cascade)
                            .on_update(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_prepared_prompt_conversation")
                    .table(PreparedPrompt::Table)
                    .col(PreparedPrompt::ConversationId)
                    .col(PreparedPrompt::SortOrder)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PreparedPrompt::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum PreparedPrompt {
    Table,
    Id,
    ConversationId,
    Content,
    SortOrder,
    LastSentAt,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    use sea_orm_migration::{MigrationTrait, SchemaManager};

    use super::Migration;
    use crate::db::entities::conversation;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    async fn columns(conn: &sea_orm::DatabaseConnection) -> Vec<String> {
        conn.query_all(sql("PRAGMA table_info(prepared_prompt)"))
            .await
            .expect("table_info")
            .iter()
            .map(|row| row.try_get::<String>("", "name").expect("name"))
            .collect()
    }

    async fn count(conn: &sea_orm::DatabaseConnection) -> i64 {
        conn.query_one(sql("SELECT COUNT(*) AS n FROM prepared_prompt"))
            .await
            .expect("count")
            .expect("row")
            .try_get::<i64>("", "n")
            .expect("n")
    }

    #[tokio::test]
    async fn creates_the_table_and_rolls_back() {
        let db = fresh_in_memory_db().await;
        assert_eq!(
            columns(&db.conn).await,
            [
                "id",
                "conversation_id",
                "content",
                "sort_order",
                "last_sent_at",
                "created_at",
                "updated_at"
            ]
        );

        let manager = SchemaManager::new(&db.conn);
        Migration.down(&manager).await.expect("down");
        assert!(columns(&db.conn).await.is_empty(), "table dropped");
        Migration.up(&manager).await.expect("up again");
        assert_eq!(columns(&db.conn).await.len(), 7);
    }

    /// A conversation row that is ever really removed takes its prompts with
    /// it, so no prompt can outlive its conversation.
    #[tokio::test]
    async fn removing_a_conversation_row_removes_its_prompts() {
        use sea_orm::EntityTrait;

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/prepared-prompt-migration").await;
        let gone = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let kept = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        for conversation_id in [gone, gone, kept] {
            db.conn
                .execute(sql(&format!(
                    "INSERT INTO prepared_prompt \
                     (conversation_id, content, sort_order, created_at, updated_at) \
                     VALUES ({conversation_id}, 'next', 0, \
                     '2026-11-23 00:00:00', '2026-11-23 00:00:00')"
                )))
                .await
                .expect("insert prompt");
        }
        assert_eq!(count(&db.conn).await, 3);

        conversation::Entity::delete_by_id(gone)
            .exec(&db.conn)
            .await
            .expect("delete conversation row");
        assert_eq!(count(&db.conn).await, 1, "only the kept one's prompt");
    }
}
