use std::sync::Arc;

use super::*;
use crate::acp::background_status::BackgroundTaskBrief;
use crate::acp::types::{AcpEvent, ConnectionStatus};
use crate::db::entities::conversation;
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;
use sea_orm::EntityTrait;

fn writer() -> SnapshotWriter {
    let dir = std::env::temp_dir().join(format!("codeg-bg-snapshot-{}", uuid::Uuid::new_v4()));
    SnapshotWriter::new(pi::PiScanner::new(
        dir.join("sessions"),
        dir.join("bg-jobs").join("jobs.json"),
    ))
}

async fn stored(db: &crate::db::AppDatabase, id: i32) -> Option<BackgroundSnapshot> {
    let row = conversation::Entity::find_by_id(id)
        .one(&db.conn)
        .await
        .unwrap()
        .unwrap();
    BackgroundSnapshot::parse(row.background_snapshot.as_deref())
}

/// A live connection bound to conversation `id`.
async fn connection(manager: &ConnectionManager, conn_id: &str, id: i32) {
    manager
        .insert_test_connection(conn_id, AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    manager
        .get_state(conn_id)
        .await
        .unwrap()
        .write()
        .await
        .conversation_id = Some(id);
}

/// What the transcript watcher reports for the connection.
async fn running(manager: &ConnectionManager, conn_id: &str, tasks: Vec<BackgroundTaskBrief>) {
    let state = manager.get_state(conn_id).await.unwrap();
    let mut s = state.write().await;
    s.apply_event(&AcpEvent::BackgroundActivity {
        session_id: "sess".into(),
        turns: Vec::new(),
        outstanding: tasks.len() as u32,
        settled: Vec::new(),
        watermark: 0,
        tasks,
        out_of_turn: false,
        activity_at: None,
    });
}

#[test]
fn a_live_status_becomes_a_snapshot_with_its_kinds() {
    let now = Utc::now();
    let mut delegation = BackgroundTaskBrief::new("task-1", KIND_DELEGATION, "run the tests");
    delegation.agent_type = Some(AgentType::Codex);
    let background = ConversationBackground {
        task_count: 5,
        tasks: vec![
            BackgroundTaskBrief::new("a1", "agent", "Review"),
            BackgroundTaskBrief::new("t1", KIND_SUBAGENT, "Explore: find it"),
            BackgroundTaskBrief::new("b1", "shell", "sleep 900"),
            delegation,
        ],
        out_of_turn: true,
        held_open: false,
    };
    let snap = snapshot_of(&background, now).expect("work");
    let kinds: Vec<&str> = snap.items.iter().map(|i| i.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            KIND_OUT_OF_TURN,
            KIND_SUB_AGENT,
            KIND_SUB_AGENT,
            KIND_SHELL,
            KIND_CODEG_DELEGATION
        ]
    );
    assert_eq!(snap.items[4].agent.as_deref(), Some("codex"));
    assert_eq!(snap.items[4].id.as_deref(), Some("task-1"));
    assert_eq!(snap.more, 1, "one task past the listing");
    assert!(snap.had_turn_of_its_own());
    assert_eq!(snap.background_items().count(), 4);

    // A turn held open with nothing named is the running turn's business.
    let held = ConversationBackground {
        task_count: 0,
        tasks: vec![],
        out_of_turn: false,
        held_open: true,
    };
    assert_eq!(snapshot_of(&held, now), None);

    // Round trip, and a damaged row reads as nothing.
    let parsed = BackgroundSnapshot::parse(Some(&snap.to_json())).unwrap();
    assert_eq!(parsed, snap);
    assert_eq!(BackgroundSnapshot::parse(Some("{not json")), None);
    assert_eq!(BackgroundSnapshot::parse(Some("")), None);
}

#[tokio::test]
async fn the_writer_records_changes_once_and_clears_finished_work() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/bg-snapshot-writes").await;
    let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let quiet = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let manager = ConnectionManager::new();
    connection(&manager, "c-busy", id).await;
    connection(&manager, "c-quiet", quiet).await;
    let w = writer();
    let t0 = Utc::now();

    assert_eq!(w.pass(&db.conn, &manager, t0, false).await, 0);
    assert_eq!(w.writes(), 0, "nothing runs, nothing is written");

    running(
        &manager,
        "c-busy",
        vec![BackgroundTaskBrief::new("b1", "shell", "sleep 900")],
    )
    .await;
    assert_eq!(w.pass(&db.conn, &manager, t0, false).await, 1);
    let snap = stored(&db, id).await.expect("recorded");
    assert_eq!(snap.items[0].kind, KIND_SHELL);
    assert_eq!(snap.items[0].label, "sleep 900");
    assert_eq!(snap.at, t0);
    assert_eq!(stored(&db, quiet).await, None);
    assert_eq!(w.writes(), 1);

    // The same work is not written again; the heartbeat refreshes its time.
    let t1 = t0 + chrono::Duration::seconds(30);
    w.pass(&db.conn, &manager, t1, false).await;
    assert_eq!(w.writes(), 1);
    let t2 = t0 + chrono::Duration::minutes(5);
    w.pass(&db.conn, &manager, t2, true).await;
    assert_eq!(w.writes(), 2);
    assert_eq!(stored(&db, id).await.unwrap().at, t2);

    // A second task starts: written.
    running(
        &manager,
        "c-busy",
        vec![
            BackgroundTaskBrief::new("b1", "shell", "sleep 900"),
            BackgroundTaskBrief::new("a1", "agent", "Review"),
        ],
    )
    .await;
    w.pass(&db.conn, &manager, t2, false).await;
    assert_eq!(stored(&db, id).await.unwrap().items.len(), 2);

    // All done: cleared.
    running(&manager, "c-busy", vec![]).await;
    assert_eq!(w.pass(&db.conn, &manager, t2, false).await, 0);
    assert_eq!(stored(&db, id).await, None);
    let writes = w.writes();
    w.pass(&db.conn, &manager, t2, false).await;
    assert_eq!(w.writes(), writes, "a cleared row is not cleared again");
}

