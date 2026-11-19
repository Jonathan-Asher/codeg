//! "Continue in another agent": hand a session's work to a new session on
//! another agent (or the same agent with another model).
//!
//! A session cannot change its agent in place — each one keeps its own
//! native history — so the work moves to a NEW conversation, in the same
//! folder, whose composer starts with a handoff. The old session's agent
//! writes that handoff: codeg sends it [`HANDOFF_PROMPT`] as an ordinary,
//! visible message and keeps the reply once the turn ends
//! ([`run_handoff_core`]). When that turn cannot run or fails, codeg can put
//! a plain handoff together itself from what it can see
//! ([`build_mechanical_handoff_core`]).
//!
//! The link between the two conversations is written when the new one's row
//! is created (`conversation_service::record_continuation`, from the create
//! commands). Opening the new session and prefilling its composer is the
//! frontend's part (`lib/continue-in-agent.ts`).

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast::error::RecvError;

use crate::acp::auto_resume::{reopen_conversation, ReopenTarget};
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, ConnectionStatus, PromptInputBlock};
use crate::app_error::AppCommandError;
use crate::db::service::{conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
use crate::web::event_bridge::EventEmitter;

/// What codeg asks the old session's agent to write. Sent as a normal user
/// message, so it shows in the session like one the user typed.
pub const HANDOFF_PROMPT: &str =
    "Write a handoff for the agent that will continue this work in a new session. \
That agent cannot see this conversation, so include everything it needs:

- **Goal**: what we are trying to achieve.
- **Done**: what is finished so far.
- **Current state**: the branch, and which files are changed or uncommitted.
- **Decisions and constraints**: what I decided or asked for along the way.
- **Open problems**: anything broken, unclear or unresolved.
- **Next steps**: what to do next, in order.

You may look at the repository to get the state right (for example with `git status`), \
but do not change anything. Reply with only the handoff, in Markdown.";

/// Owner label of a connection opened only to write a handoff (the session
/// had none). No window owns it, so the idle sweep reaps it unless a tab
/// picks it up — as for a side question.
const OWNER_LABEL: &str = "continue_in_agent";

/// Prefix of the handoff message's id (the prompt ledger and the
/// cross-client `UserMessage` broadcast carry it).
const MESSAGE_ID_PREFIX: &str = "continue-handoff";

/// How long codeg waits for the handoff turn to end. A handoff is one reply,
/// but an agent may first look around the repository; past this the dialog
/// says it took too long and offers the plain handoff.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// How often the wait checks that the connection is still there: a process
/// that dies mid-turn may never send its `TurnComplete`.
const LIVENESS_CHECK: Duration = Duration::from_secs(5);

/// A turn that ended without text is checked for a usage-limit stop this
/// many times, this far apart: the lifecycle subscriber records the pause
/// from the same `TurnComplete`, a moment after this wait sees it.
const LIMIT_CHECK_ATTEMPTS: u32 = 10;
const LIMIT_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// The longest reply still checked for being a usage-limit notice rather than
/// a handoff ("You've hit your weekly limit · resets …"). A real handoff is
/// longer, and may well mention a limit.
const LIMIT_NOTICE_MAX_CHARS: usize = 400;

/// Why the handoff could not be written. The dialog words each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffFailureKind {
    /// The conversation has no agent session yet: nothing was ever answered.
    NoSession,
    /// A turn is already running on the session.
    Busy,
    /// The session could not be opened.
    Connect,
    /// The handoff turn was stopped.
    Stopped,
    /// The account's usage limit stopped the turn.
    UsageLimit,
    /// The turn ended without any text.
    Empty,
    /// The turn did not end in time.
    TimedOut,
    /// Anything else: the agent errored, or its connection went away.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HandoffFailure {
    pub kind: HandoffFailureKind,
    /// The agent's or codeg's own words, when there are any.
    pub message: Option<String>,
}

