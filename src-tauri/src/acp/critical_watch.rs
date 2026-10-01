//! Critical sessions: tell the user when a session they marked critical sits
//! idle, or goes silent mid-turn.
//!
//! A conversation marked critical (`conversation.critical`) is watched here,
//! in the backend, so the alerts work with no window open — a box driven from
//! another machine, a browser closed overnight. Once a second the watchdog
//! reads every critical row and the live connection behind it and works out a
//! [`Phase`]:
//!
//! * **idle** — the turn ended, the agent waits on the user (a permission, a
//!   question, a plan approval), or the turn was interrupted;
//! * **working** — a turn is streaming;
//! * **background** — the turn is held open only for background work (the
//!   agent itself is idle, "Idle — N background tasks running").
//!
//! Every phase change starts a new *stretch*, and so does every turn boundary
//! the event bus reports in between two reads (a turn starting, a user
//! message, an answered permission or question, a turn ending) — so a turn
//! that started and finished inside one second still counts as the user
//! acting. An idle stretch that lasts the idle threshold raises an alert, and
//! the alert repeats every repeat interval until the user acknowledges it
//! (opens the session, dismisses or snoozes the alert) or acts (sends a
//! message, answers). A working or background stretch with no streamed
//! progress for the stall threshold raises a "may be stuck" alert the same
//! way, if the session has stall detection on.
//!
//! The decisions live in [`SessionWatch`], a pure state machine fed with
//! observations and instants, so they are tested without a clock; the runtime
//! around it ([`critical_watch_task`]) only gathers observations and delivers
//! what the machine fires.
//!
//! Delivery: every connected client hears [`CRITICAL_ALERT_EVENT`] (raise a
//! notification now) and [`CRITICAL_ALERTS_EVENT`] (the set of alerts waiting
//! for an acknowledgement changed — the in-app banner), and reads the set on
//! connect through [`critical_alerts`]. The alert id is unique per firing, so
//! the windows of one machine can agree on a single system notification. With
//! no client connected — or with "also send to chat channel" on — the alert
//! goes to the configured chat channels too.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope};
use crate::acp::InternalEventBus;
use crate::app_error::AppCommandError;
use crate::chat_channel::i18n::{self as channel_i18n, Lang};
use crate::chat_channel::types::{MessageLevel, RichMessage};
use crate::db::entities::conversation::{self, ConversationTurnState};
use crate::db::service::{app_metadata_service, conversation_service};
use crate::models::AgentType;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// `app_metadata` key of [`CriticalSessionSettings`]. Per data directory, like
/// the automatic resume's setting: the watchdog that reads it runs in the
/// backend that owns the sessions.
pub const CRITICAL_SETTINGS_KEY: &str = "critical_session_settings";

/// Fired once per alert (the first one and every repeat): raise a system
/// notification now. Payload: [`CriticalAlert`].
pub const CRITICAL_ALERT_EVENT: &str = "app://critical-session-alert";

/// The alerts waiting for an acknowledgement changed. Payload:
/// [`CriticalAlertsSnapshot`] with the whole set.
pub const CRITICAL_ALERTS_EVENT: &str = "app://critical-session-alerts";

/// How often the watchdog reads the critical sessions' state.
const TICK: Duration = Duration::from_secs(1);

/// Chat-channel message language, shared with the channel event pushes.
const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";

/// Longest snooze the API accepts, in minutes (a day).
const MAX_SNOOZE_MINUTES: u32 = 24 * 60;

/// "Critical sessions" (Settings › Notifications).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CriticalSessionSettings {
    /// How long a critical session sits idle before the first alert.
    pub idle_secs: u64,
    /// How often an unacknowledged alert repeats; `0` is "never repeat".
    pub repeat_secs: u64,
    /// How long a working turn may stream nothing before "may be stuck".
    pub stall_secs: u64,
    /// Clients play the alert tone with the notification.
    pub sound: bool,
    /// Send every alert to the configured chat channels too, not only when no
    /// client is connected.
    pub send_to_channel: bool,
}

impl Default for CriticalSessionSettings {
    fn default() -> Self {
        Self {
            idle_secs: 60,
            repeat_secs: 300,
            stall_secs: 300,
            sound: true,
            send_to_channel: false,
        }
    }
}

impl CriticalSessionSettings {
    /// Keep the thresholds in a range the watchdog's one-second tick can
    /// honour and a user can live with.
    pub fn sanitized(self) -> Self {
        const DAY: u64 = 24 * 60 * 60;
        Self {
            idle_secs: self.idle_secs.clamp(5, DAY),
            repeat_secs: if self.repeat_secs == 0 {
                0
            } else {
                self.repeat_secs.clamp(5, DAY)
            },
            stall_secs: self.stall_secs.clamp(10, DAY),
            ..self
        }
    }

    fn thresholds(&self, stall_detection: bool) -> Thresholds {
        Thresholds {
            idle: Duration::from_secs(self.idle_secs),
            repeat: (self.repeat_secs > 0).then(|| Duration::from_secs(self.repeat_secs)),
            stall: stall_detection.then(|| Duration::from_secs(self.stall_secs)),
        }
    }
}

/// The stored settings. A missing or unreadable row reads as the default.
pub async fn load_critical_settings(conn: &DatabaseConnection) -> CriticalSessionSettings {
    match app_metadata_service::get_value(conn, CRITICAL_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str::<CriticalSessionSettings>(&raw)
            .map(CriticalSessionSettings::sanitized)
            .unwrap_or_else(|e| {
                tracing::warn!("[critical] unreadable settings ({e}); using the default");
                CriticalSessionSettings::default()
            }),
        Ok(None) => CriticalSessionSettings::default(),
        Err(e) => {
            tracing::warn!("[critical] failed to load settings ({e}); using the default");
            CriticalSessionSettings::default()
        }
    }
}

/// Store the settings and hand them to the running watchdog.
pub async fn save_critical_settings(
    conn: &DatabaseConnection,
    settings: CriticalSessionSettings,
) -> Result<CriticalSessionSettings, AppCommandError> {
    let settings = settings.sanitized();
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize critical session settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, CRITICAL_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    with_registry(|r| r.settings = settings);
    Ok(settings)
}

// ── The state machine ──

/// Why an idle session is idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleKind {
    /// The agent's turn ended.
    TurnEnded,
    /// The agent waits on the user: a permission, a question, a plan.
    NeedsYou,
    /// The last turn was cut off before it finished.
    Interrupted,
}

/// What a critical session is doing, as the watchdog sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// A turn is streaming.
    Working,
    /// The turn is held open only for background work; the agent is idle.
    Background,
    /// Nothing is running, for the given reason.
    Idle(IdleKind),
}

