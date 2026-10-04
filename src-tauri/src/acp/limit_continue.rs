//! Continue a session by itself once the account's usage limit resets.
//!
//! When a Claude Code (or Codex) account hits its 5-hour, weekly or
//! model-scoped limit, the turn in flight stops with the agent's own words —
//! "You've hit your weekly limit · resets 10pm (Asia/Jerusalem)". The
//! connection hands those words to the lifecycle subscriber
//! (`SessionState::turn_usage_limit`), which records the turn's end and
//! pauses the conversation until the limit resets ([`finish_limited_turn`]):
//! `limit_resume_at` / `limit_resume_state = scheduled` on the row, so the
//! schedule survives a restart and runs with no window open.
//!
//! How the turn is recognized: claude-agent-acp settles a usage-limited turn
//! with a JetBrains AIR `sessionFailure` record on the prompt response —
//! category `limit`, severity `error`, title = the CLI's message — which
//! [`usage_limit_text_from_failure`] picks out by the CLI's own message
//! prefixes. An agent without AIR rejects the prompt with the same words
//! instead ([`usage_limit_text_from_error`]).
//!
//! When it resets ([`resolve_reset`]), most exact first:
//! 1. behind a local account pool (`commands::usage_pool`), the pool's own
//!    reading: the message names one account's limit, but the session can
//!    go on as soon as any enabled account can take it — in a minute when
//!    one still has headroom, else at the first account's reset;
//! 2. the rate-limit event the agent sent with the block (Claude's
//!    `_claude/rateLimit` with `status: "rejected"` carries the blocking
//!    window's exact `resetsAt`; Codex's rollouts carry each window's reset);
//! 3. the window the message names ("weekly limit" → `seven_day`) in the
//!    plan-usage reading, when it agrees with the message to the minute;
//! 4. the message itself, in the time zone it names ([`parse_reset_time`]).
//!
//! The scheduler ([`run_limit_continue`]) sends [`LIMIT_CONTINUE_PROMPT`]
//! through the normal prompt path once the reset has passed, plus a safety
//! delay and a per-session jitter. Several sessions paused on the same limit
//! continue most recently active first, a stagger apart and within the
//! shared attach limit, so they do not burn the fresh window all at once. A
//! continuation that hits the limit again is rescheduled from the new reset,
//! up to [`MAX_ATTEMPTS`] per pause; then the turn is left as a plain
//! interruption, with the manual Continue.
//!
//! The transcript recognizes the continuation by its exact text and draws it
//! as a "Continued after limit reset" divider (`src/lib/limit-continue.ts`).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use regex::Regex;
use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::acp::auto_resume::{reopen_and_send, ReopenTarget, Sent};
use crate::acp::critical_watch::{announce_limit_event, CriticalAlertKind};
use crate::acp::manager::ConnectionManager;
use crate::acp::types::SessionFailureRecord;
use crate::app_error::AppCommandError;
use crate::db::entities::conversation::{self, ConversationLimitResume, ConversationStatus};
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;
use crate::db::service::conversation_service::{self, UsageLimitTurnEnd};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;

/// The prompt a continuation starts with. It goes to the agent, so it is not
/// localized; the transcript recognizes it by its exact text and draws it as
/// a "Continued after limit reset" divider. The frontend keeps the same text
/// in `src/lib/limit-continue.ts` — a test below fails if the two drift.
pub const LIMIT_CONTINUE_PROMPT: &str = "Your usage limit has reset. Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete.";

/// `app_metadata` key of [`LimitContinueSettings`]. Per data directory, like
/// the automatic resume's setting.
pub const LIMIT_CONTINUE_SETTINGS_KEY: &str = "limit_continue_settings";

/// Continuations sent per pause before giving up on it.
pub const MAX_ATTEMPTS: i32 = 3;

