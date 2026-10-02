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
    assert!(mark_turn_running(&db.conn, id).await.unwrap());
    finish_turn_on_usage_limit(
        &db.conn,
        id,
        Some(ConversationStatus::PendingReview),
        resets_at,
        MAX_ATTEMPTS,
        true,
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
    let end = finish_turn_on_usage_limit(&db.conn, a, None, reset, MAX_ATTEMPTS, false)
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

    // A delegation child is driven by its parent.
    let parent = session(&db, folder, "parent").await;
    let child = session(&db, folder, "child").await;
    let mut active: conversation::ActiveModel = row(&db, child).await.into();
    active.parent_id = Set(Some(parent));
    active.kind = Set(ConversationKind::Delegate);
    active.update(&db.conn).await.unwrap();
    assert_eq!(
        hit_limit(&db, child, reset).await,
        UsageLimitTurnEnd::NotPaused
    );
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
            finish_turn_on_usage_limit(&db.conn, id, None, reset, MAX_ATTEMPTS, true)
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
        finish_turn_on_usage_limit(&db.conn, id, None, reset, MAX_ATTEMPTS, true)
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
