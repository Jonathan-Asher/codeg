//! ACP `session/fork` support.
//!
//! The request is the schema's typed `ForkSessionRequest` (behind
//! `unstable_session_fork`). It goes out untyped for the one reason
//! `session/new` and `session/resume` do: grok's top-level `models` has no field
//! on the typed response, so [`send_capturing_models`] reads it off the raw
//! reply first.

use agent_client_protocol::schema::v1::{
    ForkSessionRequest, ForkSessionResponse, Meta, SessionId, AGENT_METHOD_NAMES,
};
use agent_client_protocol::{Agent, ConnectionTo};
use serde::Deserialize;

use crate::acp::connection::send_capturing_models;

use crate::acp::error::AcpError;
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
/// * **codex-acp 1.8.0** first matches `message_id` against `items[].id`, then
///   falls back to hashing each agent message and taking the
///   `message_occurrence`-th match. Codex rollout files record NO item ids, so
///   codeg cannot produce one it would recognise — the fingerprint is the only
///   path that resolves there, and `message_id` is sent as codeg's own turn id
///   purely because the field is required.
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
        // Codex rollouts carry no item ids, so the id can never match and the
        // fingerprint is the only thing that resolves. `message_id` is still
        // required by the wire contract, so it carries codeg's own turn id —
        // deliberately something codex will not find, which is exactly what
        // makes it fall through to the fingerprint branch.
        AgentType::Codex => {
            let text = turn_text(turn);
            if text.trim().is_empty() {
                return None;
            }
            let fingerprint = fingerprint_agent_message(&text);
            let occurrence = fingerprint_occurrence(turns, idx, &fingerprint);
            Some(ForkPoint {
                message_id: turn_id.to_string(),
                message_fingerprint: Some(fingerprint),
                message_occurrence: u32::try_from(occurrence).ok(),
            })
        }
        // DeepSeek and Claude 0.75.1 both read the two halves in the same
        // order, so both are sent. The id resolves on its own whenever the
        // transcript named the message, and the fingerprint is what still
        // resolves when it did not — a DeepSeek log written without an `id` or
        // a parse that began mid-log; on Claude, a fork point that has drifted
        // off the active parentUuid chain onto an abandoned branch. Sending the
        // fingerprint alongside an id costs nothing: both adapters stop at the
        // first id that matches and never look at it.
        //
        // Pi (pi-acp ≥ our fork) resolves by fingerprint only: its adapter
        // hashes the normalized text of each assistant message in the linear
        // transcript and forks from the first user message AFTER the match
        // (pi's fork RPC takes a user-message entryId). The id half is sent
        // but ignored there; the empty-text guard below still matters — a
        // textless turn would hash to the empty-string digest.
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

/// What a fork is for. Decides what happens when the chosen fork point cannot
/// be named, and how the two rows the fork leaves behind are titled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkMode {
    /// "Fork from here": branch the conversation at a reply. A point the agent
    /// cannot name degrades to a tail fork rather than refusing the click, and
    /// the forked row is marked `[Fork]`.
    #[default]
    Branch,
    /// "Edit message": fork at the reply just BEFORE a message the user is
    /// rewriting, then send the edited text there. The fork has to end exactly
    /// at that reply — a tail fork still holds the message being replaced, so
    /// the edit would continue the wrong conversation — which makes a point
    /// that cannot be named an error, never a fallback. The forked row keeps
    /// its title (it IS the conversation being edited), locked so a title the
    /// forked transcript carries can't replace it, and the sibling that
    /// preserves the original branch is named `<title> (before edit)`.
    Edit,
}

/// Whether this agent's adapter forks EXACTLY at a named message or refuses —
/// the only kind of fork an edit can be built on.
///
/// The `ClaudeCode`, `Codex` and `DeepSeek` adapters all answer
/// `invalid_params` when they cannot resolve the point. Pi's adapter matches by
/// fingerprint too, but forks at the tail when nothing matches, so a miss there
/// looks exactly like a hit. Every other agent has no fork point at all.
pub fn honours_fork_point_strictly(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::ClaudeCode | AgentType::Codex | AgentType::DeepSeek)
}

