use std::collections::HashSet;
use std::time::Instant;

use chrono::{DateTime, Duration as ChronoDuration, TimeZone, Utc};
use chrono_tz::Tz;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};

use super::*;
use crate::acp::critical_watch::{
    derive_phase, with_limit_pause, IdleKind, Observation, Phase, SessionWatch, Thresholds,
};
use crate::db::entities::conversation::{ConversationKind, ConversationTurnState};
use crate::db::service::conversation_service::{
    claim_limit_resume, end_limit_pause, finish_turn, finish_turn_on_usage_limit,
    interrupt_orphaned_turns, list_due_limit_resumes, mark_turn_running,
    requeue_claimed_limit_resumes, reschedule_limit_resume, update_limit_auto_continue,
};
use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

const USAGE: ConversationLimitReason = ConversationLimitReason::UsageLimit;
const POOL: ConversationLimitReason = ConversationLimitReason::PoolCapacity;

fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
}

fn record(category: &str, severity: &str, title: &str) -> SessionFailureRecord {
    SessionFailureRecord {
        id: "turn-1:error".into(),
        revision: 1,
        category: category.into(),
        severity: severity.into(),
        title: title.into(),
        details: None,
        actions: Vec::new(),
        resolved: false,
    }
}

// ─── Detection ──────────────────────────────────────────────────────────

#[test]
fn the_air_failure_of_a_usage_limit_is_recognized() {
    let weekly = "You've hit your weekly limit · resets 10pm (Asia/Jerusalem)";
    assert_eq!(
        usage_limit_text_from_failure(&record("limit", "error", weekly)).as_deref(),
        Some(weekly)
    );
    // Codex's wording.
    let codex = "You've hit your usage limit. Upgrade to Plus to continue using Codex \
                 (https://chatgpt.com/explore/plus), or try again at 3:05 PM.";
    assert!(usage_limit_text_from_failure(&record("limit", "error", codex)).is_some());
    // A configured budget is a `limit` no reset lifts.
    assert!(usage_limit_text_from_failure(&record(
        "limit",
        "error",
        "This Claude session reached its configured budget."
    ))
    .is_none());
    // A retry warning, or another category, is not the turn's end.
    assert!(usage_limit_text_from_failure(&record("limit", "warning", weekly)).is_none());
    assert!(usage_limit_text_from_failure(&record("service", "error", weekly)).is_none());
}

#[test]
fn a_rejected_prompt_carrying_the_limit_is_recognized() {
    assert_eq!(
        usage_limit_text_from_error(
            "Internal error: You've hit your session limit · resets 5:30pm (Asia/Jerusalem)"
        )
        .as_deref(),
        Some("You've hit your session limit · resets 5:30pm (Asia/Jerusalem)")
    );
    assert_eq!(
        usage_limit_text_from_error("Internal error: Claude AI usage limit reached|1791000000")
            .as_deref(),
        Some("Internal error: Claude AI usage limit reached|1791000000")
    );
    assert!(usage_limit_text_from_error("Internal error: overloaded").is_none());
}

#[test]
fn the_message_names_its_window() {
    assert_eq!(
        named_claude_window("You've hit your session limit · resets 5:30pm (UTC)"),
        Some("five_hour")
    );
    assert_eq!(
        named_claude_window("You've hit your weekly limit · resets 10pm (UTC)"),
        Some("seven_day")
    );
    assert_eq!(
        named_claude_window("You've hit your Opus limit · resets 10pm (UTC)"),
        Some("seven_day_opus")
    );
    assert_eq!(named_claude_window("You've hit your usage limit."), None);
}

// ─── Reading the reset out of the message ───────────────────────────────

const JERUSALEM: Tz = Tz::Asia__Jerusalem;

#[test]
fn a_time_alone_is_its_next_occurrence_in_the_named_zone() {
    // 15:00 in Jerusalem (UTC+3 in October): 22:00 is later today.
    let now = utc(2026, 10, 2, 12, 0);
    let text = "You've hit your weekly limit · resets 10pm (Asia/Jerusalem)";
    assert_eq!(
        parse_reset_time(text, now, Tz::UTC),
        Some(utc(2026, 10, 2, 19, 0))
    );
    // 23:00 in Jerusalem: tomorrow's 22:00.
    let late = utc(2026, 10, 2, 20, 0);
    assert_eq!(
        parse_reset_time(text, late, Tz::UTC),
        Some(utc(2026, 10, 3, 19, 0))
    );
}

#[test]
fn minutes_zones_and_suffixes_are_read() {
    let now = utc(2026, 10, 2, 12, 0);
    assert_eq!(
        parse_reset_time(
            "You've hit your session limit · resets 5:30pm (America/New_York)",
            now,
            JERUSALEM
        ),
        Some(utc(2026, 10, 2, 21, 30)),
        "EDT is UTC-4"
    );
    assert_eq!(
        parse_reset_time(
            "You've hit your Opus limit · resets 10pm (Asia/Jerusalem) · progress saved",
            now,
            Tz::UTC
        ),
        Some(utc(2026, 10, 2, 19, 0))
    );
    assert_eq!(
        parse_reset_time(
            "You've hit your session limit · resets 12am (UTC)",
            now,
            JERUSALEM
        ),
        Some(utc(2026, 10, 3, 0, 0)),
        "12am is midnight"
    );
}

#[test]
fn a_date_further_out_is_read_with_its_year() {
    let now = utc(2026, 10, 2, 12, 0);
    assert_eq!(
        parse_reset_time(
            "You've hit your weekly limit · resets Oct 5, 10pm (Asia/Jerusalem)",
            now,
            Tz::UTC
        ),
        Some(utc(2026, 10, 5, 19, 0))
    );
    assert_eq!(
        parse_reset_time(
            "You've hit your weekly limit · resets Oct 5, 5:30pm (Asia/Jerusalem)",
            now,
            Tz::UTC
        ),
        Some(utc(2026, 10, 5, 14, 30))
    );
    // Across the new year, without and with an explicit year.
    let december = utc(2026, 12, 30, 12, 0);
    assert_eq!(
        parse_reset_time(
            "You've hit your weekly limit · resets Jan 2, 9am (UTC)",
            december,
            JERUSALEM
        ),
        Some(utc(2027, 1, 2, 9, 0))
    );
    assert_eq!(
        parse_reset_time(
            "You've hit your weekly limit · resets Jan 2, 2027, 9am (UTC)",
            december,
            JERUSALEM
        ),
        Some(utc(2027, 1, 2, 9, 0))
    );
}