/// What an alert is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriticalAlertKind {
    /// The turn ended and nothing happened since.
    Idle,
    /// The agent has been waiting on the user.
    NeedsYou,
    /// The turn was interrupted and nothing happened since.
    Interrupted,
    /// A working turn has streamed nothing for the stall threshold.
    Stalled,
    /// A turn held for background work has seen no background progress for
    /// the stall threshold.
    BackgroundStalled,
}

impl IdleKind {
    fn alert_kind(self) -> CriticalAlertKind {
        match self {
            IdleKind::TurnEnded => CriticalAlertKind::Idle,
            IdleKind::NeedsYou => CriticalAlertKind::NeedsYou,
            IdleKind::Interrupted => CriticalAlertKind::Interrupted,
        }
    }
}

/// The timing the machine applies to one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    pub idle: Duration,
    /// `None`: alert once per stretch, never repeat.
    pub repeat: Option<Duration>,
    /// `None`: stall detection is off for this session.
    pub stall: Option<Duration>,
}

/// One reading of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Observation {
    pub phase: Phase,
    /// Bumped on every turn boundary the event bus saw (a turn starting or
    /// ending, a user message, an answer). A change starts a new stretch even
    /// when the phase read the same both times.
    pub epoch: u64,
    /// Last streamed progress (content, thoughts, tool calls, background
    /// activity), if any was seen.
    pub progress_at: Option<Instant>,
}

/// An alert the machine decided to raise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fired {
    pub kind: CriticalAlertKind,
    /// 1 for the first alert of an episode, 2+ for repeats.
    pub count: u32,
    /// When the idle stretch or the silence began.
    pub since: Instant,
    /// Distinguishes episodes of one session, for alert ids.
    pub episode: u64,
}

/// What one alert is about: an idle stretch, or a silence inside a working
/// or background stretch (identified by its anchor, the instant the silence
/// began).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EpisodeKey {
    Idle(u64),
    Silence(u64, Instant),
}

#[derive(Debug, Clone)]
struct Episode {
    key: EpisodeKey,
    seq: u64,
    kind: CriticalAlertKind,
    since: Instant,
    acked: bool,
    alerts: u32,
    /// When the next alert is due, once the first one fired or a snooze set
    /// it. Before that the first alert is due at `since` + the threshold,
    /// worked out from the current settings.
    next_due: Option<Instant>,
    /// Snoozed: hidden from the banner until the snooze ends.
    snoozed: bool,
}

impl Episode {
    fn new(key: EpisodeKey, seq: u64, kind: CriticalAlertKind, since: Instant) -> Self {
        Self {
            key,
            seq,
            kind,
            since,
            acked: false,
            alerts: 0,
            next_due: None,
            snoozed: false,
        }
    }
}

/// The alerting state of one critical session.
#[derive(Debug, Clone)]
pub struct SessionWatch {
    phase: Phase,
    epoch: u64,
    stretch: u64,
    stretch_started: Instant,
    episode: Episode,
}

impl SessionWatch {
    /// Start watching. `acknowledged` treats what the session is doing right
    /// now as already seen: marking a session critical is itself an action,
    /// and a watchdog starting up cannot tell how long an idle session has
    /// been idle.
    pub fn new(obs: Observation, now: Instant, acknowledged: bool) -> Self {
        let mut watch = Self {
            phase: obs.phase,
            epoch: obs.epoch,
            stretch: 0,
            stretch_started: now,
            episode: Episode::new(EpisodeKey::Idle(0), 0, CriticalAlertKind::Idle, now),
        };
        let (key, kind, since) = watch.current_episode(obs.progress_at);
        watch.episode = Episode::new(key, 0, kind, since);
        watch.episode.acked = acknowledged;
        watch
    }

    /// Feed the latest observation; returns the alert to raise now, if any.
    pub fn step(&mut self, obs: Observation, th: &Thresholds, now: Instant) -> Option<Fired> {
        self.observe(obs, now);
        let due = self.due_at(th)?;
        if now < due {
            return None;
        }
        let ep = &mut self.episode;
        ep.alerts += 1;
        ep.snoozed = false;
        ep.next_due = th.repeat.map(|repeat| now + repeat);
        Some(Fired {
            kind: ep.kind,
            count: ep.alerts,
            since: ep.since,
            episode: ep.seq,
        })
    }

    /// The user saw the alert (opened the session, dismissed it): no more
    /// alerts until something new happens. Returns whether it took effect.
    ///
    /// Only an alert that fired can be acknowledged. Opening a session before
    /// its first alert is not one of the actions that end an idle stretch (a
    /// new turn, a message, an answer), so the first alert still comes; a
    /// snoozed alert counts as fired.
    pub fn ack(&mut self) -> bool {
        if self.episode.alerts == 0 {
            return false;
        }
        self.episode.acked = true;
        self.episode.snoozed = false;
        true
    }

    /// Hold the alerts until `until`; then alert again if still unanswered.
    pub fn snooze(&mut self, until: Instant) {
        if self.episode.acked {
            return;
        }
        self.episode.next_due = Some(until);
        self.episode.snoozed = true;
    }

    /// An alert fired and nobody acknowledged or snoozed it yet: what the
    /// in-app banner shows.
    pub fn active(&self) -> bool {
        let ep = &self.episode;
        ep.alerts > 0 && !ep.acked && !ep.snoozed
    }

    fn observe(&mut self, obs: Observation, now: Instant) {
        if obs.phase != self.phase || obs.epoch != self.epoch {
            self.phase = obs.phase;
            self.epoch = obs.epoch;
            self.stretch += 1;
            self.stretch_started = now;
        }
        let (key, kind, since) = self.current_episode(obs.progress_at);
        if key != self.episode.key {
            self.episode = Episode::new(key, self.episode.seq + 1, kind, since);
        }
    }

    fn current_episode(
        &self,
        progress_at: Option<Instant>,
    ) -> (EpisodeKey, CriticalAlertKind, Instant) {
        match self.phase {
            Phase::Idle(kind) => (
                EpisodeKey::Idle(self.stretch),
                kind.alert_kind(),
                self.stretch_started,
            ),
            Phase::Working | Phase::Background => {
                // Silence counts from the later of the stretch start and the
                // last progress: progress from before the stretch says nothing
                // about this turn.
                let anchor =
                    progress_at.map_or(self.stretch_started, |p| p.max(self.stretch_started));
                let kind = if self.phase == Phase::Working {
                    CriticalAlertKind::Stalled
                } else {
                    CriticalAlertKind::BackgroundStalled
                };
                (EpisodeKey::Silence(self.stretch, anchor), kind, anchor)
            }
        }
    }

