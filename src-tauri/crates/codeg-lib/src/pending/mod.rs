//! Everything waiting on the user, across every session: a permission
//! request, a question (codeg-mcp's `ask_user_question`, an agent's own ask, a
//! delegated sub-agent's question), a plan waiting for approval (Claude's
//! ExitPlanMode and Codex's plan review, both permission requests, and Grok's
//! `exit_plan_mode`).
//!
//! The source of truth is each live session's own state
//! (`SessionState::pending_*`, the fields behind the sidebar's "needs you"
//! mark): an item is pending exactly while its session holds it. Answering it
//! on any device, cancelling the turn, the agent giving up and its process
//! ending all clear it, and its reminders stop with it. On top of that this
//! module keeps the bookkeeping — when each item was asked, whether an iPhone
//! heard of it, which reminders went out — and drives:
//!
//! * the iPhone push for each new item ("needs you", per the device's
//!   preferences), and a catch-up push for the items the phone never heard of
//!   when the user leaves the desk;
//! * reminders on an escalating schedule (by default 5 min, 30 min and 2 h
//!   after the ask, then every 4 h), as an iPhone push and a desktop
//!   notification, until the item clears — whether or not the user is at the
//!   desk, but never about the session someone is looking at;
//! * the counts: the iPhone app badge, the desktop dock badge and the
//!   "Waiting for you" list every client shows.
//!
//! [`engine`] is the pure state machine, tested with a fake clock;
//! [`watch`] is the runtime around it. The bookkeeping is stored in
//! `app_metadata`, so after a restart an item the agent asks again (an
//! auto-resumed turn) keeps its age, its reminders and its "the phone knows"
//! instead of starting over.
//!
//! API: `list_pending_items` (snapshot), `get_pending_reminder_settings`,
//! `update_pending_reminder_settings`; events [`PENDING_ITEMS_EVENT`] (the list
//! changed, whole snapshot) and [`PENDING_REMINDER_EVENT`] (post a desktop
//! notification now). `docs/ios-push.md` documents the push side.

pub mod engine;
pub mod watch;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Timelike, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::session_state::SessionState;
use crate::acp::types::ConnectionStatus;
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

use engine::Engine;

/// The list changed. Payload: [`PendingSnapshot`], the whole list.
pub const PENDING_ITEMS_EVENT: &str = "app://pending-items";

/// A reminder is due: post a desktop notification now. Payload:
/// [`PendingReminder`]. Its `id` is unique per firing, so the windows of one
/// machine can agree on a single notification.
pub const PENDING_REMINDER_EVENT: &str = "app://pending-reminder";

/// `app_metadata` key of [`ReminderSettings`].
pub const REMINDER_SETTINGS_KEY: &str = "pending_reminder_settings";

/// `app_metadata` key of the bookkeeping (see [`engine::Stored`]).
pub const REMINDER_STATE_KEY: &str = "pending_reminder_state";

/// Overrides the schedule, for end-to-end checks: `"5,10,20/30"` reminds 5,
/// 10 and 20 seconds after the ask, then every 30 s. Not shown in, nor saved
/// by, the settings.
pub const SCHEDULE_ENV: &str = "CODEG_REMINDER_SCHEDULE";

/// Longest text an item carries (the question, the tool call's title, the
/// plan's first line).
const MAX_TEXT_CHARS: usize = 300;
/// Longest option label an item carries.
const MAX_OPTION_CHARS: usize = 80;

const MINUTE: u64 = 60;
const DAY: u64 = 24 * 60 * MINUTE;

/// What an item waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    /// A tool call parked on allow / reject.
    Permission,
    /// A question set waiting for answers.
    Question,
    /// A plan waiting for approval.
    Plan,
}

impl PendingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PendingKind::Permission => "permission",
            PendingKind::Question => "question",
            PendingKind::Plan => "plan",
        }
    }
}

/// Where the session holds the item, which is also how it is answered:
/// `acp_respond_permission`, `acp_answer_question` or
/// `acp_answer_plan_approval`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingSource {
    Permission,
    Question,
    PlanApproval,
}