/// How a handoff turn went: the handoff, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HandoffOutcome {
    pub text: Option<String>,
    pub failure: Option<HandoffFailure>,
}

impl HandoffOutcome {
    fn written(text: String) -> Self {
        Self {
            text: Some(text),
            failure: None,
        }
    }

    fn failed(kind: HandoffFailureKind, message: Option<String>) -> Self {
        Self {
            text: None,
            failure: Some(HandoffFailure { kind, message }),
        }
    }
}

/// Ask the conversation's agent for a handoff and wait for it: open the
/// session the normal way if nothing has it open (sharing the connection a
/// tab already has), send [`HANDOFF_PROMPT`] through the normal prompt path
/// (so every client shows it as a user message), and keep the turn's final
/// text once it ends.
///
/// `Err` only when the conversation cannot be read; everything that can go
/// wrong with the turn is an [`HandoffOutcome`] failure the dialog shows.
pub async fn run_handoff_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    conversation_id: i32,
) -> Result<HandoffOutcome, AppCommandError> {
    let row = conversation_service::get_by_id(&db.conn, conversation_id)
        .await
        .map_err(|e| AppCommandError::not_found(e.to_string()))?;
    if row.external_id.is_none() {
        return Ok(HandoffOutcome::failed(HandoffFailureKind::NoSession, None));
    }
    let Some(bus) = emitter.acp_event_bus() else {
        return Ok(HandoffOutcome::failed(
            HandoffFailureKind::Error,
            Some("codeg cannot follow the session's events here".to_string()),
        ));
    };

    // The connection that has the conversation open — a tab's, most often —
    // when it can take the prompt now; otherwise the session is opened the
    // way a tab's connect opens it, sharing a connection still on its way.
    let live = match manager
        .find_connection_by_conversation_id(conversation_id)
        .await
    {
        Some(conn_id) => match manager.get_state(&conn_id).await {
            Some(state) => {
                let status = state.read().await.status.clone();
                match status {
                    ConnectionStatus::Connected => Some(conn_id),
                    ConnectionStatus::Prompting => {
                        return Ok(HandoffOutcome::failed(HandoffFailureKind::Busy, None));
                    }
                    _ => None,
                }
            }
            None => None,
        },
        None => None,
    };
    let conn_id = match live {
        Some(conn_id) => conn_id,
        None => {
            let target = ReopenTarget {
                conversation_id,
                folder_id: row.folder_id,
                agent_type: row.agent_type,
                external_id: row.external_id.clone(),
            };
            tracing::info!(
                "[ACP] continue in another agent: opening conversation {conversation_id} for its handoff"
            );
            match reopen_conversation(db, manager, emitter, data_dir, &target, OWNER_LABEL).await {
                Ok(conn_id) => conn_id,
                Err(why) => {
                    return Ok(HandoffOutcome::failed(
                        HandoffFailureKind::Connect,
                        Some(why),
                    ))
                }
            }
        }
    };

    // Subscribed BEFORE the prompt goes out, so its `TurnComplete` cannot
    // slip past.
    let mut rx = bus.subscribe();
    let blocks = vec![PromptInputBlock::Text {
        text: HANDOFF_PROMPT.to_string(),
    }];
    let message_id = format!("{MESSAGE_ID_PREFIX}-{}", uuid::Uuid::new_v4());
    match manager
        .send_prompt_linked_with_message_id(
            db,
            &conn_id,
            blocks,
            Some(row.folder_id),
            Some(conversation_id),
            None,
            Some(message_id),
        )
        .await
    {
        Ok(_) => {}
        Err(AcpError::TurnInProgress) => {
            return Ok(HandoffOutcome::failed(HandoffFailureKind::Busy, None));
        }
        Err(e) => {
            return Ok(HandoffOutcome::failed(
                HandoffFailureKind::Error,
                Some(e.to_string()),
            ));
        }
    }
    tracing::info!(
        "[ACP] continue in another agent: handoff asked of conversation {conversation_id}"
    );

    let ended = wait_for_turn_end(manager, &mut rx, &conn_id).await;
    let outcome = match ended {
        TurnEnd::Ended {
            stop_reason,
            text,
            last_error,
        } => {
            let mut outcome = settle_turn_end(&stop_reason, text, last_error);
            if outcome
                .failure
                .as_ref()
                .is_some_and(|f| f.kind == HandoffFailureKind::Empty)
                && turn_hit_limit(&db.conn, conversation_id).await
            {
                outcome = HandoffOutcome::failed(HandoffFailureKind::UsageLimit, None);
            }
            outcome
        }
        TurnEnd::Gone => HandoffOutcome::failed(
            HandoffFailureKind::Error,
            Some("the session's connection closed before the handoff was written".to_string()),
        ),
        TurnEnd::TimedOut => HandoffOutcome::failed(HandoffFailureKind::TimedOut, None),
    };
    Ok(outcome)
}