    fn due_at(&self, th: &Thresholds) -> Option<Instant> {
        let ep = &self.episode;
        if ep.acked {
            return None;
        }
        let threshold = match ep.key {
            EpisodeKey::Idle(_) => th.idle,
            EpisodeKey::Silence(..) => th.stall?,
        };
        if ep.alerts == 0 && ep.next_due.is_none() {
            return Some(ep.since + threshold);
        }
        ep.next_due
    }
}

/// Where a critical session stands, from what codeg knows of it: whether it
/// is blocked on the user, its live connection (status, held for background
/// work), and the persisted turn state.
pub fn derive_phase(
    needs_you: bool,
    live: Option<&LiveState>,
    turn_state: Option<ConversationTurnState>,
) -> Phase {
    if needs_you {
        return Phase::Idle(IdleKind::NeedsYou);
    }
    if let Some(live) = live {
        if live.status == ConnectionStatus::Prompting {
            return if live.awaiting_background {
                Phase::Background
            } else {
                Phase::Working
            };
        }
    }
    match turn_state {
        Some(ConversationTurnState::Interrupted) => Phase::Idle(IdleKind::Interrupted),
        // A live connection sitting idle is first-hand proof the turn ended;
        // the persisted `running` just has not caught up yet.
        Some(ConversationTurnState::Running) => match live {
            Some(live) if live.status == ConnectionStatus::Connected => {
                Phase::Idle(IdleKind::TurnEnded)
            }
            _ => Phase::Working,
        },
        None => Phase::Idle(IdleKind::TurnEnded),
    }
}

/// The live connection's side of [`derive_phase`].
#[derive(Debug, Clone, PartialEq)]
pub struct LiveState {
    pub status: ConnectionStatus,
    pub awaiting_background: bool,
}

// ── Alerts and the registry ──

/// One alert, as clients see it.
#[derive(Debug, Clone, Serialize)]
pub struct CriticalAlert {
    /// Unique per firing (process instance, session, episode, count): the
    /// windows of one machine claim it to post one system notification.
    pub id: String,
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub title: Option<String>,
    pub kind: CriticalAlertKind,
    /// When the idle stretch or the silence began.
    pub since: DateTime<Utc>,
    /// 1 for the first alert, 2+ for repeats.
    pub count: u32,
    pub fired_at: DateTime<Utc>,
    /// Play the alert tone (the setting at firing time).
    pub sound: bool,
}

/// Payload of [`CRITICAL_ALERTS_EVENT`] and of `get_critical_alerts`.
#[derive(Debug, Clone, Serialize)]
pub struct CriticalAlertsSnapshot {
    pub alerts: Vec<CriticalAlert>,
}

/// What the watchdog needs of a critical row.
#[derive(Debug, Clone)]
pub struct WatchedRow {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub title: Option<String>,
    pub stall_detection: bool,
}

impl From<&conversation::Model> for WatchedRow {
    fn from(row: &conversation::Model) -> Self {
        Self {
            conversation_id: row.id,
            folder_id: row.folder_id,
            agent_type: conversation_service::parse_agent_type(&row.agent_type),
            title: row.title.clone(),
            stall_detection: row.critical_stall,
        }
    }
}

/// A bus event's meaning for the watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// A turn boundary or a user action: starts a new stretch.
    Boundary,
    /// Streamed progress: resets the silence a stall is measured on.
    Progress,
}

pub fn classify(event: &AcpEvent) -> Option<Signal> {
    match event {
        AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        }
        | AcpEvent::TurnComplete { .. }
        | AcpEvent::UserMessage { .. }
        | AcpEvent::FeedbackSubmitted { .. }
        | AcpEvent::PermissionResolved { .. }
        | AcpEvent::QuestionResolved { .. }
        | AcpEvent::PlanApprovalResolved { .. } => Some(Signal::Boundary),
        AcpEvent::ContentDelta { .. }
        | AcpEvent::Thinking { .. }
        | AcpEvent::ToolCall { .. }
        | AcpEvent::ToolCallUpdate { .. }
        | AcpEvent::PlanUpdate { .. }
        | AcpEvent::AsyncTask { .. }
        | AcpEvent::BackgroundActivity { .. }
        | AcpEvent::AwaitingBackground { .. }
        | AcpEvent::DelegationStarted { .. }
        | AcpEvent::DelegationCompleted { .. } => Some(Signal::Progress),
        _ => None,
    }
}

#[derive(Debug)]
struct Entry {
    row: WatchedRow,
    epoch: u64,
    progress_at: Option<Instant>,
    watch: Option<SessionWatch>,
    /// The last alert fired in the current episode — what the banner shows.
    last: Option<CriticalAlert>,
}

/// Every watched session's state. One per process (see [`with_registry`]);
/// tests build their own.
#[derive(Debug)]
pub struct CriticalRegistry {
    instance: String,
    /// The first evaluation ran. Sessions found on it are judged by the
    /// startup rule (an interruption alerts, a plain idle does not); later
    /// ones were just marked, which acknowledges whatever they are doing.
    started: bool,
    pub settings: CriticalSessionSettings,
    sessions: HashMap<i32, Entry>,
}

impl CriticalRegistry {
    pub fn new(instance: impl Into<String>) -> Self {
        Self {
            instance: instance.into(),
            started: false,
            settings: CriticalSessionSettings::default(),
            sessions: HashMap::new(),
        }
    }

    /// Record a bus signal for a watched session; others are ignored.
    pub fn record(&mut self, conversation_id: i32, signal: Signal, now: Instant) {
        if let Some(entry) = self.sessions.get_mut(&conversation_id) {
            if signal == Signal::Boundary {
                entry.epoch += 1;
            }
            entry.progress_at = Some(now);
        }
    }

    /// The bus lagged: events were lost, and with them progress stamps. A
    /// lag means events were flowing, so count it as progress everywhere
    /// rather than risk a false "may be stuck".
    pub fn note_lag(&mut self, now: Instant) {
        for entry in self.sessions.values_mut() {
            entry.progress_at = Some(now);
        }
    }

    /// Bring the watched set in line with the critical rows: add the newly
    /// marked, drop the unmarked and deleted, refresh titles and switches.
    pub fn sync_rows(&mut self, rows: impl IntoIterator<Item = WatchedRow>) {
        let mut seen = HashSet::new();
        for row in rows {
            seen.insert(row.conversation_id);
            match self.sessions.get_mut(&row.conversation_id) {
                Some(entry) => entry.row = row,
                None => {
                    self.sessions.insert(
                        row.conversation_id,
                        Entry {
                            row,
                            epoch: 0,
                            progress_at: None,
                            watch: None,
                            last: None,
                        },
                    );
                }
            }
        }
        self.sessions.retain(|id, _| seen.contains(id));
    }

