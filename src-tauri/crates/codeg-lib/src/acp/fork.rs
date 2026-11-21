//! ACP `session/fork` support.
//!
//! The request is the schema's typed `ForkSessionRequest` (behind
//! `unstable_session_fork`). It goes out untyped for the one reason
//! `session/new` and `session/resume` do: grok's top-level `models` has no field
//! on the typed response, so [`send_capturing_models`] reads it off the raw
//! reply first.

use agent_client_protocol::schema::v1::{
    ForkSessionRequest, ForkSessionResponse, McpServer, Meta, SessionId, AGENT_METHOD_NAMES,
};
use agent_client_protocol::{Agent, ConnectionTo};
use serde::Deserialize;

use crate::acp::connection::{
    agent_error_text, claude_raw_sdk_session_meta, send_capturing_models, ClaudeSessionOptions,
};

use crate::acp::error::AcpError;
use crate::commands::conversations::{is_pi_wake_turn, pi_agent_turn_marker_since};
use crate::models::agent::AgentType;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// Where in the history to fork, for the agents that can honour it.
///
/// Rides as `_meta.jetbrains.air.fork` on `session/fork`. Every adapter that
/// implements it reads the same block and they all fall back to forking at the
/// TAIL when it is absent, so omitting this is always the old behaviour.
///
/// They resolve it differently, which is why all three halves exist:
///
/// * **claude-agent-acp 0.75.1** resolves in three levels: `message_id` against
///   the live id map, then against `messageIdForGrouping` (the API message id,
///   else the record uuid) along the ACTIVE parentUuid chain, then — new in
///   0.75.1 — against the full persisted transcript INCLUDING abandoned
///   branches, where a failed id finally falls through to the fingerprint. Up
///   to 0.74.0 it ignored the fingerprint entirely, so codeg sent the id alone;
///   from 0.75.1 both halves are sent, which is what turns a fork point on an
///   abandoned branch from a silent tail-fork into an exact hit.
///   `crate::parsers::claude` derives the id into
///   [`crate::models::MessageTurn::agent_message_id`], and the hash side is
///   byte-compatible with what `fingerprint_agent_message` computes (a single
///   fingerprint match even wins regardless of occurrence).
/// * **codex-acp** (1.8.0 through 2.8.0) reads codex's own history
///   (`thread/read`) and forks a whole codex TURN: the one holding the named
///   item. It first matches `message_id` against the id of every item of
///   every turn, then hashes the text of each `agentMessage` item ON ITS OWN
///   and takes the `message_occurrence`-th match, counted across all the
///   session's agent messages. A codex 2.x turn holds several agent messages
///   (`commentary` between tool calls, then a `final_answer`), so both halves
///   have to name ONE message as codex holds it — see [`codex_fork_point`].
///   Recent codex rollouts record each agent message's item id (and
///   codex keeps it in `thread/read` and in every fork of the thread), which
///   `crate::parsers::codex` puts in
///   [`crate::models::MessageTurn::agent_message_id`]; older rollouts record
///   none, and there the fingerprint is the only half that resolves.
/// * **deepseek-acp 0.8.0** is the only one that can use BOTH halves, so codeg
///   sends both. Its id side accepts either the wire id it stamps on message
///   chunks (`<turn>:<step>`) or the session log's own `message.id`, and
///   `crate::parsers::deepseek` records the latter. Its fingerprint side hashes
///   the history TWICE — once per assistant message, once per whole turn — and
///   refuses (`invalid_params`) when the two land on different turns; codeg
///   renders one bubble per log turn, so the per-turn reading is the one that
///   matches, and the id is what keeps the ambiguous case from ever being
///   reached.
///
/// All three strip a trailing `:segment:<n>` before matching, so ids must not
/// carry one.
#[derive(Debug, Clone)]
pub struct ForkPoint {
    pub message_id: String,
    pub message_fingerprint: Option<String>,
    /// 1-based index among agent messages sharing the same fingerprint.
    pub message_occurrence: Option<u32>,
}

/// `sha256:<64 lowercase hex>` of `text`, the shape codex-acp compares against.
pub fn fingerprint_agent_message(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

/// This turn's agent text, as one string — what codex fingerprints.
fn turn_text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// 1-based index of `turns[idx]` among the assistant turns sharing its
/// fingerprint — what both fingerprint-matching adapters count, so an answer
/// repeated verbatim earlier in the session still forks at the right one.
///
/// Assistant turns only: both hash agent messages, so a user turn with
/// identical text must not shift the count.
fn fingerprint_occurrence(turns: &[MessageTurn], idx: usize, fingerprint: &str) -> usize {
    turns[..idx]
        .iter()
        .filter(|t| {
            matches!(t.role, TurnRole::Assistant)
                && fingerprint_agent_message(&turn_text(t)) == fingerprint
        })
        .count()
        + 1
}

/// Build the fork point naming `turn_id`, or `None` when this agent/turn cannot
/// be named — in which case the caller forks at the tail, as before.
///
/// Only ASSISTANT turns are fork points: every adapter resolves the point
/// against an agent message, and "continue from my own prompt" is already what
/// a plain fork-send does.
pub fn resolve_fork_point(
    turns: &[MessageTurn],
    turn_id: &str,
    agent_type: AgentType,
) -> Option<ForkPoint> {
    let idx = turns
        .iter()
        .position(|t| t.id == turn_id && matches!(t.role, TurnRole::Assistant))?;
    let turn = &turns[idx];

    match agent_type {
        AgentType::Codex => codex_fork_point(turns, idx),
        // DeepSeek and Claude 0.75.1 both read the two halves in the same
        // order, so both are sent. The id resolves on its own whenever the
        // transcript named the message, and the fingerprint is what still
        // resolves when it did not — a DeepSeek log written without an `id` or
        // a parse that began mid-log; on Claude, a fork point that has drifted
        // off the active parentUuid chain onto an abandoned branch. Sending the
        // fingerprint alongside an id costs nothing: both adapters stop at the
        // first id that matches and never look at it.
        //
        // Pi: `parsers::pi` names each assistant turn by its session entry
        // id, which pi-acp 0.0.34-steering.3+ looks up directly; the
        // fingerprint (the text of that assistant message, which is the
        // turn's text) is what still resolves a turn parsed without an id.
        // Older pi-acp builds read only the fingerprint and forked at the
        // tail on a miss — see [`fork_capabilities`].
        //
        // The `text.trim().is_empty()` guard below is load-bearing on Claude,
        // not just tidiness. Every turn `parsers::claude` leaves unnamed is one
        // codeg SYNTHESIZED with no text of its own (a `/goal` marker, a bare
        // top-level `tool_use`, a bare `tool_result`); `fingerprint("")` would
        // match every text-free grouping on the agent's side at once and then
        // pick between them by occurrence, forking somewhere arbitrary. A tail
        // fork is the honest answer for those.
        AgentType::ClaudeCode | AgentType::DeepSeek | AgentType::Pi => {
            let text = turn_text(turn);
            let fingerprint = (!text.trim().is_empty()).then(|| fingerprint_agent_message(&text));
            // Neither half can name this turn — an assistant bubble opened by a
            // tool result alone, with no message of its own to point at.
            if turn.agent_message_id.is_none() && fingerprint.is_none() {
                return None;
            }
            let occurrence = fingerprint
                .as_ref()
                .map(|fp| fingerprint_occurrence(turns, idx, fp));
            Some(ForkPoint {
                // Same reasoning as codex when the transcript named nothing:
                // the field is required, and codeg's own turn id (`turn-<n>`,
                // a position, never a record uuid) is deliberately something
                // neither adapter will find, which is what makes it fall
                // through to the fingerprint.
                message_id: turn
                    .agent_message_id
                    .clone()
                    .unwrap_or_else(|| turn_id.to_string()),
                message_fingerprint: fingerprint,
                message_occurrence: occurrence.and_then(|n| u32::try_from(n).ok()),
            })
        }
        // Every other agent either has no `session/fork` or no fork point in
        // it; forking at the tail is the honest fallback.
        _ => None,
    }
}

/// The agent message a Codex fork point names for the reply at `turns[idx]`,
/// the way codex-acp resolves it (see [`ForkPoint`]): ONE message, by codex's
/// item id when the rollout recorded one (codeg's own turn id otherwise, which
/// codex never finds), and by the fingerprint of that message's text, whose
/// occurrence is counted among every agent message up to it, not among turns.
///
/// The parse gives each agent message a turn of its own
/// (`parsers::codex::group_into_turns`), with codex's text for it: a final
/// answer citing codex's memories is shown, and hashed, without the
/// `<oai-mem-citation>` block its rollout record keeps. Each text block still
/// counts as one message, should a turn ever hold two.
///
/// codex forks the whole codex turn holding the message, so any message of
/// the turn this reply ends lands the fork in the same place. The reply's own
/// message is named when it has one. A reply that ends in tool calls — a turn
/// stopped before its answer, a plan followed by its review — names the latest
/// message before it in the same reply, never one past the user message that
/// opened the reply, which would belong to an earlier codex turn. `None` when
/// the reply holds no message: codex has nothing in it to name, and the caller
/// must not guess (see [`ForkMode::Edit`]).
fn codex_fork_point(turns: &[MessageTurn], idx: usize) -> Option<ForkPoint> {
    let opened = turns[..=idx]
        .iter()
        .rposition(|t| matches!(t.role, TurnRole::User))
        .map_or(0, |user| user + 1);
    let named = (opened..=idx).rev().find(|&i| {
        let t = &turns[i];
        matches!(t.role, TurnRole::Assistant)
            && (t.agent_message_id.is_some() || codex_message_texts(t).next().is_some())
    })?;
    let turn = &turns[named];
    let fingerprint = codex_message_texts(turn)
        .last()
        .map(fingerprint_agent_message);
    // codex-acp lists every agent message of every turn in order and takes the
    // n-th whose hash matches; the named message is the last text up to here.
    let occurrence = fingerprint.as_deref().map(|fp| {
        turns[..=named]
            .iter()
            .filter(|t| matches!(t.role, TurnRole::Assistant))
            .flat_map(codex_message_texts)
            .filter(|text| fingerprint_agent_message(text) == fp)
            .count()
    });
    Some(ForkPoint {
        message_id: turn
            .agent_message_id
            .clone()
            .unwrap_or_else(|| turn.id.clone()),
        message_fingerprint: fingerprint,
        message_occurrence: occurrence.and_then(|n| u32::try_from(n).ok()),
    })
}

/// The agent messages a parsed Codex turn shows, in order: its non-blank text
/// blocks. A blank one hashes like every other blank message, so it names
/// nothing.
fn codex_message_texts(turn: &MessageTurn) -> impl Iterator<Item = &str> {
    turn.blocks.iter().filter_map(|block| match block {
        ContentBlock::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
        _ => None,
    })
}

/// Why an edit cannot fork at the reply `turn_id` names, for the user. Shown
/// after "Couldn't edit the message:".
fn unresolved_edit_reason(turns: &[MessageTurn], turn_id: &str, agent_type: AgentType) -> String {
    let reply_is_there = turns
        .iter()
        .any(|t| t.id == turn_id && matches!(t.role, TurnRole::Assistant));
    if reply_is_there && agent_type == AgentType::Codex {
        return CODEX_REPLY_WITHOUT_MESSAGE.to_string();
    }
    "the agent cannot fork at the reply before this message".to_string()
}

/// Whether the message an edit forking at `turn_id` rewrites — the first user
/// turn after that reply — is one the user steered into a running Codex turn
/// (the parser marks it, see `MessageTurn::agent_message_id`).
///
/// codex forks whole turns: a fork at the reply before such a message ends
/// where that turn ends, AFTER the message and everything Codex did with it,
/// so the edit would land in the wrong place without a word. Refused instead.
fn edits_a_steered_codex_message(
    turns: &[MessageTurn],
    turn_id: &str,
    agent_type: AgentType,
) -> bool {
    if agent_type != AgentType::Codex {
        return false;
    }
    turns
        .iter()
        .skip_while(|t| t.id != turn_id)
        .find(|t| matches!(t.role, TurnRole::User))
        .is_some_and(|edited| edited.agent_message_id.is_some())
}

/// The message an edit rewrites was steered into a running Codex turn
/// ([`edits_a_steered_codex_message`]).
const CODEX_STEERED_MESSAGE: &str = "this message was sent while Codex was still working, and \
     Codex can only go back to the end of a turn, so it can't be edited on its own. Edit the \
     message that started that turn instead. Nothing was changed.";

/// A Codex reply with no agent message in it ([`codex_fork_point`]).
const CODEX_REPLY_WITHOUT_MESSAGE: &str = "the reply before it has no message from Codex to go \
     back to (that turn ended before Codex wrote one), so Codex can't continue from there. \
     Nothing was changed.";

/// codex-acp could not find the point codeg named in its own history.
const CODEX_POINT_NOT_FOUND: &str = "Codex couldn't find that reply in its own history of \
     the session, so it can't continue from there. Nothing was changed.";

/// Whether codex-acp refused a `session/fork` because the AIR fork point
/// names nothing in the session (`resolveForkTurnId`: `invalid_params`, "Fork
/// point message … was not found in session …").
fn is_codex_fork_point_miss(e: &agent_client_protocol::Error) -> bool {
    matches!(
        e.code,
        agent_client_protocol::schema::v1::ErrorCode::InvalidParams
    ) && e.to_string().contains("Fork point message")
}

/// What a fork is for. Decides what happens when the chosen fork point cannot
/// be named, how the two rows the fork leaves behind are titled, and which of
/// them keeps the critical mark.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkMode {
    /// "Fork from here": branch the conversation at a reply. A point the agent
    /// cannot name degrades to a tail fork rather than refusing the click, and
    /// the forked row is marked `[Fork]`. The fork is an exploration, so a
    /// critical mark stays with the original — on the sibling that now holds
    /// it — and the forked row starts unmarked.
    #[default]
    Branch,
    /// "Edit message", keeping the original as a separate conversation: fork
    /// at the reply just BEFORE a message the user is rewriting, then send the
    /// edited text there. The fork has to end exactly at that reply — a tail
    /// fork still holds the message being replaced, so the edit would continue
    /// the wrong conversation — which makes a point that cannot be named an
    /// error, never a fallback. The forked row keeps its title (it IS the
    /// conversation being edited), locked so a title the forked transcript
    /// carries can't replace it, and the sibling that preserves the original
    /// branch is named `<title> (before edit)`. The forked row keeps a
    /// critical mark too, for the same reason; the sibling starts unmarked.
    Edit,
    /// "Edit message", continuing in place — the default. Everything
    /// [`ForkMode::Edit`] does, except that the sibling holding the original
    /// branch is born soft-deleted: the user sees ONE conversation, the same
    /// row (same id, tab, pin, folder, selectors and title) now running on
    /// the forked session.
    ///
    /// The agent session id still changes — no adapter can rewind a session
    /// in place over ACP (claude-agent-acp keeps the SDK's `resumeSessionAt`
    /// to itself, and every edit-capable adapter's fork writes a NEW session)
    /// — so what this hides is the id change, not the fork.
    ///
    /// The hidden row is what keeps the original recoverable rather than
    /// destroyed. It still holds the old session id, so the unique
    /// `(external_id, agent_type)` index stops anything from re-binding or
    /// re-importing it as a new conversation, and the import picker lists it
    /// as a deleted conversation it can restore. The agent's own transcript
    /// is never touched.
    EditInPlace,
}