/// How the wait for the handoff turn ended.
enum TurnEnd {
    Ended {
        stop_reason: String,
        text: Option<String>,
        /// The last error the connection reported during the turn.
        last_error: Option<String>,
    },
    /// The connection went away before the turn ended.
    Gone,
    TimedOut,
}

async fn wait_for_turn_end(
    manager: &ConnectionManager,
    rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<crate::acp::types::EventEnvelope>>,
    conn_id: &str,
) -> TurnEnd {
    let deadline = tokio::time::Instant::now() + HANDOFF_TIMEOUT;
    let mut liveness = tokio::time::interval(LIVENESS_CHECK);
    liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_error: Option<String> = None;
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(env) if env.connection_id == conn_id => match &env.payload {
                    AcpEvent::TurnComplete { stop_reason, .. } => {
                        return TurnEnd::Ended {
                            stop_reason: stop_reason.clone(),
                            text: last_assistant_text(manager, conn_id).await,
                            last_error,
                        };
                    }
                    AcpEvent::Error { message, .. } => last_error = Some(message.clone()),
                    _ => {}
                },
                Ok(_) => {}
                // Fell behind the bus: the turn's end may be among what was
                // dropped. The connection's own state says whether it ended.
                Err(RecvError::Lagged(_)) => {
                    let Some(state) = manager.get_state(conn_id).await else {
                        return TurnEnd::Gone;
                    };
                    if !state.read().await.turn_in_flight {
                        return TurnEnd::Ended {
                            stop_reason: "end_turn".to_string(),
                            text: last_assistant_text(manager, conn_id).await,
                            last_error,
                        };
                    }
                }
                Err(RecvError::Closed) => return TurnEnd::Gone,
            },
            _ = liveness.tick() => {
                if manager.get_state(conn_id).await.is_none() {
                    return TurnEnd::Gone;
                }
            }
            _ = tokio::time::sleep_until(deadline) => return TurnEnd::TimedOut,
        }
    }
}

/// The just-ended turn's final text (`SessionState::last_assistant_text`:
/// the main thread's text after its last tool call).
async fn last_assistant_text(manager: &ConnectionManager, conn_id: &str) -> Option<String> {
    let state = manager.get_state(conn_id).await?;
    let guard = state.read().await;
    guard.last_assistant_text.clone()
}