    /// Stop watching one session at once (it was unmarked).
    pub fn remove(&mut self, conversation_id: i32) {
        self.sessions.remove(&conversation_id);
    }

    /// Feed one session's phase; returns the alert to deliver, if one fired.
    pub fn step(
        &mut self,
        conversation_id: i32,
        phase: Phase,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Option<CriticalAlert> {
        let started = self.started;
        let settings = self.settings;
        let instance = self.instance.clone();
        let entry = self.sessions.get_mut(&conversation_id)?;
        let obs = Observation {
            phase,
            epoch: entry.epoch,
            progress_at: entry.progress_at,
        };
        if entry.watch.is_none() {
            let acknowledged = started || phase != Phase::Idle(IdleKind::Interrupted);
            entry.watch = Some(SessionWatch::new(obs, now, acknowledged));
            return None;
        }
        let watch = entry.watch.as_mut()?;
        let th = settings.thresholds(entry.row.stall_detection);
        let Some(fired) = watch.step(obs, &th, now) else {
            if !watch.active() {
                entry.last = None;
            }
            return None;
        };
        let since = wall_now
            - chrono::Duration::from_std(now.saturating_duration_since(fired.since))
                .unwrap_or_else(|_| chrono::Duration::zero());
        let alert = CriticalAlert {
            id: format!(
                "{instance}-c{conversation_id}-e{}-n{}",
                fired.episode, fired.count
            ),
            conversation_id,
            folder_id: entry.row.folder_id,
            agent_type: entry.row.agent_type,
            title: entry.row.title.clone(),
            kind: fired.kind,
            since,
            count: fired.count,
            fired_at: wall_now,
            sound: settings.sound,
        };
        entry.last = Some(alert.clone());
        Some(alert)
    }

    /// The evaluation pass is over; sessions found from now on were marked.
    pub fn finish_pass(&mut self) {
        self.started = true;
    }

    pub fn ack(&mut self, conversation_id: i32) {
        if let Some(entry) = self.sessions.get_mut(&conversation_id) {
            if entry.watch.as_mut().is_some_and(SessionWatch::ack) {
                entry.last = None;
            }
        }
    }

    pub fn snooze(&mut self, conversation_id: i32, until: Instant) {
        if let Some(entry) = self.sessions.get_mut(&conversation_id) {
            if let Some(watch) = entry.watch.as_mut() {
                watch.snooze(until);
            }
        }
    }

    /// The alerts waiting for an acknowledgement, oldest session first.
    pub fn active_alerts(&self) -> Vec<CriticalAlert> {
        let mut alerts: Vec<CriticalAlert> = self
            .sessions
            .values()
            .filter(|e| e.watch.as_ref().is_some_and(SessionWatch::active))
            .filter_map(|e| {
                e.last.clone().map(|mut alert| {
                    alert.title = e.row.title.clone();
                    alert
                })
            })
            .collect();
        alerts.sort_by_key(|a| a.conversation_id);
        alerts
    }

    /// Identity of the active set, to tell whether a pass changed it.
    fn active_key(&self) -> Vec<(i32, String)> {
        self.active_alerts()
            .into_iter()
            .map(|a| (a.conversation_id, a.id))
            .collect()
    }

    #[cfg(test)]
    fn watch(&self, conversation_id: i32) -> Option<&SessionWatch> {
        self.sessions.get(&conversation_id)?.watch.as_ref()
    }
}

static REGISTRY: LazyLock<StdMutex<CriticalRegistry>> = LazyLock::new(|| {
    StdMutex::new(CriticalRegistry::new(
        uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
    ))
});

/// Run `f` on the process-wide registry. Never held across an `.await`.
fn with_registry<R>(f: impl FnOnce(&mut CriticalRegistry) -> R) -> R {
    let mut guard = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

fn publish(emitter: &EventEmitter, alerts: Vec<CriticalAlert>) {
    emit_event(
        emitter,
        CRITICAL_ALERTS_EVENT,
        CriticalAlertsSnapshot { alerts },
    );
}

/// Run `f` on the registry and publish the active set if it changed.
fn mutate_and_publish(
    emitter: &EventEmitter,
    f: impl FnOnce(&mut CriticalRegistry),
) -> Vec<CriticalAlert> {
    let (changed, alerts) = with_registry(|r| {
        let before = r.active_key();
        f(r);
        (before != r.active_key(), r.active_alerts())
    });
    if changed {
        publish(emitter, alerts.clone());
    }
    alerts
}

// ── API ──

/// The alerts waiting for an acknowledgement, for a client that just
/// connected (events fired before it connected are gone).
pub fn critical_alerts() -> CriticalAlertsSnapshot {
    CriticalAlertsSnapshot {
        alerts: with_registry(|r| r.active_alerts()),
    }
}

/// The user opened the session or dismissed its alert: once an alert fired
/// for the current idle stretch (or silence), it alerts no more. Before the
/// first alert this does nothing (see [`SessionWatch::ack`]).
pub fn ack_critical_session_core(
    emitter: &EventEmitter,
    conversation_id: i32,
) -> CriticalAlertsSnapshot {
    CriticalAlertsSnapshot {
        alerts: mutate_and_publish(emitter, |r| r.ack(conversation_id)),
    }
}

/// Hold the session's alert for `minutes`, then alert again if nothing
/// happened in between.
pub fn snooze_critical_session_core(
    emitter: &EventEmitter,
    conversation_id: i32,
    minutes: u32,
) -> CriticalAlertsSnapshot {
    let minutes = minutes.clamp(1, MAX_SNOOZE_MINUTES);
    let until = Instant::now() + Duration::from_secs(u64::from(minutes) * 60);
    CriticalAlertsSnapshot {
        alerts: mutate_and_publish(emitter, |r| r.snooze(conversation_id, until)),
    }
}

/// Mark or unmark a conversation critical (and set its stall detection).
/// Unmarking clears its alert at once; marking starts watching on the next
/// pass, with what the session is doing now counted as seen.
pub async fn set_conversation_critical_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    conversation_id: i32,
    critical: bool,
    stall_detection: Option<bool>,
) -> Result<(), AppCommandError> {
    conversation_service::update_critical(conn, conversation_id, critical, stall_detection)
        .await
        .map_err(AppCommandError::from)?;
    if !critical {
        mutate_and_publish(emitter, |r| r.remove(conversation_id));
    }
    crate::commands::conversations::emit_conversation_upsert(emitter, conn, conversation_id).await;
    Ok(())
}

// ── Runtime ──

/// Whether anyone is looking: a WebSocket client (a browser, a remote desktop
/// window) or, in the desktop app, a visible window.
fn clients_connected(emitter: &EventEmitter) -> bool {
    crate::web::ws::connected_client_count() > 0 || window_visible(emitter)
}

#[cfg(feature = "tauri-runtime")]
fn window_visible(emitter: &EventEmitter) -> bool {
    use tauri::Manager;
    match emitter {
        EventEmitter::Tauri(app) => app
            .webview_windows()
            .values()
            .any(|w| w.is_visible().unwrap_or(false)),
        _ => false,
    }
}

#[cfg(not(feature = "tauri-runtime"))]
fn window_visible(_emitter: &EventEmitter) -> bool {
    false
}

async fn live_state(manager: &ConnectionManager, conversation_id: i32) -> Option<LiveState> {
    let conn_id = manager
        .find_connection_by_conversation_id(conversation_id)
        .await?;
    let state = manager.get_state(&conn_id).await?;
    let s = state.read().await;
    Some(LiveState {
        status: s.status.clone(),
        awaiting_background: s.awaiting_background,
    })
}

async fn channel_lang(db: &DatabaseConnection) -> Lang {
    app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| Lang::from_str_lossy(&v))
        .unwrap_or_default()
}

