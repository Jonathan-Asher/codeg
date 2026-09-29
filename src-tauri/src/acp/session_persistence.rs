//! Whether the agent may keep its own record of a session.
//!
//! Every agent writes its conversation to its own store (Claude Code:
//! `~/.claude/projects/<cwd>/<session>.jsonl`), and codeg reads history back
//! from there. A Quick Ask "private" question is the one case where that record
//! is unwanted: the user asked for an answer that is not saved anywhere.
//!
//! The switch rides the per-launch `runtime_env`, like
//! [`HostToolsPolicy`](crate::acp::host_tools_policy::HostToolsPolicy): the
//! connect command stamps it, `spawn_agent_connection` reads it back, and
//! `run_connection` turns it into the agent-specific request. It is a
//! per-launch key, never a setting — `fingerprint_config` skips it, so a
//! private session is not reported as running on stale configuration.
//!
//! Only agents that expose a way to turn their transcript off honour it.
//! Today that is Claude Code, whose SDK takes `persistSession: false` (the
//! `--no-session-persistence` CLI flag) through the ACP adapter's
//! `_meta.claudeCode.options`. Every other agent keeps writing its own record,
//! which the Quick Ask cleanup removes afterwards where it can.

use std::collections::BTreeMap;

/// Per-launch `runtime_env` key. Only [`SESSION_PERSISTENCE_OFF`] means
/// anything; any other value (or none) leaves the agent's default alone.
pub(crate) const SESSION_PERSISTENCE_ENV: &str = "CODEG_SESSION_PERSISTENCE";

/// The value that asks the agent not to keep a transcript.
pub(crate) const SESSION_PERSISTENCE_OFF: &str = "off";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionPersistence {
    /// The agent keeps its own record, as it always has.
    #[default]
    Default,
    /// Ask the agent not to write a transcript at all.
    Off,
}

impl SessionPersistence {
    /// Read the per-launch key. Deliberately NOT falling back to codeg's own
    /// process env: a stray variable must never make every session vanish.
    pub fn from_env(runtime_env: &BTreeMap<String, String>) -> Self {
        match runtime_env.get(SESSION_PERSISTENCE_ENV).map(|v| v.trim()) {
            Some(value) if value.eq_ignore_ascii_case(SESSION_PERSISTENCE_OFF) => Self::Off,
            _ => Self::Default,
        }
    }

    /// Stamp a launch as private. Idempotent.
    pub fn mark_off(runtime_env: &mut BTreeMap<String, String>) {
        runtime_env.insert(
            SESSION_PERSISTENCE_ENV.to_string(),
            SESSION_PERSISTENCE_OFF.to_string(),
        );
    }

    /// The Claude Code SDK options this setting contributes to
    /// `_meta.claudeCode.options` on `session/new`, or `None` when there is
    /// nothing to add. The adapter spreads these straight into the SDK's
    /// `query()` options, and the SDK turns `persistSession: false` into
    /// `--no-session-persistence`.
    pub fn claude_session_options(self) -> Option<serde_json::Map<String, serde_json::Value>> {
        match self {
            Self::Default => None,
            Self::Off => {
                let mut options = serde_json::Map::new();
                options.insert("persistSession".to_string(), serde_json::Value::Bool(false));
                Some(options)
            }
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::Default => "agent default",
            Self::Off => "off (private)",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_key_keeps_the_default() {
        assert_eq!(
            SessionPersistence::from_env(&BTreeMap::new()),
            SessionPersistence::Default
        );
    }

    #[test]
    fn off_is_read_back_case_insensitively() {
        let mut env = BTreeMap::new();
        env.insert(SESSION_PERSISTENCE_ENV.to_string(), " OFF ".to_string());
        assert_eq!(SessionPersistence::from_env(&env), SessionPersistence::Off);
    }

    #[test]
    fn unknown_values_keep_the_default() {
        let mut env = BTreeMap::new();
        env.insert(SESSION_PERSISTENCE_ENV.to_string(), "on".to_string());
        assert_eq!(
            SessionPersistence::from_env(&env),
            SessionPersistence::Default
        );
    }

    #[test]
    fn mark_off_round_trips() {
        let mut env = BTreeMap::new();
        SessionPersistence::mark_off(&mut env);
        SessionPersistence::mark_off(&mut env);
        assert_eq!(env.len(), 1);
        assert_eq!(SessionPersistence::from_env(&env), SessionPersistence::Off);
    }

    #[test]
    fn only_off_adds_claude_options() {
        assert!(SessionPersistence::Default
            .claude_session_options()
            .is_none());
        let options = SessionPersistence::Off
            .claude_session_options()
            .expect("off contributes options");
        assert_eq!(
            options.get("persistSession"),
            Some(&serde_json::Value::Bool(false))
        );
    }
}