/// What a turn's end makes of the handoff. Pure, for the tests.
fn settle_turn_end(
    stop_reason: &str,
    text: Option<String>,
    last_error: Option<String>,
) -> HandoffOutcome {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    match stop_reason {
        "end_turn" => match text {
            Some(text)
                if text.chars().count() <= LIMIT_NOTICE_MAX_CHARS
                    && crate::acp::limit_continue::usage_limit_text_from_error(&text).is_some() =>
            {
                HandoffOutcome::failed(HandoffFailureKind::UsageLimit, Some(text))
            }
            Some(text) => HandoffOutcome::written(text),
            None => HandoffOutcome::failed(HandoffFailureKind::Empty, last_error),
        },
        "cancelled" => HandoffOutcome::failed(HandoffFailureKind::Stopped, None),
        other => {
            let limit = last_error
                .as_deref()
                .and_then(crate::acp::limit_continue::usage_limit_text_from_error);
            match (limit, last_error) {
                (Some(limit), _) => {
                    HandoffOutcome::failed(HandoffFailureKind::UsageLimit, Some(limit))
                }
                (None, Some(error)) => {
                    HandoffOutcome::failed(HandoffFailureKind::Error, Some(error))
                }
                (None, None) => HandoffOutcome::failed(
                    HandoffFailureKind::Error,
                    Some(format!("the agent stopped ({other})")),
                ),
            }
        }
    }
}

/// Whether the conversation's last turn stopped on a usage limit: the
/// lifecycle subscriber records that from the same `TurnComplete`, so give it
/// a moment.
async fn turn_hit_limit(conn: &sea_orm::DatabaseConnection, conversation_id: i32) -> bool {
    for attempt in 0..LIMIT_CHECK_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(LIMIT_CHECK_INTERVAL).await;
        }
        match conversation_service::get_by_id(conn, conversation_id).await {
            Ok(row) if row.limit_pause.is_some() || row.limit_reason.is_some() => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
}

// ── The plain handoff codeg writes itself ──────────────────────────────────

/// How long the transcript read for the first message may take.
const TRANSCRIPT_READ_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `git status` may take.
const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// Most characters of the first message the plain handoff quotes.
const FIRST_MESSAGE_MAX_CHARS: usize = 4_000;
/// Most lines of `git status --short` the plain handoff lists.
const GIT_STATUS_MAX_LINES: usize = 200;

/// What `git status --short` said in the session's folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitStatus {
    /// Nothing changed.
    Clean,
    /// Its output, one changed file per line.
    Changes(String),
    /// It did not run, or failed (not a repository, no git): why.
    Unavailable(String),
}

/// Everything the plain handoff is made of.
#[derive(Debug, Clone)]
pub struct MechanicalHandoff {
    pub conversation_id: i32,
    pub title: Option<String>,
    pub first_user_message: Option<String>,
    pub folder: Option<String>,
    pub branch: Option<String>,
    pub git_status: GitStatus,
}

/// The plain handoff codeg writes when the old agent could not ("Continue
/// without a summary"): the session's link (its history is one
/// `get_session_info` call away), folder, branch, first message and
/// `git status --short`. Markdown, for the new agent to read. Pure.
pub fn format_mechanical_handoff(handoff: &MechanicalHandoff) -> String {
    let mut out = String::new();
    out.push_str(
        "This handoff was put together by codeg: the previous agent could not write one, \
         so it has only what codeg can see. For the conversation itself, call \
         `get_session_info` on the session linked below.\n\n",
    );
    let title = handoff
        .title
        .as_deref()
        .map(collapse_whitespace)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("Session {}", handoff.conversation_id));
    out.push_str(&format!(
        "- **Session**: [{}]({})\n",
        escape_link_text(&title),
        crate::deep_link::session_link(handoff.conversation_id)
    ));
    match handoff.folder.as_deref() {
        Some(folder) => out.push_str(&format!("- **Folder**: {}\n", inline_code(folder))),
        None => out.push_str("- **Folder**: unknown\n"),
    }
    match handoff.branch.as_deref() {
        Some(branch) => out.push_str(&format!("- **Branch**: {}\n", inline_code(branch))),
        None => out.push_str("- **Branch**: none (not a git branch)\n"),
    }

    out.push_str("\n**First request**\n\n");
    match handoff
        .first_user_message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        Some(message) => {
            let message = truncate_chars(message, FIRST_MESSAGE_MAX_CHARS);
            for line in message.lines() {
                if line.trim().is_empty() {
                    out.push_str(">\n");
                } else {
                    out.push_str("> ");
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
        None => out.push_str("Not available.\n"),
    }

    out.push_str("\n**Uncommitted changes** (`git status --short`)\n\n");
    match &handoff.git_status {
        GitStatus::Clean => out.push_str("None: the working tree is clean.\n"),
        GitStatus::Changes(output) => {
            let lines: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
            let shown = &lines[..lines.len().min(GIT_STATUS_MAX_LINES)];
            let body = shown.join("\n");
            let fence = code_fence_for(&body);
            out.push_str(&format!("{fence}\n{body}\n{fence}\n"));
            if lines.len() > shown.len() {
                out.push_str(&format!("\n…and {} more.\n", lines.len() - shown.len()));
            }
        }
        GitStatus::Unavailable(why) => {
            out.push_str(&format!("Unknown: {}.\n", why.trim().trim_end_matches('.')));
        }
    }
    out.trim_end().to_string()
}

/// The text of the conversation's first user message: its text blocks,
/// joined. `None` when it has none.
pub fn first_user_text(turns: &[MessageTurn]) -> Option<String> {
    turns
        .iter()
        .filter(|turn| matches!(turn.role, TurnRole::User))
        .find_map(|turn| {
            let text = turn
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.trim()),
                    _ => None,
                })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        })
}

