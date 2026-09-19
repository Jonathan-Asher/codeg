//! Export a conversation's transcript to a Markdown file.
//!
//! `conversation_export_markdown(conversation_id)` loads the full turn list
//! through the same parser machinery the detail view uses
//! (`get_folder_conversation_core`) and writes a portable Markdown file into
//! `codeg-exports/` under the conversation's working directory. Serialization
//! (`turns_to_markdown`) is a pure function so it stays unit-testable without
//! a database or session files.

use std::path::PathBuf;

use crate::app_error::AppCommandError;
use crate::commands::conversations::get_folder_conversation_core;
use crate::db::service::folder_service;
use crate::db::AppDatabase;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// Flatten a turn's blocks for export: prose as Markdown paragraphs, tool
/// activity as one-line blockquotes. Tool internals (inputs, outputs, images,
/// thinking) are omitted per the feature spec — the export reads as the
/// conversation, not as a debug log.
fn turn_to_markdown(turn: &MessageTurn) -> String {
    let role = match turn.role {
        TurnRole::User => "user",
        TurnRole::Assistant => "assistant",
        TurnRole::System => "system",
    };
    let mut out = format!("## {} — {}\n\n", role, turn.timestamp.to_rfc3339());

    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text } => {
                if text.trim().is_empty() {
                    continue;
                }
                out.push_str(text.trim_end());
                out.push_str("\n\n");
            }
            ContentBlock::ToolUse { tool_name, .. } => {
                out.push_str(&format!("> used tool: {}\n\n", tool_name));
            }
            ContentBlock::ToolResult { is_error, .. } => {
                if *is_error {
                    out.push_str("> tool result: error\n\n");
                }
                // Successful tool results are omitted — the matching
                // `used tool:` line already marks the activity.
            }
            // Thinking, images, image generation: skipped (spec).
            _ => {}
        }
    }

    out
}

/// Serialize a conversation to Markdown: `# {title}` then one `##` section
/// per turn. Pure — unit-tested.
pub fn turns_to_markdown(title: Option<&str>, turns: &[MessageTurn]) -> String {
    let mut out = String::new();
    match title {
        Some(t) if !t.trim().is_empty() => out.push_str(&format!("# {}\n\n", t.trim())),
        _ => out.push_str("# Conversation\n\n"),
    }
    for turn in turns {
        out.push_str(&turn_to_markdown(turn));
    }
    out
}

/// Filesystem-safe slug: lowercase, non-alphanumerics → `-`, collapsed and
/// trimmed, capped at 60 chars. Pure — unit-tested.
pub fn slugify_title(title: &str) -> String {
    let mut collapsed = String::with_capacity(title.len());
    let mut prev_dash = true; // trims leading dashes
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            collapsed.push(c);
            prev_dash = false;
        } else if !prev_dash {
            collapsed.push('-');
            prev_dash = true;
        }
    }
    let truncated: String = collapsed.chars().take(60).collect();
    let trimmed = truncated.trim_end_matches('-').to_string();
    if trimmed.is_empty() {
        "conversation".to_string()
    } else {
        trimmed
    }
}

/// Build the export path: `{conversation cwd}/codeg-exports/{slug}-{date}.md`.
/// Pure — unit-tested.
pub fn export_path_for(cwd: &str, title: Option<&str>, date: &str) -> PathBuf {
    let slug = slugify_title(title.unwrap_or(""));
    PathBuf::from(cwd)
        .join("codeg-exports")
        .join(format!("{}-{}.md", slug, date))
}

pub async fn conversation_export_markdown_core(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) -> Result<String, AppCommandError> {
    let (detail, parsed_title) = get_folder_conversation_core(conn, conversation_id)?;
    let title = parsed_title.or(detail.summary.title.clone());
    let turns = detail.turns;

    // The conversation's workspace: the recorded origin cwd wins (a removed
    // task worktree's conversations were re-parented but kept their original
    // cwd), else the owning folder's path.
    let cwd = match detail.summary.origin_cwd.clone() {
        Some(c) => Some(c),
        None => folder_service::get_folder_by_id(conn, detail.summary.folder_id)
            .await
            .ok()
            .flatten()
            .map(|f| f.path),
    };
    let cwd = cwd.ok_or_else(|| {
        AppCommandError::task_execution_failed(
            "Cannot export: this conversation has no workspace folder",
        )
    })?;

    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let path = export_path_for(&cwd, title.as_deref(), &date);
    let markdown = turns_to_markdown(title.as_deref(), &turns);

    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| {
            AppCommandError::task_execution_failed("Failed to create export directory")
                .with_detail(e.to_string())
        })?;
    }
    tokio::fs::write(&path, markdown)
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Failed to write export file")
                .with_detail(e.to_string())
        })?;

    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn conversation_export_markdown(
    conversation_id: i32,
    db: tauri::State<'_, AppDatabase>,
) -> Result<String, AppCommandError> {
    let conn = db.conn.clone();
    conversation_export_markdown_core(&conn, conversation_id).await
}
