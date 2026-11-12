//! The pending registry, driven by a fake clock and a fake sender: the
//! schedule, stopping on an answer, the away catch-up, nothing while looking,
//! the quiet hours, the badge and the restart.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::engine::{Engine, Pass};
use super::watch::{pending_message, run_jobs, PushSink};
use super::*;
use crate::acp::plan_approval::PendingPlanApprovalState;
use crate::acp::question::{PendingQuestionState, QuestionOption, QuestionSpec};
use crate::acp::session_state::PendingPermissionState;
use crate::acp::types::PermissionOptionInfo;
use crate::chat_channel::i18n::Lang;
use crate::models::AgentType;
use crate::presence::Looking;

const MIN: i64 = 60;
const HOUR: i64 = 60 * MIN;

fn t0() -> DateTime<Utc> {
    "2026-10-26T09:00:00Z".parse().unwrap()
}

fn at(secs: i64) -> DateTime<Utc> {
    t0() + chrono::Duration::seconds(secs)
}

fn opt(label: &str) -> PendingOption {
    PendingOption {
        id: label.into(),
        label: label.into(),
        kind: None,
    }
}

/// A question `id` asked in `conversation_id`, filed under `root`.
fn item(id: &str, conversation_id: i32, root: i32, asked_at: DateTime<Utc>) -> (Ask, SessionMeta) {
    (
        Ask {
            id: format!("question:{id}"),
            kind: PendingKind::Question,
            source: PendingSource::Question,
            conversation_id,
            connection_id: format!("conn-{conversation_id}"),
            request_id: id.into(),
            asked_at,
            text: "Which database?".into(),
            options: vec![opt("SQLite"), opt("Postgres")],
            question: Some(QuestionDetail {
                item_id: format!("{id}-0"),
                header: "Storage".into(),
                multi_select: false,
                count: 1,
                secret: false,
            }),
            queued: 0,
            agent_label: "Claude Code".into(),
        },
        SessionMeta {
            root_conversation_id: root,
            folder_id: Some(3),
            folder_name: Some("codeg".into()),
            title: Some("Fix login".into()),
            agent_type: Some("claude_code".into()),
        },
    )
}

fn away() -> Looking {
    Looking::default()
}

/// At the desk, looking at `at`.
fn desk(at: &[i32]) -> Looking {
    Looking {
        anyone: true,
        conversations: at.iter().copied().collect::<HashSet<_>>(),
    }
}

#[derive(Default)]
struct FakeSink {
    delivers: AtomicBool,
    pushes: Mutex<Vec<(String, u32, bool)>>,
    badges: Mutex<Vec<u32>>,
}

#[async_trait]
impl PushSink for FakeSink {
    async fn push(&self, item: &PendingItem, attempt: u32, reminder: bool) -> bool {
        self.pushes
            .lock()
            .unwrap()
            .push((item.id.clone(), attempt, reminder));
        self.delivers.load(Ordering::SeqCst)
    }

    async fn badge(&self, count: u32) {
        self.badges.lock().unwrap().push(count);
    }
}

/// What one step sent.
#[derive(Debug, Default)]
struct Step {
    list_changed: bool,
    pushes: Vec<(String, u32, bool)>,
    badges: Vec<u32>,
    reminders: Vec<String>,
}

struct Harness {
    engine: Engine,
    sink: FakeSink,
}

impl Harness {
    fn new(settings: ReminderSettings) -> Self {
        let sink = FakeSink::default();
        sink.delivers.store(true, Ordering::SeqCst);
        Self {
            engine: Engine::new(settings),
            sink,
        }
    }

    fn delivers(&self, yes: bool) {
        self.sink.delivers.store(yes, Ordering::SeqCst);
    }

    /// Observe at `t0 + secs`, then carry the jobs out through the sink.
    async fn step(&mut self, secs: i64, live: &[(Ask, SessionMeta)], looking: &Looking) -> Step {
        let pass: Pass = self.engine.observe(live.to_vec(), looking, at(secs));
        let pushes_before = self.sink.pushes.lock().unwrap().len();
        let badges_before = self.sink.badges.lock().unwrap().len();
        let step = Step {
            list_changed: pass.list_changed,
            reminders: pass.reminders.iter().map(|r| r.id.clone()).collect(),
            ..Step::default()
        };
        let engine = &mut self.engine;
        run_jobs(&self.sink, pass.jobs, |id, ok| engine.note_delivery(id, ok)).await;
        Step {
            pushes: self.sink.pushes.lock().unwrap()[pushes_before..].to_vec(),
            badges: self.sink.badges.lock().unwrap()[badges_before..].to_vec(),
            ..step
        }
    }
}

