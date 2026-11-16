//! The assistant roster as it crosses the companion socket
//! (`BrokerMessage::ListAssistants`), and the sentences both sides write from
//! it: the companion appends the roster to `delegate_to_agent`'s schema, and
//! codeg quotes it when a call names an assistant it cannot use. codeg
//! re-exports these at `acp::delegation::assistants`.

use serde::{Deserialize, Serialize};

/// One roster line as it crosses the companion socket (`ListAssistants`).
/// Carries what the delegating agent needs to pick an assistant — nothing of
/// its options or instructions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantRosterEntry {
    pub id: i32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The agent's wire name (`codex`, `claude_code`, …).
    pub agent_type: String,
    /// The agent's display name (`Codex CLI`), as the roster quotes it. Empty
    /// falls back to the wire name.
    #[serde(default)]
    pub agent_label: String,
}

impl AssistantRosterEntry {
    fn agent_name(&self) -> &str {
        if self.agent_label.is_empty() {
            &self.agent_type
        } else {
            &self.agent_label
        }
    }
}

/// Longest description quoted per roster line in the tool schema, in
/// characters: the list rides every session's tool description.
pub const ROSTER_DESCRIPTION_CAP: usize = 160;

fn capped(text: &str, cap: usize) -> String {
    let mut out: String = text.chars().take(cap).collect();
    if text.chars().count() > cap {
        out.push('…');
    }
    out
}

/// `3: Reviewer [Codex CLI] — reviews diffs` — one roster line, as both the
/// schema roster and the not-found refusal quote it.
fn roster_line(entry: &AssistantRosterEntry, with_description: bool) -> String {
    let mut line = format!("{}: {} [{}]", entry.id, entry.name, entry.agent_name());
    let description = entry.description.trim();
    if with_description && !description.is_empty() {
        line.push_str(" — ");
        line.push_str(&capped(description, ROSTER_DESCRIPTION_CAP));
    }
    line
}

/// The sentence appended to `assistant_id`'s schema description: who could be
/// delegated to when the session started. A hint only: an assistant created
/// later can still be used by its id.
pub fn roster_for_schema(roster: &[AssistantRosterEntry]) -> String {
    if roster.is_empty() {
        return " No assistants were configured when this session started; use this only \
                with an id taken from a `codeg://assistant/<number>` link in the user's message."
            .to_string();
    }
    let lines: Vec<String> = roster.iter().map(|e| roster_line(e, true)).collect();
    format!(
        " Assistants configured when this session started (id: name [agent] — when to use): {}. \
         An assistant created later can still be used by its id.",
        lines.join("; ")
    )
}

/// The refusal a call naming an unusable assistant gets. It names the
/// assistants that ARE usable and tells the agent not to fall back to an agent
/// of its choosing: that would drop the assistant's options and instructions
/// without the user ever knowing.
pub fn assistant_not_found_message(asked: &str, roster: &[AssistantRosterEntry]) -> String {
    let available = if roster.is_empty() {
        "There are no usable assistants right now.".to_string()
    } else {
        let lines: Vec<String> = roster.iter().map(|e| roster_line(e, false)).collect();
        format!("Usable assistants: {}.", lines.join("; "))
    };
    format!(
        "No usable assistant {asked}: it does not exist, was deleted, or is disabled. \
         {available} Do not delegate this to another agent instead — tell the user."
    )
}