/// How long after the reset a continuation goes out: the limit's clock and
/// ours never agree to the second. `CODEG_LIMIT_CONTINUE_DELAY_SECS`.
const DEFAULT_SAFETY_DELAY_SECS: u64 = 60;
/// Most extra delay one session adds on top, so sessions paused on the same
/// reset do not all fire on the same tick. `CODEG_LIMIT_CONTINUE_JITTER_SECS`.
const DEFAULT_JITTER_SECS: u64 = 30;
/// Least time between two continuations starting.
/// `CODEG_LIMIT_CONTINUE_STAGGER_SECS`.
const DEFAULT_STAGGER_SECS: u64 = 30;
/// How long after a failed continuation (the session would not reopen) the
/// next attempt goes out.
const RETRY_AFTER_FAILURE_SECS: i64 = 120;
/// The scheduler looks at the table at least this often, whatever it was told.
const POLL: Duration = Duration::from_secs(30);
/// How long after startup the scheduler first looks: clients reconnect first.
const START_DELAY: Duration = Duration::from_secs(10);
/// A reset further ahead than this is a misread, not a limit.
const MAX_AHEAD_DAYS: i64 = 35;
/// A "rejected" event or rollout reading older than this is about an
/// earlier block.
const STRUCTURED_MAX_AGE_SECS: i64 = 15 * 60;
/// Owner label of the connections a continuation opens (logs, the
/// connection list). No window owns them.
const OWNER_LABEL: &str = "limit_continue";

/// "Continue automatically when the usage limit resets" (General settings).
/// On unless the user turned it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LimitContinueSettings {
    pub enabled: bool,
}

impl Default for LimitContinueSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// The stored setting. A missing or unreadable row reads as the default (on).
pub async fn load_limit_continue_settings(conn: &DatabaseConnection) -> LimitContinueSettings {
    match app_metadata_service::get_value(conn, LIMIT_CONTINUE_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[limit-continue] unreadable settings ({e}); using the default");
            LimitContinueSettings::default()
        }),
        Ok(None) => LimitContinueSettings::default(),
        Err(e) => {
            tracing::warn!("[limit-continue] failed to load settings ({e}); using the default");
            LimitContinueSettings::default()
        }
    }
}

/// Store the setting. Turning it off ends every pause waiting for its reset:
/// those turns become plain interruptions, with the manual Continue.
pub async fn save_limit_continue_settings(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    settings: LimitContinueSettings,
) -> Result<LimitContinueSettings, AppCommandError> {
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize the usage-limit settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, LIMIT_CONTINUE_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    if !settings.enabled {
        let paused = conversation_service::list_scheduled_limit_resumes(conn)
            .await
            .map_err(AppCommandError::from)?;
        for row in paused {
            if conversation_service::end_limit_pause(conn, row.id)
                .await
                .map_err(AppCommandError::from)?
            {
                crate::commands::conversations::emit_conversation_upsert(emitter, conn, row.id)
                    .await;
            }
        }
    }
    wake();
    Ok(settings)
}

// ─── Detection ──────────────────────────────────────────────────────────

/// How the agents word a usage limit. Claude Code's are the SDK's
/// `USAGE_LIMIT_ERROR_PREFIXES` ("You've hit your session limit · resets
/// 5:30pm (Asia/Jerusalem)") plus the older "Claude AI usage limit
/// reached|<epoch>" and "5-hour limit reached ∙ resets 3pm"; Codex says
/// "You've hit your usage limit. … try again at 3:05 PM."
const USAGE_LIMIT_MARKERS: &[&str] = &[
    "you've hit your",
    "you\u{2019}ve hit your",
    "you've reached your",
    "you\u{2019}ve reached your",
    "usage limit reached",
    "limit reached \u{2219} resets",
    "limit reached \u{b7} resets",
];

/// Whether `text` is an agent's usage-limit message.
pub fn is_usage_limit_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    USAGE_LIMIT_MARKERS.iter().any(|m| lower.contains(m))
}

