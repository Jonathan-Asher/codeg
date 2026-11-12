//! Pi's live structured channel: what a connection does with pi-acp's
//! `_meta.piAcp.*` (0.0.34-steering.6 and later, advertised in `initialize`
//! as `_meta.piAcp.capabilities`). Wire format: `~/.claude/plans/
//! pi-acp-live-wire.md`; the history side is `parsers/pi/fold.rs`.
//!
//! * **Runs Pi starts by itself** (`agentTurn`): a sub-agent finishing, a job
//!   exiting or any extension wakes Pi with no prompt in flight. Each becomes a
//!   real codeg turn — `StatusChanged(Prompting)` with the turn gate held,
//!   opened by the same "woken by" marker the history draws
//!   (`codeg.agentWake`), and closed by `TurnComplete` with Pi's own stop
//!   reason. Spinner, Stop (`session/cancel`), the session lists' running
//!   state, the review flag and the "finished" push all follow from that.
//! * **Cards**: a `subagent` launch's `subagentRun` and a `bgj_run`'s
//!   `backgroundJob` are reshaped into the history cards
//!   (`codeg.subagentRun`, `codeg.backgroundJob`, `parsers::pi::live`) on the
//!   call itself while its turn is open, and published as
//!   [`AcpEvent::ToolCard`] on every change from either carrier, so a card in
//!   an earlier turn (or already in history) updates in place.
//! * **Notices** (`customMessage`): folded into the cards they name as their
//!   "What the model saw" notes, read as wake reasons while a woken run has
//!   not said anything yet, and drawn as a System note only when displayed and
//!   unclaimed — the history's rules.
//! * **Compaction**: the shared compaction card (`_meta.contextCompaction`).
//!
//! Everything here is gated on the capabilities: an older pi-acp sends none of
//! these keys, and the connection behaves exactly as before.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use chrono::Utc;
use serde_json::{Map, Value};
use tokio::sync::RwLock;

use crate::acp::session_state::SessionState;
use crate::acp::types::{AcpEvent, ConnectionStatus};
use crate::models::agent::AgentType;
use crate::parsers::pi::live::{self, LiveNote, WakeTrigger, LIVE_NOTES_MAX};
use crate::web::event_bridge::{emit_with_state, EventEmitter};

/// Cards remembered per connection. A card is re-published on every change,
/// so forgetting an old one only stops its notes from accumulating.
const CARDS_MAX: usize = 256;
/// Ended agent turns remembered, so a late `ended` (or a notice naming one)
/// is not read as the current turn's.
const FINISHED_TURNS_MAX: usize = 32;
/// Title of the marker call opening a woken run (the history's tool name).
pub(crate) const AGENT_WAKE_TITLE: &str = "agent_wake";
/// Title of a live System note's call.
pub(crate) const SYSTEM_NOTE_TITLE: &str = "pi_notice";
/// Title of a compaction card's call (the one the other bridges use).
const COMPACTION_TITLE: &str = "Context compaction";

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/// What pi-acp's `initialize` advertised (`_meta.piAcp.capabilities`, each the
/// version of its shape) and whether it agreed to publish AIR async tasks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PiLiveCaps {
    pub agent_turns: bool,
    pub custom_messages: bool,
    pub subagents: bool,
    pub background_jobs: bool,
    pub compaction: bool,
    /// pi-acp echoed `_meta.jetbrains.air` with `asyncTasks`: its jobs, async
    /// runs and woken runs arrive as AIR async tasks too.
    pub async_tasks: bool,
}

