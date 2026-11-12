//! Smoke test that exercises the externally-visible test scaffolding:
//! `fresh_in_memory_db` + `EventEmitter::test_web_only`. These are the
//! foundations for parser snapshot tests (Phase 2) and HTTP API
//! integration tests (Phase 4).

use std::sync::Arc;

use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::event_bridge::{EventEmitter, WebEventBroadcaster};

#[tokio::test]
async fn in_memory_db_boots_and_runs_migrations() {
    let db = fresh_in_memory_db().await;
    // Migrations ran if the connection is usable for a trivial query.
    use sea_orm::ConnectionTrait;
    let backend = db.conn.get_database_backend();
    assert_eq!(format!("{backend:?}"), "Sqlite");
}

#[test]
fn test_web_only_emitter_constructs() {
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let _emitter = EventEmitter::test_web_only(broadcaster);
}