#[test]
fn older_and_other_agents_formats_are_read() {
    let now = utc(2026, 10, 2, 12, 0);
    let epoch = now.timestamp() + 3_600;
    assert_eq!(
        parse_reset_time(
            &format!("Claude AI usage limit reached|{epoch}"),
            now,
            Tz::UTC
        ),
        Some(now + ChronoDuration::hours(1)),
        "epoch seconds"
    );
    assert_eq!(
        parse_reset_time(
            &format!("Claude AI usage limit reached|{}", epoch * 1000),
            now,
            Tz::UTC
        ),
        Some(now + ChronoDuration::hours(1)),
        "epoch milliseconds"
    );
    // No zone: the host's (here Tokyo, UTC+9): 15:00 JST = 06:00Z tomorrow.
    assert_eq!(
        parse_reset_time("5-hour limit reached ∙ resets 3pm", now, Tz::Asia__Tokyo),
        Some(utc(2026, 10, 3, 6, 0))
    );
    assert_eq!(
        parse_reset_time(
            "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
            now,
            JERUSALEM
        ),
        Some(utc(2026, 10, 2, 19, 0))
    );
    // Codex, in the host's zone (Los Angeles, PDT = UTC-7).
    let la = Tz::America__Los_Angeles;
    assert_eq!(
        parse_reset_time(
            "You've hit your usage limit. Upgrade to Plus to continue using Codex \
             (https://chatgpt.com/explore/plus), or try again at Oct 5th, 2026 3:05 PM.",
            now,
            la
        ),
        Some(utc(2026, 10, 5, 22, 5))
    );
    assert_eq!(
        parse_reset_time(
            "You've hit your usage limit. Try again at 3:05 PM.",
            now,
            la
        ),
        Some(utc(2026, 10, 2, 22, 5))
    );
    assert_eq!(
        parse_reset_time(
            "You've hit your usage limit · try again in 2 hours 30 minutes",
            now,
            Tz::UTC
        ),
        Some(now + ChronoDuration::minutes(150))
    );
    assert_eq!(
        parse_reset_time("Limit reached · resets in 1d 2h", now, Tz::UTC),
        Some(now + ChronoDuration::hours(26))
    );
}

#[test]
fn a_message_without_a_usable_time_gives_none() {
    let now = utc(2026, 10, 2, 12, 0);
    for text in [
        "You've hit your weekly limit · contact your admin to increase it",
        "You're out of usage credits",
        "Claude AI usage limit reached|1000000000",
        "You've hit your weekly limit · resets Mar 3, 2031, 9am (UTC)",
    ] {
        assert_eq!(parse_reset_time(text, now, Tz::UTC), None, "{text}");
    }
}

#[test]
fn the_exact_structured_reset_wins_over_the_message() {
    let now = utc(2026, 10, 2, 12, 0);
    let text = "You've hit your weekly limit · resets 10pm (Asia/Jerusalem)";
    let exact = utc(2026, 10, 2, 19, 0).timestamp() + 37;

    // The "rejected" rate-limit event's own reset.
    assert_eq!(
        choose_reset(text, now, Tz::UTC, Some(exact), None),
        Some((
            Utc.timestamp_opt(exact, 0).unwrap(),
            ResetSource::Structured
        ))
    );
    // The named window's reset, when it agrees with the message.
    assert_eq!(
        choose_reset(text, now, Tz::UTC, None, Some(exact)),
        Some((
            Utc.timestamp_opt(exact, 0).unwrap(),
            ResetSource::Structured
        ))
    );
    // A window reading that disagrees (stale) loses to the message.
    let stale = exact + 6 * 3_600;
    assert_eq!(
        choose_reset(text, now, Tz::UTC, None, Some(stale)),
        Some((utc(2026, 10, 2, 19, 0), ResetSource::Text))
    );
    // A structured reset already past is ignored.
    let past = now.timestamp() - 60;
    assert_eq!(
        choose_reset(text, now, Tz::UTC, Some(past), None),
        Some((utc(2026, 10, 2, 19, 0), ResetSource::Text))
    );
    // No time in the message: the named window's reading.
    assert_eq!(
        choose_reset(
            "You've hit your weekly limit · contact your admin to increase it",
            now,
            Tz::UTC,
            None,
            Some(exact)
        ),
        Some((
            Utc.timestamp_opt(exact, 0).unwrap(),
            ResetSource::Structured
        ))
    );
    assert_eq!(
        choose_reset("You've hit your weekly limit", now, Tz::UTC, None, None),
        None
    );
}

// ─── Scheduling ─────────────────────────────────────────────────────────

fn timing() -> Timing {
    Timing {
        safety_delay: std::time::Duration::from_secs(60),
        max_jitter: std::time::Duration::from_secs(30),
        stagger: std::time::Duration::from_secs(30),
    }
}

#[test]
fn a_continuation_fires_after_the_reset_plus_a_stable_jitter() {
    let reset = utc(2026, 10, 2, 19, 0);
    for id in 1..50 {
        let at = fire_at(id, reset, &timing());
        let after = (at - reset).num_seconds();
        assert!((60..=90).contains(&after), "{after}");
        assert_eq!(at, fire_at(id, reset, &timing()), "the same every look");
    }
    let spread: HashSet<i64> = (1..50)
        .map(|id| fire_at(id, reset, &timing()).timestamp())
        .collect();
    assert!(
        spread.len() > 1,
        "sessions on one reset do not all fire at once"
    );
}

