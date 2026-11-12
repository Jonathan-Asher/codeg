//! Side questions: Claude Code's `/btw`, asked from codeg's composer.
//!
//! A side question is answered from the session's current context by one model
//! call with no tools. codeg's claude-agent-acp build serves it as the ACP v1
//! extension request `_codeg/side_question` (`{sessionId, question, history?}`
//! → `{response, synthetic, refusalFallback?}`), advertised as
//! `agentCapabilities._meta.codeg.sideQuestion`. It is a control request of
//! its own, not a prompt: it works while a turn runs, starts no turn, leaves
//! the running one alone, reuses the session's warm prompt cache, and neither
//! the question nor the answer goes into the agent's transcript. So it takes
//! no prompt lock and goes nowhere near the message queue: the connection
//! loop hands it to a task of its own and keeps serving the turn.
//!
//! Claude Code keeps no side-question history for an SDK host, so codeg keeps
//! it: every exchange is stored per conversation (`side_question`), the
//! composer's panel steps through them, and the newest
//! [`HISTORY_REPLAY_LIMIT`] the model answered go back as `history` with the
//! next question, which is how a follow-up builds on the earlier ones.
//!
//! The adapter sets no deadline and Claude Code gives up after 11 minutes, so
//! codeg bounds the wait itself ([`side_question_timeout`]) and cancels the
//! request with `$/cancel_request` when it runs out.

use std::path::Path;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ErrorCode, Meta, SessionId};
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::db::entities::side_question as side_question_entity;
use crate::db::service::{conversation_service, side_question_service};
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

/// The request claude-agent-acp (codeg's build) answers a side question on.
pub const SIDE_QUESTION_METHOD: &str = "_codeg/side_question";

/// How many earlier exchanges go back to the agent with a new question.
pub const HISTORY_REPLAY_LIMIT: u64 = 20;

/// How many exchanges the panel lists.
pub const LIST_LIMIT: u64 = 200;

/// Longest question accepted, in characters. A question is typed; a paste
/// this long belongs in the conversation, where tools can read it.
pub const MAX_QUESTION_CHARS: usize = 20_000;

/// Default for [`side_question_timeout`]: three minutes. A side question is one
/// model call over the session's context; a healthy answer takes seconds, a
/// slow one under a minute.
const DEFAULT_TIMEOUT_SECS: u64 = 180;

/// Owner label of a connection opened only to answer a side question. No
/// window owns it, so the idle sweep reaps it unless a tab picks it up.
const OWNER_LABEL: &str = "side_question";

/// How long codeg waits for an answer before it cancels the side question:
/// `CODEG_SIDE_QUESTION_TIMEOUT_SECS`, else three minutes. `0` is not "no
/// limit": the CLI's own 11 minutes would then be the only bound, so it falls
/// back to the default. Read once per process.
pub fn side_question_timeout() -> Duration {
    static SECS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    let secs = *SECS.get_or_init(|| {
        std::env::var("CODEG_SIDE_QUESTION_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|secs| *secs > 0)
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
    });
    Duration::from_secs(secs)
}

/// Which codeg extensions an adapter advertised at `initialize`, under
/// `agentCapabilities._meta.codeg`. Each is a version number; codeg speaks
/// version 1, and a missing, non-integer or lower one counts as not offered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodegExtensions {
    /// `_codeg/side_question` (`sideQuestion`).
    pub side_question: bool,
    /// `_codeg/prompt_suggestion` (`promptSuggestions`).
    pub prompt_suggestions: bool,
}

impl CodegExtensions {
    /// Read the advertisement from `agentCapabilities._meta`.
    pub fn from_agent_capabilities_meta(meta: Option<&Meta>) -> Self {
        let codeg = meta.and_then(|m| m.get("codeg"));
        let offers = |key: &str| {
            codeg
                .and_then(|c| c.get(key))
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|version| version >= 1)
        };
        Self {
            side_question: offers("sideQuestion"),
            prompt_suggestions: offers("promptSuggestions"),
        }
    }
}

