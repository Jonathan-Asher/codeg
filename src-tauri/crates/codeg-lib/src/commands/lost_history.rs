//! Sessions whose agent no longer has their history.
//!
//! An agent can delete its record of a session behind codeg's back: Claude
//! Code removes every transcript that has seen no activity for its
//! `cleanupPeriodDays` (30 unless set) each time it starts. The conversation
//! row outlives the file. Opening it found nothing to show, and resuming or
//! forking it failed with the agent's "not found". What codeg still has is the
//! text its message search indexed while the transcript could be read.
//!
//! * **Detection** — [`history_unavailable_for`]. The parser says the agent's
//!   store is there and holds nothing for the session
//!   ([`TranscriptPresence::Missing`]), and codeg's own records say the
//!   session had a history: indexed text, metered turns, a stored message
//!   count, or a status only a turn that ended (or a person settling the
//!   session) sets. That second half is what keeps a session whose transcript
//!   is not written yet from ever being taken for a lost one. The verdict
//!   rides on the conversation detail, so every client — the iPhone app
//!   included — can open the session read-only.
//! * **The saved text** — [`saved_turns_core`] for the read-only view, and
//!   [`export_saved_history_core`] for carrying it into a new session.
//! * **The connect guard** — [`refuse_lost_history`]. A resume of such a
//!   session is refused before an agent is started for it. The agent could
//!   only fail to load it, and a prompt sent into the attempt moved the row to
//!   the top of the sidebar (the send marks it in progress, the failure marks
//!   it cancelled, and both stamp `updated_at`).
//!
//! The indexer keeps a lost session's rows rather than rewriting them to
//! nothing (`message_search_service::mark_indexed_keeping_rows`): they are the
//! last copy of its text.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use serde::Serialize;

use crate::acp::error::AcpError;
use crate::app_error::AppCommandError;
use crate::db::entities::token_usage_turn;
use crate::db::error::DbError;
use crate::db::service::message_search_service::{self, SavedTurn};
use crate::db::service::{agent_setting_service, conversation_service};
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::models::{
    AgentType, DbConversationSummary, HistoryUnavailable, HistoryUnavailableReason,
};
use crate::parsers::{self, TranscriptPresence};

/// Saved text up to this many characters goes into the new session's
/// composer as it is; longer, it is attached as a file instead.
const INLINE_EXPORT_MAX_CHARS: usize = 4_000;

/// Where, under codeg's data directory, the longer exports are written.
const EXPORT_DIR: &str = "saved-history";

/// A status only a turn that ended — or a person settling the session — sets.
/// A row is created `in_progress`, and stays so until its first turn ends.
fn status_says_it_ran(status: &str) -> bool {
    matches!(status, "pending_review" | "completed" | "cancelled")
}