impl PendingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            PendingSource::Permission => "permission",
            PendingSource::Question => "question",
            PendingSource::PlanApproval => "plan_approval",
        }
    }
}

/// One choice of an item: a permission option (`id` is its option id,
/// `kind` its ACP kind) or a question's option (`id` is the label, which is
/// what an answer carries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// The first question of a question set, beyond its text and options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionDetail {
    /// The question's own id (`answers[].questionId` in an answer).
    pub item_id: String,
    pub header: String,
    pub multi_select: bool,
    /// How many questions the set asks (the card asks them together).
    pub count: u32,
    /// The answer is a secret the card masks: no notification asks for it
    /// as text.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
}

/// One item as a live session holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    /// `<source>:<the request's own id>`.
    pub id: String,
    pub kind: PendingKind,
    pub source: PendingSource,
    /// The session that asks (a sub-agent's own row for a delegated one).
    pub conversation_id: i32,
    pub connection_id: String,
    /// The permission request's, the question set's or the plan approval's id.
    pub request_id: String,
    pub asked_at: DateTime<Utc>,
    pub text: String,
    pub options: Vec<PendingOption>,
    pub question: Option<QuestionDetail>,
    /// Permission requests queued behind this one.
    pub queued: u32,
    /// The asking agent's display name.
    pub agent_label: String,
}

/// Where an item shows: the top-level session (the parent of a delegated
/// sub-agent), read from the database.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionMeta {
    pub root_conversation_id: i32,
    pub folder_id: Option<i32>,
    pub folder_name: Option<String>,
    pub title: Option<String>,
    /// The top-level session's stored agent id (what opening it needs).
    pub agent_type: Option<String>,
}

/// One item of the list, as the API, the events and the pushes carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingItem {
    pub id: String,
    pub kind: PendingKind,
    pub source: PendingSource,
    /// The session that asks.
    pub conversation_id: i32,
    /// The session to open: itself, or the top of a delegation chain.
    pub root_conversation_id: i32,
    pub folder_id: Option<i32>,
    pub folder_name: Option<String>,
    /// The title of the session to open.
    pub title: Option<String>,
    /// The stored agent id of the session to open.
    pub agent_type: Option<String>,
    /// The asking agent's display name.
    pub agent_label: String,
    pub connection_id: String,
    pub request_id: String,
    /// When the session started waiting.
    pub asked_at: DateTime<Utc>,
    pub text: String,
    pub options: Vec<PendingOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<QuestionDetail>,
    pub queued: u32,
    pub reminders_sent: u32,
    pub last_reminded_at: Option<DateTime<Utc>>,
    pub next_reminder_at: Option<DateTime<Utc>>,
    /// An iPhone received a notification about it.
    pub phone_notified: bool,
}

/// The whole list, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PendingSnapshot {
    pub items: Vec<PendingItem>,
    pub count: u32,
}

/// One reminder, for the desktop notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingReminder {
    /// `<item id>#<attempt>`: unique per firing.
    pub id: String,
    /// 1 for the first reminder.
    pub attempt: u32,
    pub item: PendingItem,
}

// ── Settings ──

/// "Reminders" (Settings › General, with the other notification settings).
/// Stored by the backend that owns the sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReminderSettings {
    pub enabled: bool,
    /// When to remind, in seconds after the ask, ascending.
    pub steps_secs: Vec<u64>,
    /// After the last step, remind again this often; `0` stops after it.
    pub repeat_secs: u64,
    /// Hold reminders between `quiet_start_min` and `quiet_end_min`.
    pub quiet_hours: bool,
    /// Minutes after midnight, in `timezone`.
    pub quiet_start_min: u32,
    pub quiet_end_min: u32,
    /// IANA zone of the quiet hours (the client's, sent when it saves);
    /// empty is this machine's.
    pub timezone: String,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            steps_secs: vec![5 * MINUTE, 30 * MINUTE, 120 * MINUTE],
            repeat_secs: 240 * MINUTE,
            quiet_hours: false,
            quiet_start_min: 22 * 60,
            quiet_end_min: 7 * 60,
            timezone: String::new(),
        }
    }
}

