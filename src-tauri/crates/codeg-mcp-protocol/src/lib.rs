//! What codeg and its `codeg-mcp` companion have to agree on: the broker
//! socket's frames and messages ([`transport`]), the requests those messages
//! carry ([`question`], [`authoring`], [`browser`]), and the names and limits
//! both sides use ([`features`], [`flags`], [`MAX_SESSION_MESSAGES`]).
//!
//! Both depend on this crate, so the companion builds without codeg's
//! library. codeg re-exports every item at the path it had before the split
//! (`acp::delegation::transport`, `acp::question`, `browser::agent`, …).
//!
//! There is no protocol version: codeg and the companion ship from the same
//! commit, in the same bundle, image or archive (see [`transport`]).

pub mod authoring;
pub mod browser;
pub mod question;
pub mod transport;

/// Hard cap on how many recent turns a single `get_session_info` call may
/// request. The companion clamps the agent-supplied `max_messages` to this, and
/// the resolver treats it as the authoritative ceiling so a pathological value
/// can't blow up the UDS frame or the LLM context.
pub const MAX_SESSION_MESSAGES: u32 = 200;

/// The tool groups of a companion launch: the comma-separated values of its
/// `--features` flag. codeg writes them (`acp::connection`), lists them in the
/// settings status (`commands::mcp_service`), and the companion reads them
/// (`CompanionFeatures::parse`); an unknown one is ignored.
pub mod features {
    /// `delegate_to_agent`, `get_delegation_status`, `cancel_delegation`,
    /// `resume_delegation`.
    pub const DELEGATION: &str = "delegation";
    /// `check_user_feedback`.
    pub const FEEDBACK: &str = "feedback";
    /// `ask_user_question`.
    pub const ASK: &str = "ask";
    /// `get_session_info`.
    pub const SESSIONS: &str = "sessions";
    /// `task_progress` / `task_complete`, for sessions the work-task engine
    /// launched.
    pub const TASKS: &str = "tasks";
    /// `create_automation`.
    pub const AUTOMATIONS: &str = "automations";
    /// `create_work_task`.
    pub const TASKBOARD: &str = "taskboard";
    /// The built-in browser's tab, snapshot, console, screenshot and action
    /// tools.
    pub const BROWSER: &str = "browser";
    /// `browser_eval`; only ever together with [`BROWSER`].
    pub const BROWSER_EVAL: &str = "browser_eval";
}

/// The companion's command-line flags, as codeg passes them in the agent's
/// MCP config.
pub mod flags {
    /// codeg's ACP connection id of the session the companion serves.
    pub const PARENT_CONNECTION_ID: &str = "--parent-connection-id";
    /// The broker's socket (Unix) or named pipe (Windows).
    pub const SOCKET_PATH: &str = "--socket-path";
    /// The per-launch secret every broker message carries.
    pub const TOKEN: &str = "--token";
    /// The codeg process to watch; the companion exits when it is gone.
    pub const PARENT_PID: &str = "--parent-pid";
    /// The tool groups to expose, from [`crate::features`], comma-separated.
    pub const FEATURES: &str = "--features";
    /// `custom:<id>` agents to offer as `delegate_to_agent` targets.
    pub const CUSTOM_AGENTS: &str = "--custom-agents";
    /// Built-in agents switched off in settings, left out of those targets.
    pub const DISABLED_AGENTS: &str = "--disabled-agents";
}