/// A top-level conversation bound to agent session `sess-<title>`.
async fn session(db: &AppDatabase, folder: i32, title: &str) -> i32 {
    let created = conversation_service::create(&db.conn, folder, AgentType::ClaudeCode, None, None)
        .await
        .expect("row");
    let mut active: conversation::ActiveModel = created.into();
    active.title = Set(Some(title.to_string()));
    active.external_id = Set(Some(format!("sess-{title}")));
    active.update(&db.conn).await.expect("bind session").id
}

async fn row(db: &AppDatabase, id: i32) -> conversation::Model {
    conversation::Entity::find_by_id(id)
        .one(&db.conn)
        .await
        .expect("query")
        .expect("row present")
}

/// Run a turn on `id` that ends on the usage limit, resetting at `resets_at`.
async fn hit_limit(db: &AppDatabase, id: i32, resets_at: DateTime<Utc>) -> UsageLimitTurnEnd {
    hit_limit_for(db, id, resets_at, USAGE).await
}

/// [`hit_limit`], for a stop of `reason`.
async fn hit_limit_for(
    db: &AppDatabase,
    id: i32,
    resets_at: DateTime<Utc>,
    reason: ConversationLimitReason,
) -> UsageLimitTurnEnd {
    assert!(mark_turn_running(&db.conn, id).await.unwrap());
    finish_turn_on_usage_limit(
        &db.conn,
        id,
        Some(ConversationStatus::PendingReview),
        resets_at,
        MAX_ATTEMPTS,
        true,
        reason,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_usage_limit_pauses_the_conversation_until_the_reset() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-pause").await;
    let id = session(&db, folder, "paused").await;
    let reset = Utc::now() + ChronoDuration::hours(3);

    assert_eq!(
        hit_limit(&db, id, reset).await,
        UsageLimitTurnEnd::Paused { attempts: 0 }
    );
    let paused = row(&db, id).await;
    assert!(is_limit_paused(&paused));
    assert_eq!(paused.turn_state, None, "the turn itself ended");
    assert_eq!(paused.status, ConversationStatus::PendingReview);
    assert_eq!(
        paused.limit_resume_at.map(|t| t.timestamp()),
        Some(reset.timestamp())
    );
    assert_eq!(paused.limit_resume_attempts, 0);
    let summary = conversation_service::get_by_id(&db.conn, id).await.unwrap();
    let pause = summary.limit_pause.expect("the summary carries the pause");
    assert_eq!(pause.state, ConversationLimitResume::Scheduled);

    // Not due before the reset, due after it.
    assert!(list_due_limit_resumes(&db.conn, Utc::now())
        .await
        .unwrap()
        .is_empty());
    let due = list_due_limit_resumes(&db.conn, reset + ChronoDuration::minutes(2))
        .await
        .unwrap();
    assert_eq!(due.iter().map(|r| r.id).collect::<Vec<_>>(), vec![id]);

    // A turn that ends normally after a pause leaves no mark.
    let other = session(&db, folder, "plain").await;
    mark_turn_running(&db.conn, other).await.unwrap();
    finish_turn(&db.conn, other, None).await.unwrap();
    assert_eq!(row(&db, other).await.limit_resume_state, None);
}

#[tokio::test]
async fn with_the_feature_off_the_turn_ends_as_before() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-off").await;
    let reset = Utc::now() + ChronoDuration::hours(1);

    // The global setting off.
    let a = session(&db, folder, "global-off").await;
    mark_turn_running(&db.conn, a).await.unwrap();
    let end = finish_turn_on_usage_limit(&db.conn, a, None, reset, MAX_ATTEMPTS, false, USAGE)
        .await
        .unwrap();
    assert_eq!(end, UsageLimitTurnEnd::NotPaused);
    let a_row = row(&db, a).await;
    assert_eq!(a_row.limit_resume_state, None);
    assert_eq!(a_row.turn_state, None);

    // The per-session switch off.
    let b = session(&db, folder, "session-off").await;
    update_limit_auto_continue(&db.conn, b, false)
        .await
        .unwrap();
    assert_eq!(hit_limit(&db, b, reset).await, UsageLimitTurnEnd::NotPaused);

    // A child row that is not a delegated session (an agent's own
    // sub-agent, read from its transcript) is not a session to continue.
    let parent = session(&db, folder, "parent").await;
    let child = child_of(&db, folder, parent, "child", None).await;
    assert_eq!(
        hit_limit(&db, child, reset).await,
        UsageLimitTurnEnd::NotPaused
    );
}

/// A session under `parent`: one it delegated to when `call` names the
/// delegation, else a plain child row.
async fn child_of(
    db: &AppDatabase,
    folder: i32,
    parent: i32,
    title: &str,
    call: Option<&str>,
) -> i32 {
    let child = session(db, folder, title).await;
    let mut active: conversation::ActiveModel = row(db, child).await.into();
    active.parent_id = Set(Some(parent));
    if let Some(call) = call {
        active.kind = Set(ConversationKind::Delegate);
        active.delegation_call_id = Set(Some(call.to_string()));
    }
    active.update(&db.conn).await.unwrap();
    child
}

#[tokio::test]
async fn a_session_another_delegated_to_is_continued_too() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-delegated").await;
    let reset = Utc::now() + ChronoDuration::hours(1);
    let parent = session(&db, folder, "parent").await;
    let child = child_of(&db, folder, parent, "delegated", Some("call-1")).await;

    // The same outage stops both; each is paused on its own.
    for id in [parent, child] {
        assert_eq!(
            hit_limit_for(&db, id, reset, POOL).await,
            UsageLimitTurnEnd::Paused { attempts: 0 }
        );
    }
    let due = list_due_limit_resumes(&db.conn, reset + ChronoDuration::seconds(1))
        .await
        .unwrap();
    let mut ids: Vec<i32> = due.iter().map(|row| row.id).collect();
    ids.sort();
    assert_eq!(ids, vec![parent, child]);
}