impl PiLiveCaps {
    /// `None` for every other agent and for a pi-acp without the channel.
    pub fn from_init_meta(
        agent_type: AgentType,
        meta: Option<&Map<String, Value>>,
    ) -> Option<Self> {
        if agent_type != AgentType::Pi {
            return None;
        }
        let meta = meta?;
        let caps = meta.get("piAcp")?.get("capabilities")?.as_object()?;
        let on = |key: &str| {
            caps.get(key)
                .and_then(Value::as_u64)
                .is_some_and(|v| v >= 1)
        };
        let async_tasks = meta
            .get("jetbrains")
            .and_then(|j| j.get("air"))
            .and_then(|a| a.get("capabilities"))
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|c| c.as_str() == Some("asyncTasks")));
        Some(PiLiveCaps {
            agent_turns: on("agentTurns"),
            custom_messages: on("customMessages"),
            subagents: on("subagents"),
            background_jobs: on("backgroundJobs"),
            compaction: on("compaction"),
            async_tasks,
        })
    }
}

/// Whether a Pi tool call launches a sub-agent run: pi-acp's marker
/// (`_meta.piAcp.subagent.role == "run"`), the history pass's `is_launch`.
/// The connection titles such a call `agent`, so the Agent card takes it.
pub(crate) fn marks_subagent(agent_type: AgentType, meta: Option<&Map<String, Value>>) -> bool {
    agent_type == AgentType::Pi
        && meta
            .and_then(|m| m.get("piAcp"))
            .and_then(|p| p.get("subagent"))
            .and_then(|s| s.get("role"))
            .and_then(Value::as_str)
            == Some("run")
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-connection state
// ─────────────────────────────────────────────────────────────────────────────

/// The connection's view of Pi's live channel. Shared by the idle and turn
/// loops, like the rest of the per-connection live state.
#[derive(Default)]
pub(crate) struct PiLiveState {
    /// `Some` once `initialize` showed the channel; everything below is inert
    /// without it.
    pub(crate) caps: Option<PiLiveCaps>,
    /// The run Pi started by itself that codeg is showing as a turn.
    turn: Option<AgentTurn>,
    /// Agent turns already over for codeg (ended, stopped, or joined by a
    /// prompt before codeg showed them).
    finished: VecDeque<String>,
    /// How the open agent turn ended, for the loop to settle: it owns the
    /// permission queue `TurnComplete` drains.
    close: Option<TurnClose>,
    /// Run and job cards by the launch call's id, oldest first.
    cards: HashMap<String, Card>,
    card_order: VecDeque<String>,
    /// Calls not drawn: a workflow's child launches (the card's rows are
    /// them) and Pi's answers to a child's question (the card's row shows the
    /// answer).
    dropped: HashSet<String>,
    /// Compaction cards already opened.
    compactions: HashSet<String>,
    /// Notices that arrived while Pi was idle (no turn of any kind open): what
    /// the history pass counts as having woken the next run Pi starts by
    /// itself (`Scan::pending`).
    idle_notices: Vec<WakeTrigger>,
    /// Ids for live System notes.
    note_seq: u64,
}

struct AgentTurn {
    id: String,
    /// The marker call at the turn's head and the reasons it lists. `None`
    /// until a reason is known (a run that began with no notice has none).
    wake: Option<(String, Vec<WakeTrigger>)>,
    /// Pi has said or done something: notices from here on arrived mid-run
    /// and are not what woke it.
    output: bool,
}

/// How an agent turn ended, in codeg's stop-reason vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TurnClose {
    pub(crate) stop_reason: &'static str,
    /// Pi's own words when the run failed.
    pub(crate) error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CardKind {
    Run,
    Job,
}

struct Card {
    kind: CardKind,
    /// The last live card pi-acp sent.
    live: Option<Value>,
    /// The launch's arguments, from the first frame that carried them.
    args: Option<Value>,
    /// The launch result Pi got (the history's `launch` note).
    launch: Option<String>,
    notes: Vec<LiveNote>,
}

impl Card {
    fn new(kind: CardKind) -> Self {
        Card {
            kind,
            live: None,
            args: None,
            launch: None,
            notes: Vec::new(),
        }
    }

    fn all_notes(&self) -> Vec<LiveNote> {
        let mut notes = Vec::with_capacity(self.notes.len() + 1);
        if let Some(launch) = &self.launch {
            notes.push(LiveNote::new("launch", launch));
        }
        notes.extend(self.notes.iter().cloned());
        notes
    }

    /// The card's `_meta` in the history's shape, once pi-acp has sent one.
    fn meta(&self) -> Option<Value> {
        let live = self.live.as_ref()?;
        Some(match self.kind {
            CardKind::Run => live::run_meta(live, self.args.as_ref(), &self.all_notes()),
            CardKind::Job => live::job_meta(live),
        })
    }
}

impl PiLiveState {
    pub(crate) fn enabled(&self) -> bool {
        self.caps.is_some()
    }

    /// Whether a run Pi started by itself is showing as the current turn.
    pub(crate) fn agent_turn_open(&self) -> bool {
        self.turn.is_some()
    }

    /// How the agent turn ended, once, for the loop to settle.
    pub(crate) fn take_close(&mut self) -> Option<TurnClose> {
        self.close.take()
    }

    /// Stop: the open agent turn is over for codeg now (the loop ends it at
    /// once, as it does a prompt turn); its `ended` record is not waited for.
    pub(crate) fn cancel_turn(&mut self) -> bool {
        self.close = None;
        match self.turn.take() {
            Some(turn) => {
                self.finish(turn.id);
                true
            }
            None => false,
        }
    }

    /// A prompt turn starts. Nothing can admit one while an agent turn holds
    /// the gate, so this only tidies up after a missed `ended`.
    pub(crate) fn prompt_started(&mut self) {
        if let Some(turn) = self.turn.take() {
            self.finish(turn.id);
        }
        self.close = None;
        // The user spoke: what arrived before woke nothing.
        self.idle_notices.clear();
    }

    /// The agent said or did something in the open turn.
    pub(crate) fn note_output(&mut self) {
        if let Some(turn) = self.turn.as_mut() {
            turn.output = true;
        }
    }

    fn finish(&mut self, id: String) {
        if !self.finished.contains(&id) {
            self.finished.push_back(id);
            while self.finished.len() > FINISHED_TURNS_MAX {
                self.finished.pop_front();
            }
        }
    }

    fn card_mut(&mut self, id: &str, kind: CardKind) -> &mut Card {
        if !self.cards.contains_key(id) {
            self.cards.insert(id.to_string(), Card::new(kind));
            self.card_order.push_back(id.to_string());
            while self.card_order.len() > CARDS_MAX {
                if let Some(old) = self.card_order.pop_front() {
                    self.cards.remove(&old);
                }
            }
        }
        let card = self.cards.get_mut(id).expect("just inserted");
        // A notice can name a call before its card arrives; the card's own
        // shape decides what it is.
        if card.live.is_none() {
            card.kind = kind;
        }
        card
    }

    /// Whether a tool call is one codeg does not draw (see `dropped`). Called
    /// with each frame; the opening frame decides, later ones follow it.
    pub(crate) fn drops_call(
        &mut self,
        id: &str,
        title: Option<&str>,
        args: Option<&Value>,
    ) -> bool {
        if !self.enabled() {
            return false;
        }
        if self.dropped.contains(id) {
            return true;
        }
        // `<launch id>/<n>`: a workflow script's own `subagent_launch`, which
        // pi forwards as a call of its own. History has no such call; the
        // run's rows are those children.
        if let Some((anchor, _)) = id.rsplit_once('/') {
            if self
                .cards
                .get(anchor)
                .is_some_and(|card| card.kind == CardKind::Run)
            {
                self.dropped.insert(id.to_string());
                return true;
            }
        }
        // Pi's answer to a child's question, once the card shows the
        // question: the row shows the answer (the history pass's `answer`).
        if title == Some("subagent_supervisor")
            && args.and_then(|a| a.get("action")).and_then(Value::as_str) == Some("reply")
        {
            if let Some(request) = args.and_then(|a| a.get("replyTo")).and_then(Value::as_str) {
                if self.asked(request) {
                    self.dropped.insert(id.to_string());
                    return true;
                }
            }
        }
        false
    }

    /// Whether some run card shows question `request_id`.
    fn asked(&self, request_id: &str) -> bool {
        self.cards.values().any(|card| {
            card.live
                .as_ref()
                .and_then(|live| live.get("children"))
                .and_then(Value::as_array)
                .is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row.get("exchanges")
                            .and_then(Value::as_array)
                            .is_some_and(|exchanges| {
                                exchanges.iter().any(|e| {
                                    e.get("requestId").and_then(Value::as_str) == Some(request_id)
                                })
                            })
                    })
                })
        })
    }

    /// Rewrite one frame of a Pi tool call for its card: the live card in
    /// `_meta.piAcp` becomes the history card, and a run's input the
    /// history's (`subagent_type`, `description`, the arguments). `args` is
    /// the frame's own `rawInput`; `content` its result text, if any. Returns
    /// the card update to publish, when this frame carried one.
    pub(crate) fn decorate_call(
        &mut self,
        id: &str,
        args: Option<&Value>,
        raw_input: &mut Option<String>,
        meta: &mut Option<Value>,
        content: Option<&str>,
        status: Option<&str>,
    ) -> Option<AcpEvent> {
        if !self.enabled() {
            return None;
        }
        let Some(Value::Object(mut obj)) = meta.take() else {
            return None;
        };
        let Some(Value::Object(mut pi_acp)) = obj.remove("piAcp") else {
            *meta = Some(Value::Object(obj));
            return None;
        };
        let run = pi_acp.remove("subagentRun");
        let job = pi_acp.remove("backgroundJob");
        let launch = pi_acp
            .get("subagent")
            .and_then(|s| s.get("role"))
            .and_then(Value::as_str)
            == Some("run");
        let args = args.filter(|a| a.as_object().is_some_and(|o| !o.is_empty()));
        let terminal = matches!(status, Some("completed" | "failed"));

        let card_meta = if let Some(run) = run.filter(Value::is_object) {
            let card = self.card_mut(id, CardKind::Run);
            if card.args.is_none() {
                card.args = args.cloned();
            }
            if terminal && card.launch.is_none() {
                card.launch = content
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string);
            }
            card.live = Some(run);
            *raw_input = Some(
                live::run_input(card.live.as_ref().expect("set"), card.args.as_ref()).to_string(),
            );
            card.meta()
        } else if let Some(job) = job.filter(Value::is_object) {
            let card = self.card_mut(id, CardKind::Job);
            card.live = Some(job);
            card.meta()
        } else {
            if launch {
                // The marker came before any card (the opening frames carry
                // one; this keeps the call known for its child launches).
                let card = self.card_mut(id, CardKind::Run);
                if card.args.is_none() {
                    card.args = args.cloned();
                }
            }
            None
        };
        if !pi_acp.is_empty() {
            obj.insert("piAcp".to_string(), Value::Object(pi_acp));
        }
        if let Some(Value::Object(card)) = &card_meta {
            for (key, value) in card {
                obj.insert(key.clone(), value.clone());
            }
        }
        *meta = Some(Value::Object(obj));
        card_meta.map(|meta| AcpEvent::ToolCard {
            tool_call_id: id.to_string(),
            meta,
        })
    }

    /// A card that arrived on its own (`session_info_update`, after the
    /// launch's turn ended), as the update to publish.
    fn card_update(&mut self, kind: CardKind, live: &Value) -> Option<AcpEvent> {
        let id = live.get("toolCallId").and_then(Value::as_str)?.to_string();
        let card = self.card_mut(&id, kind);
        card.live = Some(live.clone());
        Some(AcpEvent::ToolCard {
            tool_call_id: id,
            meta: card.meta()?,
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// session_info_update
// ─────────────────────────────────────────────────────────────────────────────

/// What a `session_info_update` did that the caller acts on.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InfoOutcome {
    /// An agent turn opened: the caller resets its turn-scoped state.
    pub(crate) opened_turn: bool,
}

/// Apply Pi's live channel from one `session_info_update`'s `_meta`.
pub(crate) async fn on_session_info(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    pi: &mut PiLiveState,
    meta: Option<&Map<String, Value>>,
) -> InfoOutcome {
    let mut outcome = InfoOutcome::default();
    let Some(caps) = pi.caps else {
        return outcome;
    };
    let Some(pi_acp) = meta.and_then(|m| m.get("piAcp")).and_then(Value::as_object) else {
        return outcome;
    };
    if caps.agent_turns {
        if let Some(record) = pi_acp.get("agentTurn").filter(|r| r.is_object()) {
            outcome.opened_turn = agent_turn(state, emitter, pi, record).await;
        }
    }
    if caps.subagents {
        if let Some(run) = pi_acp.get("subagentRun").filter(|r| r.is_object()) {
            if let Some(event) = pi.card_update(CardKind::Run, run) {
                emit_with_state(state, emitter, event).await;
            }
        }
    }
    if caps.background_jobs {
        if let Some(job) = pi_acp.get("backgroundJob").filter(|r| r.is_object()) {
            if let Some(event) = pi.card_update(CardKind::Job, job) {
                emit_with_state(state, emitter, event).await;
            }
        }
    }
    if caps.custom_messages {
        if let Some(message) = pi_acp.get("customMessage").filter(|r| r.is_object()) {
            custom_message(state, emitter, pi, message).await;
        }
    }
    if caps.compaction {
        if let Some(record) = pi_acp.get("compaction").filter(|r| r.is_object()) {
            compaction(state, emitter, pi, record).await;
        }
    }
    outcome
}

/// codeg's stop reason for how an agent turn ended. Pi's `error` (after its
/// own retries) is the same failure a prompt turn reports as `rejected`.
fn stop_reason(stop: Option<&str>, end: Option<&str>) -> &'static str {
    match stop {
        Some("end_turn") => "end_turn",
        Some("max_tokens") => "max_tokens",
        Some("refusal") => "refusal",
        Some("cancelled") => "cancelled",
        Some("error") => "rejected",
        _ => match end {
            Some("cancelled" | "processExited") => "cancelled",
            _ => "end_turn",
        },
    }
}

async fn agent_turn(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    pi: &mut PiLiveState,
    record: &Value,
) -> bool {
    // A replayed run (`session/load`) is history, not a turn.
    if record.get("replay").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let Some(id) = record.get("id").and_then(Value::as_str).map(str::to_string) else {
        return false;
    };
    match record.get("state").and_then(Value::as_str) {
        Some("running") => {
            if pi.turn.is_some() || pi.finished.contains(&id) {
                return false;
            }
            // Claim the turn gate in the same critical section the prompt
            // path checks it in: whichever comes first owns the turn. A
            // prompt already admitted joins this run in pi-acp (it is
            // steered in), so its own turn shows the run.
            let claimed = {
                let mut s = state.write().await;
                if s.turn_in_flight || s.status == ConnectionStatus::Prompting {
                    false
                } else {
                    s.turn_in_flight = true;
                    // Pi's own clock, the one its transcript is stamped with.
                    s.pi_agent_turn_started_at = Some(
                        record
                            .get("startedAt")
                            .and_then(Value::as_i64)
                            .and_then(chrono::DateTime::from_timestamp_millis)
                            .unwrap_or_else(Utc::now),
                    );
                    true
                }
            };
            if !claimed {
                tracing::info!(
                    "[ACP][pi] a prompt is in flight; run {id} Pi started itself joins it"
                );
                pi.finish(id);
                return false;
            }
            tracing::info!("[ACP][pi] Pi started a run by itself; showing it as a turn ({id})");
            emit_with_state(
                state,
                emitter,
                AcpEvent::StatusChanged {
                    status: ConnectionStatus::Prompting,
                },
            )
            .await;
            // What woke it, as the history marker lists it: the notices that
            // arrived while Pi was idle, then the run's own (its text follows
            // in a `customMessage`). A trigger the history would skip (a
            // hidden notice that is not a run's result) is left out.
            let trigger = record.get("trigger");
            let field = |key: &str| trigger.and_then(|t| t.get(key));
            let skipped = live::is_skipped_hidden(
                field("customType").and_then(Value::as_str).unwrap_or(""),
                field("hidden").and_then(Value::as_bool) == Some(true),
            );
            let mut triggers = std::mem::take(&mut pi.idle_notices);
            if let Some(kind) = field("kind")
                .and_then(Value::as_str)
                .and_then(live::wake_kind_of_trigger)
                .filter(|_| !skipped)
            {
                triggers.push(WakeTrigger {
                    kind,
                    text: String::new(),
                });
            }
            let mut turn = AgentTurn {
                id: id.clone(),
                wake: None,
                output: false,
            };
            if !triggers.is_empty() {
                let wake_id = format!("pi-wake-{id}");
                emit_with_state(state, emitter, wake_call(&wake_id, &triggers)).await;
                turn.wake = Some((wake_id, triggers));
            }
            pi.turn = Some(turn);
            true
        }
        Some("ended") => {
            if pi.turn.as_ref().map(|t| t.id.as_str()) != Some(id.as_str()) {
                // Already over for codeg (Stop), or one it never showed.
                pi.finish(id);
                return false;
            }
            pi.turn = None;
            pi.finish(id);
            let end = record.get("endReason").and_then(Value::as_str);
            if end == Some("promptJoined") {
                // The prompt that joined it owns the rest of the run.
                return false;
            }
            let stop = record.get("stopReason").and_then(Value::as_str);
            let reason = stop_reason(stop, end);
            pi.close = Some(TurnClose {
                stop_reason: reason,
                error: (reason == "rejected").then(|| {
                    record
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .unwrap_or("Pi stopped with an error")
                        .to_string()
                }),
            });
            false
        }
        _ => false,
    }
}

fn wake_call(wake_id: &str, triggers: &[WakeTrigger]) -> AcpEvent {
    AcpEvent::ToolCall {
        tool_call_id: wake_id.to_string(),
        title: AGENT_WAKE_TITLE.to_string(),
        kind: "other".to_string(),
        status: "completed".to_string(),
        content: None,
        raw_input: None,
        raw_output: None,
        locations: None,
        meta: Some(live::wake_meta(triggers)),
        images: None,
    }
}

fn meta_update(id: &str, meta: Value) -> AcpEvent {
    AcpEvent::ToolCallUpdate {
        tool_call_id: id.to_string(),
        title: None,
        status: None,
        content: None,
        raw_input: None,
        raw_output: None,
        raw_output_append: None,
        locations: None,
        meta: Some(meta),
        images: None,
    }
}

async fn custom_message(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    pi: &mut PiLiveState,
    message: &Value,
) {
    // Already shown as the extension command's reply text.
    if message.get("commandReply").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let custom_type = message
        .get("customType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hidden = message.get("hidden").and_then(Value::as_bool) == Some(true)
        || message.get("display").and_then(Value::as_bool) == Some(false);
    let legacy_job = message
        .get("details")
        .and_then(|d| d.get("legacyJobReport"))
        .is_some_and(|r| !r.is_null());
    if live::is_skipped_hidden(custom_type, hidden) && !legacy_job {
        return;
    }
    let text = message.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return;
    }
    let prompting = state.read().await.status == ConnectionStatus::Prompting;

    // Pi is idle: whatever wakes it next, this notice is part of it.
    if pi.turn.is_none() && !prompting && pi.idle_notices.len() < LIVE_NOTES_MAX {
        pi.idle_notices.push(WakeTrigger {
            kind: live::wake_kind(custom_type, legacy_job),
            text: text.to_string(),
        });
    }

    // What woke the run, while it has not said anything yet. A notice naming
    // a turn codeg never saw belongs to the current one.
    let turn_id = message.get("agentTurnId").and_then(Value::as_str);
    let for_turn = match (&pi.turn, turn_id) {
        (Some(turn), Some(id)) => turn.id == id || !pi.finished.iter().any(|f| f == id),
        (Some(_), None) => true,
        (None, _) => false,
    };
    if for_turn {
        if let Some(turn) = pi.turn.as_mut().filter(|t| !t.output) {
            let kind = live::wake_kind(custom_type, legacy_job);
            let event = match turn.wake.as_mut() {
                Some((wake_id, triggers)) => {
                    match triggers.iter_mut().find(|t| t.text.is_empty()) {
                        Some(first) => {
                            first.kind = kind;
                            first.text = text.to_string();
                        }
                        None => triggers.push(WakeTrigger {
                            kind,
                            text: text.to_string(),
                        }),
                    }
                    meta_update(wake_id, live::wake_meta(triggers))
                }
                None => {
                    let triggers = vec![WakeTrigger {
                        kind,
                        text: text.to_string(),
                    }];
                    let wake_id = format!("pi-wake-{}", turn.id);
                    let event = wake_call(&wake_id, &triggers);
                    turn.wake = Some((wake_id, triggers));
                    event
                }
            };
            emit_with_state(state, emitter, event).await;
        }
    }

    // Folded into the cards it reports on.
    let ids: Vec<String> = message
        .get("toolCallIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let note_kind = live::note_kind(custom_type);
    for id in &ids {
        let is_job = custom_type == "bg-job-exit" || legacy_job;
        let card = pi.card_mut(id, if is_job { CardKind::Job } else { CardKind::Run });
        // A job's card carries its exit notice itself.
        if card.kind != CardKind::Run {
            continue;
        }
        let Some(kind) = note_kind else {
            continue;
        };
        if card.notes.len() < LIVE_NOTES_MAX {
            card.notes.push(LiveNote::new(kind, text));
        }
        if let Some(meta) = card.meta() {
            emit_with_state(
                state,
                emitter,
                AcpEvent::ToolCard {
                    tool_call_id: id.clone(),
                    meta,
                },
            )
            .await;
        }
    }

    // A displayed notice no card claims reads as the history reads it: a
    // System note, in the turn it arrived in.
    if ids.is_empty() && !hidden && prompting {
        pi.note_seq += 1;
        let id = format!("pi-note-{}-{}", Utc::now().timestamp_millis(), pi.note_seq);
        emit_with_state(
            state,
            emitter,
            AcpEvent::ToolCall {
                tool_call_id: id,
                title: SYSTEM_NOTE_TITLE.to_string(),
                kind: "other".to_string(),
                status: "completed".to_string(),
                content: None,
                raw_input: None,
                raw_output: None,
                locations: None,
                meta: Some(live::system_note_meta(custom_type, text)),
                images: None,
            },
        )
        .await;
    }
}

async fn compaction(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    pi: &mut PiLiveState,
    record: &Value,
) {
    if record.get("replay").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(card) = live::compaction(record) else {
        return;
    };
    // A card belongs to a turn; one between turns would be grafted onto the
    // last turn's message. The transcript has it either way.
    if state.read().await.status != ConnectionStatus::Prompting {
        return;
    }
    let event = if pi.compactions.insert(card.id.clone()) {
        AcpEvent::ToolCall {
            tool_call_id: card.id,
            title: COMPACTION_TITLE.to_string(),
            kind: "other".to_string(),
            status: card.status.to_string(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: Some(card.meta),
            images: None,
        }
    } else {
        AcpEvent::ToolCallUpdate {
            tool_call_id: card.id,
            title: Some(COMPACTION_TITLE.to_string()),
            status: Some(card.status.to_string()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: Some(card.meta),
            images: None,
        }
    };
    emit_with_state(state, emitter, event).await;
}

#[cfg(test)]
mod tests;