fn push(id: &str, attempt: u32, reminder: bool) -> (String, u32, bool) {
    (format!("question:{id}"), attempt, reminder)
}

// ── The schedule ──

#[test]
fn the_schedule_escalates_then_repeats() {
    let s = ReminderSettings::default();
    let offsets: Vec<Option<u64>> = (0..=5).map(|k| s.offset_secs(k)).collect();
    assert_eq!(
        offsets,
        vec![
            None,
            Some(300),
            Some(1800),
            Some(7200),
            Some(7200 + 14_400),
            Some(7200 + 2 * 14_400)
        ]
    );
    assert_eq!(s.latest_due(t0(), 1, at(299)), None);
    assert_eq!(s.latest_due(t0(), 1, at(300)), Some(1));
    assert_eq!(s.latest_due(t0(), 1, at(2 * HOUR)), Some(3));
    assert_eq!(s.latest_due(t0(), 4, at(2 * HOUR)), None);
    assert_eq!(s.latest_due(t0(), 1, at(6 * HOUR)), Some(4));
    // Three days asleep: one reminder, the latest.
    assert_eq!(s.latest_due(t0(), 2, at(72 * HOUR)), Some(3 + 17));
    assert_eq!(s.due_at(t0(), 2), Some(at(30 * MIN)));

    let once = ReminderSettings {
        repeat_secs: 0,
        ..ReminderSettings::default()
    };
    assert_eq!(once.offset_secs(4), None);
    assert_eq!(once.latest_due(t0(), 4, at(100 * HOUR)), None);
    let off = ReminderSettings {
        enabled: false,
        ..ReminderSettings::default()
    };
    assert_eq!(off.due_at(t0(), 1), None);
}

#[test]
fn settings_are_kept_in_range_and_the_env_schedule_parses() {
    let s = ReminderSettings {
        steps_secs: vec![10, 300, 300, 99_999_999, 0],
        repeat_secs: 1,
        quiet_start_min: 25 * 60,
        timezone: "Mars/Olympus".into(),
        ..ReminderSettings::default()
    }
    .sanitized();
    assert_eq!(s.steps_secs, vec![60, 300, 7 * 24 * 3600]);
    assert_eq!(s.repeat_secs, 300);
    assert_eq!(s.quiet_start_min, 60);
    assert_eq!(s.timezone, "");
    let zoned = ReminderSettings {
        timezone: " Asia/Jerusalem ".into(),
        ..ReminderSettings::default()
    }
    .sanitized();
    assert_eq!(zoned.timezone, "Asia/Jerusalem");

    assert_eq!(parse_schedule("5,10,20/30"), Some((vec![5, 10, 20], 30)));
    assert_eq!(parse_schedule(" 20, 5 "), Some((vec![5, 20], 0)));
    assert_eq!(parse_schedule("/60"), Some((vec![], 60)));
    assert_eq!(parse_schedule("soon"), None);
    assert_eq!(parse_schedule(""), None);
}

#[test]
fn quiet_hours_wrap_midnight_in_their_zone() {
    let s = ReminderSettings {
        quiet_hours: true,
        quiet_start_min: 22 * 60,
        quiet_end_min: 7 * 60,
        timezone: "Asia/Jerusalem".into(),
        ..ReminderSettings::default()
    };
    let utc = |raw: &str| raw.parse::<DateTime<Utc>>().unwrap();
    // January: Jerusalem is UTC+2.
    assert!(s.is_quiet(utc("2026-01-15T21:30:00Z")), "23:30 local");
    assert!(s.is_quiet(utc("2026-01-15T04:59:00Z")), "06:59 local");
    assert!(!s.is_quiet(utc("2026-01-15T05:00:00Z")), "07:00 local");
    assert!(!s.is_quiet(utc("2026-01-15T12:00:00Z")), "14:00 local");
    let day = ReminderSettings {
        quiet_start_min: 9 * 60,
        quiet_end_min: 17 * 60,
        timezone: "UTC".into(),
        ..s.clone()
    };
    assert!(day.is_quiet(utc("2026-01-15T09:00:00Z")));
    assert!(!day.is_quiet(utc("2026-01-15T17:00:00Z")));
    let off = ReminderSettings {
        quiet_hours: false,
        ..s.clone()
    };
    assert!(!off.is_quiet(utc("2026-01-15T21:30:00Z")));
    let empty = ReminderSettings {
        quiet_start_min: 60,
        quiet_end_min: 60,
        ..s
    };
    assert!(!empty.is_quiet(utc("2026-01-15T23:00:00Z")));
}

