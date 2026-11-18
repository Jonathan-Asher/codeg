//! The model a conversation runs on, as its row's `model` column keeps it.
//!
//! The column is what every surface without the transcript at hand shows —
//! the sidebar card and hover, the canvas card, the `get_session_info` tool —
//! so it follows the model the session is actually on, not the one it
//! started with. Two kinds of event move it, in the order they happen:
//!
//! * the session's model selector changes (the user picks one, or the agent
//!   reports one it switched to itself, as a `/model` does): the selector's
//!   value, written by `acp::lifecycle::record_selector_state`;
//! * a transcript read sees a reply on a model other than the stored one: the
//!   newest reply's model, written by the conversation detail read.
//!
//! A reply older than the last selector change must not undo it: after a
//! switch, the newest reply in the transcript is still the old model's until
//! the agent answers on the new one. Selector changes are kept in memory for
//! that comparison; after a restart, the transcript's newest reply decides,
//! which is what the detail views show first anyway.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Utc};

use crate::models::message::{MessageTurn, TurnRole};

/// The "model" Claude Code stamps on the replies it writes itself (local
/// commands such as `/model`, API error notices). No model answered those.
pub const SYNTHETIC_MODEL: &str = "<synthetic>";

/// When each conversation's model selector last moved its `model` column.
static SELECTOR_CHANGES: LazyLock<Mutex<HashMap<i32, DateTime<Utc>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The model of the newest assistant reply in `turns` that a model wrote, and
/// when that reply was written (its end, or its start when it has none).
pub fn latest_reply_model(turns: &[MessageTurn]) -> Option<(String, DateTime<Utc>)> {
    turns
        .iter()
        .rev()
        .filter(|turn| matches!(turn.role, TurnRole::Assistant))
        .find_map(|turn| {
            let model = turn.model.as_deref()?.trim();
            if model.is_empty() || model == SYNTHETIC_MODEL {
                return None;
            }
            Some((
                model.to_string(),
                turn.completed_at.unwrap_or(turn.timestamp),
            ))
        })
}

/// Whether two spellings name the same model: equal but for case, surrounding
/// space, and the context-size tag a selector value carries and the
/// transcript's resolved id does not (`claude-fable-5-2[1m]` and
/// `claude-fable-5-2`). Such a pair is not a change, so it writes nothing.
pub fn same_model(a: &str, b: &str) -> bool {
    fn base(model: &str) -> String {
        let model = model.trim();
        let model = match model.rfind('[') {
            Some(at) if model.ends_with(']') => &model[..at],
            _ => model,
        };
        model.trim().to_ascii_lowercase()
    }
    base(a) == base(b)
}

/// Record that the selector moved `conversation_id`'s column at `at`.
pub fn note_selector_change(conversation_id: i32, at: DateTime<Utc>) {
    if let Ok(mut changes) = SELECTOR_CHANGES.lock() {
        changes.insert(conversation_id, at);
    }
}

/// Whether the selector moved `conversation_id`'s column after `at`.
fn selector_changed_after(conversation_id: i32, at: DateTime<Utc>) -> bool {
    SELECTOR_CHANGES
        .lock()
        .ok()
        .and_then(|changes| changes.get(&conversation_id).copied())
        .is_some_and(|changed| changed > at)
}

/// What the column becomes after a transcript read: the newest reply's model
/// when it names another model than `stored` and is not older than the last
/// selector change; `None` (no write) otherwise.
pub fn model_from_reply(
    conversation_id: i32,
    stored: Option<&str>,
    reply: Option<(&str, DateTime<Utc>)>,
) -> Option<String> {
    let (model, at) = reply?;
    let model = model.trim();
    if model.is_empty() || model == SYNTHETIC_MODEL {
        return None;
    }
    if stored.is_some_and(|stored| same_model(stored, model)) {
        return None;
    }
    if selector_changed_after(conversation_id, at) {
        return None;
    }
    Some(model.to_string())
}