impl ForkMode {
    /// Either kind of edit: both fork strictly and title the rows the same
    /// way; they differ only in whether the original stays visible.
    pub fn is_edit(self) -> bool {
        matches!(self, ForkMode::Edit | ForkMode::EditInPlace)
    }
}

/// Whether this agent's adapter forks EXACTLY at a named message or refuses —
/// the only kind of fork an edit can be built on.
///
/// The `ClaudeCode`, `Codex` and `DeepSeek` adapters all answer
/// `invalid_params` when they cannot resolve the point, on every version codeg
/// runs. pi-acp does too from the build that advertises it
/// ([`fork_capabilities`]); older builds forked at the tail when nothing
/// matched, so a miss there looked exactly like a hit. Every other agent has
/// no fork point at all.
pub fn honours_fork_point_strictly(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::ClaudeCode | AgentType::Codex | AgentType::DeepSeek)
}

/// What the adapter on a connection promises about `session/fork`, settled
/// once at `initialize` by [`fork_capabilities`] and kept on the session state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ForkCapabilities {
    /// Forks exactly at a named reply or refuses: what an edit needs.
    pub strict_point: bool,
    /// Forks from a separate process while the session runs a turn.
    pub while_running: bool,
}

impl ForkCapabilities {
    /// What codeg knows of this agent's adapter without asking it.
    pub fn built_in(agent_type: AgentType) -> Self {
        Self {
            strict_point: honours_fork_point_strictly(agent_type),
            while_running: forks_while_running(agent_type),
        }
    }
}