impl ReminderSettings {
    /// At most eight steps, each a minute to a week; repeats of five
    /// minutes to a week; a zone chrono-tz knows.
    pub fn sanitized(self) -> Self {
        let mut steps: Vec<u64> = self
            .steps_secs
            .into_iter()
            .filter(|s| *s > 0)
            .map(|s| s.clamp(MINUTE, 7 * DAY))
            .collect();
        steps.sort_unstable();
        steps.dedup();
        steps.truncate(8);
        let timezone = self.timezone.trim().to_string();
        let timezone = if timezone.is_empty() || timezone.parse::<chrono_tz::Tz>().is_ok() {
            timezone
        } else {
            String::new()
        };
        Self {
            enabled: self.enabled,
            steps_secs: steps,
            repeat_secs: if self.repeat_secs == 0 {
                0
            } else {
                self.repeat_secs.clamp(5 * MINUTE, 7 * DAY)
            },
            quiet_hours: self.quiet_hours,
            quiet_start_min: self.quiet_start_min % (24 * 60),
            quiet_end_min: self.quiet_end_min % (24 * 60),
            timezone,
        }
    }

    /// The settings the watch runs on: these, with [`SCHEDULE_ENV`] applied.
    pub fn effective(self) -> Self {
        match std::env::var(SCHEDULE_ENV) {
            Ok(raw) => match parse_schedule(&raw) {
                Some((steps_secs, repeat_secs)) => Self {
                    steps_secs,
                    repeat_secs,
                    ..self
                },
                None => {
                    tracing::warn!("[pending] ignoring {SCHEDULE_ENV}={raw:?}");
                    self
                }
            },
            Err(_) => self,
        }
    }

    /// Seconds after the ask of reminder `k` (1 is the first).
    pub fn offset_secs(&self, k: u32) -> Option<u64> {
        let steps = self.steps_secs.len() as u32;
        if k == 0 {
            return None;
        }
        if k <= steps {
            return Some(self.steps_secs[(k - 1) as usize]);
        }
        if self.repeat_secs == 0 {
            return None;
        }
        let last = self.steps_secs.last().copied().unwrap_or(0);
        Some(last.saturating_add(self.repeat_secs.saturating_mul(u64::from(k - steps))))
    }

    /// The latest reminder, `from` or later, already due at `now` for an item
    /// asked at `asked_at`. Several due at once (the machine slept) collapse
    /// into the latest.
    pub fn latest_due(&self, asked_at: DateTime<Utc>, from: u32, now: DateTime<Utc>) -> Option<u32> {
        let elapsed = u64::try_from((now - asked_at).num_seconds()).ok()?;
        let mut latest = None;
        for (i, step) in self.steps_secs.iter().enumerate() {
            if *step <= elapsed {
                latest = Some(i as u32 + 1);
            }
        }
        if self.repeat_secs > 0 {
            let last = self.steps_secs.last().copied().unwrap_or(0);
            if elapsed >= last.saturating_add(self.repeat_secs) {
                let extra = ((elapsed - last) / self.repeat_secs).min(1_000_000) as u32;
                latest = Some(self.steps_secs.len() as u32 + extra);
            }
        }
        latest.filter(|k| *k >= from.max(1))
    }

    /// When reminder `k` is due for an item asked at `asked_at`.
    pub fn due_at(&self, asked_at: DateTime<Utc>, k: u32) -> Option<DateTime<Utc>> {
        if !self.enabled {
            return None;
        }
        let secs = i64::try_from(self.offset_secs(k)?).ok()?;
        Some(asked_at + chrono::Duration::seconds(secs))
    }

    /// Whether `now` falls in the quiet hours.
    pub fn is_quiet(&self, now: DateTime<Utc>) -> bool {
        let (start, end) = (self.quiet_start_min, self.quiet_end_min);
        if !self.quiet_hours || start == end {
            return false;
        }
        let minute = match self.timezone.parse::<chrono_tz::Tz>() {
            Ok(tz) => {
                let local = now.with_timezone(&tz);
                local.hour() * 60 + local.minute()
            }
            Err(_) => {
                let local = now.with_timezone(&chrono::Local);
                local.hour() * 60 + local.minute()
            }
        };
        if start < end {
            (start..end).contains(&minute)
        } else {
            minute >= start || minute < end
        }
    }
}

