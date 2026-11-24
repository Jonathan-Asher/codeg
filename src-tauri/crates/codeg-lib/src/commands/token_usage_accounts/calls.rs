//! Keep `token_usage_call` in step with the Claude transcripts.
//!
//! A conversation is read again when its transcript tree (the main file
//! and every sub-agent file beside it) no longer matches the fingerprint
//! stamped on its main-thread row, or when the accounting changed
//! ([`CALL_SCHEMA_VERSION`]). That catches what the turn sync cannot: a
//! background sub-agent still writing after its session's last turn.
//!
//! Only trees written to since `cutoff` are read: the account split covers
//! what the pool kept records of (35 days), and the whole transcript tree
//! (many GB on a busy machine) is never walked in one go. Each pass reads
//! the most recently written trees first and stops at its deadline, so the
//! page stays responsive while a first pass catches up.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use chrono::{DateTime, Utc};

use super::pricing::{self, CallTokens};
use crate::app_error::AppCommandError;
use crate::db::service::agent_setting_service;
use crate::db::service::token_usage_accounts_service::{
    self as service, CallRow, CallStamp, CallSyncCandidate, ThreadRow,
};
use crate::models::AgentType;
use crate::parsers::claude::usage_calls::{self, ClaudeCalls, TreeStamp};
use crate::parsers::claude::resolve_claude_projects_dir_for_env;

/// The accounting the stored calls were read under. Bump it when a change
/// makes stored rows wrong rather than stale; every conversation in the
/// window is then read again.
pub(crate) const CALL_SCHEMA_VERSION: i32 = 1;

/// A session read this recently is not read again, however much its tree
/// moved: an active session's transcript grows every few seconds, and
/// rewriting all its calls on each page refresh would only hold the
/// database for nothing.
const MIN_REREAD: chrono::Duration = chrono::Duration::seconds(60);

/// One call sync at a time: a second would read the same files again.
static CALL_SYNC_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CallSyncOutcome {
    pub synced: u32,
    /// Trees still to read: the deadline came first, or another pass holds
    /// the lock.
    pub remaining: bool,
}

/// A conversation to read: its transcript and how the tree looks now.
#[derive(Debug, Clone)]
pub(crate) struct Planned {
    pub conversation_id: i32,
    pub path: PathBuf,
    pub stamp: TreeStamp,
}

/// Which candidates need reading, newest tree first. Runs on the blocking
/// pool (it stats files and, for a conversation never read, finds its
/// transcript).
pub(crate) fn plan(
    projects: &std::path::Path,
    candidates: Vec<CallSyncCandidate>,
    cutoff: Option<DateTime<Utc>>,
) -> Vec<Planned> {
    let mut index: Option<HashMap<String, PathBuf>> = None;
    let mut out = Vec::new();
    let now = Utc::now();
    for c in candidates {
        let fresh = super::assemble::parse_stored_time(c.synced_at.as_deref())
            .is_some_and(|at| now - at < MIN_REREAD);
        if fresh && c.schema_version == Some(CALL_SCHEMA_VERSION) {
            continue;
        }
        let stored = c.source_path.as_deref().map(PathBuf::from).filter(|p| {
            p.is_file() && p.file_stem().and_then(|s| s.to_str()) == Some(c.external_id.as_str())
        });
        let path = match stored {
            Some(p) => p,
            None => {
                let index = index.get_or_insert_with(|| usage_calls::index_projects(projects));
                // The file the session id names. A `/clear` rollover is not
                // followed here: finding a successor parses the head of every
                // newer transcript in the project directory, once per
                // session, which on a busy directory costs more than the
                // whole read. codeg moves a conversation's id to its
                // successor when it opens it, and the next pass reads that.
                let Some(found) = index.get(&c.external_id) else {
                    continue;
                };
                found.clone()
            }
        };
        let Some(stamp) = usage_calls::tree_stamp(&path) else {
            continue;
        };
        if let (Some(cutoff), Some(modified)) = (cutoff, stamp.modified) {
            if modified < cutoff {
                continue;
            }
        }
        if c.source_fingerprint.as_deref() == Some(stamp.fingerprint.as_str())
            && c.schema_version == Some(CALL_SCHEMA_VERSION)
        {
            continue;
        }
        out.push(Planned {
            conversation_id: c.conversation_id,
            path,
            stamp,
        });
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.stamp.modified));
    out
}

