//! A Claude Code sub-agent's own thread, read like a session of its own.
//!
//! Every sub-agent an `Agent` (`Task`) call launches writes its conversation to
//! `<session>/subagents/agent-<agentId>.jsonl`, in the session's own record
//! format, next to an `agent-<agentId>.meta.json` naming the call that
//! launched it (`toolUseId`), its type and description, and — once it is done,
//! on recent CLIs — `"finished": true`.
//!
//! How an Agent call leads to its file:
//! * once the call has a result, `toolUseResult.agentId` on it (a foreground
//!   call's report, a background call's launch acknowledgement). The session
//!   parser records it on the card ([`AgentExecutionStats::subagent_id`],
//!   only while the file is there), and the live card reads the same id out of
//!   the result text;
//! * while a foreground call runs nothing in the session names the file yet,
//!   and the meta file's `toolUseId` is the link.
//!
//! The file is parsed by the session parser, through the transcript cache and
//! keyed by its own path, so a running sub-agent's growing file is read
//! incrementally exactly like a running session's.
//!
//! [`AgentExecutionStats::subagent_id`]: crate::models::AgentExecutionStats::subagent_id

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use super::{
    find_session_file_in, subagent_dir_of, transcript_cache, ClaudeParser, BACKGROUND_TASK_MARKER,
};
use crate::models::{ContentBlock, ConversationDetail, MessageTurn};
use crate::parsers::{is_safe_subagent_id, CacheUse, Need, ParseError};

/// What a sub-agent's `.meta.json` says about it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SubagentMeta {
    /// `general-purpose`, `Explore`, `fork`, a custom agent's name.
    pub agent_type: Option<String>,
    /// The `description` the Agent call gave it.
    pub description: Option<String>,
    /// The Agent call that launched it.
    pub tool_use_id: Option<String>,
    /// `Some(true)` once it is done; absent while it runs, and on CLIs that
    /// predate the field.
    pub finished: Option<bool>,
}

fn read_meta(path: &Path) -> Option<SubagentMeta> {
    let raw = fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(SubagentMeta {
        agent_type: text("agentType"),
        description: text("description"),
        tool_use_id: text("toolUseId"),
        finished: value.get("finished").and_then(|v| v.as_bool()),
    })
}

fn transcript_path(dir: &Path, agent_id: &str) -> PathBuf {
    dir.join(format!("agent-{agent_id}.jsonl"))
}

fn meta_path(dir: &Path, agent_id: &str) -> PathBuf {
    dir.join(format!("agent-{agent_id}.meta.json"))
}

/// A sub-agent's transcript, found for the Agent call that launched it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubagentFile {
    pub agent_id: String,
    pub path: PathBuf,
    pub meta: Option<SubagentMeta>,
}

/// The transcript in `dir` (a session's `subagents/` directory) of the
/// sub-agent the Agent call `tool_use_id` launched. `agent_id`, when the caller
/// already knows it (the card's `subagent_id`, a launch acknowledgement), is
/// tried first; otherwise the meta files are searched for the call. `None`
/// until the sub-agent has written its transcript.
pub(crate) fn locate_in(
    dir: &Path,
    tool_use_id: &str,
    agent_id: Option<&str>,
) -> Option<SubagentFile> {
    if let Some(id) = agent_id.filter(|id| is_safe_subagent_id(id)) {
        let path = transcript_path(dir, id);
        if path.is_file() {
            return Some(SubagentFile {
                agent_id: id.to_string(),
                meta: read_meta(&meta_path(dir, id)),
                path,
            });
        }
    }
    if tool_use_id.is_empty() {
        return None;
    }
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|n| n.strip_prefix("agent-"))
            .and_then(|n| n.strip_suffix(".meta.json"))
        else {
            continue;
        };
        if !is_safe_subagent_id(id) {
            continue;
        }
        let Some(meta) = read_meta(&entry.path()) else {
            continue;
        };
        if meta.tool_use_id.as_deref() != Some(tool_use_id) {
            continue;
        }
        let path = transcript_path(dir, id);
        return path.is_file().then(|| SubagentFile {
            agent_id: id.to_string(),
            path,
            meta: Some(meta),
        });
    }
    None
}

/// How the Agent call stands in the transcript that made it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallState {
    /// It has a result: a foreground call's report, or a background launch
    /// whose task notification came in.
    Settled,
    /// Made, and not answered yet (or a background launch still out).
    Unsettled,
    /// Not in the turns read.
    Unknown,
}

/// The state of the Agent call `tool_use_id` in `turns`. Turns whose content
/// was not read (a cached tail view's stubs) have no blocks, so a call that old
/// reads as unknown.
pub(crate) fn call_state(turns: &[MessageTurn], tool_use_id: &str) -> CallState {
    let mut launched = false;
    for turn in turns.iter().rev() {
        for block in &turn.blocks {
            match block {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    ..
                } if id == tool_use_id => {
                    let marker = output_preview
                        .as_deref()
                        .and_then(|out| out.strip_prefix(BACKGROUND_TASK_MARKER));
                    return match marker {
                        Some(payload) if !background_settled(payload) => CallState::Unsettled,
                        _ => CallState::Settled,
                    };
                }
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    ..
                } if id == tool_use_id => launched = true,
                _ => {}
            }
        }
    }
    if launched {
        CallState::Unsettled
    } else {
        CallState::Unknown
    }
}

