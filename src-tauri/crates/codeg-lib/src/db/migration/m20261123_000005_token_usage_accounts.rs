//! Usage by thread and by account: Claude sessions' calls one by one, their
//! threads (main thread and sub-agents), and the account pool's request
//! records they are joined to.
//!
//! * `token_usage_call` — one row per API call of a Claude session, with
//!   the upstream `message_id`/`request_id` the transcript recorded and the
//!   call's list price. Same JOIN-to-`conversation` design as
//!   `token_usage_turn` (folder, agent and soft delete are never copied).
//! * `token_usage_thread` — labels for each sub-agent; the main thread's row
//!   (`thread_key = ''`) is the call sync's stamp.
//! * `usage_pool_request` — the pool's per-request metadata (account, ids,
//!   tokens, weekly reading) and the share of the weekly limit computed from
//!   it. Unique on the pool's own record id, so a re-read overlap inserts
//!   nothing twice.
//!
//! New tables only; nothing existing changes.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

fn tokens(col: impl IntoIden) -> ColumnDef {
    ColumnDef::new(col)
        .big_integer()
        .not_null()
        .default(0)
        .to_owned()
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(TokenUsageCall::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(TokenUsageCall::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(TokenUsageCall::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(TokenUsageCall::ThreadKey)
                            .string()
                            .not_null()
                            .default(""),
                    )
                    .col(ColumnDef::new(TokenUsageCall::MessageId).string().null())
                    .col(ColumnDef::new(TokenUsageCall::RequestId).string().null())
                    .col(
                        ColumnDef::new(TokenUsageCall::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(ColumnDef::new(TokenUsageCall::Model).string().null())
                    .col(tokens(TokenUsageCall::InputTokens))
                    .col(tokens(TokenUsageCall::OutputTokens))
                    .col(tokens(TokenUsageCall::CacheReadTokens))
                    .col(tokens(Alias::new("cache_write_5m_tokens")))
                    .col(tokens(Alias::new("cache_write_1h_tokens")))
                    .col(ColumnDef::new(TokenUsageCall::CostUsd).double().null())
                    .to_owned(),
            )
            .await?;
        for (name, col) in [
            (
                "idx_token_usage_call_conversation",
                TokenUsageCall::ConversationId,
            ),
            (
                "idx_token_usage_call_occurred_at",
                TokenUsageCall::OccurredAt,
            ),
            ("idx_token_usage_call_message_id", TokenUsageCall::MessageId),
            ("idx_token_usage_call_request_id", TokenUsageCall::RequestId),
        ] {
            manager
                .create_index(
                    Index::create()
                        .name(name)
                        .table(TokenUsageCall::Table)
                        .col(col)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_table(
                Table::create()
                    .table(TokenUsageThread::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(TokenUsageThread::ConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(TokenUsageThread::ThreadKey)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(TokenUsageThread::Label).string().null())
                    .col(ColumnDef::new(TokenUsageThread::AgentType).string().null())
                    .col(ColumnDef::new(TokenUsageThread::ParentKey).string().null())
                    .col(ColumnDef::new(TokenUsageThread::SourcePath).string().null())
                    .col(
                        ColumnDef::new(TokenUsageThread::SourceFingerprint)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(TokenUsageThread::SchemaVersion)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(TokenUsageThread::SyncedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(TokenUsageThread::ConversationId)
                            .col(TokenUsageThread::ThreadKey),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(UsagePoolRequest::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(UsagePoolRequest::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(UsagePoolRequest::RecordId)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(UsagePoolRequest::OccurredAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UsagePoolRequest::Account)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(UsagePoolRequest::AccountKind)
                            .string()
                            .not_null()
                            .default("claude"),
                    )
                    .col(ColumnDef::new(UsagePoolRequest::LinkRow).string().null())
                    .col(ColumnDef::new(UsagePoolRequest::Model).string().null())
                    .col(ColumnDef::new(UsagePoolRequest::MessageId).string().null())
                    .col(ColumnDef::new(UsagePoolRequest::RequestId).string().null())
                    .col(ColumnDef::new(UsagePoolRequest::SessionId).string().null())
                    .col(tokens(UsagePoolRequest::InputTokens))
                    .col(tokens(UsagePoolRequest::OutputTokens))
                    .col(tokens(UsagePoolRequest::CacheReadTokens))
                    .col(tokens(Alias::new("cache_write_5m_tokens")))
                    .col(tokens(Alias::new("cache_write_1h_tokens")))
                    .col(ColumnDef::new(Alias::new("util7d")).double().null())
                    .col(ColumnDef::new(Alias::new("util7d_prev")).double().null())
                    .col(
                        ColumnDef::new(Alias::new("reset7d_ms"))
                            .big_integer()
                            .null(),
                    )
                    .col(ColumnDef::new(UsagePoolRequest::CostUsd).double().null())
                    .col(ColumnDef::new(UsagePoolRequest::Pct).double().null())
                    .col(
                        ColumnDef::new(UsagePoolRequest::PctSource)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(UsagePoolRequest::MeterLevel).double().null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_usage_pool_request_message_id")
                    .table(UsagePoolRequest::Table)
                    .col(UsagePoolRequest::MessageId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_usage_pool_request_request_id")
                    .table(UsagePoolRequest::Table)
                    .col(UsagePoolRequest::RequestId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_usage_pool_request_occurred_at")
                    .table(UsagePoolRequest::Table)
                    .col(UsagePoolRequest::OccurredAt)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_usage_pool_request_account_time")
                    .table(UsagePoolRequest::Table)
                    .col(UsagePoolRequest::Account)
                    .col(UsagePoolRequest::OccurredAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(UsagePoolRequest::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(TokenUsageThread::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(TokenUsageCall::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden, Clone, Copy)]
enum TokenUsageCall {
    Table,
    Id,
    ConversationId,
    ThreadKey,
    MessageId,
    RequestId,
    OccurredAt,
    Model,
    InputTokens,
    OutputTokens,
    CacheReadTokens,
    CostUsd,
}

#[derive(DeriveIden)]
enum TokenUsageThread {
    Table,
    ConversationId,
    ThreadKey,
    Label,
    AgentType,
    ParentKey,
    SourcePath,
    SourceFingerprint,
    SchemaVersion,
    SyncedAt,
}

#[derive(DeriveIden)]
enum UsagePoolRequest {
    Table,
    Id,
    RecordId,
    OccurredAt,
    Account,
    AccountKind,
    LinkRow,
    Model,
    MessageId,
    RequestId,
    SessionId,
    InputTokens,
    OutputTokens,
    CacheReadTokens,
    CostUsd,
    Pct,
    PctSource,
    MeterLevel,
}

#[cfg(test)]
mod tests {
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::{MigrationTrait, MigratorTrait, SchemaManager};

    use super::Migration;
    use crate::db::migration::Migrator;

    async fn columns(conn: &sea_orm::DatabaseConnection, table: &str) -> Vec<String> {
        conn.query_all(Statement::from_string(
            DbBackend::Sqlite,
            format!("SELECT name FROM pragma_table_info('{table}') ORDER BY cid"),
        ))
        .await
        .expect("pragma")
        .into_iter()
        .map(|r| r.try_get::<String>("", "name").expect("name"))
        .collect()
    }

    #[tokio::test]
    async fn creates_the_three_tables_with_the_entity_columns_and_drops_them_again() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        Migrator::up(&conn, None).await.expect("up");
        assert_eq!(
            columns(&conn, "token_usage_call").await,
            [
                "id",
                "conversation_id",
                "thread_key",
                "message_id",
                "request_id",
                "occurred_at",
                "model",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_5m_tokens",
                "cache_write_1h_tokens",
                "cost_usd",
            ]
        );
        assert_eq!(
            columns(&conn, "token_usage_thread").await,
            [
                "conversation_id",
                "thread_key",
                "label",
                "agent_type",
                "parent_key",
                "source_path",
                "source_fingerprint",
                "schema_version",
                "synced_at",
            ]
        );
        assert_eq!(
            columns(&conn, "usage_pool_request").await,
            [
                "id",
                "record_id",
                "occurred_at",
                "account",
                "account_kind",
                "link_row",
                "model",
                "message_id",
                "request_id",
                "session_id",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_5m_tokens",
                "cache_write_1h_tokens",
                "util7d",
                "util7d_prev",
                "reset7d_ms",
                "cost_usd",
                "pct",
                "pct_source",
                "meter_level",
            ]
        );
        // The record id is unique: a re-read overlap inserts nothing twice.
        let insert = "INSERT INTO usage_pool_request (record_id, occurred_at, account) VALUES ('r1', '2026-11-23T00:00:00Z', 'a')";
        conn.execute(Statement::from_string(DbBackend::Sqlite, insert.to_owned()))
            .await
            .expect("first insert");
        assert!(conn
            .execute(Statement::from_string(DbBackend::Sqlite, insert.to_owned()))
            .await
            .is_err());

        // This migration's own down, whatever is listed after it.
        Migration
            .down(&SchemaManager::new(&conn))
            .await
            .expect("down");
        for table in [
            "token_usage_call",
            "token_usage_thread",
            "usage_pool_request",
        ] {
            assert!(columns(&conn, table).await.is_empty(), "{table} dropped");
        }
        assert!(
            !columns(&conn, "token_usage_turn").await.is_empty(),
            "the older tables stay"
        );
    }
}
