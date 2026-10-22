use std::sync::Arc;

use async_trait::async_trait;
use chrono::TimeZone;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};

use super::*;
use crate::acp::delegation::broker::ConversationDepthLookup;
use crate::acp::delegation::spawner::mock::MockSpawner;
use crate::acp::delegation::spawner::ConnectionSpawner;
use crate::acp::delegation::types::{DelegationError, DelegationSuccess};
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};

struct RootDepth;

#[async_trait]
impl ConversationDepthLookup for RootDepth {
    async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

fn broker() -> DelegationBroker {
    DelegationBroker::new(
        Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
        Arc::new(RootDepth) as Arc<dyn ConversationDepthLookup>,
    )
}

fn at(h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 22, h, m, 0).unwrap()
}

/// A parent conversation and a delegation child of it (task `task-1`).
async fn parent_and_child(db: &AppDatabase) -> (i32, DbConversationSummary) {
    let folder = seed_folder(db, "/tmp/limit-delivery").await;
    let parent = seed_conversation(db, folder, AgentType::ClaudeCode).await;
    let child = seed_conversation(db, folder, AgentType::ClaudeCode).await;
    let mut row: conversation::ActiveModel = conversation::Entity::find_by_id(child)
        .one(&db.conn)
        .await
        .unwrap()
        .unwrap()
        .into();
    row.parent_id = Set(Some(parent));
    row.parent_tool_use_id = Set(Some("toolu_1".into()));
    row.delegation_call_id = Set(Some("task-1".into()));
    row.title = Set(Some("compute the answer".into()));
    row.update(&db.conn).await.unwrap();
    let summary = conversation_service::get_by_id(&db.conn, child)
        .await
        .unwrap();
    (parent, summary)
}

fn finished(text: &str) -> DelegationOutcome {
    DelegationOutcome::Ok(DelegationSuccess {
        text: text.into(),
        child_conversation_id: 2,
        child_agent_type: AgentType::ClaudeCode,
        turn_count: 1,
        duration_ms: 0,
        token_usage: None,
    })
}

async fn stored(db: &AppDatabase) -> Vec<PendingDelivery> {
    load(&db.conn).await.unwrap()
}

#[tokio::test]
async fn a_paused_child_owes_its_parent_exactly_one_result() {
    let db = fresh_in_memory_db().await;
    let (parent, child) = parent_and_child(&db).await;
    let broker = broker();

    record_pause(&db.conn, &child, "task-1", at(21, 0), None).await;
    let records = stored(&db).await;
    assert_eq!(records.len(), 1);
    let rec = &records[0];
    assert_eq!(rec.state, DeliveryState::Awaiting);
    assert_eq!(rec.parent_conversation_id, parent);
    assert_eq!(rec.child_conversation_id, child.id);
    assert_eq!(rec.parent_tool_use_id, "toolu_1");
    assert_eq!(rec.task_preview, "compute the answer");

    // Stopped by the limit again after a continuation: same record, new reset.
    record_pause(&db.conn, &child, "task-1", at(23, 30), None).await;
    let records = stored(&db).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].resets_at, at(23, 30));

    // The continued child finishes: its result is ready for the parent.
    child_finished(
        &db.conn,
        &broker,
        &child,
        "task-1",
        "end_turn",
        &finished("The answer is 42."),
    )
    .await;
    let records = stored(&db).await;
    assert_eq!(records[0].state, DeliveryState::Ready);
    let report = records[0].report.clone().unwrap();
    assert_eq!(report.status, TaskStatus::Completed);
    assert_eq!(report.text.as_deref(), Some("The answer is 42."));

    // A later turn of the child (driven by hand) owes nothing more.
    child_finished(
        &db.conn,
        &broker,
        &child,
        "task-1",
        "end_turn",
        &finished("something else"),
    )
    .await;
    let records = stored(&db).await;
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].report.as_ref().unwrap().text.as_deref(),
        Some("The answer is 42.")
    );

    // A pause recorded while the result still waits does not reopen it.
    record_pause(&db.conn, &child, "task-1", at(23, 59), None).await;
    assert_eq!(stored(&db).await[0].state, DeliveryState::Ready);

    // Claimed once: the second claim finds nothing to send.
    assert!(
        set_state(
            &db.conn,
            "task-1",
            DeliveryState::Ready,
            DeliveryState::Delivered
        )
        .await
    );
    assert!(
        !set_state(
            &db.conn,
            "task-1",
            DeliveryState::Ready,
            DeliveryState::Delivered
        )
        .await
    );
}

#[tokio::test]
async fn a_child_stopped_by_hand_is_not_delivered() {
    let db = fresh_in_memory_db().await;
    let (_, child) = parent_and_child(&db).await;
    record_pause(&db.conn, &child, "task-1", at(21, 0), None).await;
    let canceled = DelegationOutcome::Err {
        code: "canceled".into(),
        message: "child session was cancelled".into(),
        child_conversation_id: Some(child.id),
    };
    child_finished(
        &db.conn,
        &broker(),
        &child,
        "task-1",
        "cancelled",
        &canceled,
    )
    .await;
    assert_eq!(stored(&db).await[0].state, DeliveryState::Dropped);
}

#[tokio::test]
async fn a_turn_of_a_child_nobody_paused_owes_nothing() {
    let db = fresh_in_memory_db().await;
    let (_, child) = parent_and_child(&db).await;
    child_finished(
        &db.conn,
        &broker(),
        &child,
        "task-1",
        "end_turn",
        &finished("x"),
    )
    .await;
    assert!(stored(&db).await.is_empty());
}