/// The capabilities of the adapter that answered `initialize`, given the
/// response's top-level `_meta`.
///
/// On top of [`ForkCapabilities::built_in`], pi-acp says what its own build
/// does: from 0.0.34-steering.3 (github.com/Jonathan-Asher/pi-acp) it
/// advertises `_meta.forkPoint = { strict: true, whileRunning: true }`. That
/// build writes the fork from the session file itself, ending exactly at the
/// named reply (its tool results included), refuses a point it cannot find,
/// and never opens the source session in a pi process, so a session another
/// process is appending to can be forked. The flag is read only for Pi: launch
/// prefers a PATH-resolved install, so the running build is the one to ask,
/// and no other adapter uses the key.
pub fn fork_capabilities(
    agent_type: AgentType,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> ForkCapabilities {
    let mut caps = ForkCapabilities::built_in(agent_type);
    if matches!(agent_type, AgentType::Pi) {
        let advertised = |key: &str| {
            meta.and_then(|m| m.get("forkPoint"))
                .and_then(|f| f.get(key))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        caps.strict_point |= advertised("strict");
        caps.while_running |= advertised("whileRunning");
    }
    caps
}

/// The agent a fork is settled for, with what its adapter can do. An
/// [`AgentType`] alone converts with [`ForkCapabilities::built_in`].
#[derive(Debug, Clone, Copy)]
pub struct ForkAdapter {
    pub agent_type: AgentType,
    pub caps: ForkCapabilities,
}

impl From<AgentType> for ForkAdapter {
    fn from(agent_type: AgentType) -> Self {
        Self {
            agent_type,
            caps: ForkCapabilities::built_in(agent_type),
        }
    }
}

/// Settle where a fork aimed at `turn_id` lands, given the conversation's
/// parsed turns — or why they could not be read.
///
/// `Ok(None)` is a tail fork. [`ForkMode::Branch`] degrades to it whenever the
/// point cannot be named, as "fork from here" always has; an edit (either
/// kind, see [`ForkMode::is_edit`]) refuses instead, for the reason given on
/// [`ForkMode::Edit`].
pub fn settle_fork_point(
    turns: Result<&[MessageTurn], &str>,
    turn_id: &str,
    adapter: impl Into<ForkAdapter>,
    mode: ForkMode,
) -> Result<Option<ForkPoint>, AcpError> {
    let ForkAdapter { agent_type, caps } = adapter.into();
    let strict = mode.is_edit();
    if strict && !caps.strict_point {
        return Err(AcpError::ForkPointUnresolved(format!(
            "{agent_type} cannot fork a session at a chosen message"
        )));
    }
    match turns {
        Ok(turns) => match resolve_fork_point(turns, turn_id, agent_type) {
            Some(_) if strict && edits_a_steered_codex_message(turns, turn_id, agent_type) => Err(
                AcpError::ForkPointUnresolved(CODEX_STEERED_MESSAGE.to_string()),
            ),
            Some(point) => Ok(Some(point)),
            // Not found, or found but with nothing the agent could match it by
            // (see `resolve_fork_point`) — either way there is no exact point.
            None if strict => Err(AcpError::ForkPointUnresolved(unresolved_edit_reason(
                turns, turn_id, agent_type,
            ))),
            None => Ok(None),
        },
        Err(reason) if strict => Err(AcpError::ForkPointUnresolved(format!(
            "the conversation could not be read ({reason})"
        ))),
        Err(_) => Ok(None),
    }
}

/// Whether "fork from here" can run while a turn is in flight on the session,
/// by forking in a SEPARATE agent process into a new conversation (see
/// `ConnectionManager::fork_session_to_new_conversation`) instead of
/// re-pointing the live connection, which has to wait for the turn to end.
///
/// That needs an adapter whose `session/fork` reads the parent session from
/// disk without opening it, tolerates the parent's transcript being appended
/// to by the other process mid-read, and never writes to it. Verified per
/// adapter against the versions codeg ships:
///
/// * **claude-agent-acp** (0.81.1 pinned, 0.84.0 installed — `fork-session.js`
///   is byte-identical in both): `unstable_forkSession` needs no live session.
///   It resolves the point through `getSessionMessages` (the transcript on
///   disk), then the SDK's `forkSession(id, {dir, upToMessageId})` reads the
///   JSONL into one buffer, parses it line by line with every unparsable line
///   skipped (`try { JSON.parse } catch {}` — a half-written tail line is
///   dropped, not fatal), keeps the entries up to the named message, and
///   writes them under a NEW session id as a new file. The parent's file is
///   only ever read. A COMPLETED reply's entries were flushed before the next
///   prompt was, so the fork point always lies before the partial tail.
/// * **codex-acp** (1.13.1): its fork goes through codex's own app-server
///   (`thread/read` to find the point, then `thread/fork`). The rollout
///   reader skips a torn JSON line, but codex core's fork preparation
///   (`thread-store/src/local/paginated_fork.rs`) also materializes the
///   SOURCE rollout into the shared `~/.codex` state database, guarded only by
///   in-process locks, while the live turn's app-server — another process —
///   keeps appending to that rollout and materializing it itself. Not shown
///   safe, so not enabled.
/// * **deepseek-acp** (0.9.0): refuses a fork of a session with a prompt in
///   flight in its own process, and the cross-process read goes through the
///   dsh session store, which it does not ship in source. Not verified, not
///   enabled.
///
/// * **pi-acp** from 0.0.34-steering.3 says so itself, at `initialize`
///   ([`fork_capabilities`]): it writes the fork from the session file,
///   skipping a half-written tail line, and never opens the source in pi. The
///   builds before it opened the source session in a second pi process, which
///   can append to the file on startup.
///
/// Every other agent forks at the tail at best, and a tail fork taken mid-turn
/// would copy the half-written reply — never offered.
pub fn forks_while_running(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::ClaudeCode)
}

/// Where the running turn starts in `turns`: the turn `in_flight_turn_id`
/// names, else the last user turn. `None` when neither is there.
///
/// The id is the one the detail endpoint reports for the same transcript as
/// `in_flight_user_turn_id`:
///
/// * a turn codeg sent: its prompt, when the caller matched it;
/// * a run Pi started by itself, which has no prompt
///   (`commands::conversations::pi_agent_turn_anchor`): the "woken by" System
///   turn history opens the run with, or, before Pi has written the run's
///   first reply, a marker no turn carries, which says when the run began.
///   With the marker, the run starts at the first turn written since then,
///   or after the whole transcript when there is none. Normally there is
///   none; a message the user steered in before the run's first reply is
///   one, and leaves history no divider.
///
/// Only a user turn or a "woken by" divider can start a turn; an id naming any
/// other turn, or none, falls back to the last user turn.
fn running_turn_start(turns: &[MessageTurn], in_flight_turn_id: Option<&str>) -> Option<usize> {
    if let Some(id) = in_flight_turn_id {
        let starts_a_turn = |t: &MessageTurn| match t.role {
            TurnRole::User => true,
            TurnRole::System => is_pi_wake_turn(t),
            TurnRole::Assistant => false,
        };
        if let Some(start) = turns.iter().position(|t| t.id == id && starts_a_turn(t)) {
            return Some(start);
        }
        if let Some(since) = pi_agent_turn_marker_since(id) {
            let since_then =
                |t: &MessageTurn| !matches!(t.role, TurnRole::System) && t.timestamp >= since;
            return Some(turns.iter().position(since_then).unwrap_or(turns.len()));
        }
    }
    turns.iter().rposition(|t| matches!(t.role, TurnRole::User))
}

/// Settle the fork point for a fork taken in a separate process while the
/// session may be running a turn ([`forks_while_running`]).
///
/// Stricter than a plain branch: there is no tail fallback. The tail of a
/// session with a turn in flight IS the half-written reply, so a point that
/// cannot be named is refused instead.
///
/// While a turn runs (`running`), the point must also lie BEFORE the turn's
/// start: only a reply that finished is a fork point. The start is the turn
/// `in_flight_turn_id` names when the caller could place it — the prompt of a
/// turn codeg sent, or the "woken by" divider of a run Pi started by itself
/// (see `running_turn_start`); otherwise the last user turn in the
/// transcript stands in for it. No start at all means the prompt has not
/// reached the transcript yet, and nothing can be shown to have finished —
/// refused, and the user retries a moment later.
pub fn settle_mid_run_fork_point(
    turns: Result<&[MessageTurn], &str>,
    turn_id: &str,
    adapter: impl Into<ForkAdapter>,
    running: bool,
    in_flight_turn_id: Option<&str>,
) -> Result<ForkPoint, AcpError> {
    let ForkAdapter { agent_type, caps } = adapter.into();
    if !caps.while_running {
        return Err(AcpError::ForkNeedsIdle);
    }
    let turns = turns.map_err(|reason| {
        AcpError::ForkPointUnresolved(format!("the conversation could not be read ({reason})"))
    })?;
    let idx = turns
        .iter()
        .position(|t| t.id == turn_id && matches!(t.role, TurnRole::Assistant))
        .ok_or_else(|| {
            AcpError::ForkPointUnresolved("this reply is not in the conversation".to_string())
        })?;
    if running && !running_turn_start(turns, in_flight_turn_id).is_some_and(|start| idx < start) {
        return Err(AcpError::ForkPointUnresolved(
            "this reply is still being written; fork from an earlier one, or wait for \
             the turn to finish"
                .to_string(),
        ));
    }
    resolve_fork_point(turns, turn_id, agent_type).ok_or_else(|| {
        AcpError::ForkPointUnresolved("the agent cannot fork at this reply".to_string())
    })
}

/// Why "Fork" on a whole conversation was refused: it has no reply that
/// finished — nothing sent yet, or only the turn still running.
pub const NO_FINISHED_REPLY: &str = "this conversation has no finished reply to fork yet";

/// Settle where "Fork" on a whole conversation lands: its latest FINISHED
/// reply. `None` is a tail fork.
///
/// While a turn runs (`running`), that is the last reply before the running
/// turn starts — its prompt, or the "woken by" divider of a run Pi started by
/// itself, found as [`settle_mid_run_fork_point`] finds it — and settled the
/// way it settles a reply picked by hand: named, never the tail, and only for
/// an adapter that forks while a turn runs.
///
/// Between turns it is the last reply in the transcript, and nothing is
/// writing to the session, so a reply the agent cannot name forks at the
/// tail, which is the same place (followed at most by a prompt that got no
/// reply).
pub fn settle_latest_reply_fork_point(
    turns: Result<&[MessageTurn], &str>,
    adapter: impl Into<ForkAdapter>,
    running: bool,
    in_flight_turn_id: Option<&str>,
) -> Result<Option<ForkPoint>, AcpError> {
    let adapter = adapter.into();
    if running && !adapter.caps.while_running {
        return Err(AcpError::ForkNeedsIdle);
    }
    let turns = turns.map_err(|reason| {
        AcpError::ForkPointUnresolved(format!("the conversation could not be read ({reason})"))
    })?;
    let finished = if running {
        &turns[..running_turn_start(turns, in_flight_turn_id).unwrap_or(0)]
    } else {
        turns
    };
    let reply = finished
        .iter()
        .rev()
        .find(|t| matches!(t.role, TurnRole::Assistant) && !t.blocks.is_empty())
        .ok_or_else(|| AcpError::ForkPointUnresolved(NO_FINISHED_REPLY.to_string()))?;
    if running {
        return settle_mid_run_fork_point(Ok(turns), &reply.id, adapter, true, in_flight_turn_id)
            .map(Some);
    }
    Ok(resolve_fork_point(turns, &reply.id, adapter.agent_type))
}

/// The `(before edit)` marker an edit fork gives the row holding the original
/// branch. Plain English on purpose: conversation titles are data, not UI
/// copy — the `[Fork] ` prefix is not localized either.
const BEFORE_EDIT_SUFFIX: &str = " (before edit)";

/// Title for the sibling row that keeps the pre-edit branch: `title` with the
/// `(before edit)` marker, never stacked — editing again inside a branch that
/// already carries it must not produce `… (before edit) (before edit)`.
pub fn before_edit_title(title: &str) -> String {
    let base = title.strip_suffix(BEFORE_EDIT_SUFFIX).unwrap_or(title);
    format!("{base}{BEFORE_EDIT_SUFFIX}")
}

/// Split a leading fork marker off `title`: `[Fork]` is fork 1 and `[Fork-N]`
/// fork N. Returns the number and the text after the marker (leading spaces
/// dropped, so the no-space `[Fork]Title` form reads the same), or `None` when
/// `title` does not start with a marker.
fn split_fork_marker(title: &str) -> Option<(u32, &str)> {
    let after = title.strip_prefix("[Fork")?;
    let (number, rest) = match after.strip_prefix(']') {
        Some(rest) => (1, rest),
        None => {
            let digits_and_rest = after.strip_prefix('-')?;
            let close = digits_and_rest.find(']')?;
            let digits = &digits_and_rest[..close];
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let number: u32 = digits.parse().ok()?;
            if number == 0 {
                return None;
            }
            (number, &digits_and_rest[close + 1..])
        }
    };
    Some((number, rest.trim_start()))
}

/// The title a fork is numbered against: `title` without any leading `[Fork]`
/// / `[Fork-N]` markers, so forking a fork never stacks them.
pub fn fork_base_title(title: &str) -> &str {
    let mut base = title;
    while let Some((_, rest)) = split_fork_marker(base) {
        base = rest;
    }
    base
}

/// Title for a new fork of a conversation titled `title`: `[Fork] <base>`, or
/// `[Fork-N] <base>` with the first N ≥ 2 that no title in `existing` already
/// uses for the same base. `existing` is every live title in the folder the
/// fork lands in (archived ones included, deleted ones not), so forking the
/// same conversation twice gives `[Fork] X` and then `[Fork-2] X`.
pub fn numbered_fork_title<'a>(
    title: &str,
    existing: impl IntoIterator<Item = &'a str>,
) -> String {
    let base = fork_base_title(title).trim();
    let taken: std::collections::HashSet<u32> = existing
        .into_iter()
        .filter_map(|other| {
            let (number, rest) = split_fork_marker(other)?;
            (fork_base_title(rest).trim() == base).then_some(number)
        })
        .collect();
    let number = (1..).find(|n| !taken.contains(n)).unwrap_or(1);
    if number == 1 {
        format!("[Fork] {base}")
    } else {
        format!("[Fork-{number}] {base}")
    }
}