// ── Reading a session ──

fn session() -> SessionState {
    let mut s = SessionState::new(
        "conn-7".to_string(),
        AgentType::ClaudeCode,
        None,
        "main".to_string(),
        Some(3),
    );
    s.conversation_id = Some(7);
    s
}

fn permission_option(id: &str, kind: &str) -> PermissionOptionInfo {
    PermissionOptionInfo {
        option_id: id.into(),
        name: id.to_uppercase(),
        kind: kind.into(),
        meta: None,
    }
}

#[test]
fn asks_are_read_from_what_the_session_holds() {
    let mut s = session();
    s.pending_permission = Some(PendingPermissionState {
        request_id: "req-1".into(),
        tool_call_id: "tc-1".into(),
        tool_call: serde_json::json!({"toolCallId": "tc-1", "title": "Run cargo test"}),
        options: vec![
            permission_option("yes", "allow_once"),
            permission_option("no", "reject_once"),
        ],
        created_at: t0(),
        queued: 2,
    });
    s.pending_question = Some(PendingQuestionState {
        question_id: "q-1".into(),
        questions: vec![QuestionSpec {
            id: "q-1-a".into(),
            question: "Which database?".into(),
            header: "Storage".into(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "SQLite".into(),
                    description: String::new(),
                },
                QuestionOption {
                    label: "Postgres".into(),
                    description: "bigger".into(),
                },
            ],
            is_secret: false,
        }],
        created_at: at(5),
    });
    s.pending_plan_approval = Some(PendingPlanApprovalState {
        approval_id: "ap-1".into(),
        tool_call_id: "tc-plan".into(),
        plan_markdown: "\n# Plan: move the cache\n\n1. read".into(),
        created_at: at(9),
    });
    let asks = asks_of(&s);
    let summary: Vec<(&str, PendingKind, PendingSource, &str)> = asks
        .iter()
        .map(|a| (a.id.as_str(), a.kind, a.source, a.text.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "permission:req-1",
                PendingKind::Permission,
                PendingSource::Permission,
                "Run cargo test"
            ),
            (
                "question:q-1",
                PendingKind::Question,
                PendingSource::Question,
                "Which database?"
            ),
            (
                "plan_approval:ap-1",
                PendingKind::Plan,
                PendingSource::PlanApproval,
                "Plan: move the cache"
            ),
        ]
    );
    assert_eq!(asks[0].queued, 2);
    assert_eq!(asks[0].options[0].kind.as_deref(), Some("allow_once"));
    assert_eq!(asks[1].options, vec![opt("SQLite"), opt("Postgres")]);
    assert_eq!(asks[1].question.as_ref().unwrap().item_id, "q-1-a");
    assert_eq!(asks[1].asked_at, at(5));
    assert_eq!(asks[2].agent_label, "Claude Code");

    // Claude's ExitPlanMode is a permission request, and a plan.
    s.pending_question = None;
    s.pending_plan_approval = None;
    s.pending_permission = Some(PendingPermissionState {
        request_id: "req-2".into(),
        tool_call_id: "tc-2".into(),
        tool_call: serde_json::json!({
            "toolCallId": "tc-2",
            "title": "Ready to code?",
            "rawInput": {"plan": "## Move the cache\n- step"}
        }),
        options: vec![
            permission_option("exit-plan-bypass", "allow_always"),
            permission_option("reject", "reject_once"),
        ],
        created_at: t0(),
        queued: 0,
    });
    let asks = asks_of(&s);
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].kind, PendingKind::Plan);
    assert_eq!(asks[0].source, PendingSource::Permission);
    assert_eq!(asks[0].text, "Move the cache");

    // No row to open, or on its way out: nothing.
    s.conversation_id = None;
    assert!(asks_of(&s).is_empty());
    s.conversation_id = Some(7);
    s.status = ConnectionStatus::Disconnected;
    assert!(asks_of(&s).is_empty());
}