/// What the column becomes after the session's selectors changed: the model
/// selector's value when it names another model than `stored`; `None` (no
/// write) otherwise.
pub fn model_from_selector(stored: Option<&str>, selector: Option<&str>) -> Option<String> {
    let model = selector?.trim();
    if model.is_empty() {
        return None;
    }
    if stored.is_some_and(|stored| same_model(stored, model)) {
        return None;
    }
    Some(model.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 18, 17, minute, 0).unwrap()
    }

    fn turn(role: TurnRole, model: Option<&str>, minute: u32) -> MessageTurn {
        MessageTurn {
            id: format!("turn-{minute}"),
            role,
            blocks: Vec::new(),
            timestamp: at(minute),
            usage: None,
            duration_ms: None,
            model: model.map(str::to_string),
            completed_at: None,
            agent_message_id: None,
            spoken: false,
        }
    }

    #[test]
    fn the_newest_reply_names_the_model_not_the_first() {
        let turns = vec![
            turn(TurnRole::User, None, 0),
            turn(TurnRole::Assistant, Some("claude-fable-5-1"), 1),
            turn(TurnRole::Assistant, Some("claude-opus-5-5"), 2),
            turn(TurnRole::User, None, 3),
            turn(TurnRole::Assistant, Some("claude-fable-5-2"), 4),
            // `/model` answered by Claude Code itself.
            turn(TurnRole::Assistant, Some(SYNTHETIC_MODEL), 5),
            turn(TurnRole::Assistant, None, 6),
        ];
        assert_eq!(
            latest_reply_model(&turns),
            Some(("claude-fable-5-2".to_string(), at(4)))
        );
        assert_eq!(latest_reply_model(&turns[..1]), None);
    }

    #[test]
    fn a_context_tag_or_case_is_not_another_model() {
        assert!(same_model("claude-fable-5-2[1m]", "claude-fable-5-2"));
        assert!(same_model(" GPT-5.5 ", "gpt-5.5"));
        assert!(!same_model("claude-fable-5-1", "claude-fable-5-2"));
    }

    #[test]
    fn a_stale_column_takes_the_newest_reply() {
        let id = 9_001;
        assert_eq!(
            model_from_reply(
                id,
                Some("claude-fable-5-1"),
                Some(("claude-fable-5-2", at(4)))
            ),
            Some("claude-fable-5-2".to_string())
        );
        assert_eq!(
            model_from_reply(id, None, Some(("claude-opus-5-5", at(4)))),
            Some("claude-opus-5-5".to_string())
        );
        // The same model, spelled the selector's way: nothing to write.
        assert_eq!(
            model_from_reply(
                id,
                Some("claude-fable-5-2[1m]"),
                Some(("claude-fable-5-2", at(4)))
            ),
            None
        );
        assert_eq!(model_from_reply(id, Some("x"), None), None);
    }

    #[test]
    fn a_reply_older_than_a_selector_change_does_not_undo_it() {
        let id = 9_002;
        note_selector_change(id, at(10));
        // Still the old model's reply: the switch stands.
        assert_eq!(
            model_from_reply(
                id,
                Some("claude-fable-5-2[1m]"),
                Some(("claude-opus-5-5", at(9)))
            ),
            None
        );
        // The first reply after it moves the column again.
        assert_eq!(
            model_from_reply(
                id,
                Some("claude-fable-5-2[1m]"),
                Some(("claude-haiku-5", at(11)))
            ),
            Some("claude-haiku-5".to_string())
        );
    }

    #[test]
    fn the_selector_writes_only_a_change() {
        assert_eq!(
            model_from_selector(Some("claude-fable-5-1"), Some("claude-fable-5-2[1m]")),
            Some("claude-fable-5-2[1m]".to_string())
        );
        assert_eq!(
            model_from_selector(Some("claude-fable-5-2"), Some("claude-fable-5-2[1m]")),
            None
        );
        assert_eq!(model_from_selector(None, Some(" ")), None);
        assert_eq!(model_from_selector(None, None), None);
        assert_eq!(
            model_from_selector(None, Some("opus")),
            Some("opus".to_string())
        );
    }
}