/// Settle where a fork aimed at `turn_id` lands, given the conversation's
/// parsed turns — or why they could not be read.
///
/// `Ok(None)` is a tail fork. [`ForkMode::Branch`] degrades to it whenever the
/// point cannot be named, as "fork from here" always has; [`ForkMode::Edit`]
/// refuses instead, for the reason given on the variant.
pub fn settle_fork_point(
    turns: Result<&[MessageTurn], &str>,
    turn_id: &str,
    agent_type: AgentType,
    mode: ForkMode,
) -> Result<Option<ForkPoint>, AcpError> {
    let strict = mode == ForkMode::Edit;
    if strict && !honours_fork_point_strictly(agent_type) {
        return Err(AcpError::ForkPointUnresolved(format!(
            "{agent_type} cannot fork a session at a chosen message"
        )));
    }
    match turns {
        Ok(turns) => match resolve_fork_point(turns, turn_id, agent_type) {
            Some(point) => Ok(Some(point)),
            // Not found, or found but with nothing the agent could match it by
            // (see `resolve_fork_point`) — either way there is no exact point.
            None if strict => Err(AcpError::ForkPointUnresolved(
                "the agent cannot fork at the reply before this message".to_string(),
            )),
            None => Ok(None),
        },
        Err(reason) if strict => Err(AcpError::ForkPointUnresolved(format!(
            "the conversation could not be read ({reason})"
        ))),
        Err(_) => Ok(None),
    }
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
/// The fork names no MCP servers, on purpose. It is not the request that makes
/// the forked session usable: `handle_fork_or_exit` resumes it straight away,
/// with the connection's servers, and every adapter checked mounts them there.
/// Naming them on the fork too only starts them twice — codex-acp 1.13 builds
/// the forked thread from the fork's list, then the resume finds that thread
/// idle and unsubscribed and cold-restarts it with the resume's config;
/// glm-acp-agent connects them on the fork and reconnects on the resume;
/// deepseek-acp mounts them on a session handle the resume replaces with a new
/// one. claude-agent-acp ignores the field. When there is no resume — the agent
/// does not advertise it, or it fails — the fork is attached as-is, without
/// servers, as it always has been.
///
/// `fork_point` forks at a chosen message instead of the tail; see [`ForkPoint`].
/// An agent that does not implement it ignores the unknown `_meta` key, so this
/// is inert rather than an error wherever it isn't understood. An agent that
/// DOES implement it but cannot resolve the point answers `invalid_params`,
/// which surfaces as a fork failure the user can retry from a different turn.
pub async fn fork_session(
    cx: &ConnectionTo<Agent>,
    session_id: &SessionId,
    cwd: &str,
    fork_point: Option<&ForkPoint>,
) -> Result<(ForkSessionResponse, Option<serde_json::Value>), AcpError> {
    send_capturing_models(
        cx,
        AGENT_METHOD_NAMES.session_fork,
        build_fork_request(session_id, cwd, fork_point),
    )
    .await
    .map_err(|e| AcpError::protocol(format!("session/fork failed: {e}")))
}

fn build_fork_request(
    session_id: &SessionId,
    cwd: &str,
    fork_point: Option<&ForkPoint>,
) -> ForkSessionRequest {
    let req = ForkSessionRequest::new(session_id.clone(), cwd);
    match fork_point {
        Some(point) => req.meta(point.to_meta()),
        None => req,
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
            "/work",
            Some(&point),
        ))
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "sessionId": "sess-1",
                "cwd": "/work",
                "_meta": {"jetbrains": {"air": {"fork": {
                    "version": 1,
                    "messageId": "msg_01",
                    "messageFingerprint": "sha256:ab",
                    "messageOccurrence": 2,
                }}}},
            })
        );
    }

    /// A tail fork is the bare request: no fork point, and no MCP servers — the
    /// resume that follows every fork is what mounts them (see
    /// [`fork_session`]), so naming them here would start them twice.
    #[test]
    fn a_tail_fork_names_neither_a_fork_point_nor_mcp_servers() {
        let wire =
            serde_json::to_value(build_fork_request(&SessionId::new("sess-1"), "/work", None))
                .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"sessionId": "sess-1", "cwd": "/work"})
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

    /// The fingerprint is the only thing that can resolve on codex, so a turn
    /// with no text to hash is not a fork point.
    #[test]
    fn codex_declines_a_turn_with_no_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::Text { text: "   ".into() }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::Codex).is_none());
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
        for mode in [ForkMode::Branch, ForkMode::Edit] {
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
        let err = settle("turn-9", AgentType::ClaudeCode, ForkMode::Edit)
            .expect_err("an unknown turn must not become a tail fork");
        assert!(matches!(err, AcpError::ForkPointUnresolved(_)), "got {err:?}");
        assert_eq!(err.code(), Some("fork_point_unresolved"));

        // A user turn is never a fork point, so aiming an edit at one is the
        // same miss — never "fork up to and including the message".
        assert!(settle("turn-2", AgentType::ClaudeCode, ForkMode::Edit).is_err());
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
    /// edit; pi-acp falls back to the tail, which would look like success.
    #[test]
    fn edit_is_limited_to_agents_that_honour_the_point_strictly() {
        for agent in [AgentType::ClaudeCode, AgentType::Codex, AgentType::DeepSeek] {
            assert!(honours_fork_point_strictly(agent), "{agent}");
        }
        for agent in [AgentType::Pi, AgentType::Gemini, AgentType::Custom("acme")] {
            assert!(!honours_fork_point_strictly(agent), "{agent}");
        }
        // Refused up front — even a turn pi COULD fingerprint…
        assert!(matches!(
            settle("turn-1", AgentType::Pi, ForkMode::Edit),
            Err(AcpError::ForkPointUnresolved(_))
        ));
        // …while "fork from here" on pi is unchanged.
        assert!(settle("turn-1", AgentType::Pi, ForkMode::Branch)
            .unwrap()
            .is_some());
    }

    /// The wire form both transports send.
    #[test]
    fn fork_mode_reads_its_wire_names() {
        assert_eq!(
            serde_json::from_value::<ForkMode>(serde_json::json!("edit")).unwrap(),
            ForkMode::Edit
        );
        assert_eq!(
            serde_json::from_value::<ForkMode>(serde_json::json!("branch")).unwrap(),
            ForkMode::Branch
        );
        // An absent mode is a plain branch — every caller that predates edit.
        assert_eq!(ForkMode::default(), ForkMode::Branch);
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
}