/// When codeg last metered a turn of the session: its last real activity, as
/// opposed to `updated_at`, which codeg also moves on its own (a status
/// change, a prompt that never reached the agent).
async fn last_metered_turn_at(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Option<DateTime<Utc>>, DbError> {
    Ok(token_usage_turn::Entity::find()
        .filter(token_usage_turn::Column::ConversationId.eq(conversation_id))
        .order_by_desc(token_usage_turn::Column::OccurredAt)
        .one(conn)
        .await?
        .map(|row| row.occurred_at))
}

/// The retention period that explains the deletion, in days, when the agent's
/// own cleanup does: a Claude Code session whose last activity is at least
/// that old. The period is the one the cleanup ran under — `configured_days`
/// when it is shorter than Claude Code's default, the default otherwise: a
/// longer setting (raised since, often because of exactly this) did not apply
/// then. A setting of 0 keeps nothing at all; it explains nothing more than
/// "missing" does, so it is not offered as a reason.
fn cleanup_explains(
    agent: AgentType,
    last_activity: DateTime<Utc>,
    now: DateTime<Utc>,
    configured_days: Option<u32>,
) -> Option<u32> {
    if agent != AgentType::ClaudeCode {
        return None;
    }
    let default = parsers::claude::DEFAULT_CLEANUP_PERIOD_DAYS;
    let period = configured_days
        .filter(|days| (1..default).contains(days))
        .unwrap_or(default);
    let idle_days = (now - last_activity).num_days();
    (idle_days >= i64::from(period)).then_some(period)
}

/// The verdict for `summary`, whose transcript the parser did not find and
/// whose agent's store, it says, holds nothing for it. `None` — leave it an
/// ordinary conversation — unless codeg's records show it had a history.
async fn verdict(
    conn: &DatabaseConnection,
    summary: &DbConversationSummary,
    now: DateTime<Utc>,
    configured_cleanup_days: Option<u32>,
) -> Result<Option<HistoryUnavailable>, DbError> {
    let saved_turns = message_search_service::saved_turn_count(conn, summary.id).await?;
    let last_turn = last_metered_turn_at(conn, summary.id).await?;
    let had_history = saved_turns > 0
        || summary.message_count > 0
        || last_turn.is_some()
        || status_says_it_ran(&summary.status);
    if !had_history {
        return Ok(None);
    }
    let retention_days = cleanup_explains(
        summary.agent_type,
        last_turn.unwrap_or(summary.updated_at),
        now,
        configured_cleanup_days,
    );
    Ok(Some(HistoryUnavailable {
        reason: if retention_days.is_some() {
            HistoryUnavailableReason::AgentCleanup
        } else {
            HistoryUnavailableReason::Missing
        },
        retention_days,
        saved_turns,
    }))
}

/// The config dir Claude Code's launches set (`CLAUDE_CONFIG_DIR` in the
/// agent's settings or in `~/.claude/settings.json`'s `env`), when they set
/// one. The parser reads codeg's own environment, so a session kept there is
/// one it cannot see — and must not be taken for lost.
async fn claude_launch_config_dir(conn: &DatabaseConnection) -> Option<PathBuf> {
    let setting = agent_setting_service::get_by_agent_type(conn, AgentType::ClaudeCode)
        .await
        .ok()
        .flatten();
    let local = crate::commands::acp::load_agent_local_config_json(AgentType::ClaudeCode);
    let env = crate::commands::acp::build_runtime_env_from_setting(
        AgentType::ClaudeCode,
        setting.as_ref(),
        local.as_deref(),
    );
    crate::acp::outside_writer::launch_config_dir(&env)
}

/// Whether Claude Code keeps session `id` under `config_dir` after all (one
/// that is not where the parser looked).
fn claude_keeps_it_in(config_dir: &Path, id: &str) -> bool {
    if config_dir == parsers::claude::resolve_claude_config_dir() {
        return false;
    }
    parsers::presence_in_buckets(
        &config_dir.join("projects"),
        id,
        Path::new(&format!("{id}.jsonl")),
        false,
    ) == TranscriptPresence::Present
}

/// The verdict for a conversation the parser found no transcript for and
/// whose agent's store holds nothing for it ([`TranscriptPresence::Missing`]):
/// `Some` when its history is gone, `None` to show it as an ordinary
/// conversation. A lookup that fails says `None`: this only ever adds a
/// read-only view, so when in doubt it stays out of the way.
pub(crate) async fn history_unavailable_for(
    conn: &DatabaseConnection,
    summary: &DbConversationSummary,
) -> Option<HistoryUnavailable> {
    if summary.agent_type == AgentType::ClaudeCode {
        if let (Some(dir), Some(id)) = (
            claude_launch_config_dir(conn).await,
            summary.external_id.as_deref(),
        ) {
            if claude_keeps_it_in(&dir, id) {
                return None;
            }
        }
    }
    let configured = if summary.agent_type == AgentType::ClaudeCode {
        parsers::claude::configured_cleanup_period_days()
    } else {
        None
    };
    match verdict(conn, summary, Utc::now(), configured).await {
        Ok(verdict) => verdict,
        Err(e) => {
            tracing::warn!(
                conversation_id = summary.id,
                error = %e,
                "[lost-history] could not tell whether the session's history is gone"
            );
            None
        }
    }
}

/// Refuse to resume `session_id` when its history is gone (see the module
/// docs): before an agent is started for it, which could only fail to load
/// it. Everything that can't be told — no session id, an agent this can't
/// check, a session codeg has no record of — goes through, as before.
/// `runtime_env` is the launch's own environment, which can keep Claude Code's
/// sessions somewhere the parser does not look.
pub(crate) async fn refuse_lost_history(
    conn: &DatabaseConnection,
    agent_type: AgentType,
    session_id: Option<&str>,
    runtime_env: &BTreeMap<String, String>,
) -> Result<(), AcpError> {
    let Some(session_id) = session_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let id = session_id.to_string();
    let presence = tokio::task::spawn_blocking(move || {
        parsers::build_agent_parser(agent_type).transcript_presence(&id)
    })
    .await
    .unwrap_or(TranscriptPresence::Unknown);
    if presence != TranscriptPresence::Missing {
        return Ok(());
    }
    if agent_type == AgentType::ClaudeCode {
        if let Some(dir) = crate::acp::outside_writer::launch_config_dir(runtime_env) {
            if claude_keeps_it_in(&dir, session_id) {
                return Ok(());
            }
        }
    }
    let Ok(Some(conversation_id)) =
        conversation_service::find_live_id_for_session(conn, session_id, agent_type).await
    else {
        return Ok(());
    };
    let Ok(summary) = conversation_service::get_by_id(conn, conversation_id).await else {
        return Ok(());
    };
    match history_unavailable_for(conn, &summary).await {
        Some(_) => {
            tracing::info!(
                conversation_id,
                session_id,
                "[lost-history] not resuming a session whose history the agent deleted"
            );
            Err(AcpError::HistoryUnavailable(format!(
                "{agent_type} no longer has this session's history, so it can't be resumed"
            )))
        }
        None => Ok(()),
    }
}

/// The text the message search kept of a conversation, oldest turn first:
/// what the read-only view of a lost session shows.
pub async fn saved_turns_core(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<SavedTurn>, AppCommandError> {
    Ok(message_search_service::saved_turns(conn, conversation_id).await?)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_conversation_saved_turns(
    conversation_id: i32,
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<SavedTurn>, AppCommandError> {
    saved_turns_core(&db.conn, conversation_id).await
}

/// A session's saved text, ready to hand to a new session: `markdown` when it
/// is short enough to sit in a composer, else `path` — the file it was written
/// to, on the machine the agent runs on — and its size either way.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SavedHistoryExport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub chars: usize,
    pub turns: usize,
}

/// The saved turns as one Markdown document: a heading and a line saying what
/// it is and what it lacks, then each turn under its speaker. Written for the
/// agent that reads it, so it is in English whatever the app's language.
fn saved_history_markdown(summary: &DbConversationSummary, turns: &[SavedTurn]) -> String {
    let title = summary
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("Untitled session");
    let agent = summary.agent_type.to_string();
    let mut out = format!(
        "# {title}\n\nThe text codeg saved from an earlier {agent} session whose history \
         {agent} no longer has: the messages only. Tool calls and their output were not kept, \
         and messages too long to index are left out.\n"
    );
    for turn in turns {
        let speaker = match turn.role.as_str() {
            "user" => "User",
            "assistant" => agent.as_str(),
            _ => "System",
        };
        out.push_str(&format!("\n## {speaker}\n\n{}\n", turn.content.trim()));
    }
    out
}

/// Export a conversation's saved text for "Start a new session from this":
/// inline when it is short, else written to `<data_dir>/saved-history/` and
/// handed over as that path, which the new session's composer attaches.
pub async fn export_saved_history_core(
    conn: &DatabaseConnection,
    data_dir: &Path,
    conversation_id: i32,
) -> Result<SavedHistoryExport, AppCommandError> {
    let summary = conversation_service::get_by_id(conn, conversation_id).await?;
    let turns = message_search_service::saved_turns(conn, conversation_id).await?;
    let markdown = saved_history_markdown(&summary, &turns);
    let chars = markdown.chars().count();
    if chars <= INLINE_EXPORT_MAX_CHARS {
        return Ok(SavedHistoryExport {
            markdown: Some(markdown),
            path: None,
            chars,
            turns: turns.len(),
        });
    }
    let dir = data_dir.join(EXPORT_DIR);
    let path = dir.join(format!("conversation-{conversation_id}.md"));
    let write = {
        let path = path.clone();
        move || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(&path, markdown)
        }
    };
    tokio::task::spawn_blocking(write)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
        .map_err(AppCommandError::io)?;
    Ok(SavedHistoryExport {
        markdown: None,
        path: Some(path.to_string_lossy().into_owned()),
        chars,
        turns: turns.len(),
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn export_conversation_saved_history(
    conversation_id: i32,
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<SavedHistoryExport, AppCommandError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    export_saved_history_core(&db.conn, &data_dir, conversation_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::conversation;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::message::MessageTurn;
    use sea_orm::{ActiveModelTrait, Set};

    fn at(days_ago: i64) -> DateTime<Utc> {
        Utc::now() - chrono::Duration::days(days_ago)
    }

    fn turn(role: &str, text: &str) -> MessageTurn {
        serde_json::from_value(serde_json::json!({
            "id": format!("t-{text}"),
            "role": role,
            "blocks": [{ "type": "text", "text": text }],
            "timestamp": "2026-09-24T10:00:00Z",
        }))
        .expect("turn fixture")
    }

    async fn set_row(
        db: &crate::db::AppDatabase,
        id: i32,
        status: conversation::ConversationStatus,
        updated_days_ago: i64,
    ) {
        let row = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        let mut active: conversation::ActiveModel = row.into();
        active.status = Set(status);
        active.updated_at = Set(at(updated_days_ago));
        active.external_id = Set(Some(format!("session-{id}")));
        active.title = Set(Some("Higgsfield alternatives".into()));
        active.update(&db.conn).await.unwrap();
    }

    async fn meter_turn(db: &crate::db::AppDatabase, id: i32, days_ago: i64) {
        token_usage_turn::ActiveModel {
            conversation_id: Set(id),
            turn_key: Set(format!("turn-{days_ago}")),
            occurred_at: Set(at(days_ago)),
            ..Default::default()
        }
        .insert(&db.conn)
        .await
        .unwrap();
    }

    #[test]
    fn claude_cleanup_explains_a_session_idle_past_the_period_it_ran_under() {
        let now = Utc::now();
        // The default 30 days, whatever longer period is set now.
        assert_eq!(
            cleanup_explains(AgentType::ClaudeCode, at(49), now, None),
            Some(30)
        );
        assert_eq!(
            cleanup_explains(AgentType::ClaudeCode, at(49), now, Some(36_500)),
            Some(30)
        );
        // A shorter period set explains a younger session.
        assert_eq!(
            cleanup_explains(AgentType::ClaudeCode, at(10), now, Some(7)),
            Some(7)
        );
        // Not idle long enough: something else removed it.
        assert_eq!(
            cleanup_explains(AgentType::ClaudeCode, at(6), now, None),
            None
        );
        // "Keep nothing" explains nothing.
        assert_eq!(
            cleanup_explains(AgentType::ClaudeCode, at(6), now, Some(0)),
            None
        );
        // Other agents keep no such period.
        assert_eq!(cleanup_explains(AgentType::Codex, at(400), now, None), None);
    }

    #[tokio::test]
    async fn a_session_that_ran_is_lost_and_one_never_written_is_not() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/lost-proj").await;
        let fresh = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let ran = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        // Created, never through a turn: its transcript is simply not written
        // yet, so it is no lost session.
        let summary = conversation_service::get_by_id(&db.conn, fresh)
            .await
            .unwrap();
        assert_eq!(
            verdict(&db.conn, &summary, Utc::now(), None).await.unwrap(),
            None
        );

        // A turn ran 49 days ago; the row was touched 6 days ago by a prompt
        // that never reached the agent. The metered turn dates the activity.
        set_row(&db, ran, conversation::ConversationStatus::Cancelled, 6).await;
        meter_turn(&db, ran, 49).await;
        message_search_service::index_conversation(
            &db.conn,
            ran,
            at(49),
            &[
                turn("user", "Do research"),
                turn("assistant", "Four tracks"),
            ],
        )
        .await
        .unwrap();
        let summary = conversation_service::get_by_id(&db.conn, ran)
            .await
            .unwrap();
        assert_eq!(
            verdict(&db.conn, &summary, Utc::now(), Some(36_500))
                .await
                .unwrap(),
            Some(HistoryUnavailable {
                reason: HistoryUnavailableReason::AgentCleanup,
                retention_days: Some(30),
                saved_turns: 2,
            })
        );
    }

    #[tokio::test]
    async fn a_lost_session_without_metered_turns_is_dated_by_its_row() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/lost-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        // Imported long ago, never metered, nothing indexed: its status is
        // the evidence, its row's age the explanation.
        set_row(&db, id, conversation::ConversationStatus::PendingReview, 88).await;
        let summary = conversation_service::get_by_id(&db.conn, id).await.unwrap();
        let found = verdict(&db.conn, &summary, Utc::now(), None).await.unwrap();
        assert_eq!(
            found,
            Some(HistoryUnavailable {
                reason: HistoryUnavailableReason::AgentCleanup,
                retention_days: Some(30),
                saved_turns: 0,
            })
        );

        // Recent activity: the cleanup does not explain it.
        set_row(&db, id, conversation::ConversationStatus::Completed, 3).await;
        let summary = conversation_service::get_by_id(&db.conn, id).await.unwrap();
        assert_eq!(
            verdict(&db.conn, &summary, Utc::now(), None)
                .await
                .unwrap()
                .map(|v| v.reason),
            Some(HistoryUnavailableReason::Missing)
        );
    }

    #[tokio::test]
    async fn the_saved_turns_come_back_in_order_and_export_inline_when_short() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/lost-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        set_row(&db, id, conversation::ConversationStatus::Completed, 40).await;
        message_search_service::index_conversation(
            &db.conn,
            id,
            at(40),
            &[
                turn("user", "Do research on alternatives"),
                turn("assistant", "I started four research tracks"),
                turn("user", "What about Seedance 2.5?"),
            ],
        )
        .await
        .unwrap();

        let saved = saved_turns_core(&db.conn, id).await.unwrap();
        assert_eq!(
            saved
                .iter()
                .map(|t| (t.turn_idx, t.role.as_str(), t.content.as_str()))
                .collect::<Vec<_>>(),
            [
                (0, "user", "Do research on alternatives"),
                (1, "assistant", "I started four research tracks"),
                (2, "user", "What about Seedance 2.5?"),
            ]
        );

        let data_dir = tempfile::tempdir().unwrap();
        let export = export_saved_history_core(&db.conn, data_dir.path(), id)
            .await
            .unwrap();
        assert_eq!(export.path, None);
        assert_eq!(export.turns, 3);
        let markdown = export.markdown.unwrap();
        assert!(markdown.starts_with("# Higgsfield alternatives\n"));
        assert!(markdown.contains("## User\n\nDo research on alternatives\n"));
        assert!(markdown.contains("## Claude Code\n\nI started four research tracks\n"));
        assert_eq!(export.chars, markdown.chars().count());
        // Nothing written for an inline export.
        assert!(!data_dir.path().join(EXPORT_DIR).exists());
    }

    #[tokio::test]
    async fn a_long_export_is_written_to_a_file_and_handed_over_by_path() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/lost-proj").await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        set_row(&db, id, conversation::ConversationStatus::Completed, 40).await;
        let long = "pricing ".repeat(800);
        message_search_service::index_conversation(
            &db.conn,
            id,
            at(40),
            &[turn("user", "Compare the prices"), turn("assistant", &long)],
        )
        .await
        .unwrap();

        let data_dir = tempfile::tempdir().unwrap();
        let export = export_saved_history_core(&db.conn, data_dir.path(), id)
            .await
            .unwrap();
        assert_eq!(export.markdown, None);
        let path = PathBuf::from(export.path.unwrap());
        assert_eq!(
            path,
            data_dir
                .path()
                .join(EXPORT_DIR)
                .join(format!("conversation-{id}.md"))
        );
        let written = std::fs::read_to_string(path).unwrap();
        assert!(written.contains("## User\n\nCompare the prices\n"));
        assert!(written.contains(long.trim()));
        assert_eq!(export.chars, written.chars().count());
        assert!(export.chars > INLINE_EXPORT_MAX_CHARS);
    }

    #[test]
    fn claude_keeps_it_in_looks_only_where_the_parser_did_not() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("abc.jsonl"), "{}\n").unwrap();
        assert!(claude_keeps_it_in(root.path(), "abc"));
        assert!(!claude_keeps_it_in(root.path(), "other"));
        // Unsafe ids never reach the filesystem.
        assert!(!claude_keeps_it_in(root.path(), "../abc"));
    }
}
