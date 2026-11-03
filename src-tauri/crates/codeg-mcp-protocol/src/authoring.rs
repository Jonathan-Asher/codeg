//! The `create_automation` and `create_work_task` requests the companion
//! parses out of the tool arguments, and the bounds it applies. codeg's
//! `acp::chat_authoring` (and `models::AutomationAction`) re-export them.

use serde::{Deserialize, Serialize};

/// Cap on an automation name / task title. Long enough for a descriptive
/// sentence, short enough that a board card and the automations list stay
/// readable. Over-long input is truncated, never rejected — the LLM's intent is
/// still honored.
pub const MAX_TITLE_CHARS: usize = 120;

/// Cap on the stored prompt body. Generous (a full task briefing is welcome)
/// but bounded so a runaway generation can't push a multi-megabyte blob into
/// the config JSON.
pub const MAX_PROMPT_CHARS: usize = 20_000;

/// What firing the automation does. Lives inside the config blob (not a
/// column) so every pre-existing row deserializes as the legacy default —
/// nothing queries automations by action.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationAction {
    /// Launch a headless agent session (the original behavior).
    #[default]
    LaunchSession,
    /// Enqueue a work task (status todo) on the target folder's board; the
    /// work-task engine owns the actual execution.
    EnqueueTask,
}

/// A validated `create_automation` request. The companion has already checked
/// the required strings are non-empty; ranges/enums are re-checked by the
/// automation service at save.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAutomationSpec {
    pub name: String,
    pub prompt: String,
    /// 5- or 6-field cron. `None` → a manual-trigger automation (run from the
    /// Automations page on demand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// IANA zone name. `None` → the host's detected zone (see
    /// codeg's `chat_authoring::local_timezone`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// What firing does: start a headless session, or queue a board task.
    #[serde(default)]
    pub action: AutomationAction,
    /// Agent wire slug. `None` → the target folder's default agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Absolute path of the target project. `None` → the caller's own folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub enabled: bool,
}

/// A validated `create_work_task` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewWorkTaskSpec {
    pub title: String,
    pub prompt: String,
    /// Per-task agent override. `None` → inherit the board's settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Absolute path of the target project. `None` → the caller's own folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
}

/// Truncate to at most `cap` characters (character-, not byte-counted, so a
/// multi-byte name is never split mid-codepoint).
pub fn truncate_chars(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    s.chars().take(cap).collect()
}
