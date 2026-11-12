pub mod entities;
pub mod error;
pub mod migration;
pub mod service;
pub mod watch;

#[cfg(any(test, feature = "test-utils"))]
pub mod test_helpers;

use std::path::Path;
use std::time::Duration;

use sea_orm::sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sea_orm::sqlx::ConnectOptions as _;
use sea_orm::{DatabaseConnection, DbErr, RuntimeErr, SqlxSqliteConnector};
use sea_orm_migration::MigratorTrait;

use error::DbError;
use migration::Migrator;

pub struct AppDatabase {
    pub conn: DatabaseConnection,
}

/// The database's file name inside the data dir: a debug desktop build keeps
/// its own beside a release one.
pub fn database_file_name() -> &'static str {
    if cfg!(all(debug_assertions, feature = "tauri-runtime")) {
        "codeg-dev.db"
    } else {
        "codeg.db"
    }
}

pub async fn init_database(
    app_data_dir: impl AsRef<Path>,
    app_version: &str,
) -> Result<AppDatabase, DbError> {
    let app_data_dir = app_data_dir.as_ref();
    std::fs::create_dir_all(app_data_dir)?;

    // Nothing below may run in a process that does not own the data dir: the
    // restore swaps the database file, and the migrations and sweeps rewrite
    // rows its owner is using — the interrupted-turn sweep would cut off a live
    // owner's running turns and queue them for an automatic resume. Both
    // binaries claim the dir at startup, before their first write; this is the
    // backstop for any other way in.
    match crate::data_dir_owner::claim(app_data_dir) {
        Ok(()) => {}
        Err(err @ crate::data_dir_owner::ClaimError::InUse { .. }) => {
            return Err(DbError::InUse(err.to_string()));
        }
        // No lock support at all, not contention: open as before the lock
        // existed. The engines still refuse to start without it.
        Err(err) => tracing::warn!("[db] {err}; opening without the data dir owner lock"),
    }

    // Apply any pending restore BEFORE opening a connection — swapping
    // `codeg.db` under a live SQLite handle would corrupt it. A failure here
    // aborts startup loudly (leaving the safety snapshot intact) rather than
    // booting a half-restored data dir.
    match crate::commands::backup::restore::apply_pending_restore_on_startup(app_data_dir) {
        Ok(crate::commands::backup::restore::RestoreApplied::Applied { .. }) => {}
        Ok(crate::commands::backup::restore::RestoreApplied::None) => {}
        Err(e) => return Err(DbError::Io(e)),
    }
    crate::commands::backup::restore::cleanup_transient_dirs(app_data_dir);

    let db_path = app_data_dir.join(database_file_name());

    // Apply migrations on a dedicated single connection. The runtime pool below
    // keeps several connections open for read concurrency, but sea-orm spreads a
    // migration's statements across whichever pooled connections are free. A
    // statement that references a column an earlier migration just added (e.g.
    // the `is_chat` → `kind` backfill) can then land on a connection whose
    // cached SQLite schema predates the `ALTER TABLE`, producing a flaky
    // `no such column: "is_chat"` under load. One connection observes every DDL
    // change in order, so the schema it compiles against is always current.
    let migrate_conn = open_pool(&db_path, 1).await?;
    Migrator::up(&migrate_conn, None)
        .await
        .map_err(|e| DbError::Migration(e.to_string()))?;
    migrate_conn.close().await?;

    // Runtime connection pool. Migrations are already applied above, so the
    // schema is stable and spreading queries across pooled connections is safe.
    let conn = open_pool(&db_path, POOL_MAX_CONNECTIONS).await?;

    service::app_metadata_service::update_app_version(&conn, app_version).await?;

    // No agent turn survives a process exit, so a row still marked as running
    // was cut off when the previous process quit, crashed or restarted for an
    // update. Record it as interrupted before anything can read the list, so
    // every client sees it with a way to continue. Both runtimes open the
    // database here, before any connection exists. A failure must not block
    // startup — the rows just keep their stale mark.
    match service::conversation_service::interrupt_orphaned_turns(&conn).await {
        Ok(0) => {}
        Ok(count) => {
            tracing::info!(
                "[conversation] marked {count} turn(s) cut off by the last exit as interrupted"
            );
        }
        Err(e) => tracing::warn!("[conversation] failed to mark interrupted turns: {e}"),
    }

    // Publish user-registered ACP agents into the process-global launch
    // registry before anything can ask for agent metadata. This is the single
    // chokepoint every runtime (desktop, server) goes through, so custom agents
    // are live from the first `all_acp_agents()` / `get_agent_meta()` call.
    // A failure here must not block startup — the built-in agents still work.
    if let Err(e) = service::custom_agent_service::hydrate_registry(&conn).await {
        tracing::warn!("[custom-agent] failed to hydrate custom agent registry: {e}");
    }

    // Load user-authorized workspace links before any file command can run, so
    // the workspace path guard follows exactly the symlinks the user created
    // and nothing else. A failure here fails *closed* (registry stays empty:
    // linked subtrees look unreadable) rather than blocking startup.
    match crate::folder_links::hydrate(&conn).await {
        Ok(count) if count > 0 => {
            tracing::info!("[folder-link] hydrated {count} workspace link(s)");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[folder-link] failed to hydrate workspace links: {e}"),
    }

    Ok(AppDatabase { conn })
}

/// Connections in the runtime pool.
const POOL_MAX_CONNECTIONS: u32 = 5;
/// How long a statement waits for another connection's write lock before it
/// fails with "database is locked".
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// How every connection to the database is opened. sqlx applies these to each
/// connection it opens, including one re-opened after the idle timeout — not
/// just to whichever pooled connection a `PRAGMA` statement happens to land on
/// (which left the others on SQLite's defaults: `synchronous=FULL`, a 2 MB
/// page cache). `journal_mode=WAL` persists in the database file.
pub(crate) fn connect_options(db_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(BUSY_TIMEOUT)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .pragma("cache_size", "-8000")
        .disable_statement_logging()
}

/// A pool of up to `max_connections` connections opened with
/// [`connect_options`]. Every connection gets the write-lock watch, and every
/// statement the slow-statement log (see [`watch`]).
pub(crate) async fn open_pool(
    db_path: &Path,
    max_connections: u32,
) -> Result<DatabaseConnection, DbError> {
    let pool = SqlitePoolOptions::new()
        .max_connections(max_connections)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .acquire_slow_threshold(watch::SLOW_ACQUIRE)
        .idle_timeout(Duration::from_secs(300))
        .after_connect(|conn, _meta| Box::pin(async move { watch::watch_writes(conn).await }))
        .connect_with(connect_options(db_path))
        .await
        .map_err(|e| DbError::Database(DbErr::Conn(RuntimeErr::SqlxError(e))))?;
    let mut conn = SqlxSqliteConnector::from_sqlx_sqlite_pool(pool);
    conn.set_metric_callback(watch::log_slow_statement);
    Ok(conn)
}

#[cfg(test)]
mod owner_tests {
    use super::*;
    use crate::db::entities::conversation::{
        self, ConversationAutoResume, ConversationTurnState,
    };
    use crate::db::service::{app_metadata_service, conversation_service, folder_service};
    use crate::models::agent::AgentType;
    use sea_orm::EntityTrait;

    /// The data dir's database, opened without claiming the dir.
    async fn open(dir: &Path) -> DatabaseConnection {
        open_pool(&dir.join(database_file_name()), 1)
            .await
            .expect("open")
    }

    /// A data dir whose database holds one conversation with a running turn, as
    /// its owner leaves it mid-turn. Written without claiming the dir. Returns
    /// the conversation's id.
    async fn seed_running_turn(dir: &Path) -> i32 {
        let conn = open(dir).await;
        Migrator::up(&conn, None).await.expect("migrate");
        app_metadata_service::update_app_version(&conn, "1.0.0")
            .await
            .expect("version");
        let folder = folder_service::add_folder(&conn, "/tmp/single-owner")
            .await
            .expect("folder")
            .id;
        let id = conversation_service::create(&conn, folder, AgentType::ClaudeCode, None, None)
            .await
            .expect("conversation")
            .id;
        assert!(conversation_service::mark_turn_running(&conn, id)
            .await
            .expect("mark running"));
        conn.close().await.expect("close");
        id
    }

    /// The row and the recorded app version as they stand, read without
    /// anything that sweeps.
    async fn stored(dir: &Path, id: i32) -> (conversation::Model, Option<String>) {
        let conn = open(dir).await;
        let row = conversation::Entity::find_by_id(id)
            .one(&conn)
            .await
            .expect("query")
            .expect("row");
        let version = app_metadata_service::get_value(&conn, "app_version")
            .await
            .expect("version");
        conn.close().await.expect("close");
        (row, version)
    }

    #[tokio::test]
    async fn a_dir_another_process_owns_is_left_as_it_was_and_its_owner_still_sweeps() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let id = seed_running_turn(tmp.path()).await;
        let before = stored(tmp.path(), id).await;

        let owner = crate::data_dir_owner::hold_as_other_process(tmp.path());
        let refused = init_database(tmp.path(), "2.0.0").await;
        assert!(
            matches!(refused, Err(DbError::InUse(_))),
            "a dir another process owns is refused"
        );
        assert_eq!(
            stored(tmp.path(), id).await,
            before,
            "the refused start wrote nothing: the turn still runs, the version is the owner's"
        );

        // Once the owner is gone, the next start sweeps as it always has. The
        // lock can outlive `drop` for a moment (see `hold_as_other_process`).
        drop(owner);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let db = loop {
            match init_database(tmp.path(), "2.0.0").await {
                Ok(db) => break db,
                Err(DbError::InUse(_)) if std::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(e) => panic!("the owner's start failed: {e}"),
            }
        };
        let swept = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("row");
        assert_eq!(swept.turn_state, Some(ConversationTurnState::Interrupted));
        assert_eq!(swept.auto_resume, Some(ConversationAutoResume::Pending));
    }
}