/// The usage-limit message a turn's terminal AIR failure carries, if that is
/// what stopped the turn: a `limit` error whose title is the agent's own
/// usage-limit words. A configured budget or turn cap is a `limit` too, but
/// one no reset lifts.
pub fn usage_limit_text_from_failure(record: &SessionFailureRecord) -> Option<String> {
    if record.severity != "error" || record.category != "limit" {
        return None;
    }
    let title = record.title.trim();
    is_usage_limit_text(title).then(|| title.to_string())
}

/// The usage-limit message inside a rejected prompt's error ("Internal
/// error: You've hit your weekly limit · resets …"), if it is one.
pub fn usage_limit_text_from_error(message: &str) -> Option<String> {
    if !is_usage_limit_text(message) {
        return None;
    }
    // Start at the agent's own words when they open with "You've …": what
    // precedes them is the JSON-RPC wrapper.
    let start = ["You've ", "You\u{2019}ve ", "you've "]
        .iter()
        .filter_map(|m| message.find(m))
        .min()
        .unwrap_or(0);
    let text = message[start..].lines().next().unwrap_or_default().trim();
    let text = text.trim_end_matches(['"', '}', ']']).trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Whether a row is paused on the usage limit and waiting for its reset.
pub fn is_limit_paused(row: &conversation::Model) -> bool {
    matches!(
        row.limit_resume_state,
        Some(ConversationLimitResume::Scheduled | ConversationLimitResume::Claimed)
    )
}

/// Where a reset time came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetSource {
    /// A rate-limit reading the agent reported (exact).
    Structured,
    /// Read out of the agent's message (to the minute).
    Text,
}

/// The Claude window a message names: "session limit" → `five_hour`, and so
/// on — Claude Code's own names for them.
pub(crate) fn named_claude_window(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    [
        ("session limit", "five_hour"),
        ("5-hour limit", "five_hour"),
        ("weekly limit", "seven_day"),
        ("opus limit", "seven_day_opus"),
        ("sonnet limit", "seven_day_sonnet"),
        ("fable limit", "seven_day_overage_included"),
    ]
    .into_iter()
    .find(|(name, _)| lower.contains(name))
    .map(|(_, id)| id)
}

/// The host's time zone: what an agent prints a reset in when it names none.
pub(crate) fn host_time_zone() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|name| Tz::from_str(&name).ok())
        .unwrap_or(Tz::UTC)
}

static EPOCH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\|\s*(\d{9,13})\b").expect("epoch regex"));
static RELATIVE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:resets?|try again)\s+in\s+([^.·∙(]+)").expect("relative regex")
});
static SPAN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b")
        .expect("span regex")
});
static ANCHOR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:resets?|try again)(?:\s+at)?\s+(.+)").expect("anchor regex")
});
static ZONE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\(([A-Za-z][A-Za-z0-9_+\-]*(?:/[A-Za-z0-9_+\-]+)*)\)").expect("zone regex")
});
static TIME_12H_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b").expect("12h regex")
});
static TIME_24H_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([01]?\d|2[0-3]):([0-5]\d)\b").expect("24h regex"));
static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?",
    )
    .expect("date regex")
});

fn month_number(name: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    let months = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    months
        .iter()
        .position(|m| lower.starts_with(m))
        .map(|i| i as u32 + 1)
}

fn local_to_utc(tz: Tz, date: NaiveDate, time: NaiveTime) -> Option<DateTime<Utc>> {
    let naive = date.and_time(time);
    tz.from_local_datetime(&naive)
        .earliest()
        // A time inside a spring-forward gap: the first instant after it.
        .or_else(|| {
            tz.from_local_datetime(&(naive + chrono::Duration::hours(1)))
                .earliest()
        })
        .map(|t| t.with_timezone(&Utc))
}