/// One earlier exchange, as `history` carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SideQuestionExchange {
    pub question: String,
    pub answer: String,
}

/// What the agent answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SideQuestionReply {
    /// `None` when Claude Code produced no answer at all.
    pub answer: Option<String>,
    /// The answer is a notice from Claude Code ("(API error: …)", the model
    /// tried to call a tool), not the model's own words.
    pub synthetic: bool,
    /// Claude Code's note that a fallback model answered after the model
    /// refused (`refusalFallback.content`).
    pub fallback_notice: Option<String>,
}

/// The `_codeg/side_question` params.
pub fn build_params(
    session_id: &str,
    question: &str,
    history: &[SideQuestionExchange],
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sessionId": session_id,
        "question": question,
    });
    if !history.is_empty() {
        params["history"] = serde_json::json!(history);
    }
    params
}

/// Read a `_codeg/side_question` response. Strict about the one field that
/// must be there: a reply without `response` (a string or `null`) is a
/// protocol error, never an empty answer.
pub fn parse_reply(raw: &serde_json::Value) -> Result<SideQuestionReply, AcpError> {
    let answer = match raw.get("response") {
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        Some(serde_json::Value::Null) => None,
        _ => {
            return Err(AcpError::protocol(
                "The side question's answer has no `response`".to_string(),
            ))
        }
    };
    let synthetic = raw
        .get("synthetic")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let fallback_notice = raw
        .get("refusalFallback")
        .and_then(|fallback| fallback.get("content"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|notice| !notice.is_empty())
        .map(str::to_string);
    Ok(SideQuestionReply {
        answer,
        synthetic,
        fallback_notice,
    })
}

/// The agent's error reply, as what the user is told. An adapter without the
/// method (`-32601`, an older claude-agent-acp) cannot answer side questions at
/// all; every other refusal carries the adapter's own words.
fn map_agent_error(error: agent_client_protocol::Error) -> AcpError {
    match error.code {
        ErrorCode::MethodNotFound => AcpError::SideQuestionUnsupported,
        ErrorCode::RequestCancelled => {
            AcpError::SideQuestionFailed("The side question was cancelled.".to_string())
        }
        _ => {
            let message = error.message.trim();
            AcpError::SideQuestionFailed(if message.is_empty() {
                format!("The agent could not answer the side question ({error}).")
            } else {
                message.to_string()
            })
        }
    }
}

/// Ask the side question on the wire and wait up to `timeout` for the answer.
///
/// Running out of time drops the request's future, and dropping a request the
/// agent has not answered yet is what makes the runtime send
/// `$/cancel_request` for it (see `agent_client_protocol::SentRequest`): the
/// adapter aborts the question and Claude Code stops it.
pub async fn send_side_question(
    cx: &ConnectionTo<Agent>,
    session_id: &SessionId,
    question: &str,
    history: &[SideQuestionExchange],
    timeout: Duration,
) -> Result<SideQuestionReply, AcpError> {
    let params = build_params(session_id.0.as_ref(), question, history);
    let request = UntypedMessage::new(SIDE_QUESTION_METHOD, params)
        .map_err(|e| AcpError::protocol(format!("Failed to build side question request: {e}")))?;
    let answer = cx.send_request_to(Agent, request).block_task();
    match tokio::time::timeout(timeout, answer).await {
        Ok(Ok(raw)) => parse_reply(&raw),
        Ok(Err(e)) => Err(map_agent_error(e)),
        Err(_) => {
            tracing::warn!(
                "[ACP] side question got no answer in {}s; cancelled",
                timeout.as_secs()
            );
            Err(AcpError::SideQuestionTimedOut {
                secs: timeout.as_secs(),
            })
        }
    }
}

/// One exchange as the API hands it out (and stores it). `id` and
/// `conversation_id` are `None` for a question asked of a connection no
/// conversation is bound to yet: it was answered, and kept nowhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideQuestionRecord {
    pub id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub question: String,
    pub answer: Option<String>,
    pub synthetic: bool,
    pub fallback_notice: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl From<side_question_entity::Model> for SideQuestionRecord {
    fn from(row: side_question_entity::Model) -> Self {
        Self {
            id: Some(row.id),
            conversation_id: Some(row.conversation_id),
            question: row.question,
            answer: row.answer,
            synthetic: row.synthetic,
            fallback_notice: row.fallback_notice,
            created_at: row.created_at,
        }
    }
}

/// Where a side question goes: a live connection, a conversation, or both.
/// A connection that is gone, or bound to another conversation, gives way to
/// the conversation's own.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideQuestionTarget {
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
}