#[tokio::test]
async fn the_parent_gate_waits_for_idle_and_drops_a_deleted_parent() {
    let db = fresh_in_memory_db().await;
    let (parent, _) = parent_and_child(&db).await;
    let row = |db: &AppDatabase| {
        let conn = db.conn.clone();
        async move {
            conversation::Entity::find_by_id(parent)
                .one(&conn)
                .await
                .unwrap()
                .unwrap()
        }
    };
    let idle = row(&db).await;
    assert_eq!(parent_gate(Some(&idle)), ParentGate::Send);

    let mut busy = idle.clone();
    busy.turn_state = Some(ConversationTurnState::Running);
    assert_eq!(parent_gate(Some(&busy)), ParentGate::Wait);

    let mut paused = idle.clone();
    paused.limit_resume_state = Some(ConversationLimitResume::Scheduled);
    paused.limit_resume_at = Some(at(21, 0));
    assert_eq!(parent_gate(Some(&paused)), ParentGate::Wait);

    let mut deleted = idle.clone();
    deleted.deleted_at = Some(Utc::now());
    assert_eq!(parent_gate(Some(&deleted)), ParentGate::Gone);
    assert_eq!(parent_gate(None), ParentGate::Gone);
}

fn delivery(state: DeliveryState, task: &str, parent: i32) -> PendingDelivery {
    PendingDelivery {
        task_id: format!("t-{task}"),
        child_conversation_id: 9,
        parent_conversation_id: parent,
        parent_tool_use_id: "toolu".into(),
        agent_type: AgentType::ClaudeCode,
        task_preview: task.into(),
        resets_at: at(21, 0),
        state,
        report: None,
        send_failures: 0,
        next_attempt_at: None,
        updated_at: Utc::now(),
    }
}

#[test]
fn re_delegating_the_same_task_supersedes_the_paused_one() {
    let mut records = vec![
        delivery(DeliveryState::Awaiting, "Refactor  the\nparser", 1),
        delivery(DeliveryState::Ready, "Refactor the parser", 1),
        delivery(DeliveryState::Awaiting, "Refactor the parser", 2),
        delivery(DeliveryState::Awaiting, "Write the docs", 1),
        delivery(DeliveryState::Delivered, "Refactor the parser", 1),
    ];
    let key = task_key("Refactor the parser ");
    assert_eq!(supersede(&mut records, 1, &key, Utc::now()), 2);
    let states: Vec<DeliveryState> = records.iter().map(|r| r.state).collect();
    assert_eq!(
        states,
        vec![
            DeliveryState::Superseded,
            DeliveryState::Superseded,
            // Another parent's task, a different task, and a delivered one
            // are left alone.
            DeliveryState::Awaiting,
            DeliveryState::Awaiting,
            DeliveryState::Delivered,
        ]
    );
}

#[test]
fn settled_records_are_pruned_after_a_day_unsettled_after_two_weeks() {
    let now = Utc::now();
    let mut old_delivered = delivery(DeliveryState::Delivered, "a", 1);
    old_delivered.updated_at = now - chrono::Duration::hours(25);
    let mut recent_delivered = delivery(DeliveryState::Delivered, "b", 1);
    recent_delivered.updated_at = now - chrono::Duration::hours(2);
    let mut old_awaiting = delivery(DeliveryState::Awaiting, "c", 1);
    old_awaiting.updated_at = now - chrono::Duration::days(15);
    let mut awaiting = delivery(DeliveryState::Awaiting, "d", 1);
    awaiting.updated_at = now - chrono::Duration::days(3);
    let mut records = vec![old_delivered, recent_delivered, old_awaiting, awaiting];
    prune(&mut records, now);
    let kept: Vec<&str> = records.iter().map(|r| r.task_preview.as_str()).collect();
    assert_eq!(kept, vec!["b", "d"]);
}

#[test]
fn the_delivery_message_carries_the_result_once_and_what_not_to_do() {
    let mut d = delivery(DeliveryState::Ready, "compute", 1);
    d.report = Some(report_of(&finished("The answer is 42.")));
    let prompt = delivery_prompt(&d);
    assert!(prompt.contains("The answer is 42."), "{prompt}");
    assert!(prompt.contains("task_id=\"t-compute\""), "{prompt}");
    assert!(prompt.contains("status=\"completed\""), "{prompt}");
    assert!(prompt.contains("delivered once"), "{prompt}");
    assert!(
        prompt.contains("do not delegate, resume or retry"),
        "{prompt}"
    );

    let failed = DelegationOutcome::Err {
        code: "child_refusal".into(),
        message: "subagent refused".into(),
        child_conversation_id: Some(9),
    };
    d.report = Some(report_of(&failed));
    let prompt = delivery_prompt(&d);
    assert!(prompt.contains("status=\"failed\""), "{prompt}");
    assert!(prompt.contains("error_code=\"child_refusal\""), "{prompt}");
    assert!(prompt.contains("subagent refused"), "{prompt}");

    // A huge result is cut, with a pointer to the full output.
    d.report = Some(report_of(&finished(&"x".repeat(RESULT_CAP_CHARS + 10))));
    let prompt = delivery_prompt(&d);
    assert!(prompt.contains("truncated"), "{prompt:.80}");
    assert!(prompt.chars().count() < RESULT_CAP_CHARS + 1000);
}