/// Read when a limit resets out of the agent's message, relative to `now`:
///
/// * `… · resets 10pm (Asia/Jerusalem)` — the next 22:00 in that zone;
/// * `… · resets Oct 5, 5:30pm (America/New_York)`, `… Jan 2, 2027, 9am (UTC)`;
/// * `Claude AI usage limit reached|1759363200` — epoch seconds;
/// * `… try again at Oct 5th, 2025 3:05 PM.` / `… try again at 3:05 PM.`
///   (Codex: the host's zone);
/// * `… resets in 2h 30m` / `try again in 1 day 3 hours`.
///
/// A time with no zone is read in `default_tz`. `None` when the message holds
/// no time, or one that is not ahead of `now`.
pub fn parse_reset_time(text: &str, now: DateTime<Utc>, default_tz: Tz) -> Option<DateTime<Utc>> {
    let found = parse_reset_time_inner(text, now, default_tz)?;
    let ahead = found - now;
    (ahead > chrono::Duration::zero() && ahead <= chrono::Duration::days(MAX_AHEAD_DAYS))
        .then_some(found)
}

fn parse_reset_time_inner(text: &str, now: DateTime<Utc>, default_tz: Tz) -> Option<DateTime<Utc>> {
    if let Some(caps) = EPOCH_RE.captures(text) {
        let raw: i64 = caps[1].parse().ok()?;
        let secs = if raw > 1_000_000_000_000 {
            raw / 1000
        } else {
            raw
        };
        return Utc.timestamp_opt(secs, 0).single();
    }

    if let Some(caps) = RELATIVE_RE.captures(text) {
        let mut total = 0i64;
        for span in SPAN_RE.captures_iter(&caps[1]) {
            let n: i64 = span[1].parse().ok()?;
            let unit = span[2].to_lowercase();
            total += match unit.chars().next()? {
                'd' => n * 86_400,
                'h' => n * 3_600,
                'm' => n * 60,
                _ => n,
            };
        }
        if total > 0 {
            return Some(now + chrono::Duration::seconds(total));
        }
    }

    // The words after the last "resets"/"try again", up to the next
    // " · " part of the message.
    let anchor = ANCHOR_RE.captures_iter(text).last()?;
    let segment = anchor.get(1)?.as_str();
    let segment = segment.split(['·', '∙']).next().unwrap_or(segment);

    let tz = ZONE_RE
        .captures(segment)
        .and_then(|caps| Tz::from_str(&caps[1]).ok())
        .unwrap_or(default_tz);
    let time = if let Some(caps) = TIME_12H_RE.captures(segment) {
        let hour: u32 = caps[1].parse().ok()?;
        let minute: u32 = caps.get(2).map_or(Some(0), |m| m.as_str().parse().ok())?;
        if !(1..=12).contains(&hour) {
            return None;
        }
        let pm = caps[3].eq_ignore_ascii_case("p");
        let hour = match (hour, pm) {
            (12, false) => 0,
            (12, true) => 12,
            (h, true) => h + 12,
            (h, false) => h,
        };
        NaiveTime::from_hms_opt(hour, minute, 0)
    } else if let Some(caps) = TIME_24H_RE.captures(segment) {
        NaiveTime::from_hms_opt(caps[1].parse().ok()?, caps[2].parse().ok()?, 0)
    } else {
        None
    };
    let date = DATE_RE.captures(segment);
    let now_local = now.with_timezone(&tz);

    match (date, time) {
        (Some(caps), time) => {
            let month = month_number(&caps[1])?;
            let day: u32 = caps[2].parse().ok()?;
            let time = time.or_else(|| NaiveTime::from_hms_opt(0, 0, 0))?;
            match caps.get(3) {
                Some(year) => {
                    let date = NaiveDate::from_ymd_opt(year.as_str().parse().ok()?, month, day)?;
                    local_to_utc(tz, date, time)
                }
                None => {
                    // No year: this year's date, or next year's when this
                    // year's is long gone (a Dec 31 limit read on Jan 1 is
                    // a misread, a Jan 2 one read on Dec 30 is next year).
                    let this_year = NaiveDate::from_ymd_opt(now_local.year(), month, day)?;
                    let at = local_to_utc(tz, this_year, time)?;
                    if at < now - chrono::Duration::days(1) {
                        let next = NaiveDate::from_ymd_opt(now_local.year() + 1, month, day)?;
                        local_to_utc(tz, next, time)
                    } else {
                        Some(at)
                    }
                }
            }
        }
        (None, Some(time)) => {
            // A time alone: its next occurrence.
            let today = local_to_utc(tz, now_local.date_naive(), time)?;
            if today > now {
                Some(today)
            } else {
                let tomorrow = now_local.date_naive().succ_opt()?;
                local_to_utc(tz, tomorrow, time)
            }
        }
        (None, None) => None,
    }
}