#[tokio::test]
async fn a_continuation_that_hits_the_limit_again_is_rescheduled_up_to_the_cap() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-repeat").await;
    let id = session(&db, folder, "repeat").await;
    let mut reset = Utc::now() + ChronoDuration::hours(1);
    assert_eq!(
        hit_limit(&db, id, reset).await,
        UsageLimitTurnEnd::Paused { attempts: 0 }
    );

    for attempt in 1..MAX_ATTEMPTS {
        // The scheduler claims it and the continuation's turn starts.
        assert!(claim_limit_resume(&db.conn, id).await.unwrap());
        assert!(
            !claim_limit_resume(&db.conn, id).await.unwrap(),
            "claimed once"
        );
        assert!(mark_turn_running(&db.conn, id).await.unwrap());
        let running = row(&db, id).await;
        assert_eq!(
            running.limit_resume_state,
            Some(ConversationLimitResume::Continuing)
        );
        assert_eq!(running.limit_resume_attempts, attempt);
        // The limit is back: rescheduled from its new reset.
        reset += ChronoDuration::hours(5);
        assert_eq!(
            finish_turn_on_usage_limit(&db.conn, id, None, reset, MAX_ATTEMPTS, true, USAGE)
                .await
                .unwrap(),
            UsageLimitTurnEnd::Paused { attempts: attempt }
        );
        let again = row(&db, id).await;
        assert_eq!(
            again.limit_resume_state,
            Some(ConversationLimitResume::Scheduled)
        );
        assert_eq!(
            again.limit_resume_at.map(|t| t.timestamp()),
            Some(reset.timestamp())
        );
    }

    // The last attempt hits it too: give up, leave a plain interruption.
    assert!(claim_limit_resume(&db.conn, id).await.unwrap());
    assert!(mark_turn_running(&db.conn, id).await.unwrap());
    assert_eq!(
        finish_turn_on_usage_limit(&db.conn, id, None, reset, MAX_ATTEMPTS, true, USAGE)
            .await
            .unwrap(),
        UsageLimitTurnEnd::GaveUp
    );
    let gave_up = row(&db, id).await;
    assert_eq!(gave_up.limit_resume_state, None);
    assert_eq!(gave_up.limit_resume_attempts, 0);
    assert_eq!(gave_up.turn_state, Some(ConversationTurnState::Interrupted));
}

#[tokio::test]
async fn a_continuation_that_works_settles_the_pause() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-settle").await;
    let id = session(&db, folder, "settle").await;
    hit_limit(&db, id, Utc::now() + ChronoDuration::hours(1)).await;
    assert!(claim_limit_resume(&db.conn, id).await.unwrap());
    mark_turn_running(&db.conn, id).await.unwrap();
    // One turn goes through several `Prompting` transitions.
    mark_turn_running(&db.conn, id).await.unwrap();
    finish_turn(&db.conn, id, Some(ConversationStatus::PendingReview))
        .await
        .unwrap();
    let done = row(&db, id).await;
    assert_eq!(done.limit_resume_state, None);
    assert_eq!(done.limit_resume_at, None);
    assert_eq!(done.limit_resume_attempts, 0);

    // A message the user sends during a pause settles it too.
    hit_limit(&db, id, Utc::now() + ChronoDuration::hours(1)).await;
    mark_turn_running(&db.conn, id).await.unwrap();
    assert_eq!(row(&db, id).await.limit_resume_state, None);
}

#[tokio::test]
async fn cancel_leaves_a_plain_interruption() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-cancel").await;
    let id = session(&db, folder, "cancel").await;
    hit_limit(&db, id, Utc::now() + ChronoDuration::hours(1)).await;

    let emitter = EventEmitter::Noop;
    assert!(cancel_limit_continue_core(&db.conn, &emitter, id)
        .await
        .unwrap());
    let cancelled = row(&db, id).await;
    assert_eq!(cancelled.limit_resume_state, None);
    assert_eq!(
        cancelled.turn_state,
        Some(ConversationTurnState::Interrupted)
    );
    assert!(
        !cancel_limit_continue_core(&db.conn, &emitter, id)
            .await
            .unwrap(),
        "nothing left to cancel"
    );
    assert!(!claim_limit_resume(&db.conn, id).await.unwrap());

    // Turning the session's switch off ends its pause the same way.
    let other = session(&db, folder, "switch").await;
    hit_limit(&db, other, Utc::now() + ChronoDuration::hours(1)).await;
    update_limit_auto_continue_core(&db.conn, &emitter, other, false)
        .await
        .unwrap();
    let off = row(&db, other).await;
    assert!(!off.limit_auto_continue);
    assert_eq!(off.limit_resume_state, None);

    // And so does the global setting.
    let third = session(&db, folder, "global").await;
    hit_limit(&db, third, Utc::now() + ChronoDuration::hours(1)).await;
    save_limit_continue_settings(&db.conn, &emitter, LimitContinueSettings { enabled: false })
        .await
        .unwrap();
    assert!(!load_limit_continue_settings(&db.conn).await.enabled);
    assert_eq!(row(&db, third).await.limit_resume_state, None);
}

#[tokio::test]
async fn the_schedule_survives_a_restart() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-restart").await;
    let waiting = session(&db, folder, "waiting").await;
    let in_flight = session(&db, folder, "in-flight").await;
    let reset = Utc::now() + ChronoDuration::minutes(30);
    hit_limit(&db, waiting, reset).await;
    hit_limit(&db, in_flight, reset).await;
    // The process dies after claiming one, before its prompt went out.
    assert!(claim_limit_resume(&db.conn, in_flight).await.unwrap());

    // Next start: the exit sweep leaves pauses alone (no turn ran), and the
    // scheduler puts the claimed one back.
    interrupt_orphaned_turns(&db.conn).await.unwrap();
    assert_eq!(requeue_claimed_limit_resumes(&db.conn).await.unwrap(), 1);
    for id in [waiting, in_flight] {
        let r = row(&db, id).await;
        assert_eq!(
            r.limit_resume_state,
            Some(ConversationLimitResume::Scheduled)
        );
        assert_eq!(r.turn_state, None);
    }
    let due = list_due_limit_resumes(&db.conn, reset + ChronoDuration::minutes(5))
        .await
        .unwrap();
    assert_eq!(due.len(), 2);

    // A continuation cut off by an exit mid-turn is the automatic resume's.
    assert!(claim_limit_resume(&db.conn, waiting).await.unwrap());
    mark_turn_running(&db.conn, waiting).await.unwrap();
    interrupt_orphaned_turns(&db.conn).await.unwrap();
    let cut = row(&db, waiting).await;
    assert_eq!(cut.turn_state, Some(ConversationTurnState::Interrupted));
    assert_eq!(cut.limit_resume_state, None);
}

