//! The one-time catch-up for sessions the account pool stopped before codeg
//! recognized that stop.
//!
//! A turn that ended on the pool's 429 under an older codeg was recorded as
//! an ordinary end, so its session simply stayed stopped. On the first start
//! of a codeg that knows the stop, each recent top-level Claude Code session
//! with no turn running and no pause (the database narrows it to those) has
//! the end of its own transcript read — the same file the history view reads
//! — and one whose last turn ended on the pool's refusal within the last
//! [`CATCH_UP_WINDOW_HOURS`] is paused like a live stop would have been. It
//! runs once per data directory ([`POOL_STOP_CATCH_UP_KEY`]).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;

use super::{is_pool_capacity_text, load_limit_continue_settings, resolve_pool_stop_reset, wake};
use crate::db::entities::conversation::ConversationLimitReason;
use crate::db::service::{app_metadata_service, conversation_service};
use crate::models::AgentType;
use crate::parsers::claude::{
    find_session_file, follow_clear_rollover_chain, is_meta_message, is_synthetic_assistant,
};
use crate::web::event_bridge::EventEmitter;

/// `app_metadata` key, set once the catch-up has run on this data directory.
pub const POOL_STOP_CATCH_UP_KEY: &str = "limit_continue_pool_stop_catch_up";
/// Only a stop this recent is caught up.
pub const CATCH_UP_WINDOW_HOURS: i64 = 24;
/// Most sessions looked at.
const MAX_CANDIDATES: u64 = 200;
/// How much of a transcript's end is read.
const TAIL_BYTES: u64 = 256 * 1024;
/// Most transcript records looked at, from the end.
const MAX_TAIL_RECORDS: usize = 400;

/// Run the catch-up unless it already ran here. Returns how many sessions it
/// paused.
pub async fn catch_up_pool_stops(conn: &DatabaseConnection, emitter: &EventEmitter) -> usize {
    catch_up_pool_stops_with(conn, emitter, Utc::now(), claude_transcript).await
}

/// [`catch_up_pool_stops`] at `now`, finding a session's transcript with
/// `locate` (a test seam).
pub(crate) async fn catch_up_pool_stops_with(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    now: DateTime<Utc>,
    locate: impl Fn(&str) -> Option<PathBuf> + Send + 'static,
) -> usize {
    match app_metadata_service::get_value(conn, POOL_STOP_CATCH_UP_KEY).await {
        Ok(None) => {}
        Ok(Some(_)) => return 0,
        Err(e) => {
            tracing::warn!("[limit-continue] catch-up: failed to read its marker ({e})");
            return 0;
        }
    }
    let paused = if load_limit_continue_settings(conn).await.enabled {
        pause_recent_pool_stops(conn, emitter, now, locate).await
    } else {
        0
    };
    if let Err(e) =
        app_metadata_service::upsert_value(conn, POOL_STOP_CATCH_UP_KEY, &now.to_rfc3339()).await
    {
        tracing::warn!("[limit-continue] catch-up: failed to record that it ran ({e})");
    }
    paused
}

async fn pause_recent_pool_stops(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    now: DateTime<Utc>,
    locate: impl Fn(&str) -> Option<PathBuf> + Send + 'static,
) -> usize {
    let since = now - chrono::Duration::hours(CATCH_UP_WINDOW_HOURS);
    let rows = match conversation_service::list_limit_catch_up_candidates(
        conn,
        AgentType::ClaudeCode,
        since,
        MAX_CANDIDATES,
    )
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[limit-continue] catch-up: failed to list sessions ({e})");
            return 0;
        }
    };
    let sessions: Vec<(i32, String)> = rows
        .into_iter()
        .filter_map(|row| Some((row.id, row.external_id?)))
        .collect();
    if sessions.is_empty() {
        return 0;
    }
    let stops = tokio::task::spawn_blocking(move || {
        sessions
            .into_iter()
            .filter_map(|(id, session_id)| {
                let tail = read_tail(&locate(&session_id)?)?;
                let (text, at) = last_turn_api_error(&tail)?;
                Some((id, text, at))
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    let mut paused = 0;
    for (conversation_id, text, stopped_at) in stops {
        if stopped_at < since || !is_pool_capacity_text(&text) {
            continue;
        }
        let (resets_at, source) = resolve_pool_stop_reset(&text, stopped_at, now, true).await;
        match conversation_service::pause_ended_turn_on_usage_limit(
            conn,
            conversation_id,
            resets_at,
            ConversationLimitReason::PoolCapacity,
        )
        .await
        {
            Ok(true) => {
                tracing::info!(
                    conversation_id,
                    "[limit-continue] catch-up: the account pool stopped this session at \
                     {stopped_at}; paused until {resets_at} ({source:?} reset time)"
                );
                crate::commands::conversations::emit_conversation_upsert(
                    emitter,
                    conn,
                    conversation_id,
                )
                .await;
                paused += 1;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(
                conversation_id,
                "[limit-continue] catch-up: failed to pause ({e})"
            ),
        }
    }
    if paused > 0 {
        tracing::info!("[limit-continue] catch-up: paused {paused} session(s)");
        wake();
    }
    paused
}

/// A Claude Code session's transcript, where the history view finds it (the
/// latest one after a `/clear`).
fn claude_transcript(session_id: &str) -> Option<PathBuf> {
    let path = find_session_file(session_id)?;
    Some(follow_clear_rollover_chain(&path, session_id).1)
}

/// The last [`TAIL_BYTES`] of a file, from its first whole line on.
fn read_tail(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Some(text);
    }
    // Cut mid-line: drop the partial first line.
    text.split_once('\n').map(|(_, rest)| rest.to_string())
}

/// The error a Claude Code transcript's last turn ended on, with when: the
/// last conversational record is the error Claude Code writes in place of an
/// answer (`isApiErrorMessage`, or its `<synthetic>` stand-in). `None` when
/// the transcript goes on past it — a real answer, or a prompt sent after it
/// — or names no time. `tail` is the end of the JSONL file.
pub fn last_turn_api_error(tail: &str) -> Option<(String, DateTime<Utc>)> {
    for line in tail.lines().rev().take(MAX_TAIL_RECORDS) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        match value.get("type").and_then(|v| v.as_str()) {
            Some("assistant") => {
                let api_error = value.get("isApiErrorMessage").and_then(|v| v.as_bool())
                    == Some(true)
                    || is_synthetic_assistant(&value);
                if !api_error {
                    return None;
                }
                let text = assistant_text(&value)?;
                let at = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|t| DateTime::parse_from_rfc3339(t).ok())?
                    .with_timezone(&Utc);
                return Some((text, at));
            }
            Some("user") if !is_meta_message(&value) => return None,
            _ => continue,
        }
    }
    None
}

/// The text of an assistant record's message.
fn assistant_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}