/// Pick the reset time from what is known, most exact first: the agent's
/// own "rejected" reading (`blocking`, epoch seconds), then the window the
/// message names (`window`) when it agrees with the message to the minute
/// (or the message names no time), then the message. Only times ahead of
/// `now` count.
pub fn choose_reset(
    text: &str,
    now: DateTime<Utc>,
    default_tz: Tz,
    blocking: Option<i64>,
    window: Option<i64>,
) -> Option<(DateTime<Utc>, ResetSource)> {
    let at = |secs: i64| Utc.timestamp_opt(secs, 0).single();
    let ahead =
        |secs: &i64| *secs > now.timestamp() && *secs - now.timestamp() <= MAX_AHEAD_DAYS * 86_400;
    if let Some(blocking) = blocking.filter(ahead) {
        return Some((at(blocking)?, ResetSource::Structured));
    }
    let parsed = parse_reset_time(text, now, default_tz);
    let window = window.filter(ahead);
    match (parsed, window) {
        // The message rounds to the minute (and drops ":00").
        (Some(p), Some(w)) if (w - p.timestamp()).abs() <= 120 => {
            Some((at(w)?, ResetSource::Structured))
        }
        (Some(p), _) => Some((p, ResetSource::Text)),
        (None, Some(w)) => Some((at(w)?, ResetSource::Structured)),
        (None, None) => None,
    }
}

/// When the limit behind `text` resets, for an agent of `agent_type`.
pub async fn resolve_reset(
    agent_type: AgentType,
    text: &str,
    now: DateTime<Utc>,
) -> Option<(DateTime<Utc>, ResetSource)> {
    use crate::commands::{plan_usage, usage_pool};
    let now_secs = now.timestamp();
    let (blocking, window) = match agent_type {
        AgentType::Codex => (
            plan_usage::codex_blocking_reset(now_secs - STRUCTURED_MAX_AGE_SECS, now_secs).await,
            None,
        ),
        _ => match usage_pool::pool_resume_at(now_secs, named_claude_window(text)).await {
            // Behind an account pool the message speaks for one account;
            // the pool knows when any of them can take the session again.
            Some(at) => (Some(at), None),
            None => (
                plan_usage::claude_blocking_reset(now_secs),
                named_claude_window(text).and_then(plan_usage::claude_window_reset),
            ),
        },
    };
    choose_reset(text, now, host_time_zone(), blocking, window)
}

// ─── The turn's end ─────────────────────────────────────────────────────