#[test]
fn the_fingerprint_follows_what_is_asked_not_its_id() {
    let (a, _) = item("q1", 7, 7, t0());
    let (b, _) = item("q9", 7, 7, at(100));
    assert_eq!(fingerprint(&a), fingerprint(&b));
    let mut c = b.clone();
    c.text = "Which cache?".into();
    assert_ne!(fingerprint(&a), fingerprint(&c));
}

// ── The engine ──

#[tokio::test]
async fn a_new_item_is_pushed_once_then_reminded_on_schedule() {
    let mut h = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, t0())];
    let step = h.step(0, &live, &away()).await;
    assert!(step.list_changed);
    assert_eq!(step.pushes, vec![push("q1", 0, false)]);
    assert!(h.engine.snapshot().items[0].phone_notified);

    assert!(h.step(299, &live, &away()).await.pushes.is_empty());
    let step = h.step(300, &live, &away()).await;
    assert_eq!(step.pushes, vec![push("q1", 1, true)]);
    assert_eq!(step.reminders, vec!["question:q1#1".to_string()]);
    assert!(h.step(301, &live, &away()).await.pushes.is_empty());
    assert_eq!(
        h.step(30 * MIN, &live, &away()).await.pushes,
        vec![push("q1", 2, true)]
    );
    assert_eq!(
        h.step(2 * HOUR, &live, &away()).await.pushes,
        vec![push("q1", 3, true)]
    );
    assert_eq!(
        h.step(6 * HOUR, &live, &away()).await.pushes,
        vec![push("q1", 4, true)]
    );
    assert!(h.step(9 * HOUR, &live, &away()).await.pushes.is_empty());
    assert_eq!(
        h.step(10 * HOUR, &live, &away()).await.pushes,
        vec![push("q1", 5, true)]
    );

    let snapshot = h.engine.snapshot();
    assert_eq!(snapshot.count, 1);
    let shown = &snapshot.items[0];
    assert_eq!(shown.reminders_sent, 5);
    assert_eq!(shown.last_reminded_at, Some(at(10 * HOUR)));
    assert_eq!(shown.next_reminder_at, Some(at(14 * HOUR)));
    assert_eq!(shown.root_conversation_id, 7);
}

#[tokio::test]
async fn reminders_can_be_turned_off() {
    let mut h = Harness::new(ReminderSettings {
        enabled: false,
        ..ReminderSettings::default()
    });
    let live = [item("q1", 7, 7, t0())];
    assert_eq!(h.step(0, &live, &away()).await.pushes.len(), 1);
    assert!(h.step(HOUR, &live, &away()).await.pushes.is_empty());
    assert_eq!(h.engine.snapshot().items[0].next_reminder_at, None);
}

#[tokio::test]
async fn an_answer_on_any_device_stops_the_reminders_and_drops_the_badge() {
    let mut h = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, t0()), item("q2", 8, 8, t0())];
    let step = h.step(0, &live, &away()).await;
    assert_eq!(step.pushes.len(), 2);
    assert!(step.badges.is_empty(), "the count has to hold still first");
    assert_eq!(h.step(3, &live, &away()).await.badges, vec![2]);
    assert!(h.step(10, &live, &away()).await.badges.is_empty());

    // q1 answered (here, on the phone, anywhere: its session let it go).
    let rest = [item("q2", 8, 8, t0())];
    let step = h.step(100, &rest, &away()).await;
    assert!(step.list_changed);
    assert_eq!(h.engine.count(), 1);
    assert_eq!(h.step(103, &rest, &away()).await.badges, vec![1]);
    assert_eq!(
        h.step(300, &rest, &away()).await.pushes,
        vec![push("q2", 1, true)]
    );

    // q2 cancelled with its turn: nothing more, badge to zero.
    assert!(h.step(400, &[], &away()).await.list_changed);
    assert_eq!(h.step(403, &[], &away()).await.badges, vec![0]);
    assert!(h.step(30 * MIN, &[], &away()).await.pushes.is_empty());
    assert_eq!(h.engine.snapshot(), PendingSnapshot::default());
}