#[cfg(test)]
mod pool_tests {
    use super::*;
    use sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};

    async fn pragma(conn: &impl ConnectionTrait, name: &str) -> String {
        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                format!("PRAGMA {name}"),
            ))
            .await
            .expect("pragma")
            .expect("row");
        row.try_get_by_index::<i64>(0)
            .map(|v| v.to_string())
            .or_else(|_| row.try_get_by_index::<String>(0))
            .expect("value")
    }

    /// Every connection the pool opens carries the settings, not just the one
    /// a `PRAGMA` statement on the pool lands on: hold all of them at once (a
    /// transaction pins its connection) and read them from each.
    #[tokio::test]
    async fn every_pooled_connection_gets_the_pragmas() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let conn = open_pool(&tmp.path().join("p.db"), POOL_MAX_CONNECTIONS)
            .await
            .expect("pool");
        let mut held = Vec::new();
        for _ in 0..POOL_MAX_CONNECTIONS {
            held.push(conn.begin().await.expect("begin"));
        }
        for txn in &held {
            assert_eq!(pragma(txn, "journal_mode").await, "wal");
            assert_eq!(pragma(txn, "busy_timeout").await, "5000");
            // NORMAL
            assert_eq!(pragma(txn, "synchronous").await, "1");
            assert_eq!(pragma(txn, "foreign_keys").await, "1");
            assert_eq!(pragma(txn, "cache_size").await, "-8000");
        }
    }
}