/// Validate a question: trimmed, not empty, not longer than
/// [`MAX_QUESTION_CHARS`].
pub fn normalize_question(question: &str) -> Result<String, AcpError> {
    let question = question.trim();
    if question.is_empty() {
        return Err(AcpError::InvalidSideQuestion(
            "the question is empty".to_string(),
        ));
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(AcpError::InvalidSideQuestion(format!(
            "the question is longer than {MAX_QUESTION_CHARS} characters"
        )));
    }
    Ok(question.to_string())
}

/// The connection a side question runs on: the one named, when it is live and
/// serves this conversation; else the conversation's live connection; else
/// the conversation's session, reopened the way a tab's connect does. Never a
/// new turn, and never a second process on a session another connection
/// already runs (the reopen shares it).
async fn resolve_connection(
    manager: &ConnectionManager,
    db: &AppDatabase,
    emitter: &EventEmitter,
    data_dir: &Path,
    target: &SideQuestionTarget,
) -> Result<String, AcpError> {
    if let Some(conn_id) = target.connection_id.as_deref() {
        if let Some(state) = manager.get_state(conn_id).await {
            let bound = state.read().await.conversation_id;
            let serves_it = match (bound, target.conversation_id) {
                (Some(bound), Some(asked)) => bound == asked,
                _ => true,
            };
            if serves_it {
                return Ok(conn_id.to_string());
            }
        }
    }
    let Some(conversation_id) = target.conversation_id else {
        return Err(AcpError::ConnectionNotFound(
            target.connection_id.clone().unwrap_or_default(),
        ));
    };
    if let Some(conn_id) = manager
        .find_connection_by_conversation_id(conversation_id)
        .await
    {
        return Ok(conn_id);
    }
    let row = conversation_service::get_by_id(&db.conn, conversation_id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let reopen = crate::acp::auto_resume::ReopenTarget {
        conversation_id,
        folder_id: row.folder_id,
        agent_type: row.agent_type,
        external_id: row.external_id,
    };
    tracing::info!("[ACP] side question: reopening conversation {conversation_id} to answer it");
    crate::acp::auto_resume::reopen_conversation(
        db,
        manager,
        emitter,
        data_dir,
        &reopen,
        OWNER_LABEL,
    )
    .await
    .map_err(|why| AcpError::SideQuestionFailed(format!("Could not open the session: {why}.")))
}

/// Ask a side question and keep the exchange. Runs on the conversation's live
/// Claude Code connection (opening one if none is), never touches a running
/// turn, and sends the newest stored exchanges along as `history`.
pub async fn ask(
    manager: &ConnectionManager,
    db: &AppDatabase,
    emitter: &EventEmitter,
    data_dir: &Path,
    target: SideQuestionTarget,
    question: &str,
) -> Result<SideQuestionRecord, AcpError> {
    let question = normalize_question(question)?;
    let conn_id = resolve_connection(manager, db, emitter, data_dir, &target).await?;
    let conversation_id = match target.conversation_id {
        Some(id) => Some(id),
        None => match manager.get_state(&conn_id).await {
            Some(state) => state.read().await.conversation_id,
            None => None,
        },
    };
    let history = match conversation_id {
        Some(id) => side_question_service::replay_history(&db.conn, id, HISTORY_REPLAY_LIMIT)
            .await
            .map(|rows| {
                rows.into_iter()
                    .map(|(question, answer)| SideQuestionExchange { question, answer })
                    .collect()
            })
            .unwrap_or_else(|e| {
                tracing::warn!("[ACP] side question: could not read the history ({e})");
                Vec::new()
            }),
        None => Vec::new(),
    };
    let reply = manager
        .side_question(&conn_id, question.clone(), history)
        .await?;
    let Some(conversation_id) = conversation_id else {
        return Ok(SideQuestionRecord {
            id: None,
            conversation_id: None,
            question,
            answer: reply.answer,
            synthetic: reply.synthetic,
            fallback_notice: reply.fallback_notice,
            created_at: Utc::now(),
        });
    };
    let stored = side_question_service::insert(
        &db.conn,
        side_question_service::NewSideQuestion {
            conversation_id,
            question: question.clone(),
            answer: reply.answer.clone(),
            synthetic: reply.synthetic,
            fallback_notice: reply.fallback_notice.clone(),
        },
    )
    .await;
    Ok(match stored {
        Ok(row) => row.into(),
        // The answer still reaches the user; only the history misses it.
        Err(e) => {
            tracing::warn!("[ACP] side question: could not store the exchange ({e})");
            SideQuestionRecord {
                id: None,
                conversation_id: Some(conversation_id),
                question,
                answer: reply.answer,
                synthetic: reply.synthetic,
                fallback_notice: reply.fallback_notice,
                created_at: Utc::now(),
            }
        }
    })
}

/// The conversation's stored exchanges, oldest first (the newest
/// [`LIST_LIMIT`]).
pub async fn list(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<Vec<SideQuestionRecord>, AcpError> {
    side_question_service::list(&db.conn, conversation_id, LIST_LIMIT)
        .await
        .map(|rows| rows.into_iter().map(SideQuestionRecord::from).collect())
        .map_err(|e| AcpError::protocol(e.to_string()))
}

/// Forget the conversation's side questions; how many there were.
pub async fn clear(db: &AppDatabase, conversation_id: i32) -> Result<u64, AcpError> {
    side_question_service::clear(&db.conn, conversation_id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capabilities_meta(codeg: serde_json::Value) -> Meta {
        let mut meta = Meta::new();
        meta.insert(
            "claudeCode".to_string(),
            serde_json::json!({"promptQueueing": true}),
        );
        meta.insert("codeg".to_string(), codeg);
        meta
    }

    #[test]
    fn reads_the_advertised_extensions() {
        let both =
            capabilities_meta(serde_json::json!({"sideQuestion": 1, "promptSuggestions": 1}));
        assert_eq!(
            CodegExtensions::from_agent_capabilities_meta(Some(&both)),
            CodegExtensions {
                side_question: true,
                prompt_suggestions: true
            }
        );
        let newer = capabilities_meta(serde_json::json!({"sideQuestion": 2}));
        assert_eq!(
            CodegExtensions::from_agent_capabilities_meta(Some(&newer)),
            CodegExtensions {
                side_question: true,
                prompt_suggestions: false
            }
        );
        for unusable in [
            serde_json::json!({"sideQuestion": 0, "promptSuggestions": "1"}),
            serde_json::json!({"sideQuestion": true}),
            serde_json::json!("sideQuestion"),
        ] {
            let meta = capabilities_meta(unusable.clone());
            assert_eq!(
                CodegExtensions::from_agent_capabilities_meta(Some(&meta)),
                CodegExtensions::default(),
                "{unusable}"
            );
        }
        // An adapter that advertises nothing (the registry's claude-agent-acp,
        // every other agent).
        let mut plain = Meta::new();
        plain.insert(
            "claudeCode".to_string(),
            serde_json::json!({"promptQueueing": true}),
        );
        assert_eq!(
            CodegExtensions::from_agent_capabilities_meta(Some(&plain)),
            CodegExtensions::default()
        );
        assert_eq!(
            CodegExtensions::from_agent_capabilities_meta(None),
            CodegExtensions::default()
        );
    }

    #[test]
    fn params_carry_history_only_when_there_is_some() {
        assert_eq!(
            build_params("s1", "why?", &[]),
            serde_json::json!({"sessionId": "s1", "question": "why?"})
        );
        let history = [SideQuestionExchange {
            question: "a".into(),
            answer: "b".into(),
        }];
        assert_eq!(
            build_params("s1", "and then?", &history),
            serde_json::json!({
                "sessionId": "s1",
                "question": "and then?",
                "history": [{"question": "a", "answer": "b"}],
            })
        );
    }

    #[test]
    fn parses_answers_notices_and_fallbacks() {
        assert_eq!(
            parse_reply(
                &serde_json::json!({"response": "It reads the config.", "synthetic": false})
            )
            .unwrap(),
            SideQuestionReply {
                answer: Some("It reads the config.".into()),
                synthetic: false,
                fallback_notice: None,
            }
        );
        assert_eq!(
            parse_reply(&serde_json::json!({"response": null, "synthetic": false})).unwrap(),
            SideQuestionReply {
                answer: None,
                synthetic: false,
                fallback_notice: None,
            }
        );
        let fallback = parse_reply(&serde_json::json!({
            "response": "(API error: overloaded)",
            "synthetic": true,
            "refusalFallback": {
                "originalModel": "claude-x",
                "fallbackModel": "claude-y",
                "content": " Answered with claude-y. ",
            },
        }))
        .unwrap();
        assert!(fallback.synthetic);
        assert_eq!(
            fallback.fallback_notice.as_deref(),
            Some("Answered with claude-y.")
        );
        assert!(parse_reply(&serde_json::json!({"synthetic": false})).is_err());
        assert!(parse_reply(&serde_json::json!({"response": 3})).is_err());
    }

    #[test]
    fn agent_errors_become_what_the_user_is_told() {
        assert!(matches!(
            map_agent_error(agent_client_protocol::Error::method_not_found()),
            AcpError::SideQuestionUnsupported
        ));
        let not_running = agent_client_protocol::Error::new(
            -32603,
            "Claude Code is not running for this session, so it has no context to answer from.",
        );
        match map_agent_error(not_running) {
            AcpError::SideQuestionFailed(message) => {
                assert!(
                    message.starts_with("Claude Code is not running"),
                    "{message}"
                )
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            map_agent_error(agent_client_protocol::Error::request_cancelled()),
            AcpError::SideQuestionFailed(_)
        ));
    }

    #[test]
    fn questions_are_trimmed_and_bounded() {
        assert_eq!(normalize_question("  why?\n").unwrap(), "why?");
        assert!(matches!(
            normalize_question(" \n "),
            Err(AcpError::InvalidSideQuestion(_))
        ));
        let long = "x".repeat(MAX_QUESTION_CHARS + 1);
        assert!(matches!(
            normalize_question(&long),
            Err(AcpError::InvalidSideQuestion(_))
        ));
    }

    #[test]
    fn a_record_serializes_in_camel_case() {
        let record = SideQuestionRecord {
            id: Some(3),
            conversation_id: Some(7),
            question: "why?".into(),
            answer: Some("because".into()),
            synthetic: false,
            fallback_notice: None,
            created_at: DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
        };
        let wire = serde_json::to_value(&record).unwrap();
        assert_eq!(wire["conversationId"], 7);
        assert_eq!(wire["fallbackNotice"], serde_json::Value::Null);
        assert_eq!(wire["answer"], "because");
        assert!(wire["createdAt"]
            .as_str()
            .unwrap()
            .starts_with("2027-01-15"));
    }

    use crate::acp::connection::ConnectionCommand;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;
    use std::sync::Arc;

    /// The histories the fake connection loop received, one per question.
    type Histories = Arc<std::sync::Mutex<Vec<Vec<SideQuestionExchange>>>>;

    /// A live test connection whose adapter offers (or not) side questions,
    /// with a stand-in for its conversation loop that answers every side
    /// question with `answer` and keeps the history each one carried.
    async fn connection(
        manager: &ConnectionManager,
        id: &str,
        offers: bool,
        answer: &'static str,
    ) -> Histories {
        let mut rx = manager
            .insert_test_connection_live(id, AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        manager
            .get_state(id)
            .await
            .expect("registered")
            .write()
            .await
            .codeg_extensions
            .side_question = offers;
        let histories = Histories::default();
        let seen = Arc::clone(&histories);
        tokio::spawn(async move {
            while let Some(command) = rx.recv().await {
                if let ConnectionCommand::SideQuestion { history, reply, .. } = command {
                    seen.lock().unwrap().push(history);
                    let _ = reply.send(Ok(SideQuestionReply {
                        answer: Some(answer.to_string()),
                        synthetic: false,
                        fallback_notice: None,
                    }));
                }
            }
        });
        histories
    }

    #[tokio::test]
    async fn a_session_whose_adapter_does_not_offer_it_is_never_asked() {
        let manager = ConnectionManager::new();
        let histories = connection(&manager, "c1", false, "x").await;
        let outcome = manager.side_question("c1", "why?".into(), Vec::new()).await;
        assert!(
            matches!(outcome, Err(AcpError::SideQuestionUnsupported)),
            "{outcome:?}"
        );
        assert!(histories.lock().unwrap().is_empty());
        assert!(matches!(
            manager
                .side_question("gone", "why?".into(), Vec::new())
                .await,
            Err(AcpError::ConnectionNotFound(_))
        ));
    }

    /// No prompt lock, no turn gate: a side question goes to the connection
    /// while a turn is in flight and a send holds the prompt lock, and the
    /// turn's state is left exactly as it was.
    #[tokio::test]
    async fn a_side_question_goes_out_while_a_turn_runs() {
        let manager = ConnectionManager::new();
        connection(&manager, "c1", true, "It is reading the config.").await;
        let state = manager.get_state("c1").await.unwrap();
        {
            let mut s = state.write().await;
            s.turn_in_flight = true;
            s.status = crate::acp::types::ConnectionStatus::Prompting;
        }
        let prompt_lock = manager
            .connections
            .lock()
            .await
            .get("c1")
            .unwrap()
            .prompt_lock
            .clone();
        let _held = prompt_lock.lock().await;

        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            manager.side_question("c1", "what is it doing?".into(), Vec::new()),
        )
        .await
        .expect("never waits for the turn")
        .expect("answered");
        assert_eq!(reply.answer.as_deref(), Some("It is reading the config."));
        let s = state.read().await;
        assert!(s.turn_in_flight);
        assert_eq!(s.status, crate::acp::types::ConnectionStatus::Prompting);
    }

    /// The whole route: the exchange is stored on the conversation, and the
    /// next question carries the newest answered ones (notices from Claude
    /// Code left out) as its history, oldest first, at most
    /// `HISTORY_REPLAY_LIMIT`.
    #[tokio::test]
    async fn exchanges_are_stored_and_replayed_as_history() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/side-question").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let manager = ConnectionManager::new();
        let histories = connection(&manager, "c1", true, "An answer.").await;
        let target = || SideQuestionTarget {
            connection_id: Some("c1".into()),
            conversation_id: Some(conversation),
        };
        let data_dir = std::env::temp_dir();

        let first = ask(
            &manager,
            &db,
            &EventEmitter::Noop,
            &data_dir,
            target(),
            "  first?  ",
        )
        .await
        .expect("answered");
        assert_eq!(first.question, "first?");
        assert_eq!(first.answer.as_deref(), Some("An answer."));
        assert_eq!(first.conversation_id, Some(conversation));
        assert!(first.id.is_some(), "stored");

        // A notice from Claude Code is shown, never replayed.
        side_question_service::insert(
            &db.conn,
            side_question_service::NewSideQuestion {
                conversation_id: conversation,
                question: "notice?".into(),
                answer: Some("(API error: overloaded)".into()),
                synthetic: true,
                fallback_notice: None,
            },
        )
        .await
        .unwrap();
        ask(
            &manager,
            &db,
            &EventEmitter::Noop,
            &data_dir,
            target(),
            "second?",
        )
        .await
        .expect("answered");
        {
            let histories = histories.lock().unwrap();
            assert_eq!(histories.len(), 2);
            assert!(histories[0].is_empty(), "nothing before the first");
            assert_eq!(
                histories[1],
                [SideQuestionExchange {
                    question: "first?".into(),
                    answer: "An answer.".into(),
                }]
            );
        }

        let listed = list(&db, conversation).await.unwrap();
        let questions: Vec<_> = listed.iter().map(|r| r.question.as_str()).collect();
        assert_eq!(questions, ["first?", "notice?", "second?"]);

        // Many earlier exchanges: only the newest go back.
        for i in 0..25 {
            side_question_service::insert(
                &db.conn,
                side_question_service::NewSideQuestion {
                    conversation_id: conversation,
                    question: format!("q{i}"),
                    answer: Some(format!("a{i}")),
                    synthetic: false,
                    fallback_notice: None,
                },
            )
            .await
            .unwrap();
        }
        ask(
            &manager,
            &db,
            &EventEmitter::Noop,
            &data_dir,
            target(),
            "latest?",
        )
        .await
        .expect("answered");
        let last = histories.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.len(), HISTORY_REPLAY_LIMIT as usize);
        assert_eq!(last.first().unwrap().question, "q5");
        assert_eq!(last.last().unwrap().question, "q24");

        assert_eq!(clear(&db, conversation).await.unwrap(), 29);
        assert!(list(&db, conversation).await.unwrap().is_empty());
    }

    /// A connection no conversation is bound to yet still answers; the
    /// exchange is kept nowhere and nothing is replayed.
    #[tokio::test]
    async fn an_unbound_connection_answers_without_keeping_anything() {
        let db = fresh_in_memory_db().await;
        let manager = ConnectionManager::new();
        let histories = connection(&manager, "c1", true, "Sure.").await;
        let record = ask(
            &manager,
            &db,
            &EventEmitter::Noop,
            &std::env::temp_dir(),
            SideQuestionTarget {
                connection_id: Some("c1".into()),
                conversation_id: None,
            },
            "ok?",
        )
        .await
        .expect("answered");
        assert_eq!(record.id, None);
        assert_eq!(record.conversation_id, None);
        assert_eq!(record.answer.as_deref(), Some("Sure."));
        assert!(histories.lock().unwrap()[0].is_empty());
    }

    /// The connection a client names gives way to the conversation's own when
    /// it serves another conversation: history from one conversation must not
    /// reach another conversation's session.
    #[tokio::test]
    async fn a_connection_serving_another_conversation_is_not_used() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/side-question").await;
        let mine = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let other = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let manager = ConnectionManager::new();
        let wrong = connection(&manager, "wrong", true, "wrong").await;
        let right = connection(&manager, "right", true, "right").await;
        manager
            .get_state("wrong")
            .await
            .unwrap()
            .write()
            .await
            .conversation_id = Some(other);
        manager
            .get_state("right")
            .await
            .unwrap()
            .write()
            .await
            .conversation_id = Some(mine);

        let record = ask(
            &manager,
            &db,
            &EventEmitter::Noop,
            &std::env::temp_dir(),
            SideQuestionTarget {
                connection_id: Some("wrong".into()),
                conversation_id: Some(mine),
            },
            "which one?",
        )
        .await
        .expect("answered");
        assert_eq!(record.answer.as_deref(), Some("right"));
        assert!(wrong.lock().unwrap().is_empty());
        assert_eq!(right.lock().unwrap().len(), 1);
    }
}