#[tokio::test]
async fn leaving_the_desk_pushes_what_the_phone_never_heard() {
    let mut h = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, t0())];
    // At the desk, on another session: the first push goes out, and the
    // phone's "only when away" turns it down.
    h.delivers(false);
    let step = h.step(0, &live, &desk(&[5])).await;
    assert_eq!(step.pushes, vec![push("q1", 0, false)]);
    assert!(!h.engine.snapshot().items[0].phone_notified);
    assert!(h.step(60, &live, &desk(&[5])).await.pushes.is_empty());

    // The desk empties: at once.
    h.delivers(true);
    let step = h.step(61, &live, &away()).await;
    assert_eq!(step.pushes, vec![push("q1", 0, false)]);
    assert!(h.engine.snapshot().items[0].phone_notified);

    // Back and away again: the phone knows already.
    assert!(h.step(70, &live, &desk(&[5])).await.pushes.is_empty());
    assert!(h.step(80, &live, &away()).await.pushes.is_empty());
}

#[tokio::test]
async fn a_reminder_reaching_the_phone_counts_as_heard() {
    let mut h = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, t0())];
    h.delivers(false);
    h.step(0, &live, &desk(&[5])).await;
    // Reminders ignore "only when away": this one reaches the phone.
    h.delivers(true);
    assert_eq!(
        h.step(300, &live, &desk(&[5])).await.pushes,
        vec![push("q1", 1, true)]
    );
    assert!(h.step(301, &live, &away()).await.pushes.is_empty());
}

#[tokio::test]
async fn nothing_goes_out_while_someone_looks_at_the_session() {
    let mut h = Harness::new(ReminderSettings::default());
    // A sub-agent's question (conversation 51) shows in its parent, 7.
    let live = [item("q1", 51, 7, t0())];
    let step = h.step(0, &live, &desk(&[7])).await;
    assert!(step.pushes.is_empty());
    assert_eq!(h.engine.count(), 1, "it still counts");

    // Due while on screen: skipped, not saved for later.
    let step = h.step(300, &live, &desk(&[7])).await;
    assert!(step.pushes.is_empty() && step.reminders.is_empty());
    assert!(h.step(301, &live, &desk(&[5])).await.pushes.is_empty());
    // The next one, with the user on another session, goes out.
    assert_eq!(
        h.step(30 * MIN, &live, &desk(&[5])).await.pushes,
        vec![push("q1", 2, true)]
    );
    // A phone showing the session counts as looking, even "away".
    let looking_on_phone = Looking {
        anyone: false,
        conversations: [51].into_iter().collect(),
    };
    assert!(h
        .step(2 * HOUR, &live, &looking_on_phone)
        .await
        .pushes
        .is_empty());
}

#[tokio::test]
async fn quiet_hours_hold_the_reminders_and_send_the_latest_after() {
    let mut h = Harness::new(ReminderSettings {
        quiet_hours: true,
        quiet_start_min: 9 * 60,
        quiet_end_min: 16 * 60,
        timezone: "UTC".into(),
        ..ReminderSettings::default()
    });
    // Asked at 09:00 UTC, in the quiet hours: the first push is the
    // device's call, the reminders wait.
    let live = [item("q1", 7, 7, t0())];
    assert_eq!(h.step(0, &live, &away()).await.pushes.len(), 1);
    assert!(h.step(5 * MIN, &live, &away()).await.pushes.is_empty());
    assert!(h.step(2 * HOUR, &live, &away()).await.pushes.is_empty());
    // 16:00: one reminder, the latest due (6 h after the ask).
    assert_eq!(
        h.step(7 * HOUR, &live, &away()).await.pushes,
        vec![push("q1", 4, true)]
    );
    assert!(h.step(8 * HOUR, &live, &away()).await.pushes.is_empty());
    assert_eq!(
        h.step(10 * HOUR, &live, &away()).await.pushes,
        vec![push("q1", 5, true)]
    );
}