/// `"5,10,20/30"` → `([5, 10, 20], 30)`; the repeat part is optional.
pub fn parse_schedule(raw: &str) -> Option<(Vec<u64>, u64)> {
    let (steps, repeat) = match raw.split_once('/') {
        Some((steps, repeat)) => (steps, repeat.trim().parse::<u64>().ok()?),
        None => (raw, 0),
    };
    let mut parsed = Vec::new();
    for part in steps.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        parsed.push(part.parse::<u64>().ok().filter(|s| *s > 0)?);
    }
    parsed.sort_unstable();
    parsed.dedup();
    (!parsed.is_empty() || repeat > 0).then_some((parsed, repeat))
}

pub async fn load_reminder_settings(conn: &DatabaseConnection) -> ReminderSettings {
    match app_metadata_service::get_value(conn, REMINDER_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str::<ReminderSettings>(&raw)
            .map(ReminderSettings::sanitized)
            .unwrap_or_else(|e| {
                tracing::warn!("[pending] unreadable reminder settings ({e}); using the default");
                ReminderSettings::default()
            }),
        Ok(None) => ReminderSettings::default(),
        Err(e) => {
            tracing::warn!("[pending] failed to load reminder settings ({e}); using the default");
            ReminderSettings::default()
        }
    }
}

/// Store the settings and hand them to the running watch.
pub async fn save_reminder_settings(
    conn: &DatabaseConnection,
    settings: ReminderSettings,
) -> Result<ReminderSettings, AppCommandError> {
    let settings = settings.sanitized();
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize the reminder settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, REMINDER_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    let effective = settings.clone().effective();
    with_engine(|e| e.set_settings(effective));
    Ok(settings)
}

// ── The process-wide registry ──

static ENGINE: LazyLock<Mutex<Engine>> = LazyLock::new(|| Mutex::new(Engine::default()));

/// The pending count, for the badge every push carries.
static COUNT: AtomicU32 = AtomicU32::new(0);

pub(crate) fn with_engine<R>(f: impl FnOnce(&mut Engine) -> R) -> R {
    let mut guard = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// Everything waiting on the user now.
pub fn snapshot() -> PendingSnapshot {
    with_engine(|e| e.snapshot())
}

/// How many items wait on the user (the app badge).
pub fn pending_count() -> u32 {
    COUNT.load(Ordering::Relaxed)
}

pub(crate) fn set_pending_count(count: u32) {
    COUNT.store(count, Ordering::Relaxed);
}

// ── Reading a session ──

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The first line that says something: markdown headings and list markers
/// stripped, blank lines and fences skipped.
fn first_line(text: &str) -> String {
    text.lines()
        .map(|line| {
            let line = line.trim().trim_start_matches('#').trim();
            ["- ", "* ", "> "]
                .iter()
                .find_map(|marker| line.strip_prefix(*marker))
                .unwrap_or(line)
                .trim()
        })
        .find(|line| !line.is_empty() && !line.starts_with("```"))
        .map(|line| clip(line, MAX_TEXT_CHARS))
        .unwrap_or_default()
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut node = value;
    for key in path {
        node = node.get(*key)?;
    }
    node.as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn raw_input_str<'a>(tool_call: &'a Value, key: &str) -> Option<&'a str> {
    str_at(tool_call, &["rawInput", key]).or_else(|| str_at(tool_call, &["raw_input", key]))
}

/// A permission request that is really a plan gate: Claude Code's
/// ExitPlanMode, or Codex's plan review (`plan-review:<item>` tool call).
fn is_plan_gate(
    tool_call: &Value,
    options: &[crate::acp::types::PermissionOptionInfo],
) -> bool {
    crate::acp::claude_plan_mode::is_plan_approval(tool_call, options)
        || str_at(tool_call, &["toolCallId"]).is_some_and(|id| id.starts_with("plan-review:"))
}

