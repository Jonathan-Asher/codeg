//! A Claude Code sub-agent's own thread, opened in a tab of its own.
//!
//! An Agent (`Task`) card in a Claude Code session shows only the sub-agent's
//! steps. Its whole thread — prompt, thinking, every message and tool call —
//! is in its own transcript beside the session's
//! (`parsers::claude::subagent_thread`); this reads it into the same
//! [`DbConversationDetail`] a session's tab renders, re-read on each call
//! through the transcript cache (only what was appended since is parsed), and
//! says whether the sub-agent is still at work, so the tab knows to keep
//! reading.

use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::db::service::{agent_setting_service, conversation_service};
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::models::{AgentType, DbConversationDetail, DbConversationSummary, TurnRole};
use crate::parsers::claude::subagent_thread::SubagentThread;
use crate::parsers::claude::ClaudeParser;
use crate::parsers::ParseError;

/// A sub-agent's thread, as its tab shows it.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSubagentThread {
    /// Its `agentId`: names its transcript, and the tab passes it back so
    /// the next read goes straight to the file.
    pub agent_id: String,
    /// `general-purpose`, `Explore`, `fork`, … (its meta file's `agentType`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    /// What the Agent call asked of it, in a few words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Still at work: read it again in a moment.
    pub running: bool,
    /// The title of the session it is a sub-agent of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_title: Option<String>,
    /// Its transcript, in the shape a session's tab renders. The summary is
    /// the parent session's row re-labelled for the sub-agent: no external id
    /// (it is no session of its own and must never be mistaken for the
    /// parent's), `parent_id` and `parent_tool_use_id` naming where it came
    /// from.
    pub detail: DbConversationDetail,
}

/// The thread of the sub-agent that the Agent call `tool_call_id` of the
/// Claude Code conversation `conversation_id` launched. `agent_id` is the
/// sub-agent's id when the caller knows it (the card's `subagent_id`, a launch
/// acknowledgement, an earlier answer); without it the call is looked up in
/// the sub-agents' meta files, which is how a running foreground call is
/// found. `None` while the sub-agent has written no transcript.
pub async fn get_claude_subagent_thread_core(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
    tool_call_id: String,
    agent_id: Option<String>,
) -> Result<Option<ClaudeSubagentThread>, AppCommandError> {
    if tool_call_id.is_empty() && agent_id.is_none() {
        return Err(AppCommandError::invalid_input(
            "A sub-agent is named by its Agent call or its id",
        ));
    }
    let parent = conversation_service::get_by_id(conn, conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    if parent.agent_type != AgentType::ClaudeCode {
        return Err(AppCommandError::invalid_input(
            "Only a Claude Code conversation has sub-agent threads",
        ));
    }
    let Some(session_id) = parent.external_id.clone() else {
        return Ok(None);
    };
    // Where this Claude keeps its sessions (a `CLAUDE_CONFIG_DIR` in its
    // settings moves them), exactly as its conversation is read.
    let env = agent_setting_service::load_agent_env(conn, AgentType::ClaudeCode).await;
    let call = tool_call_id.clone();
    let thread = tokio::task::spawn_blocking(move || {
        ClaudeParser::for_env(&env).subagent_thread(&session_id, &call, agent_id.as_deref())
    })
    .await
    .map_err(|e| {
        AppCommandError::task_execution_failed("Failed to read the sub-agent's transcript")
            .with_detail(e.to_string())
    })?;
    match thread {
        Ok(thread) => Ok(thread.map(|thread| shape(parent, tool_call_id, thread))),
        // The session's own transcript is gone: so is any thread of it.
        Err(ParseError::ConversationNotFound(_)) => Ok(None),
        Err(ParseError::Io(err)) => Err(AppCommandError::io(err)),
        Err(err) => Err(AppCommandError::invalid_input(
            "Failed to read the sub-agent's transcript",
        )
        .with_detail(err.to_string())),
    }
}

fn shape(
    parent: DbConversationSummary,
    tool_call_id: String,
    thread: SubagentThread,
) -> ClaudeSubagentThread {
    let SubagentThread {
        agent_id,
        meta,
        detail,
        running,
    } = thread;
    let meta = meta.unwrap_or_default();
    let description = meta.description;
    let parent_title = parent.title.clone();
    let parsed = &detail.summary;
    let summary = DbConversationSummary {
        id: parent.id,
        title: description.clone().or_else(|| parsed.title.clone()),
        title_locked: true,
        model: parsed.model.clone().or(parent.model.clone()),
        git_branch: parsed.git_branch.clone().or(parent.git_branch.clone()),
        external_id: None,
        message_count: detail.turns.len() as u32,
        child_count: 0,
        parent_id: Some(parent.id),
        parent_tool_use_id: (!tool_call_id.is_empty()).then_some(tool_call_id),
        delegation_call_id: None,
        status: if running { "in_progress" } else { "completed" }.to_string(),
        background: None,
        tag_ids: Vec::new(),
        ..parent
    };
    // Still at work: its opening prompt is the turn in flight, so the calls
    // it has not had answered yet draw as running rather than as done.
    let in_flight_user_turn_id = if running {
        detail
            .turns
            .iter()
            .find(|turn| matches!(turn.role, TurnRole::User))
            .map(|turn| turn.id.clone())
    } else {
        None
    };
    ClaudeSubagentThread {
        agent_id,
        subagent_type: meta.agent_type,
        description,
        running,
        parent_title,
        detail: DbConversationDetail {
            summary,
            turns: detail.turns.clone(),
            session_stats: detail.session_stats.clone(),
            transcript_watermark: detail.transcript_watermark,
            in_flight_user_turn_id,
            turns_offset: None,
            turns_total: None,
            assistant_turns_before_offset: None,
            user_turns_before_offset: None,
            prefix_hash: None,
            uncovered_prefix_max_ts: None,
            history_unavailable: None,
        },
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_claude_subagent_thread(
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    tool_call_id: String,
    agent_id: Option<String>,
) -> Result<Option<ClaudeSubagentThread>, AppCommandError> {
    get_claude_subagent_thread_core(&db.conn, conversation_id, tool_call_id, agent_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};

    #[tokio::test]
    async fn only_a_claude_code_conversation_has_sub_agent_threads() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-subagent-test").await;
        let codex = seed_conversation(&db, folder, AgentType::Codex).await;
        let err = get_claude_subagent_thread_core(&db.conn, codex, "toolu_1".into(), None)
            .await
            .expect_err("not a Claude Code conversation");
        assert!(matches!(
            err.code,
            crate::app_error::AppErrorCode::InvalidInput
        ));
    }

    #[tokio::test]
    async fn a_conversation_with_no_session_yet_has_no_thread() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-subagent-test").await;
        let claude = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let thread = get_claude_subagent_thread_core(&db.conn, claude, "toolu_1".into(), None)
            .await
            .expect("read");
        assert!(thread.is_none());
    }

    #[tokio::test]
    async fn a_call_or_an_id_is_required() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-subagent-test").await;
        let claude = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        assert!(
            get_claude_subagent_thread_core(&db.conn, claude, String::new(), None)
                .await
                .is_err()
        );
    }
}