#[tokio::test]
async fn a_burst_in_one_session_buzzes_once() {
    let mut h = Harness::new(ReminderSettings::default());
    let live = [
        item("q1", 7, 7, t0()),
        item("q2", 7, 7, t0()),
        item("q3", 8, 8, t0()),
    ];
    let step = h.step(0, &live, &away()).await;
    assert_eq!(step.pushes, vec![push("q1", 0, false), push("q3", 0, false)]);
    assert!(h.step(2, &live, &away()).await.pushes.is_empty());
    assert_eq!(
        h.step(3, &live, &away()).await.pushes,
        vec![push("q2", 0, false)]
    );
}

#[tokio::test]
async fn an_item_first_seen_late_skips_the_reminders_already_due() {
    let mut h = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, at(-40 * MIN))];
    assert_eq!(h.step(0, &live, &away()).await.pushes, vec![push("q1", 0, false)]);
    assert!(h.step(10, &live, &away()).await.pushes.is_empty());
    assert_eq!(
        h.step(80 * MIN, &live, &away()).await.pushes,
        vec![push("q1", 3, true)]
    );
}

#[tokio::test]
async fn a_restart_picks_up_where_it_left_off() {
    let mut before = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, t0())];
    before.step(0, &live, &away()).await;
    before.step(5 * MIN, &live, &away()).await;
    before.step(30 * MIN, &live, &away()).await;
    let stored = before.engine.take_dirty().expect("bookkeeping to store");
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].next_attempt, 3);

    // codeg restarts: the agent processes went with it, nothing is pending.
    let mut after = Harness::new(ReminderSettings::default());
    after.engine.load(stored.clone(), at(40 * MIN));
    let step = after.step(40 * MIN, &[], &away()).await;
    assert!(step.pushes.is_empty());
    assert_eq!(after.engine.count(), 0);
    assert_eq!(after.engine.stored(), stored, "kept until asked again");

    // The resumed turn asks the same question again (a new id): it keeps its
    // age and its reminders, and the phone is not told twice.
    let again = [item("q9", 7, 7, at(41 * MIN))];
    let step = after.step(41 * MIN, &again, &away()).await;
    assert!(step.pushes.is_empty());
    let snapshot = after.engine.snapshot();
    let shown = &snapshot.items[0];
    assert_eq!(shown.asked_at, t0());
    assert_eq!(shown.reminders_sent, 2);
    assert!(shown.phone_notified);
    assert_eq!(
        after.step(2 * HOUR, &again, &away()).await.pushes,
        vec![push("q9", 3, true)]
    );

    // Something new in the same session is new.
    let (mut other, meta) = item("q10", 7, 7, at(2 * HOUR));
    other.text = "Which cache?".into();
    let both = [again[0].clone(), (other, meta)];
    assert_eq!(
        after.step(2 * HOUR + 10, &both, &away()).await.pushes,
        vec![push("q10", 0, false)]
    );
}

#[tokio::test]
async fn a_stored_item_is_forgotten_if_not_asked_again_soon() {
    let mut before = Harness::new(ReminderSettings::default());
    let live = [item("q1", 7, 7, t0())];
    before.step(0, &live, &away()).await;
    let stored = before.engine.take_dirty().unwrap();

    let mut after = Harness::new(ReminderSettings::default());
    after.engine.load(stored, at(MIN));
    after.step(MIN, &[], &away()).await;
    after.step(31 * MIN, &[], &away()).await;
    assert!(after.engine.stored().is_empty());
    let again = [item("q9", 7, 7, at(32 * MIN))];
    assert_eq!(
        after.step(32 * MIN, &again, &away()).await.pushes,
        vec![push("q9", 0, false)]
    );
}

#[tokio::test]
async fn an_item_the_phone_missed_before_a_restart_is_pushed_after_it() {
    let mut before = Harness::new(ReminderSettings::default());
    before.delivers(false);
    let live = [item("q1", 7, 7, t0())];
    before.step(0, &live, &desk(&[5])).await;
    let stored = before.engine.take_dirty().unwrap();
    assert!(!stored[0].phone_notified);

    let mut after = Harness::new(ReminderSettings::default());
    after.engine.load(stored, at(MIN));
    let again = [item("q9", 7, 7, at(2 * MIN))];
    assert_eq!(
        after.step(2 * MIN, &again, &away()).await.pushes,
        vec![push("q9", 0, false)]
    );
}