#[tokio::test]
async fn a_failed_continuation_goes_back_on_the_schedule() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-retry").await;
    let id = session(&db, folder, "retry").await;
    hit_limit(&db, id, Utc::now() - ChronoDuration::minutes(5)).await;
    assert!(claim_limit_resume(&db.conn, id).await.unwrap());
    let later = Utc::now() + ChronoDuration::minutes(2);
    assert!(reschedule_limit_resume(&db.conn, id, later).await.unwrap());
    let r = row(&db, id).await;
    assert_eq!(
        r.limit_resume_state,
        Some(ConversationLimitResume::Scheduled)
    );
    assert_eq!(r.limit_resume_attempts, 1, "the failed try counts");
    assert!(end_limit_pause(&db.conn, id).await.unwrap());
}

#[tokio::test]
async fn sessions_on_one_limit_continue_most_recent_first() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-order").await;
    let reset = Utc::now() - ChronoDuration::minutes(10);
    let mut ids = Vec::new();
    for (i, title) in ["oldest", "middle", "newest"].iter().enumerate() {
        let id = session(&db, folder, title).await;
        hit_limit(&db, id, reset).await;
        // Distinct activity times, oldest first.
        let mut active: conversation::ActiveModel = row(&db, id).await.into();
        active.updated_at = Set(Utc::now() - ChronoDuration::minutes(30 - i as i64));
        active.update(&db.conn).await.unwrap();
        ids.push(id);
    }
    let not_yet = session(&db, folder, "later").await;
    hit_limit(&db, not_yet, Utc::now() + ChronoDuration::hours(2)).await;

    let rows = conversation_service::list_scheduled_limit_resumes(&db.conn)
        .await
        .unwrap();
    let (due, next) = plan_due(rows.clone(), &HashSet::new(), Utc::now(), &timing());
    assert_eq!(
        due.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![ids[2], ids[1], ids[0]],
        "most recently active first"
    );
    let next = next.expect("the later one is scheduled");
    assert!(next > Utc::now() + ChronoDuration::minutes(119));

    // "Continue now" goes first, due or not.
    let forced: HashSet<i32> = [not_yet].into_iter().collect();
    let (due, next) = plan_due(rows, &forced, Utc::now(), &timing());
    assert_eq!(
        due.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![not_yet, ids[2], ids[1], ids[0]]
    );
    assert_eq!(next, None);
}

#[tokio::test]
async fn continue_now_only_takes_a_paused_session() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-now").await;
    let id = session(&db, folder, "now").await;
    assert!(!continue_limit_now_core(&db.conn, id).await.unwrap());
    hit_limit(&db, id, Utc::now() + ChronoDuration::hours(4)).await;
    assert!(continue_limit_now_core(&db.conn, id).await.unwrap());
    assert!(FORCED.lock().unwrap().remove(&id));
}

// ─── Critical sessions ──────────────────────────────────────────────────

#[test]
fn a_paused_critical_session_never_alerts() {
    let paused = with_limit_pause(derive_phase(false, None, None), true);
    assert_eq!(paused, Phase::Paused);
    // Waiting on the user, or working, outranks the pause.
    assert_eq!(
        with_limit_pause(derive_phase(true, None, None), true),
        Phase::Idle(IdleKind::NeedsYou)
    );
    assert_eq!(
        with_limit_pause(
            derive_phase(false, None, Some(ConversationTurnState::Running)),
            true
        ),
        Phase::Working
    );
    assert_eq!(
        with_limit_pause(derive_phase(false, None, None), false),
        Phase::Idle(IdleKind::TurnEnded)
    );

    let th = Thresholds {
        idle: std::time::Duration::from_secs(60),
        repeat: Some(std::time::Duration::from_secs(60)),
        stall: Some(std::time::Duration::from_secs(60)),
    };
    let t0 = Instant::now();
    let obs = |phase| Observation {
        phase,
        epoch: 0,
        progress_at: None,
    };
    let mut watch = SessionWatch::new(obs(Phase::Paused), t0, false);
    for hours in [1u64, 5, 30] {
        let at = t0 + std::time::Duration::from_secs(hours * 3_600);
        assert_eq!(watch.step(obs(Phase::Paused), &th, at), None);
    }
    // Once the pause ends without a continuation (cancelled), the idle clock
    // starts then.
    let ended = t0 + std::time::Duration::from_secs(31 * 3_600);
    let idle = obs(Phase::Idle(IdleKind::Interrupted));
    assert_eq!(watch.step(idle, &th, ended), None);
    assert!(watch
        .step(idle, &th, ended + std::time::Duration::from_secs(61))
        .is_some());
}

#[test]
fn the_frontend_matches_the_same_prompt() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/limit-continue.ts");
    let Ok(source) = std::fs::read_to_string(path) else {
        // Built outside the repository (a packaged source tree): nothing to compare.
        return;
    };
    assert!(
        source.contains(&format!("\"{LIMIT_CONTINUE_PROMPT}\"")),
        "src/lib/limit-continue.ts must carry LIMIT_CONTINUE_PROMPT verbatim"
    );
}

// ─── The account pool's stop ────────────────────────────────────────────

/// The proxy's refusal as Claude Code ends the turn on it (synthetic text,
/// shaped like the real one).
const POOL_STOP: &str = "API Error: Server is temporarily limiting requests (not your usage \
     limit) · No account can take this request right now — all 2 Claude accounts are at their \
     limit. Retry in ~3h.";