/// The lifecycle subscriber's `TurnComplete` for a turn that stopped on the
/// usage limit (`text` is the agent's message). Records the turn's end
/// instead of `finish_turn` — paused until the reset when the conversation
/// continues on its own, otherwise like any other end — and announces the
/// pause of a critical session. Returns whether a row was written.
pub async fn finish_limited_turn(
    db: &DatabaseConnection,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    conversation_id: i32,
    agent_type: AgentType,
    status: Option<ConversationStatus>,
    text: &str,
) -> Result<bool, DbError> {
    let now = Utc::now();
    let Some((resets_at, source)) = resolve_reset(agent_type, text, now).await else {
        tracing::info!(
            conversation_id,
            "[limit-continue] usage limit with no reset time ({text:?}); not pausing"
        );
        return conversation_service::finish_turn(db, conversation_id, status).await;
    };
    let settings = load_limit_continue_settings(db).await;
    let outcome = conversation_service::finish_turn_on_usage_limit(
        db,
        conversation_id,
        status,
        resets_at,
        MAX_ATTEMPTS,
        settings.enabled,
    )
    .await?;
    match outcome {
        UsageLimitTurnEnd::Paused { attempts } => {
            tracing::info!(
                conversation_id,
                attempts,
                "[limit-continue] paused until {resets_at} ({source:?} reset time, {text:?})"
            );
            wake();
            if let Ok(Some(row)) = conversation::Entity::find_by_id(conversation_id)
                .one(db)
                .await
            {
                announce_limit_event(
                    manager,
                    db,
                    emitter,
                    &row,
                    CriticalAlertKind::LimitPaused,
                    Some(resets_at),
                )
                .await;
            }
        }
        UsageLimitTurnEnd::GaveUp => tracing::info!(
            conversation_id,
            "[limit-continue] the limit came back {MAX_ATTEMPTS} times; leaving the turn interrupted"
        ),
        UsageLimitTurnEnd::NotPaused => {}
    }
    Ok(true)
}

// ─── The scheduler ──────────────────────────────────────────────────────

static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);
/// Paused conversations the user asked to continue now.
static FORCED: LazyLock<StdMutex<HashSet<i32>>> = LazyLock::new(|| StdMutex::new(HashSet::new()));

/// Have the scheduler look again now (a pause was recorded or changed).
pub fn wake() {
    WAKE.notify_one();
}

fn env_secs(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

/// The scheduler's timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    pub safety_delay: Duration,
    pub max_jitter: Duration,
    pub stagger: Duration,
}

impl Timing {
    fn from_env() -> Self {
        Self {
            safety_delay: Duration::from_secs(env_secs(
                "CODEG_LIMIT_CONTINUE_DELAY_SECS",
                DEFAULT_SAFETY_DELAY_SECS,
            )),
            max_jitter: Duration::from_secs(env_secs(
                "CODEG_LIMIT_CONTINUE_JITTER_SECS",
                DEFAULT_JITTER_SECS,
            )),
            stagger: Duration::from_secs(env_secs(
                "CODEG_LIMIT_CONTINUE_STAGGER_SECS",
                DEFAULT_STAGGER_SECS,
            )),
        }
    }
}

/// When a paused conversation's continuation goes out: the reset, plus the
/// safety delay, plus a jitter that is fixed for one pause (so every look at
/// the table agrees on it).
pub fn fire_at(conversation_id: i32, resets_at: DateTime<Utc>, timing: &Timing) -> DateTime<Utc> {
    let jitter_span = timing.max_jitter.as_secs();
    let jitter = if jitter_span == 0 {
        0
    } else {
        let mut hasher = DefaultHasher::new();
        (conversation_id, resets_at.timestamp()).hash(&mut hasher);
        hasher.finish() % (jitter_span + 1)
    };
    resets_at
        + chrono::Duration::seconds(timing.safety_delay.as_secs() as i64)
        + chrono::Duration::seconds(jitter as i64)
}

/// Which paused rows are due at `now`, in the order they continue — the
/// ones the user asked for first, then most recently active first — and when
/// the next one falls due.
pub fn plan_due(
    rows: Vec<conversation::Model>,
    forced: &HashSet<i32>,
    now: DateTime<Utc>,
    timing: &Timing,
) -> (Vec<conversation::Model>, Option<DateTime<Utc>>) {
    let mut due = Vec::new();
    let mut next: Option<DateTime<Utc>> = None;
    for row in rows {
        if row.limit_resume_state != Some(ConversationLimitResume::Scheduled) {
            continue;
        }
        let Some(resets_at) = row.limit_resume_at else {
            continue;
        };
        let at = fire_at(row.id, resets_at, timing);
        if forced.contains(&row.id) || at <= now {
            due.push(row);
        } else {
            next = Some(next.map_or(at, |n| n.min(at)));
        }
    }
    due.sort_by(|a, b| {
        forced
            .contains(&b.id)
            .cmp(&forced.contains(&a.id))
            .then(b.updated_at.cmp(&a.updated_at))
            .then(b.id.cmp(&a.id))
    });
    (due, next)
}