fn clamp_i64(v: u64) -> i64 {
    v.min(i64::MAX as u64) as i64
}

/// Stored rows for one read: every call priced, every thread labelled.
pub(crate) fn rows_of(read: &ClaudeCalls) -> (Vec<CallRow>, Vec<ThreadRow>) {
    let calls = read
        .calls
        .iter()
        .map(|c| {
            let tokens = CallTokens {
                input: c.usage.input,
                output: c.usage.output,
                cache_read: c.usage.cache_read,
                cache_write_5m: c.usage.cache_write_5m,
                cache_write_1h: c.usage.cache_write_1h,
            };
            CallRow {
                thread_key: c.thread_key.clone(),
                message_id: c.message_id.clone(),
                request_id: c.request_id.clone(),
                occurred_at: c.occurred_at,
                model: c.model.clone(),
                input_tokens: clamp_i64(c.usage.input),
                output_tokens: clamp_i64(c.usage.output),
                cache_read_tokens: clamp_i64(c.usage.cache_read),
                cache_write_5m_tokens: clamp_i64(c.usage.cache_write_5m),
                cache_write_1h_tokens: clamp_i64(c.usage.cache_write_1h),
                cost_usd: pricing::cost_usd(c.model.as_deref(), &tokens),
            }
        })
        .collect();
    let threads = read
        .threads
        .iter()
        .map(|t| ThreadRow {
            thread_key: t.key.clone(),
            label: t.label.clone(),
            agent_type: t.agent_type.clone(),
            parent_key: t.parent_key.clone(),
        })
        .collect();
    (calls, threads)
}

/// Read every Claude conversation whose transcript tree moved since it was
/// last read (and was written to after `cutoff`), until `deadline`.
pub(crate) async fn sync_claude_calls(
    conn: &sea_orm::DatabaseConnection,
    cutoff: Option<DateTime<Utc>>,
    deadline: Option<Instant>,
) -> Result<CallSyncOutcome, AppCommandError> {
    let Ok(_guard) = CALL_SYNC_GUARD.try_lock() else {
        return Ok(CallSyncOutcome {
            synced: 0,
            remaining: true,
        });
    };
    let candidates = service::call_sync_candidates(conn)
        .await
        .map_err(AppCommandError::from)?;
    if candidates.is_empty() {
        return Ok(CallSyncOutcome::default());
    }
    let env = agent_setting_service::load_agent_env(conn, AgentType::ClaudeCode).await;
    let projects = resolve_claude_projects_dir_for_env(&env);
    let planned = tokio::task::spawn_blocking(move || plan(&projects, candidates, cutoff))
        .await
        .map_err(|_| AppCommandError::task_execution_failed("Failed to scan Claude transcripts"))?;

    let mut outcome = CallSyncOutcome::default();
    for p in planned {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            outcome.remaining = true;
            break;
        }
        let path = p.path.clone();
        let read = tokio::task::spawn_blocking(move || usage_calls::read_calls(&path))
            .await
            .map_err(|_| {
                AppCommandError::task_execution_failed("Failed to read a Claude transcript")
            })?;
        let (calls, threads) = rows_of(&read);
        let stamp = CallStamp {
            source_path: p.path.to_string_lossy().into_owned(),
            source_fingerprint: p.stamp.fingerprint.clone(),
            schema_version: CALL_SCHEMA_VERSION,
        };
        match service::replace_conversation_calls(conn, p.conversation_id, &calls, &threads, &stamp)
            .await
        {
            Ok(()) => outcome.synced += 1,
            Err(e) => {
                // The conversation keeps its previous rows and its stamp,
                // so the next pass tries again.
                tracing::warn!(
                    conversation_id = p.conversation_id,
                    error = %e,
                    "token usage: failed to write a Claude session's calls"
                );
            }
        }
    }
    Ok(outcome)
}