/// The chat-channel form of an alert.
pub fn channel_message(lang: Lang, alert: &CriticalAlert) -> RichMessage {
    let session = alert
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| channel_i18n::critical_untitled(lang));
    let title = format!(
        "⚑ {}: {session}",
        channel_i18n::critical_alert_title(lang, alert.kind)
    );
    let mut message = RichMessage::info(channel_i18n::critical_alert_body(lang, alert.kind))
        .with_title(title)
        .with_field(
            channel_i18n::critical_agent_label(lang),
            alert.agent_type.to_string(),
        );
    message.level = MessageLevel::Warning;
    message
}

async fn deliver_to_channels(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
    emitter: &EventEmitter,
    fired: &[CriticalAlert],
    settings: CriticalSessionSettings,
) {
    if !settings.send_to_channel && clients_connected(emitter) {
        return;
    }
    let Some(channels) = manager.chat_channel() else {
        return;
    };
    if channels.get_status().await.is_empty() {
        return;
    }
    let lang = channel_lang(db).await;
    for alert in fired {
        channels.send_to_all(&channel_message(lang, alert)).await;
    }
}

/// One evaluation pass over every critical session.
async fn evaluate(manager: &ConnectionManager, db: &DatabaseConnection, emitter: &EventEmitter) {
    let rows = match conversation_service::list_critical(db).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[critical] failed to list critical sessions: {e}");
            return;
        }
    };
    let needs_you: HashSet<i32> = if rows.is_empty() {
        HashSet::new()
    } else {
        manager
            .list_attention()
            .await
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    };
    let mut observed = Vec::with_capacity(rows.len());
    for row in &rows {
        let live = live_state(manager, row.id).await;
        let phase = derive_phase(needs_you.contains(&row.id), live.as_ref(), row.turn_state);
        observed.push((row.id, phase));
    }

    let now = Instant::now();
    let wall_now = Utc::now();
    let (fired, changed, active, settings) = with_registry(|r| {
        let before = r.active_key();
        r.sync_rows(rows.iter().map(WatchedRow::from));
        let fired: Vec<CriticalAlert> = observed
            .iter()
            .filter_map(|(id, phase)| r.step(*id, *phase, now, wall_now))
            .collect();
        r.finish_pass();
        (
            fired,
            before != r.active_key(),
            r.active_alerts(),
            r.settings,
        )
    });

    for alert in &fired {
        tracing::info!(
            "[critical] alert {} for conversation {} ({:?}, #{})",
            alert.id,
            alert.conversation_id,
            alert.kind,
            alert.count
        );
        emit_event(emitter, CRITICAL_ALERT_EVENT, alert);
    }
    if changed {
        publish(emitter, active);
    }
    if !fired.is_empty() {
        deliver_to_channels(manager, db, emitter, &fired, settings).await;
    }
}

/// Map a bus envelope to the conversation it is about and record its signal.
async fn on_envelope(
    manager: &ConnectionManager,
    links: &mut HashMap<String, i32>,
    envelope: &EventEnvelope,
) {
    if let AcpEvent::ConversationLinked {
        conversation_id, ..
    } = &envelope.payload
    {
        links.insert(envelope.connection_id.clone(), *conversation_id);
    }
    let signal = classify(&envelope.payload);
    if let AcpEvent::StatusChanged {
        status: ConnectionStatus::Disconnected,
    } = &envelope.payload
    {
        links.remove(&envelope.connection_id);
    }
    let Some(signal) = signal else {
        return;
    };
    let conversation_id = match links.get(&envelope.connection_id) {
        Some(id) => *id,
        None => {
            let Some(state) = manager.get_state(&envelope.connection_id).await else {
                return;
            };
            let Some(id) = state.read().await.conversation_id else {
                return;
            };
            links.insert(envelope.connection_id.clone(), id);
            id
        }
    };
    let now = Instant::now();
    with_registry(|r| r.record(conversation_id, signal, now));
}