// ── The push ──

#[test]
fn a_reminder_push_names_the_session_the_wait_and_the_question() {
    let mut engine = Engine::new(ReminderSettings::default());
    engine.observe(vec![item("q1", 51, 7, t0())], &away(), t0());
    let shown = engine.snapshot().items.remove(0);
    let message = pending_message(Lang::En, &shown, 2, true, at(30 * MIN));
    assert_eq!(message.title, "Fix login");
    assert_eq!(
        message.body,
        "codeg · Claude Code is still waiting for your answer (30 min)\nWhich database?"
    );
    assert_eq!(message.conversation_id, Some(7));
    let body = message.body_json("srv1");
    assert_eq!(body["kind"], "needs_you");
    assert_eq!(body["needs"], "question");
    assert_eq!(body["aps"]["category"], "CODEG_QUESTION");
    assert_eq!(body["pending_id"], "question:q1");
    assert_eq!(body["reminder"], true);
    assert_eq!(body["attempt"], 2);
    assert_eq!(body["asking_conversation_id"], 51);
    assert_eq!(body["connection_id"], "conn-51");
    assert_eq!(body["question"]["question_id"], "q1");
    assert_eq!(body["question"]["item_id"], "q1-0");
    assert_eq!(body["question"]["answerable"], true);

    // The first push reads like the desktop's notification.
    let first = pending_message(Lang::En, &shown, 0, false, at(1));
    assert_eq!(
        first.body,
        "codeg · Claude Code is waiting for your answer\nWhich database?"
    );
    assert!(!first.is_reminder());
}

#[test]
fn a_permission_push_keeps_its_approve_button() {
    let mut s = session();
    s.pending_permission = Some(PendingPermissionState {
        request_id: "req-1".into(),
        tool_call_id: "tc-1".into(),
        tool_call: serde_json::json!({"toolCallId": "tc-1", "title": "Run cargo test"}),
        options: vec![
            permission_option("yes", "allow_once"),
            permission_option("no", "reject_once"),
        ],
        created_at: t0(),
        queued: 0,
    });
    let ask = asks_of(&s).remove(0);
    let mut engine = Engine::new(ReminderSettings::default());
    engine.observe(
        vec![(
            ask,
            SessionMeta {
                root_conversation_id: 7,
                ..SessionMeta::default()
            },
        )],
        &away(),
        t0(),
    );
    let shown = engine.snapshot().items.remove(0);
    let body = pending_message(Lang::En, &shown, 1, true, at(5 * MIN)).body_json("srv1");
    assert_eq!(body["aps"]["category"], "CODEG_PERMISSION");
    assert_eq!(body["needs"], "permission");
    assert_eq!(body["pending_kind"], "permission");
    assert_eq!(body["connection_id"], "conn-7");
    assert_eq!(body["request_id"], "req-1");
    assert_eq!(body["approve_option_id"], "yes");
    assert_eq!(body["deny_option_id"], "no");
    assert_eq!(
        body["aps"]["alert"]["body"],
        "Claude Code is still waiting for your permission (5 min)\nRun cargo test"
    );
}

// ── The runtime, end to end ──

/// The watch's own delivery, against a mock APNs.
struct MockApnsSink {
    sender: crate::push::apns::ApnsSender,
    db: sea_orm::DatabaseConnection,
    setup: crate::push::SendSetup,
}

#[async_trait]
impl PushSink for MockApnsSink {
    async fn push(&self, item: &PendingItem, attempt: u32, reminder: bool) -> bool {
        let report = super::watch::push_item(
            &self.sender,
            &self.db,
            &self.setup,
            (item, attempt, reminder),
            &Looking::default(),
        )
        .await;
        report.delivered > 0
    }

    async fn badge(&self, count: u32) {
        crate::push::sync_badges_with(&self.sender, &self.db, &self.setup, count).await;
    }
}

async fn deliver_all(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<super::engine::Job>>,
    sink: &MockApnsSink,
) {
    while let Ok(jobs) = rx.try_recv() {
        run_jobs(sink, jobs, |id, ok| with_engine(|e| e.note_delivery(id, ok))).await;
    }
}