/// Gather the plain handoff for `conversation_id` and write it out
/// ([`format_mechanical_handoff`]). Every piece that cannot be read is left
/// out with a word saying so; only a missing conversation fails.
pub async fn build_mechanical_handoff_core(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) -> Result<String, AppCommandError> {
    let row = conversation_service::get_by_id(conn, conversation_id)
        .await
        .map_err(|e| AppCommandError::not_found(e.to_string()))?;
    let folder = match row.working_dir.clone() {
        Some(dir) => Some(dir),
        None => folder_service::get_folder_by_id(conn, row.folder_id)
            .await
            .ok()
            .flatten()
            .map(|folder| folder.path),
    };

    let parsed = tokio::time::timeout(
        TRANSCRIPT_READ_TIMEOUT,
        crate::commands::conversations::get_folder_conversation_core(conn, conversation_id),
    )
    .await;
    let (first_user_message, parsed_title) = match parsed {
        Ok(Ok((detail, title))) => (first_user_text(&detail.turns), title),
        _ => (None, None),
    };

    let (branch, git_status) = match folder.as_deref() {
        Some(dir) if Path::new(dir).is_dir() => (
            crate::commands::conversations::detect_git_branch(dir).await,
            git_status_short(dir).await,
        ),
        Some(_) => (
            None,
            GitStatus::Unavailable("the folder is not on this machine".to_string()),
        ),
        None => (
            None,
            GitStatus::Unavailable("the folder is unknown".to_string()),
        ),
    };

    Ok(format_mechanical_handoff(&MechanicalHandoff {
        conversation_id,
        title: row.title.clone().or(parsed_title),
        first_user_message,
        folder,
        branch: branch.or(row.git_branch.clone()),
        git_status,
    }))
}