impl ForkPoint {
    fn to_meta(&self) -> Meta {
        let mut fork = serde_json::Map::new();
        fork.insert("version".into(), serde_json::json!(1));
        fork.insert("messageId".into(), serde_json::json!(self.message_id));
        if let Some(fp) = &self.message_fingerprint {
            fork.insert("messageFingerprint".into(), serde_json::json!(fp));
        }
        if let Some(n) = self.message_occurrence {
            fork.insert("messageOccurrence".into(), serde_json::json!(n));
        }
        let mut meta = Meta::new();
        meta.insert(
            "jetbrains".into(),
            serde_json::json!({ "air": { "fork": fork } }),
        );
        meta
    }
}

/// Send a `session/fork` request over an existing ACP connection.
///
/// Returns the full `ForkSessionResponse` — what the caller attaches when the
/// agent cannot resume the fork — plus the raw top-level `models` value so the
/// Grok path can parse per-model reasoning-effort data (`None` when the
/// response has none).
///
/// `fork_point` forks at a chosen message instead of the tail; see [`ForkPoint`].
/// An agent that does not implement it ignores the unknown `_meta` key, so this
/// is inert rather than an error wherever it isn't understood. An agent that
/// DOES implement it but cannot resolve the point answers `invalid_params`,
/// which surfaces as a fork failure the user can retry from a different turn —
/// for Codex as [`AcpError::ForkPointUnresolved`], in words rather than
/// codex-acp's "Fork point message turn-12 was not found".
///
/// What else the request names depends on the agent; see [`build_fork_request`].
#[allow(clippy::too_many_arguments)]
pub async fn fork_session(
    cx: &ConnectionTo<Agent>,
    session_id: &SessionId,
    agent_type: AgentType,
    cwd: &str,
    mcp_servers: &[McpServer],
    claude: &ClaudeSessionOptions,
    fork_point: Option<&ForkPoint>,
) -> Result<(ForkSessionResponse, Option<serde_json::Value>), AcpError> {
    send_capturing_models(
        cx,
        AGENT_METHOD_NAMES.session_fork,
        build_fork_request(session_id, agent_type, cwd, mcp_servers, claude, fork_point),
    )
    .await
    .map_err(|e| fork_error(agent_type, fork_point.is_some(), &e))
}

/// What a failed `session/fork` tells the user.
fn fork_error(
    agent_type: AgentType,
    named_a_point: bool,
    e: &agent_client_protocol::Error,
) -> AcpError {
    if named_a_point && agent_type == AgentType::Codex && is_codex_fork_point_miss(e) {
        tracing::warn!("[ACP] codex-acp could not resolve the fork point: {e}");
        return AcpError::ForkPointUnresolved(CODEX_POINT_NOT_FOUND.to_string());
    }
    AcpError::protocol(format!("session/fork failed: {}", agent_error_text(e)))
}