/// The watchdog. Subscribes to the bus synchronously (so no event between
/// spawn and the first poll is lost) and returns the future to spawn — in the
/// desktop setup and in `codeg-server`, like the other bus subscribers.
pub fn critical_watch_task(
    bus: Arc<InternalEventBus>,
    manager: ConnectionManager,
    db: DatabaseConnection,
    emitter: EventEmitter,
) -> impl Future<Output = ()> + Send + 'static {
    let mut rx = bus.subscribe();
    async move {
        let settings = load_critical_settings(&db).await;
        with_registry(|r| r.settings = settings);
        let mut links: HashMap<String, i32> = HashMap::new();
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(envelope) => on_envelope(&manager, &mut links, &envelope).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let now = Instant::now();
                        with_registry(|r| r.note_lag(now));
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = tick.tick() => evaluate(&manager, &db, &emitter).await,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDLE: Duration = Duration::from_secs(60);
    const REPEAT: Duration = Duration::from_secs(300);
    const STALL: Duration = Duration::from_secs(300);

    fn th() -> Thresholds {
        Thresholds {
            idle: IDLE,
            repeat: Some(REPEAT),
            stall: Some(STALL),
        }
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    fn obs(phase: Phase, epoch: u64) -> Observation {
        Observation {
            phase,
            epoch,
            progress_at: None,
        }
    }

    const ENDED: Phase = Phase::Idle(IdleKind::TurnEnded);
    const NEEDS_YOU: Phase = Phase::Idle(IdleKind::NeedsYou);
    const INTERRUPTED: Phase = Phase::Idle(IdleKind::Interrupted);

    /// A watch that saw a turn running, then the turn ending at `t0`.
    fn idle_since(t0: Instant, kind: Phase) -> SessionWatch {
        let mut w = SessionWatch::new(obs(Phase::Working, 0), t0 - secs(10), true);
        assert_eq!(w.step(obs(kind, 1), &th(), t0), None);
        w
    }

    #[test]
    fn idle_alerts_at_the_threshold_then_repeats() {
        let t0 = Instant::now();
        let mut w = idle_since(t0, ENDED);
        assert_eq!(w.step(obs(ENDED, 1), &th(), t0 + secs(59)), None);
        assert!(!w.active());
        let first = w
            .step(obs(ENDED, 1), &th(), t0 + secs(60))
            .expect("alert at 60 s");
        assert_eq!(first.kind, CriticalAlertKind::Idle);
        assert_eq!(first.count, 1);
        assert_eq!(first.since, t0);
        assert!(w.active());
        // Nothing more until the repeat interval passed.
        assert_eq!(w.step(obs(ENDED, 1), &th(), t0 + secs(200)), None);
        let second = w
            .step(obs(ENDED, 1), &th(), t0 + secs(360))
            .expect("repeat after 5 min");
        assert_eq!(second.count, 2);
        assert_eq!(second.episode, first.episode, "same idle stretch");
    }

    #[test]
    fn repeat_off_alerts_once() {
        let t0 = Instant::now();
        let th = Thresholds {
            repeat: None,
            ..th()
        };
        let mut w = SessionWatch::new(obs(Phase::Working, 0), t0, true);
        w.step(obs(ENDED, 1), &th, t0);
        assert!(w.step(obs(ENDED, 1), &th, t0 + secs(60)).is_some());
        assert_eq!(w.step(obs(ENDED, 1), &th, t0 + secs(3600)), None);
        assert!(w.active(), "still waiting for an acknowledgement");
    }

    #[test]
    fn ack_stops_the_alerts_until_the_next_idle_stretch() {
        let t0 = Instant::now();
        let mut w = idle_since(t0, ENDED);
        assert!(w.step(obs(ENDED, 1), &th(), t0 + secs(60)).is_some());
        w.ack();
        assert!(!w.active());
        assert_eq!(w.step(obs(ENDED, 1), &th(), t0 + secs(400)), None);
        assert_eq!(w.step(obs(ENDED, 1), &th(), t0 + secs(4000)), None);
        // The next turn runs and ends: a new stretch, timed afresh.
        let t1 = t0 + secs(5000);
        assert_eq!(w.step(obs(Phase::Working, 2), &th(), t1), None);
        assert_eq!(w.step(obs(ENDED, 3), &th(), t1 + secs(30)), None);
        assert_eq!(w.step(obs(ENDED, 3), &th(), t1 + secs(89)), None);
        assert!(w.step(obs(ENDED, 3), &th(), t1 + secs(90)).is_some());
    }

    #[test]
    fn opening_the_session_before_the_first_alert_does_not_skip_it() {
        // Looking is not acting: only a turn, a message or an answer ends an
        // idle stretch. An acknowledgement needs an alert to acknowledge.
        let t0 = Instant::now();
        let mut w = idle_since(t0, ENDED);
        w.step(obs(ENDED, 1), &th(), t0 + secs(20));
        assert!(!w.ack(), "the user opened the tab; nothing to acknowledge");
        assert!(w.step(obs(ENDED, 1), &th(), t0 + secs(60)).is_some());
        assert!(w.ack(), "opening it now acknowledges the alert");
        assert_eq!(w.step(obs(ENDED, 1), &th(), t0 + secs(400)), None);
    }

    #[test]
    fn a_snoozed_alert_is_acknowledged_by_opening_the_session() {
        let t0 = Instant::now();
        let mut w = idle_since(t0, ENDED);
        assert!(w.step(obs(ENDED, 1), &th(), t0 + secs(60)).is_some());
        w.snooze(t0 + secs(960));
        assert!(w.ack());
        assert_eq!(w.step(obs(ENDED, 1), &th(), t0 + secs(2000)), None);
        assert!(!w.active());
    }

    #[test]
    fn a_new_turn_resets_the_stretch() {
        let t0 = Instant::now();
        let mut w = idle_since(t0, ENDED);
        assert!(w.step(obs(ENDED, 1), &th(), t0 + secs(60)).is_some());
        // The user sends a message: working, no alert, banner gone.
        assert_eq!(w.step(obs(Phase::Working, 2), &th(), t0 + secs(70)), None);
        assert!(!w.active());
        // The turn ends; the clock starts again from there.
        assert_eq!(w.step(obs(ENDED, 3), &th(), t0 + secs(80)), None);
        assert_eq!(w.step(obs(ENDED, 3), &th(), t0 + secs(139)), None);
        let again = w.step(obs(ENDED, 3), &th(), t0 + secs(140)).expect("alert");
        assert_eq!(again.count, 1, "a new stretch counts from one");
    }

    #[test]
    fn a_turn_too_short_to_see_still_resets_the_stretch() {
        // The phase reads idle on both passes, but the bus saw a user message
        // and a turn ending in between (the epoch moved).
        let t0 = Instant::now();
        let mut w = idle_since(t0, ENDED);
        w.step(obs(ENDED, 1), &th(), t0 + secs(50));
        assert_eq!(w.step(obs(ENDED, 4), &th(), t0 + secs(51)), None);
        assert_eq!(
            w.step(obs(ENDED, 4), &th(), t0 + secs(100)),
            None,
            "timed from 51 s"
        );
        assert!(w.step(obs(ENDED, 4), &th(), t0 + secs(111)).is_some());
    }

    #[test]
    fn needs_you_and_interrupted_count_as_idle() {
        let t0 = Instant::now();
        let mut w = idle_since(t0, NEEDS_YOU);
        let fired = w
            .step(obs(NEEDS_YOU, 1), &th(), t0 + secs(60))
            .expect("alert");
        assert_eq!(fired.kind, CriticalAlertKind::NeedsYou);
        // The user answers: back to working, so no repeat.
        assert_eq!(w.step(obs(Phase::Working, 2), &th(), t0 + secs(70)), None);
        assert!(!w.active());

        let mut w = idle_since(t0, INTERRUPTED);
        let fired = w
            .step(obs(INTERRUPTED, 1), &th(), t0 + secs(61))
            .expect("alert");
        assert_eq!(fired.kind, CriticalAlertKind::Interrupted);
    }

    #[test]
    fn a_permission_answered_in_between_counts_as_acting() {
        // Needs you -> (answer, the turn runs and ends between two passes)
        // -> idle again: a new stretch, not the old one's alert.
        let t0 = Instant::now();
        let mut w = idle_since(t0, NEEDS_YOU);
        w.step(obs(NEEDS_YOU, 1), &th(), t0 + secs(40));
        assert_eq!(w.step(obs(ENDED, 3), &th(), t0 + secs(41)), None);
        assert_eq!(w.step(obs(ENDED, 3), &th(), t0 + secs(100)), None);
        let fired = w.step(obs(ENDED, 3), &th(), t0 + secs(101)).expect("alert");
        assert_eq!(fired.kind, CriticalAlertKind::Idle);
    }

    #[test]
    fn snooze_holds_the_alert_then_alerts_again() {
        let t0 = Instant::now();
        let th = Thresholds {
            repeat: None,
            ..th()
        };
        let mut w = SessionWatch::new(obs(Phase::Working, 0), t0, true);
        w.step(obs(ENDED, 1), &th, t0);
        assert!(w.step(obs(ENDED, 1), &th, t0 + secs(60)).is_some());
        w.snooze(t0 + secs(60 + 900));
        assert!(!w.active(), "a snoozed alert leaves the banner");
        assert_eq!(w.step(obs(ENDED, 1), &th, t0 + secs(900)), None);
        let again = w
            .step(obs(ENDED, 1), &th, t0 + secs(960))
            .expect("after snooze");
        assert_eq!(again.count, 2);
        assert!(w.active());
    }

    #[test]
    fn a_silent_working_turn_is_reported_stalled() {
        let t0 = Instant::now();
        let mut w = SessionWatch::new(obs(ENDED, 0), t0, true);
        // A turn starts at t0 and streams until t0+10.
        let mut o = Observation {
            phase: Phase::Working,
            epoch: 1,
            progress_at: Some(t0),
        };
        assert_eq!(w.step(o, &th(), t0), None);
        o.progress_at = Some(t0 + secs(10));
        assert_eq!(w.step(o, &th(), t0 + secs(10)), None);
        assert_eq!(w.step(o, &th(), t0 + secs(309)), None, "silent for 299 s");
        let fired = w.step(o, &th(), t0 + secs(310)).expect("stalled");
        assert_eq!(fired.kind, CriticalAlertKind::Stalled);
        assert_eq!(fired.since, t0 + secs(10));
        // Progress resumes: the stall is over, the banner goes.
        o.progress_at = Some(t0 + secs(320));
        assert_eq!(w.step(o, &th(), t0 + secs(320)), None);
        assert!(!w.active());
    }

    #[test]
    fn stall_detection_off_never_reports_a_stall() {
        let t0 = Instant::now();
        let th = Thresholds {
            stall: None,
            ..th()
        };
        let mut w = SessionWatch::new(obs(Phase::Working, 1), t0, false);
        assert_eq!(
            w.step(obs(Phase::Working, 1), &th, t0 + secs(100_000)),
            None
        );
        w.snooze(t0 + secs(100_001));
        assert_eq!(
            w.step(obs(Phase::Working, 1), &th, t0 + secs(100_002)),
            None
        );
    }

    #[test]
    fn a_held_turn_is_not_idle_but_stalls_without_background_progress() {
        let t0 = Instant::now();
        let mut w = SessionWatch::new(obs(Phase::Working, 1), t0, true);
        let mut o = Observation {
            phase: Phase::Background,
            epoch: 1,
            progress_at: Some(t0),
        };
        assert_eq!(w.step(o, &th(), t0 + secs(1)), None);
        // Background progress keeps it quiet well past the idle threshold.
        for n in 1..10u64 {
            o.progress_at = Some(t0 + secs(n * 100));
            assert_eq!(w.step(o, &th(), t0 + secs(n * 100 + 50)), None);
        }
        // Then the background work goes silent.
        let last = t0 + secs(900);
        assert_eq!(w.step(o, &th(), last + secs(299)), None);
        let fired = w
            .step(o, &th(), last + secs(300))
            .expect("background stalled");
        assert_eq!(fired.kind, CriticalAlertKind::BackgroundStalled);
    }

    #[test]
    fn acknowledged_on_start_means_no_alert_for_the_current_idle() {
        let t0 = Instant::now();
        let mut w = SessionWatch::new(obs(ENDED, 0), t0, true);
        assert_eq!(w.step(obs(ENDED, 0), &th(), t0 + secs(3600)), None);
        let mut w = SessionWatch::new(obs(INTERRUPTED, 0), t0, false);
        assert!(w.step(obs(INTERRUPTED, 0), &th(), t0 + secs(60)).is_some());
    }

    #[test]
    fn derive_phase_reads_attention_live_state_and_turn_state() {
        let prompting = LiveState {
            status: ConnectionStatus::Prompting,
            awaiting_background: false,
        };
        let held = LiveState {
            status: ConnectionStatus::Prompting,
            awaiting_background: true,
        };
        let connected = LiveState {
            status: ConnectionStatus::Connected,
            awaiting_background: false,
        };
        let running = Some(ConversationTurnState::Running);
        assert_eq!(derive_phase(true, Some(&prompting), running), NEEDS_YOU);
        assert_eq!(
            derive_phase(false, Some(&prompting), running),
            Phase::Working
        );
        assert_eq!(derive_phase(false, Some(&held), running), Phase::Background);
        assert_eq!(derive_phase(false, Some(&connected), running), ENDED);
        assert_eq!(derive_phase(false, None, running), Phase::Working);
        assert_eq!(
            derive_phase(
                false,
                Some(&connected),
                Some(ConversationTurnState::Interrupted)
            ),
            INTERRUPTED
        );
        assert_eq!(derive_phase(false, None, None), ENDED);
    }

    #[test]
    fn classify_separates_boundaries_from_progress() {
        assert_eq!(
            classify(&AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting
            }),
            Some(Signal::Boundary)
        );
        assert_eq!(
            classify(&AcpEvent::PermissionResolved {
                request_id: "r".into()
            }),
            Some(Signal::Boundary)
        );
        assert_eq!(
            classify(&AcpEvent::UsageUpdate { used: 1, size: 2 }),
            None,
            "usage frames are not progress"
        );
        assert_eq!(
            classify(&AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected
            }),
            None
        );
    }

    fn row(id: i32) -> WatchedRow {
        WatchedRow {
            conversation_id: id,
            folder_id: 7,
            agent_type: AgentType::ClaudeCode,
            title: Some(format!("session {id}")),
            stall_detection: true,
        }
    }

    #[test]
    fn registry_watches_marked_rows_and_publishes_the_active_set() {
        let mut r = CriticalRegistry::new("test");
        let t0 = Instant::now();
        let wall = Utc::now();
        // Startup pass: an interrupted session alerts, an idle one does not.
        r.sync_rows([row(1), row(2)]);
        assert!(r.step(1, INTERRUPTED, t0, wall).is_none());
        assert!(r.step(2, ENDED, t0, wall).is_none());
        r.finish_pass();
        assert!(r.watch(1).is_some() && r.watch(2).is_some());

        let alert = r
            .step(1, INTERRUPTED, t0 + IDLE, wall)
            .expect("interrupted alerts");
        assert_eq!(alert.kind, CriticalAlertKind::Interrupted);
        assert_eq!(alert.id, "test-c1-e0-n1");
        assert_eq!(alert.folder_id, 7);
        assert!(alert.sound);
        assert!(r.step(2, ENDED, t0 + IDLE, wall).is_none());
        assert_eq!(r.active_key(), vec![(1, "test-c1-e0-n1".to_string())]);

        // Ack clears the banner.
        r.ack(1);
        assert!(r.active_alerts().is_empty());

        // A session marked later is acknowledged as it stands.
        r.sync_rows([row(1), row(2), row(3)]);
        assert!(r.step(3, INTERRUPTED, t0, wall).is_none());
        assert!(r.step(3, INTERRUPTED, t0 + secs(3600), wall).is_none());

        // Unmarked rows drop out.
        r.sync_rows([row(2)]);
        assert!(r.watch(1).is_none() && r.watch(3).is_none());
    }

    #[test]
    fn registry_records_bus_signals_only_for_watched_sessions() {
        let mut r = CriticalRegistry::new("test");
        let t0 = Instant::now();
        let wall = Utc::now();
        r.sync_rows([row(1)]);
        r.step(1, Phase::Working, t0, wall);
        r.finish_pass();
        r.record(99, Signal::Boundary, t0);
        // The turn ends; a user message and the next turn's end land between
        // two passes, so the stretch restarts though both passes read idle.
        assert!(r.step(1, ENDED, t0 + secs(1), wall).is_none());
        r.record(1, Signal::Boundary, t0 + secs(30));
        r.record(1, Signal::Boundary, t0 + secs(40));
        assert!(r.step(1, ENDED, t0 + secs(41), wall).is_none());
        assert!(
            r.step(1, ENDED, t0 + secs(61), wall).is_none(),
            "timed from 41 s"
        );
        assert!(r.step(1, ENDED, t0 + secs(101), wall).is_some());
    }

    #[test]
    fn settings_sanitize_and_default() {
        let d = CriticalSessionSettings::default();
        assert_eq!((d.idle_secs, d.repeat_secs, d.stall_secs), (60, 300, 300));
        assert!(d.sound && !d.send_to_channel);
        let s = CriticalSessionSettings {
            idle_secs: 0,
            repeat_secs: 1,
            stall_secs: 0,
            ..d
        }
        .sanitized();
        assert_eq!((s.idle_secs, s.repeat_secs, s.stall_secs), (5, 5, 10));
        let off = CriticalSessionSettings {
            repeat_secs: 0,
            ..d
        }
        .sanitized();
        assert_eq!(off.thresholds(true).repeat, None, "0 means never repeat");
        assert_eq!(off.thresholds(false).stall, None, "per-session switch");
        let parsed: CriticalSessionSettings =
            serde_json::from_str(r#"{"idle_secs":10}"#).expect("partial settings parse");
        assert_eq!(parsed.idle_secs, 10);
        assert_eq!(parsed.repeat_secs, 300);
    }

    #[tokio::test]
    async fn settings_round_trip_through_app_metadata() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        assert_eq!(
            load_critical_settings(&db.conn).await,
            CriticalSessionSettings::default()
        );
        let saved = save_critical_settings(
            &db.conn,
            CriticalSessionSettings {
                idle_secs: 10,
                repeat_secs: 20,
                ..Default::default()
            },
        )
        .await
        .expect("save");
        assert_eq!(load_critical_settings(&db.conn).await, saved);
        assert_eq!(saved.repeat_secs, 20);
    }

    #[tokio::test]
    async fn mark_and_unmark_persist_and_broadcast_the_row() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
        use crate::web::event_bridge::{WebEventBroadcaster, CONVERSATION_CHANGED_EVENT};

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-critical-api").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let mut rx = broadcaster.subscribe();

        set_conversation_critical_core(&db.conn, &emitter, id, true, None)
            .await
            .expect("mark");
        let event = rx.try_recv().expect("the row is re-broadcast");
        assert_eq!(event.channel, CONVERSATION_CHANGED_EVENT);
        assert_eq!((*event.payload)["summary"]["critical"], true);
        assert_eq!((*event.payload)["summary"]["critical_stall"], true);
        let rows = conversation_service::list_critical(&db.conn)
            .await
            .expect("list");
        assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![id]);

        set_conversation_critical_core(&db.conn, &emitter, id, true, Some(false))
            .await
            .expect("stall off");
        let event = rx.try_recv().expect("re-broadcast");
        assert_eq!((*event.payload)["summary"]["critical_stall"], false);

        set_conversation_critical_core(&db.conn, &emitter, id, false, None)
            .await
            .expect("unmark");
        let event = rx.try_recv().expect("re-broadcast");
        assert_eq!((*event.payload)["summary"]["critical"], false);
        assert!(conversation_service::list_critical(&db.conn)
            .await
            .expect("list")
            .is_empty());

        assert!(
            set_conversation_critical_core(&db.conn, &emitter, 999_999, true, None)
                .await
                .is_err(),
            "an unknown conversation is an error"
        );
    }

    #[test]
    fn channel_message_names_the_session_and_the_kind() {
        let alert = CriticalAlert {
            id: "x".into(),
            conversation_id: 1,
            folder_id: 1,
            agent_type: AgentType::ClaudeCode,
            title: Some("Deploy fix".into()),
            kind: CriticalAlertKind::Stalled,
            since: Utc::now(),
            count: 1,
            fired_at: Utc::now(),
            sound: true,
        };
        let msg = channel_message(Lang::En, &alert);
        let title = msg.title.expect("title");
        assert!(title.starts_with('⚑'), "{title}");
        assert!(title.contains("Deploy fix"), "{title}");
        assert_eq!(msg.level, MessageLevel::Warning);
    }
}