#[test]
fn the_pool_refusal_is_recognized_as_a_limit_stop() {
    // The AIR failure the adapter settles the turn with (`rate_limited` is
    // filed under `limit`).
    let text = usage_limit_text_from_failure(&record("limit", "error", POOL_STOP));
    assert_eq!(text.as_deref(), Some(POOL_STOP));
    assert_eq!(limit_reason_of(POOL_STOP), POOL);

    // With the CLI's error-type suffix, and the plain 429 wording.
    let suffixed = format!("{POOL_STOP} (error type rate_limit, HTTP 429, request id req_x)");
    assert!(usage_limit_text_from_failure(&record("limit", "error", &suffixed)).is_some());
    let rejected = "API Error: Request rejected (429) · No account can take this request — all 1 \
                    Claude accounts are at their limit. Soonest reset in ~2d, beyond the hold \
                    window. Add another Claude account or wait for a quota reset.";
    assert!(is_pool_capacity_text(rejected));
    // The proxy's words in the details, the adapter's own title in front.
    let mut detailed = record("limit", "error", "Claude is temporarily rate limited.");
    detailed.details = Some(
        "No account can take this request right now — all 2 Claude accounts are momentarily at \
         their limit. Retry in ~45s."
            .into(),
    );
    let text = usage_limit_text_from_failure(&detailed).expect("recognized from the details");
    assert_eq!(limit_reason_of(&text), POOL);
    assert_eq!(pool_retry_hint_secs(&text), Some(45));

    // An agent without AIR rejects the prompt with the same words.
    assert_eq!(
        usage_limit_text_from_error(&format!("Internal error: {suffixed}\"}}")).as_deref(),
        Some(suffixed.as_str())
    );

    // The plain usage limit is still that.
    let weekly = "You've hit your weekly limit · resets 10pm (Asia/Jerusalem)";
    assert_eq!(
        usage_limit_text_from_failure(&record("limit", "error", weekly)).as_deref(),
        Some(weekly)
    );
    assert_eq!(limit_reason_of(weekly), USAGE);

    // Not a limit stop: the proxy's short busy spell, a 429 with no pool
    // words, a retry warning, and codeg's own pool gate.
    let busy = "API Error: Server is temporarily limiting requests (not your usage limit) · No \
                account can take this request right now — all 2 Claude accounts are momentarily \
                busy, not out of quota. Retry in ~30s; it clears on its own.";
    assert!(usage_limit_text_from_failure(&record("limit", "error", busy)).is_none());
    let throttled = "API Error: Server is temporarily limiting requests (not your usage limit) \
                     · this may be a temporary capacity issue.";
    assert!(usage_limit_text_from_failure(&record("limit", "error", throttled)).is_none());
    assert!(usage_limit_text_from_failure(&record("limit", "warning", POOL_STOP)).is_none());
    assert!(!is_pool_capacity_text(
        "All Claude subscriptions behind the account pool are at their limit, so Claude Code \
         cannot take a request yet. [pool_exhausted resumes_at=1800429000]"
    ));
    assert!(usage_limit_text_from_error("Internal error: overloaded").is_none());
}

#[test]
fn the_stop_as_it_reached_a_session_is_recognized() {
    // Verbatim as the CLI ended a turn on it.
    let seen = "API Error: Server is temporarily limiting requests (not your usage limit) · No \
                account can take this request right now — all 2 Claude accounts are at their \
                limit. Retry in ~47m.";
    let text = usage_limit_text_from_failure(&record("limit", "error", seen));
    assert_eq!(text.as_deref(), Some(seen));
    assert_eq!(limit_reason_of(seen), POOL);
    assert_eq!(pool_retry_hint_secs(seen), Some(47 * 60));
    assert_eq!(
        usage_limit_text_from_error(&format!("Internal error: {seen}")).as_deref(),
        Some(seen)
    );

    // The same with three accounts, and the pool's words when no account is
    // eligible at all (no reset in sight: its "~1m" is a stand-in).
    let three = seen.replace("all 2 Claude", "all 3 Claude");
    assert_eq!(limit_reason_of(&three), POOL);
    for none_eligible in [
        "API Error: Request rejected (429) · No account can take this request — all 3 Claude \
         accounts are at their limit. Soonest reset in ~1m, beyond the hold window. Add another \
         Claude account or wait for a quota reset.",
        "API Error: Server is temporarily limiting requests (not your usage limit) · No account \
         can take this request — all 3 Claude accounts are at their limit. Add another Claude \
         account or wait for a quota reset.",
    ] {
        assert_eq!(
            usage_limit_text_from_failure(&record("limit", "error", none_eligible)).as_deref(),
            Some(none_eligible)
        );
        assert_eq!(limit_reason_of(none_eligible), POOL);
        assert_eq!(pool_retry_hint_secs(none_eligible), None, "{none_eligible}");
    }
}

#[test]
fn the_proxy_names_its_wait() {
    assert_eq!(pool_retry_hint_secs(POOL_STOP), Some(3 * 3600));
    assert_eq!(pool_retry_hint_secs("… Retry in ~45m."), Some(45 * 60));
    assert_eq!(pool_retry_hint_secs("… Retry in 30s."), Some(30));
    assert_eq!(
        pool_retry_hint_secs("… at their limit. Soonest reset in ~2d, beyond the hold window."),
        Some(2 * 86_400)
    );
    assert_eq!(pool_retry_hint_secs("… are at their limit."), None);
}