#[tokio::test]
async fn a_connection_closing_while_codeg_runs_clears_its_work() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/bg-snapshot-close").await;
    let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let manager = ConnectionManager::new();
    connection(&manager, "c1", id).await;
    running(
        &manager,
        "c1",
        vec![BackgroundTaskBrief::new("b1", "shell", "x")],
    )
    .await;
    let w = writer();
    w.pass(&db.conn, &manager, Utc::now(), false).await;
    assert!(stored(&db, id).await.is_some());

    // The agent went away (idle sweep, a crash of its own): its background
    // work died with it, and no restart stopped anything.
    manager
        .get_state("c1")
        .await
        .unwrap()
        .write()
        .await
        .apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected,
        });
    w.pass(&db.conn, &manager, Utc::now(), false).await;
    assert_eq!(stored(&db, id).await, None);
}

#[tokio::test]
async fn a_frozen_writer_stops_and_the_exit_flush_still_writes() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/bg-snapshot-exit").await;
    let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let manager = ConnectionManager::new();
    connection(&manager, "c1", id).await;
    running(
        &manager,
        "c1",
        vec![BackgroundTaskBrief::new("a1", "agent", "Audit")],
    )
    .await;
    let w = Arc::new(writer());

    let looping = {
        let (w, conn, manager) = (w.clone(), db.conn.clone(), manager.clone_ref());
        tokio::spawn(async move {
            w.run(
                &conn,
                &manager,
                Duration::from_millis(50),
                Duration::from_secs(3600),
                Duration::from_secs(3600),
            )
            .await;
        })
    };
    // What a graceful quit does: freeze, then one last pass with a fresh time.
    w.freeze();
    tokio::time::timeout(Duration::from_secs(5), looping)
        .await
        .expect("the loop ends once frozen")
        .unwrap();
    let at = Utc::now();
    assert_eq!(w.pass(&db.conn, &manager, at, true).await, 1);
    assert_eq!(stored(&db, id).await.unwrap().at, at);

    // The teardown that follows clears every live status; nothing more is
    // written, so the row keeps what the exit stopped.
    running(&manager, "c1", vec![]).await;
    w.note_changed();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(stored(&db, id).await.is_some());
}

#[tokio::test]
async fn a_burst_of_changes_is_one_write_after_the_debounce() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/bg-snapshot-debounce").await;
    let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let manager = ConnectionManager::new();
    connection(&manager, "c1", id).await;
    let w = Arc::new(writer());
    let debounce = Duration::from_millis(400);
    let looping = {
        let (w, conn, manager) = (w.clone(), db.conn.clone(), manager.clone_ref());
        tokio::spawn(async move {
            w.run(
                &conn,
                &manager,
                debounce,
                Duration::from_secs(3600),
                Duration::from_secs(3600),
            )
            .await;
        })
    };

    for n in 1..=3 {
        let tasks = (0..n)
            .map(|i| BackgroundTaskBrief::new(format!("b{i}"), "shell", "build"))
            .collect();
        running(&manager, "c1", tasks).await;
        w.note_changed();
    }
    tokio::time::sleep(debounce / 4).await;
    assert_eq!(w.writes(), 0, "nothing before the burst settles");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while w.writes() == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        stored(&db, id).await.unwrap().items.len(),
        3,
        "the last state"
    );
    // The wake the burst left over finds nothing new to write.
    tokio::time::sleep(debounce * 2).await;
    assert_eq!(w.writes(), 1, "one write for the whole burst");

    w.freeze();
    let _ = tokio::time::timeout(Duration::from_secs(5), looping).await;
}

#[test]
fn items_are_named_for_the_prompt() {
    let at: DateTime<Utc> = "2026-11-12T11:14:00Z".parse().unwrap();
    let mut shell = BackgroundSnapshotItem::new(KIND_SHELL, "cargo test");
    shell.started_at = Some("2026-11-11T22:40:00Z".parse().unwrap());
    assert_eq!(
        describe_item(&shell, at, &Utc),
        "background shell: cargo test (started Nov 11 22:40)",
        "another day says which"
    );
    let mut job = BackgroundSnapshotItem::new(KIND_PI_JOB, "make");
    job.id = Some("jb-1".into());
    assert_eq!(describe_item(&job, at, &Utc), "background job jb-1: make");
    let unknown = BackgroundSnapshotItem::new("dev_server", "");
    assert_eq!(describe_item(&unknown, at, &Utc), "background dev server");
    let snap = BackgroundSnapshot {
        at,
        items: vec![BackgroundSnapshotItem::new(KIND_OUT_OF_TURN, "")],
        more: 1,
    };
    assert_eq!(describe_list(&snap, &Utc), vec!["- 1 more background task"]);
}