/// The boot task. Spawn once per process, after the lifecycle subscriber (it
/// records the continuation's turn as running).
pub async fn run_limit_continue(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    data_dir: PathBuf,
) {
    match conversation_service::requeue_claimed_limit_resumes(&db.conn).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(
            "[limit-continue] {n} continuation(s) cut off by the last exit are due again"
        ),
        Err(e) => tracing::warn!("[limit-continue] failed to requeue claimed continuations: {e}"),
    }
    tokio::time::sleep(START_DELAY).await;

    let timing = Timing::from_env();
    let slots = Arc::new(tokio::sync::Semaphore::new(
        match crate::acp::connection::max_concurrent_attaches() {
            0 => 4,
            n => n,
        },
    ));
    let mut last_start: Option<tokio::time::Instant> = None;
    loop {
        let rows = match conversation_service::list_scheduled_limit_resumes(&db.conn).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("[limit-continue] failed to list paused sessions: {e}");
                Vec::new()
            }
        };
        let forced: HashSet<i32> =
            std::mem::take(&mut *FORCED.lock().unwrap_or_else(|e| e.into_inner()));
        let (due, next) = plan_due(rows, &forced, Utc::now(), &timing);
        let settings = if due.is_empty() {
            LimitContinueSettings::default()
        } else {
            load_limit_continue_settings(&db.conn).await
        };
        for row in due {
            if !forced.contains(&row.id) {
                if let Some(last) = last_start {
                    let wait = timing.stagger.saturating_sub(last.elapsed());
                    if !wait.is_zero() {
                        tokio::time::sleep(wait).await;
                    }
                }
            }
            if !settings.enabled || !row.limit_auto_continue {
                // Turned off while it waited (the switches end their pauses
                // themselves; this only catches a missed one).
                end_pause(&db.conn, &emitter, row.id).await;
                continue;
            }
            match conversation_service::claim_limit_resume(&db.conn, row.id).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(e) => {
                    tracing::warn!(
                        conversation_id = row.id,
                        "[limit-continue] claim failed: {e}"
                    );
                    continue;
                }
            }
            crate::commands::conversations::emit_conversation_upsert(&emitter, &db.conn, row.id)
                .await;
            let Ok(slot) = slots.clone().acquire_owned().await else {
                return;
            };
            last_start = Some(tokio::time::Instant::now());
            let db = AppDatabase {
                conn: db.conn.clone(),
            };
            let manager = manager.clone_ref();
            let emitter = emitter.clone();
            let data_dir = data_dir.clone();
            tokio::spawn(async move {
                let _slot = slot;
                continue_one(&db, &manager, &emitter, &data_dir, row).await;
            });
        }
        let wait = next
            .map(|at| (at - Utc::now()).to_std().unwrap_or_default())
            .unwrap_or(POLL)
            .min(POLL);
        tokio::select! {
            _ = WAKE.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

async fn end_pause(conn: &DatabaseConnection, emitter: &EventEmitter, conversation_id: i32) {
    match conversation_service::end_limit_pause(conn, conversation_id).await {
        Ok(true) => {
            crate::commands::conversations::emit_conversation_upsert(emitter, conn, conversation_id)
                .await
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(
            conversation_id,
            "[limit-continue] failed to end a pause: {e}"
        ),
    }
}

/// Send one claimed continuation: reopen the session (or share the tab's
/// connection) and send [`LIMIT_CONTINUE_PROMPT`]. A failure puts it back on
/// the schedule a little later, or gives up at the attempt cap.
async fn continue_one(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    row: conversation::Model,
) {
    let cid = row.id;
    let attempts = row.limit_resume_attempts + 1;
    let target = ReopenTarget {
        conversation_id: cid,
        folder_id: row.folder_id,
        agent_type: conversation_service::parse_agent_type(&row.agent_type),
        external_id: row.external_id.clone(),
    };
    let result = reopen_and_send(
        db,
        manager,
        emitter,
        data_dir,
        &target,
        OWNER_LABEL,
        LIMIT_CONTINUE_PROMPT,
        "limit-continue",
        || false,
    )
    .await;
    match result {
        Ok(Sent::Prompted) => {
            tracing::info!(
                conversation_id = cid,
                attempts,
                "[limit-continue] continued"
            );
            announce_limit_event(
                manager,
                &db.conn,
                emitter,
                &row,
                CriticalAlertKind::LimitContinued,
                None,
            )
            .await;
        }
        Ok(Sent::Busy | Sent::Aborted) => {
            // Someone sent a message in the meantime; that turn settles the
            // pause. Hand the claim back in case it has not started yet.
            let _ = conversation_service::reschedule_limit_resume(&db.conn, cid, Utc::now()).await;
        }
        Err(reason) => {
            tracing::warn!(
                conversation_id = cid,
                attempts,
                "[limit-continue] could not continue: {reason}"
            );
            if attempts >= MAX_ATTEMPTS {
                end_pause(&db.conn, emitter, cid).await;
                return;
            }
            let at = Utc::now() + chrono::Duration::seconds(RETRY_AFTER_FAILURE_SECS);
            if let Err(e) = conversation_service::reschedule_limit_resume(&db.conn, cid, at).await {
                tracing::warn!(
                    conversation_id = cid,
                    "[limit-continue] reschedule failed: {e}"
                );
            }
            crate::commands::conversations::emit_conversation_upsert(emitter, &db.conn, cid).await;
            wake();
        }
    }
}

// ─── Commands ───────────────────────────────────────────────────────────

/// "Cancel auto-continue": the pause ends now, and the turn is left as a
/// plain interruption with the manual Continue. `false` when nothing was
/// paused (it continued or settled meanwhile).
pub async fn cancel_limit_continue_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    conversation_id: i32,
) -> Result<bool, AppCommandError> {
    let ended = conversation_service::end_limit_pause(conn, conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    if ended {
        crate::commands::conversations::emit_conversation_upsert(emitter, conn, conversation_id)
            .await;
    }
    Ok(ended)
}

/// "Continue now": send the continuation right away, ahead of the reset (it
/// may hit the limit again, which reschedules it). `false` when the
/// conversation is not paused.
pub async fn continue_limit_now_core(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<bool, AppCommandError> {
    let row = conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await
        .map_err(|e| AppCommandError::from(DbError::from(e)))?;
    let paused = row.is_some_and(|row| {
        row.deleted_at.is_none()
            && row.limit_resume_state == Some(ConversationLimitResume::Scheduled)
    });
    if paused {
        FORCED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(conversation_id);
        wake();
    }
    Ok(paused)
}

/// The per-session switch (Session Details). Turning it off ends the
/// session's pause like Cancel does.
pub async fn update_limit_auto_continue_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    conversation_id: i32,
    enabled: bool,
) -> Result<(), AppCommandError> {
    conversation_service::update_limit_auto_continue(conn, conversation_id, enabled)
        .await
        .map_err(AppCommandError::from)?;
    if !enabled {
        conversation_service::end_limit_pause(conn, conversation_id)
            .await
            .map_err(AppCommandError::from)?;
    }
    crate::commands::conversations::emit_conversation_upsert(emitter, conn, conversation_id).await;
    wake();
    Ok(())
}

#[cfg(test)]
mod tests;