/// Whether a background launch's lifecycle marker holds the task notification
/// it settles with (see `apply_background_lifecycle`).
fn background_settled(payload: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("status").map(|s| !s.is_null()))
        .unwrap_or(true)
}

/// A file written this recently is still being written.
const GROWING_WINDOW: Duration = Duration::from_secs(20);
/// A sub-agent that said it is done but whose file was written since: it was
/// resumed (`SendMessage` continues it in the same file).
const RESUMED_WINDOW: Duration = Duration::from_secs(5);
/// An unanswered call whose sub-agent and session have both been quiet this
/// long was cut off (the session ended): nothing will answer it any more.
const ABANDONED_AFTER: Duration = Duration::from_secs(15 * 60);

/// Whether the sub-agent is still at work, from what its files and its call
/// say. `thread_mtime` is its transcript's, `session_mtime` the session's.
pub(crate) fn still_running(
    meta: Option<&SubagentMeta>,
    call: CallState,
    thread_mtime: Option<SystemTime>,
    session_mtime: Option<SystemTime>,
    now: SystemTime,
) -> bool {
    let within =
        |at: Option<SystemTime>, window: Duration| match at.map(|at| now.duration_since(at)) {
            None => false,
            Some(Ok(age)) => age < window,
            // Written "in the future" (clock skew): just now.
            Some(Err(_)) => true,
        };
    if meta.and_then(|m| m.finished) == Some(true) {
        return within(thread_mtime, RESUMED_WINDOW);
    }
    match call {
        // The result is in: done, unless its file is still growing (a CLI
        // that writes the last records after the result, or a resume).
        CallState::Settled => within(thread_mtime, GROWING_WINDOW),
        CallState::Unsettled => {
            within(thread_mtime, ABANDONED_AFTER) || within(session_mtime, ABANDONED_AFTER)
        }
        CallState::Unknown => within(thread_mtime, GROWING_WINDOW),
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Turns of the session read for the Agent call's state: a running call is
/// recent, and a cached tail view keeps at least this many turns whole.
const CALL_LOOKBACK_TURNS: usize = 300;

/// A sub-agent's thread, as [`ClaudeParser::subagent_thread`] reads it.
pub(crate) struct SubagentThread {
    pub agent_id: String,
    pub meta: Option<SubagentMeta>,
    /// Its transcript, parsed like a session's.
    pub detail: Arc<ConversationDetail>,
    /// Still at work (see [`still_running`]): keep reading it.
    pub running: bool,
}

impl ClaudeParser {
    /// The thread of the sub-agent that the Agent call `tool_use_id` of the
    /// session `session_id` launched. `Ok(None)` while the sub-agent has not
    /// written a transcript (or when the call launched none).
    pub(crate) fn subagent_thread(
        &self,
        session_id: &str,
        tool_use_id: &str,
        agent_id: Option<&str>,
    ) -> Result<Option<SubagentThread>, ParseError> {
        let (resolved_id, session_path) = self.locate_transcript(session_id)?;
        // A `/clear` continues the session in a new file, and the cards from
        // before it live in the first one's directory.
        let mut dirs = vec![subagent_dir_of(&session_path)];
        if let Some(first) =
            find_session_file_in(&self.base_dir, session_id).filter(|p| *p != session_path)
        {
            dirs.push(subagent_dir_of(&first));
        }
        let Some((file, in_session_file)) = dirs
            .iter()
            .enumerate()
            .find_map(|(i, dir)| locate_in(dir, tool_use_id, agent_id).map(|f| (f, i == 0)))
        else {
            return Ok(None);
        };
        let detail = transcript_cache::cached_detail(
            &file.path,
            &file.agent_id,
            Need::everything(CacheUse::Fill),
        )?;
        let finished = file.meta.as_ref().and_then(|m| m.finished) == Some(true);
        // Read the session through the same cache entry its tab reads (same
        // path, same id), for its recent turns only.
        let call = if finished || !in_session_file {
            CallState::Unknown
        } else {
            let recent = |turns: &[MessageTurn]| turns.len().saturating_sub(CALL_LOOKBACK_TURNS);
            transcript_cache::cached_detail(
                &session_path,
                &resolved_id,
                Need {
                    cache: CacheUse::Fill,
                    content_from: &recent,
                },
            )
            .map_or(CallState::Unknown, |session| {
                call_state(&session.turns, tool_use_id)
            })
        };
        let running = still_running(
            file.meta.as_ref(),
            call,
            modified(&file.path),
            modified(&session_path),
            SystemTime::now(),
        );
        Ok(Some(SubagentThread {
            agent_id: file.agent_id,
            meta: file.meta,
            detail,
            running,
        }))
    }
}

#[cfg(test)]
mod tests;