#[test]
fn a_pool_stop_takes_the_proxys_wait_then_the_pool_reading_then_a_backoff() {
    let now = utc(2026, 10, 22, 12, 0);
    let three_hours = Some(3 * 3600);
    let held_back = |at: DateTime<Utc>| {
        Some(PoolLimit::Exhausted {
            resumes_at: Some(at.timestamp()),
        })
    };

    // The proxy's own answer wins over the reading's arithmetic …
    let in_40m = now + ChronoDuration::minutes(40);
    assert_eq!(
        choose_pool_reset(held_back(in_40m), three_hours, now, now, false),
        (now + ChronoDuration::hours(3), PoolResetSource::Hint)
    );
    // … and with none, the reading's first account to free up.
    assert_eq!(
        choose_pool_reset(held_back(in_40m), None, now, now, false),
        (in_40m, PoolResetSource::Pool)
    );
    // Whatever the reading says, the proxy's wait stands.
    let readings = [
        None,
        Some(PoolLimit::Exhausted { resumes_at: None }),
        held_back(now - ChronoDuration::minutes(5)),
        Some(PoolLimit::Headroom),
    ];
    for pool in readings {
        assert_eq!(
            choose_pool_reset(pool, three_hours, now, now, false),
            (now + ChronoDuration::hours(3), PoolResetSource::Hint)
        );
    }
    // Nothing says when: the backoff.
    assert_eq!(
        choose_pool_reset(None, None, now, now, false),
        (
            now + ChronoDuration::seconds(POOL_STOP_BACKOFF_SECS),
            PoolResetSource::Backoff
        )
    );

    // Caught up later: a wait already over continues at the next
    // opportunity, not in the past …
    let stopped = now - ChronoDuration::hours(5);
    assert_eq!(
        choose_pool_reset(None, three_hours, stopped, now, true),
        (now, PoolResetSource::Hint)
    );
    // … one mid-wait keeps the rest of it …
    let stopped = now - ChronoDuration::hours(1);
    assert_eq!(
        choose_pool_reset(None, three_hours, stopped, now, true).0,
        now + ChronoDuration::hours(2)
    );
    // … unless the pool has room now, which is newer than the hint.
    assert_eq!(
        choose_pool_reset(Some(PoolLimit::Headroom), three_hours, stopped, now, true),
        (now, PoolResetSource::Pool)
    );
    // A wait over while the pool is still out: its first account to free up.
    let stopped = now - ChronoDuration::hours(5);
    assert_eq!(
        choose_pool_reset(held_back(in_40m), three_hours, stopped, now, true),
        (in_40m, PoolResetSource::Pool)
    );
}

#[test]
fn a_continuation_waits_for_the_pool_only_so_many_times() {
    let mut defers = PoolDefers::default();
    for _ in 0..MAX_POOL_DEFERS {
        assert!(defers.may_wait(7));
    }
    assert!(!defers.may_wait(7), "then it goes out regardless");
    assert!(defers.may_wait(8), "counted per conversation");
    // Once it went out, a later pause counts afresh.
    defers.forget(7);
    assert!(defers.may_wait(7));
    // A conversation no longer waiting loses its count.
    defers.keep_only(&HashSet::from([8]));
    for _ in 0..MAX_POOL_DEFERS {
        assert!(defers.may_wait(7));
    }
}

#[test]
fn a_due_continuation_waits_while_the_pool_has_no_room() {
    let now = utc(2026, 10, 22, 12, 0);
    // No pool, or one with headroom: it goes out.
    assert_eq!(pool_defer_until(None, now), None);
    // Every account held back: until the first one frees up …
    let frees = now + ChronoDuration::minutes(25);
    let block = |at: Option<DateTime<Utc>>| {
        Some(PoolBlock {
            resumes_at: at.map(|t| t.timestamp()),
        })
    };
    assert_eq!(pool_defer_until(block(Some(frees)), now), Some(frees));
    // … or a recheck when the reading does not say when (or names a time
    // already past).
    let recheck = now + ChronoDuration::seconds(POOL_RECHECK_SECS);
    assert_eq!(pool_defer_until(block(None), now), Some(recheck));
    let past = now - ChronoDuration::minutes(1);
    assert_eq!(pool_defer_until(block(Some(past)), now), Some(recheck));
}

#[tokio::test]
async fn a_pool_stop_that_keeps_coming_back_gives_up_and_keeps_its_reason() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-pool-cap").await;
    let id = session(&db, folder, "pool-cap").await;
    let mut reset = Utc::now() + ChronoDuration::hours(3);

    assert_eq!(
        hit_limit_for(&db, id, reset, POOL).await,
        UsageLimitTurnEnd::Paused { attempts: 0 }
    );
    let summary = conversation_service::get_by_id(&db.conn, id).await.unwrap();
    assert_eq!(summary.limit_reason, Some(POOL));
    assert!(summary.limit_pause.is_some());

    // Waiting for the pool moves the time, only while it waits.
    let later = reset + ChronoDuration::minutes(20);
    assert!(
        conversation_service::defer_limit_resume(&db.conn, id, later)
            .await
            .unwrap()
    );
    assert_eq!(
        row(&db, id).await.limit_resume_at.map(|t| t.timestamp()),
        Some(later.timestamp())
    );

    for attempt in 1..MAX_ATTEMPTS {
        assert!(claim_limit_resume(&db.conn, id).await.unwrap());
        assert!(
            !conversation_service::defer_limit_resume(&db.conn, id, later)
                .await
                .unwrap()
        );
        reset += ChronoDuration::hours(1);
        assert_eq!(
            hit_limit_for(&db, id, reset, POOL).await,
            UsageLimitTurnEnd::Paused { attempts: attempt }
        );
    }
    assert!(claim_limit_resume(&db.conn, id).await.unwrap());
    assert_eq!(
        hit_limit_for(&db, id, reset, POOL).await,
        UsageLimitTurnEnd::GaveUp
    );
    let gave_up = row(&db, id).await;
    assert_eq!(gave_up.turn_state, Some(ConversationTurnState::Interrupted));
    assert_eq!(gave_up.limit_resume_state, None);
    let summary = conversation_service::get_by_id(&db.conn, id).await.unwrap();
    assert!(summary.limit_pause.is_none(), "no longer waiting");
    assert_eq!(
        summary.limit_reason,
        Some(POOL),
        "still says why it stopped"
    );

    // The next turn starts clean.
    assert!(mark_turn_running(&db.conn, id).await.unwrap());
    assert_eq!(row(&db, id).await.limit_resume_reason, None);
    finish_turn(&db.conn, id, Some(ConversationStatus::PendingReview))
        .await
        .unwrap();
    assert_eq!(row(&db, id).await.limit_resume_reason, None);
}

