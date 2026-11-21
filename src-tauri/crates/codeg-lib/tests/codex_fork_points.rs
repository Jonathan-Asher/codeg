//! The fork points codeg would send codex-acp for real Codex sessions, written
//! out so they can be checked against codex itself.
//!
//! `acp::fork` names a Codex fork point by codex's item id and by the hash and
//! occurrence of one agent message's text, all of which have to agree with what
//! codex's app-server reports for the same session (`thread/read`). Unit tests
//! pin the shapes; only codex can say whether a real rollout lines up. This
//! harness parses the sessions given and writes, for every reply, the point an
//! edit of the message after it would send (or why it would be refused), and
//! for every agent message the point "fork from here" would send. Feed that to
//! codex-acp `session/fork` (and compare with `thread/read`) in a scratch
//! `CODEX_HOME`, never the real one.
//!
//! `#[ignore]`d, and it skips itself without its inputs:
//!
//! ```sh
//! CODEG_CODEX_FORK_SESSIONS=/scratch/codex-home/sessions \
//! CODEG_CODEX_FORK_IDS=<session id>[,<session id>…] \
//! CODEG_CODEX_FORK_OUT=/tmp/codex-fork-points.json \
//!   cargo test --features test-utils --test codex_fork_points -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use codeg_lib::acp::fork::{
    fingerprint_agent_message, resolve_fork_point, settle_fork_point, ForkMode,
};
use codeg_lib::models::{AgentType, ContentBlock, MessageTurn, TurnRole};
use codeg_lib::parsers::codex::CodexParser;
use codeg_lib::parsers::AgentParser;
use serde_json::json;

fn text_of(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn point_json(point: Option<codeg_lib::acp::fork::ForkPoint>) -> serde_json::Value {
    match point {
        Some(point) => json!({
            "messageId": point.message_id,
            "messageFingerprint": point.message_fingerprint,
            "messageOccurrence": point.message_occurrence,
        }),
        None => serde_json::Value::Null,
    }
}

#[test]
#[ignore = "requires real Codex rollouts; see module docs"]
fn codex_fork_points_of_real_sessions() {
    let (Ok(sessions), Ok(ids)) = (
        std::env::var("CODEG_CODEX_FORK_SESSIONS"),
        std::env::var("CODEG_CODEX_FORK_IDS"),
    ) else {
        eprintln!("CODEG_CODEX_FORK_SESSIONS / CODEG_CODEX_FORK_IDS unset — skipping");
        return;
    };
    let out = std::env::var("CODEG_CODEX_FORK_OUT")
        .unwrap_or_else(|_| "/tmp/codex-fork-points.json".to_string());
    let parser = CodexParser::with_base_dir(PathBuf::from(sessions));

    let mut report = serde_json::Map::new();
    for id in ids.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        let detail = parser.get_conversation(id).expect("the session parses");
        let turns = &detail.turns;

        let messages: Vec<serde_json::Value> = turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::Assistant))
            .filter(|t| t.agent_message_id.is_some() || !text_of(t).trim().is_empty())
            .map(|t| {
                json!({
                    "turnId": t.id,
                    "agentMessageId": t.agent_message_id,
                    "textFingerprint": fingerprint_agent_message(&text_of(t)),
                    "point": point_json(resolve_fork_point(turns, &t.id, AgentType::Codex)),
                })
            })
            .collect();

        // What an edit of each user message forks at: the turn before it,
        // stepping over empty ones, as `resolveEditForkPointInTranscript` does.
        let mut edits = Vec::new();
        for (at, user) in turns.iter().enumerate() {
            if !matches!(user.role, TurnRole::User) {
                continue;
            }
            let Some(before) = turns[..at].iter().rev().find(|t| !t.blocks.is_empty()) else {
                continue;
            };
            let edit = if matches!(before.role, TurnRole::Assistant) {
                match settle_fork_point(
                    Ok(turns.as_slice()),
                    &before.id,
                    AgentType::Codex,
                    ForkMode::Edit,
                ) {
                    Ok(point) => json!({ "point": point_json(point) }),
                    Err(e) => json!({ "refused": e.to_string() }),
                }
            } else {
                json!({ "refused": "the message does not follow a reply" })
            };
            let mut entry = json!({
                "userTurnId": user.id,
                "userText": text_of(user).chars().take(80).collect::<String>(),
                "forkFromTurnId": before.id,
            });
            entry
                .as_object_mut()
                .expect("an object")
                .extend(edit.as_object().cloned().unwrap_or_default());
            edits.push(entry);
        }

        eprintln!(
            "{id}: {} turns, {} agent messages, {} edits",
            turns.len(),
            messages.len(),
            edits.len()
        );
        report.insert(
            id.to_string(),
            json!({ "turnCount": turns.len(), "messages": messages, "edits": edits }),
        );
    }
    std::fs::write(&out, serde_json::to_string_pretty(&report).expect("json"))
        .expect("write the report");
    eprintln!("wrote {out}");
}