/// The `session/fork` request: the fork point, if any, plus — for Claude and
/// Codex — the MCP servers the session runs with (and, for Claude, its
/// `_meta.claudeCode`).
///
/// `handle_fork_or_exit` resumes the forked session straight away with the
/// connection's MCP servers. glm-acp-agent and deepseek-acp mount them there:
/// glm connects them on the fork and reconnects on the resume, deepseek mounts
/// them on a session handle the resume replaces with a new one. So for those
/// agents the fork names no MCP servers, on purpose, since naming them on the
/// fork too only starts them twice. When there is no resume (the agent does not
/// advertise it, or it fails) the fork is attached as-is, without servers.
///
/// Codex cannot get its servers from the resume (#1105). codex-acp builds the
/// forked thread's config, `mcp_servers` included, from the fork request's own
/// list (`request.mcpServers ?? []`), and from 2.2.0 it keeps the forked thread
/// subscribed. The codex app-server answers a `thread/resume` of a loaded thread
/// that still has a subscriber by rejoining it and ignoring every config
/// override ("thread/resume overrides ignored for loaded thread"). A fork that
/// named no servers therefore stayed without them, codeg-mcp included, for the
/// whole life of the session: measured live on codex-acp 2.4.0 to 2.6.0, the
/// fork's model requests carried no codeg-mcp tool while the parent's did. So
/// Codex's fork names the servers itself, which mounts them once. codex-acp
/// 1.13 through 2.1.x unsubscribed the fork, and there the resume cold-restarts
/// the thread with the resume's identical list: the servers start twice, which
/// costs a process restart but loses nothing.
///
/// claude-agent-acp is the other way round from 0.90.0 (#1317). The fork STARTS
/// the forked session — a Claude Code process of its own — from the request's
/// `cwd`, MCP servers and `_meta`, and the resume that follows reuses it only
/// when those match what the session was started with (the adapter's session
/// fingerprint: `cwd`, the servers, `_meta.claudeCode` and a few `_meta` keys
/// codeg never sends; the AIR fork point is not part of it). A fork that names
/// nothing makes the resume tear that process down and start a second one,
/// measured live: two CLI processes per fork where one does. So Claude's fork
/// names exactly what `build_resume_session_request` names — the same servers
/// and the same `claude_raw_sdk_session_meta` — and the resume then returns the
/// running session at once (measured 1 ms, where the restart took ~240 ms).
/// From 0.73.0 through 0.89.x the fork only copied the transcript and read
/// neither field, so one request serves every version codeg may launch.
fn build_fork_request(
    session_id: &SessionId,
    agent_type: AgentType,
    cwd: &str,
    mcp_servers: &[McpServer],
    claude: &ClaudeSessionOptions,
    fork_point: Option<&ForkPoint>,
) -> ForkSessionRequest {
    let mut req = ForkSessionRequest::new(session_id.clone(), cwd);
    let mut meta = fork_point.map(ForkPoint::to_meta).unwrap_or_default();
    let claude_meta = claude_raw_sdk_session_meta(agent_type, claude);
    let names_servers = claude_meta.is_some() || agent_type == AgentType::Codex;
    if let Some(session_meta) = claude_meta {
        // Disjoint keys: the fork point lives under `jetbrains`, the session's
        // own settings under `claudeCode`.
        meta.extend(session_meta);
    }
    if names_servers && !mcp_servers.is_empty() {
        req = req.mcp_servers(mcp_servers.to_vec());
    }
    if meta.is_empty() {
        req
    } else {
        req.meta(meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn turn(id: &str, role: TurnRole, text: &str, agent_message_id: Option<&str>) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: agent_message_id.map(str::to_string),
            spoken: false,
        }
    }

    /// The shape both adapters parse — version 1, and the id under
    /// `jetbrains.air.fork` — as the request's own top-level `_meta`, which is
    /// where the typed request puts it.
    #[test]
    fn fork_request_carries_the_air_fork_block_as_its_meta() {
        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: Some("sha256:ab".into()),
            message_occurrence: Some(2),
        };
        let wire = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::Codex,
            "/work",
            &[server("other")],
            &ClaudeSessionOptions::new(true),
            Some(&point),
        ))
        .unwrap();
        assert_eq!(wire["sessionId"], "sess-1");
        assert_eq!(wire["cwd"], "/work");
        assert_eq!(
            wire["_meta"],
            serde_json::json!({"jetbrains": {"air": {"fork": {
                "version": 1,
                "messageId": "msg_01",
                "messageFingerprint": "sha256:ab",
                "messageOccurrence": 2,
            }}}})
        );
        // Codex's fork also names the connection's servers (#1105).
        assert_eq!(wire["mcpServers"][0]["name"], "other");
    }

    fn server(name: &str) -> McpServer {
        McpServer::Stdio(agent_client_protocol::schema::v1::McpServerStdio::new(
            name, "/bin/mcp",
        ))
    }

    /// For DeepSeek and Grok a tail fork is the bare request: no fork point,
    /// and no MCP servers — the resume that follows every fork is what mounts
    /// them (see [`build_fork_request`]), so naming them here would start them
    /// twice.
    #[test]
    fn a_tail_fork_names_neither_a_fork_point_nor_mcp_servers() {
        for agent_type in [AgentType::DeepSeek, AgentType::Grok] {
            let wire = serde_json::to_value(build_fork_request(
                &SessionId::new("sess-1"),
                agent_type,
                "/work",
                &[server("codeg-mcp")],
                &ClaudeSessionOptions::new(true),
                None,
            ))
            .unwrap();
            assert_eq!(
                wire,
                serde_json::json!({"sessionId": "sess-1", "cwd": "/work"}),
                "{agent_type:?}"
            );
        }
    }

    /// Codex's fork names the servers its resume names (#1105): codex-acp
    /// builds the forked thread's MCP config from the fork request alone, and
    /// the resume of that still-subscribed thread cannot add any. It carries no
    /// `_meta` of Claude's.
    #[test]
    fn a_codex_fork_names_the_servers_its_resume_sends() {
        let servers = vec![server("codeg-mcp"), server("docs")];
        let fork = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::Codex,
            "/work",
            &servers,
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        let resume = serde_json::to_value(crate::acp::connection::build_resume_session_request(
            AgentType::Codex,
            SessionId::new("sess-2"),
            std::path::Path::new("/work"),
            servers.clone(),
            &ClaudeSessionOptions::new(true),
        ))
        .unwrap();
        assert_eq!(fork["mcpServers"], resume["mcpServers"]);
        assert_eq!(fork["mcpServers"].as_array().map(Vec::len), Some(2));
        assert_eq!(fork["mcpServers"][0]["name"], "codeg-mcp");
        assert!(fork.get("_meta").is_none());

        // No servers: the bare request.
        let bare = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::Codex,
            "/work",
            &[],
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        assert_eq!(
            bare,
            serde_json::json!({"sessionId": "sess-1", "cwd": "/work"})
        );
    }

    /// Claude's fork names exactly the settings its resume names — the same
    /// servers and the same `_meta.claudeCode` — because claude-agent-acp
    /// 0.90.0 starts the forked session from the fork, and the resume reuses
    /// that session only when the two agree (anything else restarts it).
    #[test]
    fn a_claude_fork_names_the_settings_its_resume_sends() {
        let servers = vec![server("codeg-mcp"), server("docs")];
        let fork = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &servers,
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        let resume = serde_json::to_value(crate::acp::connection::build_resume_session_request(
            AgentType::ClaudeCode,
            SessionId::new("sess-2"),
            std::path::Path::new("/work"),
            servers.clone(),
            &ClaudeSessionOptions::new(true),
        ))
        .unwrap();
        assert_eq!(fork["cwd"], resume["cwd"]);
        assert_eq!(fork["mcpServers"], resume["mcpServers"]);
        assert_eq!(fork["_meta"], resume["_meta"]);
        assert_eq!(
            fork["_meta"],
            serde_json::json!({"claudeCode": {"emitRawSDKMessages": true}})
        );
        assert_eq!(fork["mcpServers"].as_array().map(Vec::len), Some(2));

        // No servers: none named on either request.
        let bare = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &[],
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        assert!(bare.get("mcpServers").is_none());
        assert_eq!(
            bare["_meta"],
            serde_json::json!({"claudeCode": {"emitRawSDKMessages": true}})
        );
    }

    /// A connection that asks for no predicted prompts (an automation run, a
    /// chat-channel bot) says so on the fork as on the resume: the option is
    /// part of the adapter's session fingerprint, so a fork that left it out
    /// would make the resume restart the forked session.
    #[test]
    fn a_claude_fork_without_prompt_suggestions_matches_its_resume() {
        let fork = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &[server("codeg-mcp")],
            &ClaudeSessionOptions::new(false),
            None,
        ))
        .unwrap();
        let resume = serde_json::to_value(crate::acp::connection::build_resume_session_request(
            AgentType::ClaudeCode,
            SessionId::new("sess-2"),
            std::path::Path::new("/work"),
            vec![server("codeg-mcp")],
            &ClaudeSessionOptions::new(false),
        ))
        .unwrap();
        assert_eq!(fork["_meta"], resume["_meta"]);
        assert_eq!(
            fork["_meta"],
            serde_json::json!({"claudeCode": {
                "emitRawSDKMessages": true,
                "options": {"promptSuggestions": false},
            }})
        );
    }

    /// The fork point and the session's settings ride the same `_meta`, side by
    /// side: neither replaces the other, and the adapter's session fingerprint
    /// reads only the `claudeCode` half.
    #[test]
    fn a_claude_fork_point_rides_beside_the_session_settings() {
        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        };
        let wire = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &[],
            &ClaudeSessionOptions::new(true),
            Some(&point),
        ))
        .unwrap();
        assert_eq!(
            wire["_meta"],
            serde_json::json!({
                "claudeCode": {"emitRawSDKMessages": true},
                "jetbrains": {"air": {"fork": {"version": 1, "messageId": "msg_01"}}},
            })
        );
    }

    /// The optional halves stay absent rather than null — every adapter
    /// validates the fingerprint's shape when present, so sending `null` would
    /// be worse than sending nothing.
    #[test]
    fn meta_omits_absent_fingerprint_and_occurrence() {
        let meta = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        }
        .to_meta();
        let fork = &meta["jetbrains"]["air"]["fork"];
        assert!(fork.get("messageFingerprint").is_none());
        assert!(fork.get("messageOccurrence").is_none());
    }

    /// The id the parser derived leads, and 0.75.1 also reads the fingerprint,
    /// so both go out: the id resolves on the active chain, the fingerprint is
    /// what still resolves once the point has drifted onto an abandoned branch.
    #[test]
    fn claude_sends_the_derived_id_and_the_fingerprint_together() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01")),
        ];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_01");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        // Claude needs BOTH halves to use the fingerprint at all, so an
        // occurrence must ride along with it.
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// A turn Claude never named still forks by content — 0.75.1 falls through
    /// to the fingerprint when the id misses, and `turn-<n>` is a position that
    /// can never collide with a record uuid.
    #[test]
    fn claude_falls_back_to_the_fingerprint_with_no_agent_id() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", None)];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "turn-1");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
    }

    /// The one case that must stay a tail fork: a turn codeg synthesized with
    /// no text and no id. `fingerprint("")` would match every text-free
    /// grouping on Claude's side, so guessing between them by occurrence is
    /// strictly worse than not naming a point at all.
    #[test]
    fn claude_declines_a_synthesized_turn_with_neither_id_nor_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::ToolUse {
            tool_use_id: Some("tl-tool-0".into()),
            tool_name: "Bash".into(),
            input_preview: None,
            status: None,
            meta: None,
        }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::ClaudeCode).is_none());
    }

    /// A textless turn Claude DID name is still a fork point by id alone.
    #[test]
    fn claude_forks_a_textless_named_turn_by_its_id_alone() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", Some("msg_01"));
        t.blocks = Vec::new();
        let point = resolve_fork_point(&[t], "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_01");
        assert!(point.message_fingerprint.is_none());
        assert!(point.message_occurrence.is_none());
    }

    #[test]
    fn codex_forks_by_content_fingerprint() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", None),
        ];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::Codex).unwrap();
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// An answer repeated verbatim must still fork at the one the user clicked,
    /// which is the only thing `messageOccurrence` is for.
    #[test]
    fn codex_counts_repeated_answers() {
        let turns = vec![
            turn("turn-0", TurnRole::Assistant, "same", None),
            turn("turn-1", TurnRole::User, "again", None),
            turn("turn-2", TurnRole::Assistant, "same", None),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "turn-0", AgentType::Codex)
                .unwrap()
                .message_occurrence,
            Some(1)
        );
        assert_eq!(
            resolve_fork_point(&turns, "turn-2", AgentType::Codex)
                .unwrap()
                .message_occurrence,
            Some(2)
        );
    }

    /// Codex hashes agent messages only, so a user turn with identical text
    /// must not shift the count.
    #[test]
    fn codex_occurrence_ignores_user_turns() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "same", None),
            turn("turn-1", TurnRole::Assistant, "same", None),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "turn-1", AgentType::Codex)
                .unwrap()
                .message_occurrence,
            Some(1)
        );
    }

    /// A reply holding no agent message — no item id and no text — names
    /// nothing codex could find.
    #[test]
    fn codex_declines_a_turn_with_no_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::Text { text: "   ".into() }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::Codex).is_none());
    }

    fn tool_call(id: &str) -> MessageTurn {
        let mut t = turn(id, TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::ToolUse {
            tool_use_id: Some(format!("call-{id}")),
            tool_name: "shell".into(),
            input_preview: None,
            status: None,
            meta: None,
        }];
        t
    }

    /// One codex 2.x reply as the parser gives it: a turn per agent message,
    /// each named by its item id, with the tool calls between them.
    fn codex_reply_history() -> Vec<MessageTurn> {
        vec![
            turn("turn-0", TurnRole::User, "build it", None),
            turn("turn-1", TurnRole::Assistant, "I'll check.", Some("msg_1")),
            tool_call("turn-2"),
            turn("turn-3", TurnRole::Assistant, "Checking.", Some("msg_2")),
            tool_call("turn-4"),
            turn("turn-5", TurnRole::Assistant, "Built it.", Some("msg_3")),
            turn("turn-6", TurnRole::User, "again", None),
            turn("turn-7", TurnRole::Assistant, "Checking.", Some("msg_4")),
            tool_call("turn-8"),
            turn("turn-9", TurnRole::User, "stop", None),
            tool_call("turn-10"),
            turn("turn-11", TurnRole::User, "next", None),
        ]
    }

    /// The reply's own message is named — by codex's item id, with the hash of
    /// that one message, not of the reply's text run together.
    #[test]
    fn codex_names_one_agent_message_by_item_id() {
        let turns = codex_reply_history();
        let point = resolve_fork_point(&turns, "turn-5", AgentType::Codex).unwrap();
        assert_eq!(point.message_id, "msg_3");
        assert_eq!(
            point.message_fingerprint,
            Some(fingerprint_agent_message("Built it."))
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// codex-acp counts an occurrence among agent MESSAGES of every turn, so a
    /// final answer equal to an earlier commentary of another reply is the
    /// second of its text.
    #[test]
    fn codex_counts_occurrences_per_message_across_replies() {
        let turns = codex_reply_history();
        let commentary = resolve_fork_point(&turns, "turn-3", AgentType::Codex).unwrap();
        assert_eq!(commentary.message_occurrence, Some(1));
        let later = resolve_fork_point(&turns, "turn-7", AgentType::Codex).unwrap();
        assert_eq!(later.message_id, "msg_4");
        assert_eq!(later.message_occurrence, Some(2));

        // Should a turn ever hold two messages, each counts, and the turn
        // names its last.
        let mut merged = turns.clone();
        merged[5].blocks = vec![
            ContentBlock::Text {
                text: "Checking.".into(),
            },
            ContentBlock::Text {
                text: "Checking.".into(),
            },
        ];
        let point = resolve_fork_point(&merged, "turn-5", AgentType::Codex).unwrap();
        assert_eq!(
            point.message_fingerprint,
            Some(fingerprint_agent_message("Checking."))
        );
        assert_eq!(point.message_occurrence, Some(3));
    }

    /// A reply that ends in a tool call (stopped mid-turn) names the latest
    /// message before it in the same reply; codex forks that whole turn.
    #[test]
    fn codex_names_the_reply_s_last_message_when_it_ends_in_a_tool_call() {
        let turns = codex_reply_history();
        let point = resolve_fork_point(&turns, "turn-8", AgentType::Codex).unwrap();
        assert_eq!(point.message_id, "msg_4");
        assert_eq!(point.message_occurrence, Some(2));
    }

    /// …but never past the user message that opened the reply: that message
    /// belongs to an earlier codex turn, and forking there would drop this one.
    #[test]
    fn codex_never_names_a_message_from_before_the_reply() {
        let turns = codex_reply_history();
        assert!(resolve_fork_point(&turns, "turn-10", AgentType::Codex).is_none());
        let err = settle_fork_point(
            Ok(turns.as_slice()),
            "turn-10",
            AgentType::Codex,
            ForkMode::Edit,
        )
        .expect_err("nothing to name in that reply");
        assert!(matches!(err, AcpError::ForkPointUnresolved(_)));
        assert_eq!(err.to_string(), CODEX_REPLY_WITHOUT_MESSAGE);
    }

    /// A rollout that recorded no item ids (older codex) is named by the
    /// fingerprint alone; the id half is codeg's own turn id, which codex never
    /// finds and so falls through.
    #[test]
    fn codex_without_item_ids_forks_by_fingerprint() {
        let mut turns = codex_reply_history();
        for t in &mut turns {
            t.agent_message_id = None;
        }
        let point = resolve_fork_point(&turns, "turn-7", AgentType::Codex).unwrap();
        assert_eq!(point.message_id, "turn-7");
        assert_eq!(
            point.message_fingerprint,
            Some(fingerprint_agent_message("Checking."))
        );
        assert_eq!(point.message_occurrence, Some(2));
    }

    /// A message steered into a running Codex turn cannot be edited: the fork
    /// before it would end where that turn ends, after the message itself.
    /// The reply before it is still a fork point for "fork from here", and a
    /// message that opened a turn edits as before.
    #[test]
    fn codex_refuses_to_edit_a_message_steered_into_a_running_turn() {
        let mut turns = codex_reply_history();
        // "build it" → I'll check. → [steer] → Checking. → … → "again"
        let mut steer = turn("turn-2b", TurnRole::User, "faster please", None);
        steer.agent_message_id = Some("codex-turn-1".into());
        turns.insert(2, steer);
        for mode in [ForkMode::Edit, ForkMode::EditInPlace] {
            let err = settle_fork_point(Ok(turns.as_slice()), "turn-1", AgentType::Codex, mode)
                .expect_err("the steered message cannot be edited");
            assert!(matches!(err, AcpError::ForkPointUnresolved(_)), "{err:?}");
            assert_eq!(err.to_string(), CODEX_STEERED_MESSAGE);
        }
        let branch = settle_fork_point(
            Ok(turns.as_slice()),
            "turn-1",
            AgentType::Codex,
            ForkMode::Branch,
        )
        .unwrap()
        .expect("fork from here still names the reply");
        assert_eq!(branch.message_id, "msg_1");
        // "again" opened its turn.
        let again = settle_fork_point(
            Ok(turns.as_slice()),
            "turn-5",
            AgentType::Codex,
            ForkMode::Edit,
        )
        .unwrap()
        .expect("a message that opened a turn edits");
        assert_eq!(again.message_id, "msg_3");
        // Only Codex forks whole turns.
        assert!(!edits_a_steered_codex_message(
            &turns,
            "turn-1",
            AgentType::ClaudeCode
        ));
    }

    /// A message codex named but codeg shows no text for is still named, by
    /// its id alone: a hash of nothing would match every blank message.
    #[test]
    fn codex_names_a_textless_message_by_id_alone() {
        let mut turns = codex_reply_history();
        turns[5].blocks = Vec::new();
        let point = resolve_fork_point(&turns, "turn-5", AgentType::Codex).unwrap();
        assert_eq!(point.message_id, "msg_3");
        assert!(point.message_fingerprint.is_none());
        assert!(point.message_occurrence.is_none());
    }

    /// codex-acp's refusal of a point it cannot find reaches the user in
    /// words; any other fork failure, or another agent's, stays as it was.
    #[test]
    fn codex_s_unresolved_fork_point_reads_as_one() {
        let miss = agent_client_protocol::Error::new(
            -32602,
            "Invalid params: Fork point message turn-596 was not found in session S",
        )
        .data(serde_json::json!({ "messageId": "turn-596" }));
        let err = fork_error(AgentType::Codex, true, &miss);
        assert!(matches!(err, AcpError::ForkPointUnresolved(_)), "{err:?}");
        assert_eq!(err.to_string(), CODEX_POINT_NOT_FOUND);

        // A tail fork named no point; another agent words its own.
        for (agent, named) in [(AgentType::Codex, false), (AgentType::ClaudeCode, true)] {
            let err = fork_error(agent, named, &miss);
            assert!(err.to_string().contains("session/fork failed"), "{err}");
        }
        let other = agent_client_protocol::Error::new(-32603, "app-server exited");
        assert!(fork_error(AgentType::Codex, true, &other)
            .to_string()
            .contains("app-server exited"));
    }

    /// DeepSeek reads BOTH halves, so both are sent — unlike codex, whose id
    /// half can never resolve.
    #[test]
    fn deepseek_sends_the_log_id_and_the_fingerprint_together() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("uuid-a2")),
        ];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::DeepSeek).unwrap();
        assert_eq!(point.message_id, "uuid-a2");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// A log that named nothing still forks by content, the codex shape: the id
    /// is codeg's own turn id, which DeepSeek cannot match, so it falls through
    /// to the fingerprint instead of failing.
    #[test]
    fn deepseek_falls_back_to_the_fingerprint_with_no_log_id() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", None)];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::DeepSeek).unwrap();
        assert_eq!(point.message_id, "turn-1");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
    }

    /// An id with no text is still a fork point on DeepSeek — a bubble whose
    /// whole turn was tool calls names a message the adapter can look up, which
    /// is exactly what codex cannot do.
    #[test]
    fn deepseek_forks_a_textless_turn_by_its_id_alone() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", Some("uuid-a1"));
        t.blocks = Vec::new();
        let point = resolve_fork_point(&[t], "turn-1", AgentType::DeepSeek).unwrap();
        assert_eq!(point.message_id, "uuid-a1");
        // Nothing to hash, so no fingerprint — and none to count occurrences of.
        assert!(point.message_fingerprint.is_none());
        assert!(point.message_occurrence.is_none());
    }

    /// Neither half available (a bubble opened by a tool result alone) is not a
    /// fork point; the caller degrades to the tail.
    #[test]
    fn deepseek_declines_a_turn_with_neither_id_nor_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::Text { text: "   ".into() }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::DeepSeek).is_none());
    }

    /// The fingerprint half counts the same way codex's does, so a repeated
    /// answer in a log that named nothing still forks at the one clicked.
    #[test]
    fn deepseek_counts_repeated_answers() {
        let turns = vec![
            turn("turn-0", TurnRole::Assistant, "same", None),
            turn("turn-1", TurnRole::User, "again", None),
            turn("turn-2", TurnRole::Assistant, "same", None),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "turn-2", AgentType::DeepSeek)
                .unwrap()
                .message_occurrence,
            Some(2)
        );
    }

    /// Forking "up to" a user turn is what a plain fork-send already does, and
    /// no adapter resolves an id against a user message.
    #[test]
    fn user_turns_are_not_fork_points() {
        let turns = vec![turn("turn-0", TurnRole::User, "hi", Some("msg_01"))];
        assert!(resolve_fork_point(&turns, "turn-0", AgentType::ClaudeCode).is_none());
        assert!(resolve_fork_point(&turns, "turn-0", AgentType::Codex).is_none());
        assert!(resolve_fork_point(&turns, "turn-0", AgentType::DeepSeek).is_none());
    }

    /// Every other agent forks at the tail — advertising a fork point they do
    /// not implement would silently change what their fork means.
    #[test]
    fn other_agents_have_no_fork_point() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01"))];
        for agent in [AgentType::Gemini, AgentType::Grok, AgentType::Custom("acme")] {
            assert!(resolve_fork_point(&turns, "turn-1", agent).is_none());
        }
    }

    #[test]
    fn unknown_turn_id_is_not_a_fork_point() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01"))];
        assert!(resolve_fork_point(&turns, "turn-9", AgentType::ClaudeCode).is_none());
    }

    /// Pinned against a digest computed outside this crate, so a change of hash
    /// or encoding cannot pass by agreeing with itself.
    #[test]
    fn fingerprint_is_sha256_hex() {
        assert_eq!(
            fingerprint_agent_message("abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// A reply the agent named, then the user message an edit would replace.
    fn history() -> Vec<MessageTurn> {
        vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01")),
            turn("turn-2", TurnRole::User, "the message being edited", None),
        ]
    }

    /// [`settle_fork_point`] over a readable [`history`].
    fn settle(
        turn_id: &str,
        agent: AgentType,
        mode: ForkMode,
    ) -> Result<Option<ForkPoint>, AcpError> {
        settle_fork_point(Ok(history().as_slice()), turn_id, agent, mode)
    }

    /// Both modes agree whenever the point resolves: an edit forks exactly
    /// where "fork from here" would.
    #[test]
    fn a_resolvable_point_forks_there_in_both_modes() {
        for mode in [ForkMode::Branch, ForkMode::Edit, ForkMode::EditInPlace] {
            let point = settle("turn-1", AgentType::ClaudeCode, mode)
                .expect("a nameable reply settles")
                .expect("and is a real fork point, not the tail");
            assert_eq!(point.message_id, "msg_01");
        }
    }

    /// "Fork from here" never refuses a click: a point it cannot name is a
    /// tail fork, exactly as before edit mode existed.
    #[test]
    fn branch_degrades_an_unnameable_point_to_the_tail() {
        assert!(settle("turn-9", AgentType::ClaudeCode, ForkMode::Branch)
            .unwrap()
            .is_none());
        let unreadable = settle_fork_point(
            Err("session file missing"),
            "turn-1",
            AgentType::ClaudeCode,
            ForkMode::Branch,
        );
        assert!(unreadable.unwrap().is_none());
    }

    /// The tail still holds the message being edited, so an edit that cannot
    /// name its point must fail instead of quietly continuing the original.
    #[test]
    fn edit_refuses_a_point_it_cannot_name() {
        // Both kinds of edit: they differ only in what happens to the original.
        for mode in [ForkMode::Edit, ForkMode::EditInPlace] {
            let err = settle("turn-9", AgentType::ClaudeCode, mode)
                .expect_err("an unknown turn must not become a tail fork");
            assert!(matches!(err, AcpError::ForkPointUnresolved(_)), "got {err:?}");
            assert_eq!(err.code(), Some("fork_point_unresolved"));

            // A user turn is never a fork point, so aiming an edit at one is
            // the same miss — never "fork up to and including the message".
            assert!(settle("turn-2", AgentType::ClaudeCode, mode).is_err());
        }
    }

    /// Not being able to read the conversation is no excuse to guess either.
    #[test]
    fn edit_refuses_when_the_conversation_cannot_be_read() {
        let err = settle_fork_point(
            Err("session file missing"),
            "turn-1",
            AgentType::Codex,
            ForkMode::Edit,
        )
        .expect_err("an unreadable conversation must not become a tail fork");
        assert!(
            err.to_string().contains("session file missing"),
            "the reason reaches the user: {err}"
        );
    }

    /// Only adapters that refuse a point they cannot resolve can carry an
    /// edit. Without its adapter saying so, pi-acp is one of the old builds
    /// that fall back to the tail, which would look like success.
    #[test]
    fn edit_is_limited_to_agents_that_honour_the_point_strictly() {
        for agent in [AgentType::ClaudeCode, AgentType::Codex, AgentType::DeepSeek] {
            assert!(honours_fork_point_strictly(agent), "{agent}");
        }
        for agent in [AgentType::Pi, AgentType::Gemini, AgentType::Custom("acme")] {
            assert!(!honours_fork_point_strictly(agent), "{agent}");
        }
        // Refused up front — even a turn pi COULD fingerprint…
        for mode in [ForkMode::Edit, ForkMode::EditInPlace] {
            assert!(matches!(
                settle("turn-1", AgentType::Pi, mode),
                Err(AcpError::ForkPointUnresolved(_))
            ));
        }
        // …while "fork from here" on pi is unchanged.
        assert!(settle("turn-1", AgentType::Pi, ForkMode::Branch)
            .unwrap()
            .is_some());
    }

    fn pi_meta(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        value.as_object().cloned().expect("an object")
    }

    /// pi-acp says what its build can do; nothing else reads the key.
    #[test]
    fn fork_capabilities_read_pi_s_advertisement_only() {
        let both = pi_meta(serde_json::json!({
            "steering": { "supported": true },
            "forkPoint": { "strict": true, "whileRunning": true }
        }));
        assert_eq!(
            fork_capabilities(AgentType::Pi, Some(&both)),
            ForkCapabilities { strict_point: true, while_running: true }
        );
        // An older pi-acp advertises neither, and a stringly flag is not one.
        assert_eq!(fork_capabilities(AgentType::Pi, None), ForkCapabilities::default());
        let stringly = pi_meta(serde_json::json!({ "forkPoint": { "strict": "true" } }));
        assert_eq!(fork_capabilities(AgentType::Pi, Some(&stringly)), ForkCapabilities::default());
        let strict_only = pi_meta(serde_json::json!({ "forkPoint": { "strict": true } }));
        assert_eq!(
            fork_capabilities(AgentType::Pi, Some(&strict_only)),
            ForkCapabilities { strict_point: true, while_running: false }
        );
        // Another agent's adapter cannot opt in through the same key…
        assert_eq!(
            fork_capabilities(AgentType::Gemini, Some(&both)),
            ForkCapabilities::default()
        );
        // …and the built-in agents keep what they have regardless.
        assert_eq!(
            fork_capabilities(AgentType::ClaudeCode, None),
            ForkCapabilities { strict_point: true, while_running: true }
        );
        assert_eq!(
            fork_capabilities(AgentType::Codex, None),
            ForkCapabilities { strict_point: true, while_running: false }
        );
    }

    /// With the adapter's promise, a Pi edit forks at the reply before the
    /// message, by the entry id the parser gave that reply.
    #[test]
    fn pi_edits_once_its_adapter_forks_strictly() {
        let pi = ForkAdapter {
            agent_type: AgentType::Pi,
            caps: ForkCapabilities { strict_point: true, while_running: false },
        };
        for mode in [ForkMode::Edit, ForkMode::EditInPlace] {
            let point = settle_fork_point(Ok(history().as_slice()), "turn-1", pi, mode)
                .expect("a strict pi adapter settles an edit")
                .expect("at a real point");
            assert_eq!(point.message_id, "msg_01");
            assert_eq!(point.message_fingerprint, Some(fingerprint_agent_message("hello")));
            // A point it cannot name is refused, as for every strict adapter.
            assert!(settle_fork_point(Ok(history().as_slice()), "turn-9", pi, mode).is_err());
        }
    }

    /// "Fork" on a whole conversation: between turns, its last reply; while a
    /// turn runs, the last reply before that turn's prompt.
    #[test]
    fn latest_reply_fork_point_is_the_newest_finished_reply() {
        let turns = running_history();
        let idle = settle_latest_reply_fork_point(
            Ok(turns.as_slice()),
            AgentType::ClaudeCode,
            false,
            None,
        )
        .unwrap()
        .expect("a named reply");
        assert_eq!(idle.message_id, "msg_02");
        let running = settle_latest_reply_fork_point(
            Ok(turns.as_slice()),
            AgentType::ClaudeCode,
            true,
            Some("turn-2"),
        )
        .unwrap()
        .expect("a named reply");
        assert_eq!(running.message_id, "msg_01");

        // An empty bubble is no reply; a prompt with no reply after it is
        // passed over between turns.
        let mut trailing = turns.clone();
        trailing[3].blocks.clear();
        trailing.push(turn("turn-4", TurnRole::User, "and again", None));
        let point =
            settle_latest_reply_fork_point(Ok(trailing.as_slice()), AgentType::ClaudeCode, false, None)
                .unwrap()
                .unwrap();
        assert_eq!(point.message_id, "msg_01");
    }

    #[test]
    fn latest_reply_fork_point_refuses_what_it_cannot_fork() {
        let turns = running_history();
        // No reply at all, or only the one the running turn is writing.
        let first_prompt = &turns[..1];
        for running in [false, true] {
            let err =
                settle_latest_reply_fork_point(Ok(first_prompt), AgentType::ClaudeCode, running, None)
                    .unwrap_err();
            assert!(err.to_string().contains(NO_FINISHED_REPLY), "{err}");
        }
        // Mid-turn, an agent that forks only between turns waits.
        assert!(matches!(
            settle_latest_reply_fork_point(Ok(turns.as_slice()), AgentType::Codex, true, None),
            Err(AcpError::ForkNeedsIdle)
        ));
        assert!(matches!(
            settle_latest_reply_fork_point(Err("gone"), AgentType::ClaudeCode, false, None),
            Err(AcpError::ForkPointUnresolved(_))
        ));
        // Between turns, an agent that names no reply forks at the tail.
        assert!(
            settle_latest_reply_fork_point(Ok(turns.as_slice()), AgentType::Gemini, false, None)
                .unwrap()
                .is_none()
        );
    }

    /// Mid-run forks for Pi follow the same advertisement.
    #[test]
    fn pi_forks_mid_run_once_its_adapter_says_it_can() {
        let turns = running_history();
        let pi = |while_running| ForkAdapter {
            agent_type: AgentType::Pi,
            caps: ForkCapabilities { strict_point: true, while_running },
        };
        let settle = |turn_id, adapter| {
            settle_mid_run_fork_point(Ok(turns.as_slice()), turn_id, adapter, true, Some("turn-2"))
        };
        let point = settle("turn-1", pi(true)).expect("a finished reply is a fork point mid-run");
        assert_eq!(point.message_id, "msg_01");
        assert!(settle("turn-3", pi(true)).is_err());
        assert!(matches!(
            settle_mid_run_fork_point(Ok(turns.as_slice()), "turn-1", pi(false), true, None),
            Err(AcpError::ForkNeedsIdle)
        ));
    }

    /// The wire form both transports send.
    #[test]
    fn fork_mode_reads_its_wire_names() {
        assert_eq!(
            serde_json::from_value::<ForkMode>(serde_json::json!("edit")).unwrap(),
            ForkMode::Edit
        );
        assert_eq!(
            serde_json::from_value::<ForkMode>(serde_json::json!("edit_in_place")).unwrap(),
            ForkMode::EditInPlace
        );
        assert_eq!(
            serde_json::from_value::<ForkMode>(serde_json::json!("branch")).unwrap(),
            ForkMode::Branch
        );
        // An absent mode is a plain branch — every caller that predates edit.
        assert_eq!(ForkMode::default(), ForkMode::Branch);
        assert!(ForkMode::Edit.is_edit() && ForkMode::EditInPlace.is_edit());
        assert!(!ForkMode::Branch.is_edit());
    }

    /// A finished exchange, then the prompt of the turn still running and the
    /// first half of its reply.
    fn running_history() -> Vec<MessageTurn> {
        vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01")),
            turn("turn-2", TurnRole::User, "count to 30", None),
            turn("turn-3", TurnRole::Assistant, "1, 2, 3", Some("msg_02")),
        ]
    }

    /// The whole point: a reply that finished before the running turn's prompt
    /// is a fork point, named exactly as a plain fork would name it.
    #[test]
    fn mid_run_forks_at_a_reply_that_finished_before_the_running_turn() {
        let turns = running_history();
        let point = settle_mid_run_fork_point(
            Ok(turns.as_slice()),
            "turn-1",
            AgentType::ClaudeCode,
            true,
            Some("turn-2"),
        )
        .expect("a finished reply is a fork point mid-run");
        let plain = resolve_fork_point(&turns, "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_01");
        assert_eq!(point.message_fingerprint, plain.message_fingerprint);
        assert_eq!(point.message_occurrence, plain.message_occurrence);
    }

    /// The reply being written is never a fork point — it is past the running
    /// turn's prompt, whether or not the caller matched that prompt.
    #[test]
    fn mid_run_refuses_the_reply_still_being_written() {
        let turns = running_history();
        for prompt in [Some("turn-2"), None] {
            let err = settle_mid_run_fork_point(
                Ok(turns.as_slice()),
                "turn-3",
                AgentType::ClaudeCode,
                true,
                prompt,
            )
            .expect_err("the in-flight reply must not be forked");
            assert!(matches!(err, AcpError::ForkPointUnresolved(_)), "{prompt:?}: {err:?}");
        }
    }

    /// A message the user steers into the running turn is a user turn AFTER
    /// the prompt. Matching the prompt keeps the first half of the running
    /// reply — which that message now follows — from passing as finished.
    #[test]
    fn mid_run_measures_from_the_running_prompt_not_a_steered_message() {
        let mut turns = running_history();
        turns.push(turn("turn-4", TurnRole::User, "faster please", None));
        turns.push(turn("turn-5", TurnRole::Assistant, "4, 5", Some("msg_03")));
        assert!(settle_mid_run_fork_point(
            Ok(turns.as_slice()),
            "turn-3",
            AgentType::ClaudeCode,
            true,
            Some("turn-2"),
        )
        .is_err());
        assert!(settle_mid_run_fork_point(
            Ok(turns.as_slice()),
            "turn-1",
            AgentType::ClaudeCode,
            true,
            Some("turn-2"),
        )
        .is_ok());
    }

    /// The running turn's prompt is not in the transcript yet: nothing can be
    /// shown to have finished, so even the last reply is refused.
    #[test]
    fn mid_run_refuses_when_no_prompt_marks_where_the_running_turn_starts() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01")),
        ];
        // Running, with only the last reply's own prompt before it.
        assert!(settle_mid_run_fork_point(
            Ok(turns.as_slice()),
            "turn-1",
            AgentType::ClaudeCode,
            true,
            None,
        )
        .is_err());
        // Idle (the turn ended in the meantime): every reply is finished.
        assert!(settle_mid_run_fork_point(
            Ok(turns.as_slice()),
            "turn-1",
            AgentType::ClaudeCode,
            false,
            None,
        )
        .is_ok());
    }

    /// No tail fallback: mid-run, the tail is the half-written reply.
    #[test]
    fn mid_run_never_degrades_to_a_tail_fork() {
        let turns = running_history();
        let unreadable = settle_mid_run_fork_point(
            Err("session file missing"),
            "turn-1",
            AgentType::ClaudeCode,
            true,
            None,
        );
        assert!(matches!(unreadable, Err(AcpError::ForkPointUnresolved(_))));
        let unknown = settle_mid_run_fork_point(
            Ok(turns.as_slice()),
            "turn-9",
            AgentType::ClaudeCode,
            true,
            None,
        );
        assert!(matches!(unknown, Err(AcpError::ForkPointUnresolved(_))));
        // A finished reply with neither an id nor text: a plain fork would
        // fork at the tail; this one has to refuse.
        let mut textless = running_history();
        textless[1].agent_message_id = None;
        textless[1].blocks = Vec::new();
        let unnamed = settle_mid_run_fork_point(
            Ok(textless.as_slice()),
            "turn-1",
            AgentType::ClaudeCode,
            true,
            Some("turn-2"),
        );
        assert!(matches!(unnamed, Err(AcpError::ForkPointUnresolved(_))));
    }

    /// A finished exchange, then a run Pi started by itself: its "woken by"
    /// divider (a System turn) and the first half of its reply.
    fn woken_history() -> Vec<MessageTurn> {
        let mut wake = turn("turn-2", TurnRole::System, "Pi continued on its own", None);
        wake.blocks.push(ContentBlock::ToolUse {
            tool_use_id: Some("pi-wake-e1".into()),
            tool_name: "agent_wake".into(),
            input_preview: None,
            status: None,
            meta: Some(serde_json::json!({ "codeg.agentWake": { "version": 1 } })),
        });
        vec![
            turn("turn-0", TurnRole::User, "launch a scout", None),
            turn("turn-1", TurnRole::Assistant, "LAUNCHED", Some("msg_01")),
            wake,
            turn(
                "turn-3",
                TurnRole::Assistant,
                "the scout found",
                Some("msg_02"),
            ),
        ]
    }

    /// A woken run starts at the divider the caller names. A System turn that
    /// is not a divider, or a reply, starts nothing: the last user turn stands
    /// in, as for an unmatched prompt.
    #[test]
    fn a_woken_run_starts_at_its_divider() {
        let turns = woken_history();
        assert_eq!(running_turn_start(&turns, Some("turn-2")), Some(2));
        assert_eq!(running_turn_start(&turns, Some("turn-3")), Some(0));
        assert_eq!(running_turn_start(&turns, None), Some(0));
        let mut note = woken_history();
        note[2].blocks.truncate(1);
        assert_eq!(running_turn_start(&note, Some("turn-2")), Some(0));

        let pi = ForkAdapter {
            agent_type: AgentType::Pi,
            caps: ForkCapabilities {
                strict_point: true,
                while_running: true,
            },
        };
        let latest = settle_latest_reply_fork_point(Ok(turns.as_slice()), pi, true, Some("turn-2"))
            .unwrap()
            .expect("a named reply");
        assert_eq!(latest.message_id, "msg_01");
        let settle = |turn_id| {
            settle_mid_run_fork_point(Ok(turns.as_slice()), turn_id, pi, true, Some("turn-2"))
        };
        assert_eq!(settle("turn-1").unwrap().message_id, "msg_01");
        assert!(matches!(
            settle("turn-3"),
            Err(AcpError::ForkPointUnresolved(_))
        ));
    }

    /// With no divider the run is named by a marker carrying when it began.
    /// Everything written before that finished; what was written after it is
    /// the run's own, such as a message the user steered in before its first
    /// reply, after which history draws no divider.
    #[test]
    fn a_woken_run_with_no_divider_starts_at_what_it_wrote() {
        let since = Utc::now();
        let marker = format!("pi-agent-turn-{}", since.timestamp_millis());
        // Seconds from the run's start, per turn.
        let stamp = |turns: &mut [MessageTurn], secs: &[i64]| {
            for (t, s) in turns.iter_mut().zip(secs) {
                t.timestamp = since + chrono::Duration::seconds(*s);
            }
        };
        let mut written = vec![
            turn("turn-0", TurnRole::User, "launch a scout", None),
            turn("turn-1", TurnRole::Assistant, "LAUNCHED", Some("msg_01")),
        ];
        stamp(&mut written, &[-60, -50]);
        assert_eq!(running_turn_start(&written, Some(&marker)), Some(2));

        let mut steered = written.clone();
        steered.push(turn("turn-2", TurnRole::User, "check the logs too", None));
        steered.push(turn("turn-3", TurnRole::Assistant, "found", Some("msg_02")));
        stamp(&mut steered, &[-60, -50, 5, 9]);
        assert_eq!(running_turn_start(&steered, Some(&marker)), Some(2));
        let pi = ForkAdapter {
            agent_type: AgentType::Pi,
            caps: ForkCapabilities {
                strict_point: true,
                while_running: true,
            },
        };
        let settle = |turn_id| {
            settle_mid_run_fork_point(Ok(steered.as_slice()), turn_id, pi, true, Some(&marker))
        };
        assert_eq!(settle("turn-1").unwrap().message_id, "msg_01");
        assert!(
            settle("turn-3").is_err(),
            "the run's reply is still being written"
        );
    }

    /// Only Claude Code is known to fork from a transcript another process is
    /// still writing without asking its adapter; every other agent waits for
    /// the turn to end unless its adapter says otherwise (pi, above).
    #[test]
    fn only_claude_code_forks_while_running() {
        assert!(forks_while_running(AgentType::ClaudeCode));
        let turns = running_history();
        for agent in [
            AgentType::Codex,
            AgentType::DeepSeek,
            AgentType::Pi,
            AgentType::Gemini,
            AgentType::Custom("acme"),
        ] {
            assert!(!forks_while_running(agent), "{agent}");
            let err = settle_mid_run_fork_point(Ok(turns.as_slice()), "turn-1", agent, true, None)
                .expect_err("refused up front");
            assert!(matches!(err, AcpError::ForkNeedsIdle), "{agent}: {err:?}");
            assert_eq!(err.code(), Some("fork_needs_idle"));
        }
    }

    #[test]
    fn before_edit_title_marks_the_original_branch_once() {
        assert_eq!(before_edit_title("Topic"), "Topic (before edit)");
        assert_eq!(
            before_edit_title("Topic (before edit)"),
            "Topic (before edit)",
            "editing inside a pre-edit branch must not stack the marker"
        );
        assert_eq!(before_edit_title("[Fork] Topic"), "[Fork] Topic (before edit)");
    }

    #[test]
    fn fork_base_title_strips_every_leading_marker() {
        assert_eq!(fork_base_title("Topic"), "Topic");
        assert_eq!(fork_base_title("[Fork] Topic"), "Topic");
        assert_eq!(fork_base_title("[Fork-3] Topic"), "Topic");
        assert_eq!(fork_base_title("[Fork]Topic"), "Topic");
        assert_eq!(fork_base_title("[Fork] [Fork-2] Topic"), "Topic");
        // Not markers: kept as part of the title.
        assert_eq!(fork_base_title("[Fork-0] Topic"), "[Fork-0] Topic");
        assert_eq!(fork_base_title("[Fork-x] Topic"), "[Fork-x] Topic");
        assert_eq!(fork_base_title("[Forked] Topic"), "[Forked] Topic");
        assert_eq!(fork_base_title("Topic [Fork]"), "Topic [Fork]");
    }

    #[test]
    fn numbered_fork_title_takes_the_first_free_number() {
        assert_eq!(numbered_fork_title("Topic", []), "[Fork] Topic");
        assert_eq!(numbered_fork_title("Topic", ["Topic"]), "[Fork] Topic");
        assert_eq!(
            numbered_fork_title("Topic", ["Topic", "[Fork] Topic"]),
            "[Fork-2] Topic"
        );
        assert_eq!(
            numbered_fork_title("Topic", ["[Fork] Topic", "[Fork-2] Topic", "[Fork-4] Topic"]),
            "[Fork-3] Topic"
        );
        // A gap at 1 is reused.
        assert_eq!(numbered_fork_title("Topic", ["[Fork-2] Topic"]), "[Fork] Topic");
        // Other bases do not count.
        assert_eq!(
            numbered_fork_title("Topic", ["[Fork] Other", "[Fork] Topic 2"]),
            "[Fork] Topic"
        );
        // The no-space and stacked legacy forms still occupy their number.
        assert_eq!(
            numbered_fork_title("Topic", ["[Fork]Topic", "[Fork-2] [Fork] Topic"]),
            "[Fork-3] Topic"
        );
    }

    #[test]
    fn numbered_fork_title_of_a_fork_does_not_stack_prefixes() {
        assert_eq!(
            numbered_fork_title("[Fork] Topic", ["Topic", "[Fork] Topic"]),
            "[Fork-2] Topic"
        );
        assert_eq!(
            numbered_fork_title("[Fork-2] Topic", ["[Fork] Topic", "[Fork-2] Topic"]),
            "[Fork-3] Topic"
        );
    }
}