async fn git_status_short(dir: &str) -> GitStatus {
    let run = crate::process::tokio_command("git")
        .args(["status", "--short"])
        .current_dir(dir)
        .output();
    match tokio::time::timeout(GIT_STATUS_TIMEOUT, run).await {
        Ok(Ok(output)) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_string();
            if text.trim().is_empty() {
                GitStatus::Clean
            } else {
                GitStatus::Changes(text)
            }
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let why = stderr.lines().next().unwrap_or_default().trim().to_string();
            GitStatus::Unavailable(if why.is_empty() {
                "`git status` failed".to_string()
            } else {
                format!("`git status` said \"{why}\"")
            })
        }
        Ok(Err(e)) => GitStatus::Unavailable(format!("`git status` could not run ({e})")),
        Err(_) => GitStatus::Unavailable("`git status` took too long".to_string()),
    }
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Escape link text the way the composer's references do, so a title cannot
/// break out of `[...]`.
fn escape_link_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '`' | '*' | '_' | '~' | '[' | ']' | '(' | ')' | '<' | '>'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `text` as a Markdown code span, with a fence longer than any backtick run
/// in it.
fn inline_code(text: &str) -> String {
    let fence = "`".repeat(longest_backtick_run(text) + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{text}{pad}{fence}")
}

/// A code-block fence longer than any backtick run in `body` (three at
/// least).
fn code_fence_for(body: &str) -> String {
    "`".repeat((longest_backtick_run(body) + 1).max(3))
}

fn longest_backtick_run(text: &str) -> usize {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    longest
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::conversations::create_continuing_conversation_core;
    use crate::db::entities::conversation;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::models::AgentType;
    use chrono::Utc;
    use sea_orm::{ActiveModelTrait, EntityTrait, Set};

    fn turn(role: TurnRole, texts: &[&str]) -> MessageTurn {
        MessageTurn {
            id: "t".into(),
            role,
            blocks: texts
                .iter()
                .map(|t| ContentBlock::Text {
                    text: (*t).to_string(),
                })
                .collect(),
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
            spoken: false,
        }
    }

    fn handoff() -> MechanicalHandoff {
        MechanicalHandoff {
            conversation_id: 42,
            title: Some("Fix the login [beta]".to_string()),
            first_user_message: Some("Fix the login.\n\nIt fails on Safari.".to_string()),
            folder: Some("/work/app".to_string()),
            branch: Some("feat/login".to_string()),
            git_status: GitStatus::Changes(" M src/login.ts\n?? notes.md".to_string()),
        }
    }

    // ── the plain handoff ──

    #[test]
    fn plain_handoff_has_the_link_folder_branch_request_and_status() {
        let text = format_mechanical_handoff(&handoff());
        assert!(text.contains("- **Session**: [Fix the login \\[beta\\]](codeg://session/42)"));
        assert!(text.contains("- **Folder**: `/work/app`"));
        assert!(text.contains("- **Branch**: `feat/login`"));
        assert!(text.contains("> Fix the login.\n>\n> It fails on Safari.\n"));
        assert!(text.contains("```\n M src/login.ts\n?? notes.md\n```"));
        assert!(text.contains("get_session_info"));
    }

    #[test]
    fn plain_handoff_says_what_it_could_not_read() {
        let text = format_mechanical_handoff(&MechanicalHandoff {
            conversation_id: 7,
            title: None,
            first_user_message: None,
            folder: None,
            branch: None,
            git_status: GitStatus::Unavailable("`git status` said \"not a git repository\"".into()),
        });
        assert!(text.contains("[Session 7](codeg://session/7)"));
        assert!(text.contains("- **Folder**: unknown"));
        assert!(text.contains("- **Branch**: none"));
        assert!(text.contains("**First request**\n\nNot available."));
        assert!(text.contains("Unknown: `git status` said \"not a git repository\"."));
    }

    #[test]
    fn plain_handoff_reads_a_clean_tree_as_no_changes() {
        let mut h = handoff();
        h.git_status = GitStatus::Clean;
        let text = format_mechanical_handoff(&h);
        assert!(text.contains("None: the working tree is clean."));
        assert!(!text.contains("```"));
    }

    #[test]
    fn plain_handoff_fences_and_caps_what_git_lists() {
        let mut h = handoff();
        let many: Vec<String> = (0..GIT_STATUS_MAX_LINES + 5)
            .map(|i| format!("?? file-{i}.txt"))
            .collect();
        h.git_status = GitStatus::Changes(many.join("\n"));
        let text = format_mechanical_handoff(&h);
        assert!(text.contains("?? file-0.txt"));
        assert!(!text.contains(&format!("file-{}.txt", GIT_STATUS_MAX_LINES)));
        assert!(text.contains("…and 5 more."));

        // A file name with backticks gets a longer fence.
        h.git_status = GitStatus::Changes("?? a```b.txt".into());
        let text = format_mechanical_handoff(&h);
        assert!(text.contains("````\n?? a```b.txt\n````"));
    }

    #[test]
    fn plain_handoff_cuts_a_long_first_message() {
        let mut h = handoff();
        h.first_user_message = Some("x".repeat(FIRST_MESSAGE_MAX_CHARS + 50));
        let text = format_mechanical_handoff(&h);
        let quoted = text
            .lines()
            .find(|l| l.starts_with("> x"))
            .expect("quoted line");
        assert_eq!(quoted.chars().count(), 2 + FIRST_MESSAGE_MAX_CHARS + 1);
        assert!(quoted.ends_with('…'));
    }

    #[test]
    fn first_user_text_takes_the_first_message_with_text() {
        let turns = vec![
            turn(TurnRole::System, &["system note"]),
            turn(TurnRole::User, &["  "]),
            turn(TurnRole::User, &["Build the feature", "with tests"]),
            turn(TurnRole::Assistant, &["Done"]),
            turn(TurnRole::User, &["later"]),
        ];
        assert_eq!(
            first_user_text(&turns).as_deref(),
            Some("Build the feature\n\nwith tests")
        );
        assert_eq!(first_user_text(&[turn(TurnRole::Assistant, &["a"])]), None);
    }

    #[test]
    fn inline_code_outlasts_backticks() {
        assert_eq!(inline_code("/a/b"), "`/a/b`");
        assert_eq!(inline_code("a`b"), "``a`b``");
        assert_eq!(inline_code("`x"), "`` `x ``");
    }

    // ── how a handoff turn's end reads ──

    #[test]
    fn an_ended_turn_with_text_is_the_handoff() {
        let outcome = settle_turn_end("end_turn", Some("  ## Goal\nShip it.\n".into()), None);
        assert_eq!(outcome.text.as_deref(), Some("## Goal\nShip it."));
        assert_eq!(outcome.failure, None);
    }

    #[test]
    fn an_ended_turn_without_text_is_empty() {
        let outcome = settle_turn_end("end_turn", Some("   ".into()), None);
        assert_eq!(outcome.text, None);
        assert_eq!(outcome.failure.unwrap().kind, HandoffFailureKind::Empty);
    }

    #[test]
    fn a_stopped_turn_is_stopped() {
        let outcome = settle_turn_end("cancelled", Some("partial".into()), None);
        assert_eq!(outcome.text, None);
        assert_eq!(outcome.failure.unwrap().kind, HandoffFailureKind::Stopped);
    }

    #[test]
    fn a_failed_turn_carries_the_agents_error() {
        let outcome = settle_turn_end("refusal", None, Some("overloaded".into()));
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.kind, HandoffFailureKind::Error);
        assert_eq!(failure.message.as_deref(), Some("overloaded"));

        let outcome = settle_turn_end("max_tokens", None, None);
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.kind, HandoffFailureKind::Error);
        assert_eq!(
            failure.message.as_deref(),
            Some("the agent stopped (max_tokens)")
        );
    }

    #[test]
    fn a_usage_limit_is_named_as_one() {
        let limit = "You've hit your weekly limit · resets 10pm (Asia/Jerusalem)";
        let outcome = settle_turn_end("end_turn", Some(limit.into()), None);
        assert_eq!(
            outcome.failure.unwrap().kind,
            HandoffFailureKind::UsageLimit
        );

        let outcome = settle_turn_end(
            "end_turn_failed",
            None,
            Some(format!("Internal error: {limit}")),
        );
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.kind, HandoffFailureKind::UsageLimit);
        assert_eq!(failure.message.as_deref(), Some(limit));

        // A real handoff that mentions the limit is still a handoff.
        let long = format!("## Goal\n{}\n\n{limit}", "Context. ".repeat(80));
        let outcome = settle_turn_end("end_turn", Some(long.clone()), None);
        assert_eq!(outcome.text.as_deref(), Some(long.trim()));
    }

    #[test]
    fn the_prompt_says_agent_and_asks_for_markdown_only() {
        assert!(HANDOFF_PROMPT.contains("agent that will continue this work"));
        assert!(HANDOFF_PROMPT.contains("Reply with only the handoff, in Markdown."));
        for part in [
            "Goal",
            "Done",
            "Current state",
            "Decisions and constraints",
            "Open problems",
            "Next steps",
        ] {
            assert!(HANDOFF_PROMPT.contains(part), "{part}");
        }
    }

    // ── the link between the two conversations ──

    async fn conversation_row(db: &AppDatabase, id: i32) -> conversation::Model {
        conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .expect("query")
            .expect("row")
    }

    #[tokio::test]
    async fn a_continuation_records_its_source_when_its_row_is_created() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/work/app").await;
        let old = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("Old".into()),
            None,
        )
        .await
        .expect("old row");
        let new = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::Codex,
            Some("New".into()),
            Some(old),
        )
        .await
        .expect("new row");

        assert_eq!(
            conversation_row(&db, new).await.continued_from_id,
            Some(old)
        );
        assert_eq!(conversation_row(&db, old).await.continued_from_id, None);
        // The summary every client reads carries it.
        let summary = conversation_service::get_by_id(&db.conn, new)
            .await
            .unwrap();
        assert_eq!(summary.continued_from_id, Some(old));
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["continued_from_id"], serde_json::json!(old));
        // …and a row that continues nothing leaves the field out.
        let json = serde_json::to_value(
            conversation_service::get_by_id(&db.conn, old)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(json.get("continued_from_id").is_none());
    }

    #[tokio::test]
    async fn a_source_that_is_gone_leaves_the_row_unlinked() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/work/app").await;
        let gone = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            None,
            None,
        )
        .await
        .unwrap();
        let mut active: conversation::ActiveModel = conversation_row(&db, gone).await.into();
        active.deleted_at = Set(Some(Utc::now()));
        active.update(&db.conn).await.unwrap();

        let new = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            Some(gone),
        )
        .await
        .expect("the create still succeeds");
        assert_eq!(conversation_row(&db, new).await.continued_from_id, None);

        let other = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            Some(9_999),
        )
        .await
        .unwrap();
        assert_eq!(conversation_row(&db, other).await.continued_from_id, None);

        // Never itself.
        assert!(
            !conversation_service::record_continuation(&db.conn, other, other)
                .await
                .unwrap()
        );
        assert_eq!(conversation_row(&db, other).await.continued_from_id, None);
    }

    #[tokio::test]
    async fn a_continuation_runs_where_its_source_ran_in_the_same_folder() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/work/app").await;
        let elsewhere = seed_folder(&db, "/work/other").await;
        let old = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            None,
            None,
        )
        .await
        .unwrap();
        let mut active: conversation::ActiveModel = conversation_row(&db, old).await.into();
        active.origin_cwd = Set(Some("/work/app-worktree".into()));
        active.update(&db.conn).await.unwrap();
        let before = conversation_row(&db, old).await.updated_at;

        let same = create_continuing_conversation_core(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            Some(old),
        )
        .await
        .unwrap();
        let row = conversation_row(&db, same).await;
        assert_eq!(row.origin_cwd.as_deref(), Some("/work/app-worktree"));

        let other = create_continuing_conversation_core(
            &db.conn,
            elsewhere,
            AgentType::Codex,
            None,
            Some(old),
        )
        .await
        .unwrap();
        let row = conversation_row(&db, other).await;
        assert_eq!(row.continued_from_id, Some(old));
        assert_eq!(row.origin_cwd, None);

        // The source is only read.
        assert_eq!(conversation_row(&db, old).await.updated_at, before);
    }
}