/// The short text of a permission request: its plan for a plan gate, else
/// the tool call's title, else what it runs.
fn permission_text(tool_call: &Value, plan_gate: bool) -> String {
    if plan_gate {
        if let Some(plan) = raw_input_str(tool_call, "plan") {
            let line = first_line(plan);
            if !line.is_empty() {
                return line;
            }
        }
    }
    str_at(tool_call, &["title"])
        .or_else(|| raw_input_str(tool_call, "command"))
        .or_else(|| raw_input_str(tool_call, "description"))
        .map(|text| clip(text, MAX_TEXT_CHARS))
        .unwrap_or_default()
}

/// What one live session waits on the user for. Nothing for a session with
/// no row yet (there is nothing to open) or one that disconnected (its
/// pending fields are about to be dropped).
pub fn asks_of(state: &SessionState) -> Vec<Ask> {
    let Some(conversation_id) = state.conversation_id else {
        return Vec::new();
    };
    if state.status == ConnectionStatus::Disconnected {
        return Vec::new();
    }
    let agent_label = state.agent_type.to_string();
    let mut out = Vec::new();
    if let Some(p) = &state.pending_permission {
        let plan_gate = is_plan_gate(&p.tool_call, &p.options);
        out.push(Ask {
            id: format!("permission:{}", p.request_id),
            kind: if plan_gate {
                PendingKind::Plan
            } else {
                PendingKind::Permission
            },
            source: PendingSource::Permission,
            conversation_id,
            connection_id: state.connection_id.clone(),
            request_id: p.request_id.clone(),
            asked_at: p.created_at,
            text: permission_text(&p.tool_call, plan_gate),
            options: p
                .options
                .iter()
                .map(|o| PendingOption {
                    id: o.option_id.clone(),
                    label: clip(&o.name, MAX_OPTION_CHARS),
                    kind: Some(o.kind.clone()),
                })
                .collect(),
            question: None,
            queued: p.queued,
            agent_label: agent_label.clone(),
        });
    }
    if let Some(q) = &state.pending_question {
        let first = q.questions.first();
        out.push(Ask {
            id: format!("question:{}", q.question_id),
            kind: PendingKind::Question,
            source: PendingSource::Question,
            conversation_id,
            connection_id: state.connection_id.clone(),
            request_id: q.question_id.clone(),
            asked_at: q.created_at,
            text: first
                .map(|spec| clip(&spec.question, MAX_TEXT_CHARS))
                .unwrap_or_default(),
            options: first
                .map(|spec| {
                    spec.options
                        .iter()
                        .map(|o| PendingOption {
                            id: o.label.clone(),
                            label: clip(&o.label, MAX_OPTION_CHARS),
                            kind: None,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            question: first.map(|spec| QuestionDetail {
                item_id: spec.id.clone(),
                header: spec.header.clone(),
                multi_select: spec.multi_select,
                count: q.questions.len() as u32,
                secret: spec.is_secret,
            }),
            queued: 0,
            agent_label: agent_label.clone(),
        });
    }
    if let Some(a) = &state.pending_plan_approval {
        out.push(Ask {
            id: format!("plan_approval:{}", a.approval_id),
            kind: PendingKind::Plan,
            source: PendingSource::PlanApproval,
            conversation_id,
            connection_id: state.connection_id.clone(),
            request_id: a.approval_id.clone(),
            asked_at: a.created_at,
            text: first_line(&a.plan_markdown),
            options: Vec::new(),
            question: None,
            queued: 0,
            agent_label,
        });
    }
    out
}

/// A stable fingerprint of what an item asks (FNV-1a over its kind, text and
/// options), to recognise the same ask again after a restart. Stable across
/// builds, unlike the std hasher.
pub fn fingerprint(ask: &Ask) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    };
    eat(ask.kind.as_str().as_bytes());
    eat(ask.text.as_bytes());
    for option in &ask.options {
        eat(option.label.as_bytes());
    }
    hash
}

#[cfg(test)]
mod tests;