/// A live session's question, through the real watch, the database and the
/// APNs client: the first push, a reminder, then the badge drop once it is
/// answered. The one test that uses the process-wide registry.
#[tokio::test]
async fn the_watch_pushes_reminds_and_clears_through_apns() {
    use crate::acp::manager::ConnectionManager;
    use crate::db::test_helpers;
    use crate::push::prefs::DevicePrefs;
    use crate::push::tests::{add_device, mock_apns, setup};
    use crate::web::event_bridge::EventEmitter;

    let db = test_helpers::fresh_in_memory_db().await;
    let folder = test_helpers::seed_folder(&db, "/tmp/pending-watch").await;
    let conversation = test_helpers::seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let (sender, mock) = mock_apns().await;
    add_device(&db.conn, "abcd0001", "Phone", DevicePrefs::default()).await;

    let manager = ConnectionManager::new();
    manager
        .insert_test_connection("conn-w", AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    let state = manager.get_state("conn-w").await.unwrap();
    let asked = Utc::now();
    {
        let mut s = state.write().await;
        s.conversation_id = Some(conversation);
        s.pending_question = Some(PendingQuestionState {
            question_id: "q-w".into(),
            questions: vec![QuestionSpec {
                id: "q-w-a".into(),
                question: "Which database?".into(),
                header: "Storage".into(),
                multi_select: false,
                options: vec![
                    QuestionOption {
                        label: "SQLite".into(),
                        description: String::new(),
                    },
                    QuestionOption {
                        label: "Postgres".into(),
                        description: String::new(),
                    },
                ],
                is_secret: false,
            }],
            created_at: asked,
        });
    }

    with_engine(|e| {
        *e = Engine::new(ReminderSettings {
            steps_secs: vec![60],
            repeat_secs: 0,
            ..ReminderSettings::default()
        })
    });
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watch =
        super::watch::Watch::new(manager.clone_ref(), db.conn.clone(), EventEmitter::Noop, tx);
    let sink = MockApnsSink {
        sender,
        db: db.conn.clone(),
        setup: setup(),
    };
    let away = Looking::default();
    let after = |n: i64| asked + chrono::Duration::seconds(n);

    // Asked: on the list, and pushed with the badge.
    watch.pass_at(after(0), &away).await;
    deliver_all(&mut rx, &sink).await;
    let listed = snapshot();
    assert_eq!(listed.count, 1);
    assert_eq!(listed.items[0].id, "question:q-w");
    assert_eq!(listed.items[0].root_conversation_id, conversation);
    assert_eq!(pending_count(), 1);
    assert!(snapshot().items[0].phone_notified);
    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].body["kind"], "needs_you");
    assert_eq!(seen[0].body["pending_id"], "question:q-w");
    assert_eq!(seen[0].body["attempt"], 0);
    assert_eq!(seen[0].body["aps"]["badge"], 1);
    assert_eq!(seen[0].body["aps"]["category"], "CODEG_QUESTION");
    assert_eq!(
        seen[0].body["question"]["options"],
        serde_json::json!(["SQLite", "Postgres"])
    );

    // A minute on: the reminder (the badge sync finds the phone up to date).
    watch.pass_at(after(60), &away).await;
    deliver_all(&mut rx, &sink).await;
    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].body["reminder"], true);
    assert_eq!(seen[1].body["attempt"], 1);
    let alert = seen[1].body["aps"]["alert"]["body"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        alert.contains("is still waiting for your answer") && alert.ends_with("Which database?"),
        "{alert}"
    );

    // Answered on another device: off the list, and the badge drops to 0.
    state.write().await.pending_question = None;
    watch.pass_at(after(61), &away).await;
    assert_eq!(snapshot().count, 0);
    assert_eq!(pending_count(), 0);
    watch.pass_at(after(64), &away).await;
    deliver_all(&mut rx, &sink).await;
    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[2].body["kind"], "badge");
    assert_eq!(seen[2].body["aps"], serde_json::json!({ "badge": 0 }));

    // Nothing more after that.
    watch.pass_at(after(600), &away).await;
    deliver_all(&mut rx, &sink).await;
    assert_eq!(mock.seen.lock().unwrap().len(), 3);
}