/// One transcript line, Claude Code's shape (synthetic content).
fn transcript_line(kind: &str, at: DateTime<Utc>, text: &str, api_error: bool) -> String {
    let mut value = serde_json::json!({
        "type": kind,
        "uuid": format!("u-{}", at.timestamp()),
        "timestamp": at.to_rfc3339(),
        "isSidechain": false,
        "message": {"role": kind, "content": [{"type": "text", "text": text}]},
    });
    if api_error {
        value["isApiErrorMessage"] = serde_json::Value::Bool(true);
        value["error"] = serde_json::Value::String("rate_limit".into());
        value["message"]["model"] = serde_json::Value::String("<synthetic>".into());
    } else if kind == "assistant" {
        value["message"]["model"] = serde_json::Value::String("claude-test".into());
    }
    value.to_string()
}

#[test]
fn the_transcript_tells_a_turn_that_ended_on_an_api_error() {
    let at = utc(2026, 10, 22, 9, 0);
    let prompt = transcript_line("user", at - ChronoDuration::minutes(1), "do it", false);
    let error = transcript_line("assistant", at, POOL_STOP, true);
    let bookkeeping =
        r#"{"type":"system","subtype":"api_error","timestamp":"2026-10-22T09:00:01Z"}"#;
    let tail = format!("{prompt}\n{error}\n{bookkeeping}\n");
    assert_eq!(
        catch_up::last_turn_api_error(&tail),
        Some((POOL_STOP.to_string(), at))
    );

    // A prompt sent after it, or a real answer: the turn went on.
    let later = transcript_line("user", at + ChronoDuration::minutes(1), "again", false);
    assert_eq!(
        catch_up::last_turn_api_error(&format!("{tail}{later}\n")),
        None
    );
    let answer = transcript_line("assistant", at, "Done.", false);
    assert_eq!(
        catch_up::last_turn_api_error(&format!("{prompt}\n{answer}\n")),
        None
    );
    // A cut first line is skipped.
    assert_eq!(
        catch_up::last_turn_api_error(&format!("e\":1}}\n{error}\n")).map(|(_, t)| t),
        Some(at)
    );
}

/// A session bound to `sess-<title>`, whose transcript is `lines`, under
/// `dir`.
async fn transcript_session(
    db: &AppDatabase,
    folder: i32,
    dir: &std::path::Path,
    title: &str,
    lines: &[String],
) -> i32 {
    let id = session(db, folder, title).await;
    std::fs::write(
        dir.join(format!("sess-{title}.jsonl")),
        lines.join("\n") + "\n",
    )
    .unwrap();
    id
}

#[tokio::test]
async fn sessions_the_pool_stopped_before_the_update_are_paused_once() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/limit-catch-up").await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let now = Utc::now();
    let ask = |at: DateTime<Utc>| transcript_line("user", at, "go on", false);
    let stop = |at: DateTime<Utc>, text: &str| transcript_line("assistant", at, text, true);

    let two_h = now - ChronoDuration::hours(2);
    let five_h = now - ChronoDuration::hours(5);
    let day_ago = now - ChronoDuration::hours(30);
    let session_limit = "You've hit your session limit · resets 5:30pm (UTC)";
    let recent = [ask(two_h), stop(two_h, POOL_STOP)];
    let recent = transcript_session(&db, folder, path, "recent", &recent).await;
    let overdue = [ask(five_h), stop(five_h, POOL_STOP)];
    let overdue = transcript_session(&db, folder, path, "overdue", &overdue).await;
    let stale = [ask(day_ago), stop(day_ago, POOL_STOP)];
    let stale = transcript_session(&db, folder, path, "stale", &stale).await;
    let moved_on = [ask(two_h), stop(two_h, POOL_STOP), ask(now)];
    let moved_on = transcript_session(&db, folder, path, "moved-on", &moved_on).await;
    let usage = [ask(two_h), stop(two_h, session_limit)];
    let usage = transcript_session(&db, folder, path, "usage", &usage).await;
    let running = [ask(two_h), stop(two_h, POOL_STOP)];
    let running = transcript_session(&db, folder, path, "running", &running).await;
    mark_turn_running(&db.conn, running).await.unwrap();
    // A session `recent` delegated to, stopped by the same outage.
    std::fs::write(
        path.join("sess-delegated.jsonl"),
        [ask(two_h), stop(two_h, POOL_STOP)].join("\n") + "\n",
    )
    .unwrap();
    let delegated = child_of(&db, folder, recent, "delegated", Some("call-7")).await;

    let base = path.to_path_buf();
    let locate = move |sid: &str| Some(base.join(format!("{sid}.jsonl")));
    let noop = EventEmitter::Noop;
    let paused = catch_up::catch_up_pool_stops_with(&db.conn, &noop, now, locate.clone()).await;
    assert_eq!(paused, 3);
    assert_eq!(
        row(&db, delegated).await.limit_resume_state,
        Some(ConversationLimitResume::Scheduled)
    );

    let recent_row = row(&db, recent).await;
    assert_eq!(
        recent_row.limit_resume_state,
        Some(ConversationLimitResume::Scheduled)
    );
    assert_eq!(recent_row.limit_resume_reason, Some(POOL));
    assert_eq!(recent_row.limit_resume_attempts, 0);
    // No pool here: the proxy's "~3h", counted from the stop.
    assert_eq!(
        recent_row.limit_resume_at.map(|t| t.timestamp()),
        Some((two_h + ChronoDuration::hours(3)).timestamp())
    );
    // Its wait is over: at the next opportunity.
    assert_eq!(
        row(&db, overdue)
            .await
            .limit_resume_at
            .map(|t| t.timestamp()),
        Some(now.timestamp())
    );
    for id in [stale, moved_on, usage, running] {
        assert_eq!(row(&db, id).await.limit_resume_state, None, "row {id}");
    }

    // Once: a later start leaves everything alone.
    let fresh = [ask(two_h), stop(two_h, POOL_STOP)];
    let fresh = transcript_session(&db, folder, path, "fresh", &fresh).await;
    assert_eq!(
        catch_up::catch_up_pool_stops_with(&db.conn, &noop, now, locate).await,
        0
    );
    assert_eq!(row(&db, fresh).await.limit_resume_state, None);
}
