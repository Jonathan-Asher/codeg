//! Talk mode: a hands-free voice conversation with one session, held from the
//! phone (Codeg Plus). The phone listens and speaks; the backend:
//!
//! * keeps each conversation's Talk state (`conversation.talk_state`, mirrored
//!   on the summary as `talk_mode`), switched by
//!   [`set_conversation_talk_mode_core`] or by a spoken message;
//! * appends a talk frame (`acp::talk_frame`, wording in [`rules`]) to the new
//!   messages it sends the agent, so the agent answers in short spoken
//!   sentences: [`plan_frame`] decides which one before a message goes out,
//!   [`finish_frame`] records what reached the agent;
//! * strips the frames from history again (`acp::internal_frames`).
//!
//! The rule everything here follows: **nothing the agent already received
//! changes.** Turning Talk on or off never touches the system prompt, `_meta`,
//! the environment, MCP servers, tools, the mode or the model, and never
//! reconnects: any of those would invalidate the agent's prompt cache, and the
//! next request would re-read the whole conversation at full price. The rules
//! travel at the END of new messages only.
//!
//! The phone's contract: `docs/talk-mode.md`.

pub mod rules;

use std::sync::Arc;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::SessionState;
use crate::acp::talk_frame::{self, TalkFrameMode};
use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::db::entities::conversation::ConversationTalkState;
use crate::db::service::{app_metadata_service, conversation_service};
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;

/// `app_metadata` key of [`TalkSettings`]. Global, per data directory.
pub const TALK_SETTINGS_KEY: &str = "talk_settings";

/// Which language the agent answers in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", from = "String")]
pub enum TalkLanguage {
    /// The language of the user's last message; Hebrew when unsure.
    #[default]
    Auto,
    He,
    En,
}

/// How the agent addresses the user in Hebrew.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", from = "String")]
pub enum TalkAddress {
    /// Gender-neutral wording.
    #[default]
    Auto,
    Masculine,
    Feminine,
}

impl TalkLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            TalkLanguage::Auto => "auto",
            TalkLanguage::He => "he",
            TalkLanguage::En => "en",
        }
    }
}

impl TalkAddress {
    pub fn as_str(self) -> &'static str {
        match self {
            TalkAddress::Auto => "auto",
            TalkAddress::Masculine => "masculine",
            TalkAddress::Feminine => "feminine",
        }
    }
}

/// An unknown value (a newer client's, a typo through the API) reads as
/// `auto` rather than failing the whole settings document.
impl From<String> for TalkLanguage {
    fn from(value: String) -> Self {
        match value.as_str() {
            "he" => TalkLanguage::He,
            "en" => TalkLanguage::En,
            _ => TalkLanguage::Auto,
        }
    }
}

impl From<String> for TalkAddress {
    fn from(value: String) -> Self {
        match value.as_str() {
            "masculine" => TalkAddress::Masculine,
            "feminine" => TalkAddress::Feminine,
            _ => TalkAddress::Auto,
        }
    }
}

/// Settings › Talk: how the agent talks back. Global.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TalkSettings {
    pub language: TalkLanguage,
    pub address: TalkAddress,
}

/// The stored settings. A missing or unreadable row reads as the default.
pub async fn load_talk_settings(conn: &DatabaseConnection) -> TalkSettings {
    match app_metadata_service::get_value(conn, TALK_SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[talk] unreadable settings ({e}); using the default");
            TalkSettings::default()
        }),
        Ok(None) => TalkSettings::default(),
        Err(e) => {
            tracing::warn!("[talk] failed to load settings ({e}); using the default");
            TalkSettings::default()
        }
    }
}

/// Store the settings. Every session picks them up with its next message,
/// which then carries the full rules again (see [`rules_key`]).
pub async fn save_talk_settings(
    conn: &DatabaseConnection,
    settings: TalkSettings,
) -> Result<TalkSettings, AppCommandError> {
    let raw = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize talk settings")
            .with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, TALK_SETTINGS_KEY, &raw)
        .await
        .map_err(AppCommandError::from)?;
    Ok(settings)
}

/// Turn Talk on or off for a conversation.
///
/// On: the state becomes `on`, and the next message on the conversation's
/// connection carries the full rules again. Off: an `on` conversation becomes
/// `ending`, so the next message tells the agent; one already off stays off.
/// Either way the row is broadcast through `conversation://changed`. Nothing
/// is sent to the agent here, and its session is not touched.
pub async fn set_conversation_talk_mode_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    manager: &ConnectionManager,
    conversation_id: i32,
    enabled: bool,
) -> Result<(), AppCommandError> {
    let current = conversation_service::read_talk_state(conn, conversation_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Conversation not found: {conversation_id}"))
        })?;
    if enabled {
        conversation_service::set_talk_state(
            conn,
            conversation_id,
            Some(ConversationTalkState::On),
        )
        .await
        .map_err(AppCommandError::from)?;
    } else if current == Some(ConversationTalkState::On) {
        conversation_service::swap_talk_state(
            conn,
            conversation_id,
            Some(ConversationTalkState::On),
            Some(ConversationTalkState::Ending),
        )
        .await
        .map_err(AppCommandError::from)?;
    }
    forget_rules(manager, conversation_id).await;
    crate::commands::conversations::emit_conversation_upsert(emitter, conn, conversation_id).await;
    Ok(())
}

/// Every live connection of `conversation_id` sends the full rules again with
/// its next message in Talk mode.
async fn forget_rules(manager: &ConnectionManager, conversation_id: i32) {
    for state in manager.session_states().await {
        let mut s = state.write().await;
        if s.conversation_id == Some(conversation_id) {
            s.talk_rules_key = None;
        }
    }
}

/// Names the full rules a connection was sent: a digest of their text, so a
/// change of settings (or of the wording) sends them again.
pub fn rules_key(settings: TalkSettings, agent_type: AgentType) -> String {
    use sha2::{Digest, Sha256};
    let hex = format!(
        "{:x}",
        Sha256::digest(rules::full(settings, agent_type).as_bytes())
    );
    hex[..16].to_string()
}

/// Which frame a message carries, from the conversation's state and whether
/// this connection already has the rules (for the current settings).
pub fn frame_mode(
    state: Option<ConversationTalkState>,
    rules_delivered: bool,
) -> Option<TalkFrameMode> {
    match state? {
        ConversationTalkState::On if rules_delivered => Some(TalkFrameMode::Compact),
        ConversationTalkState::On => Some(TalkFrameMode::Full),
        ConversationTalkState::Ending => Some(TalkFrameMode::Off),
    }
}

/// The first text of a message, trimmed (`None` when it has no text).
fn first_text(blocks: &[PromptInputBlock]) -> Option<&str> {
    blocks.iter().find_map(|block| match block {
        PromptInputBlock::Text { text } if !text.trim().is_empty() => Some(text.trim()),
        _ => None,
    })
}

/// Whether a message may carry a frame: it has text, and it is not a slash
/// command (an agent reads those as commands with arguments, and a frame
/// would become part of the arguments).
pub fn carries_frame(blocks: &[PromptInputBlock]) -> bool {
    first_text(blocks).is_some_and(|text| !text.starts_with('/'))
}

/// `/clear` and `/compact` take the rules out of the agent's context.
fn clears_context(blocks: &[PromptInputBlock]) -> bool {
    first_text(blocks).is_some_and(|text| {
        ["/clear", "/compact"].iter().any(|command| {
            text == *command
                || text
                    .strip_prefix(command)
                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))
        })
    })
}

/// What [`plan_frame`] decided for one outgoing message.
#[derive(Debug, Clone, Default)]
pub struct TalkSend {
    /// The user spoke this message (it carries the mic marker).
    pub spoken: bool,
    /// The frame to append as the message's last block, if any.
    pub frame: Option<String>,
    planned: Option<Planned>,
}

#[derive(Debug, Clone)]
struct Planned {
    mode: TalkFrameMode,
    rules_key: String,
    /// A spoken first message, sent before its conversation row existed:
    /// Talk is recorded on once the row is known.
    turn_on_after: bool,
}

impl TalkSend {
    /// A typed message with no frame: what every path outside Talk sends.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn mode(&self) -> Option<TalkFrameMode> {
        self.planned.as_ref().map(|planned| planned.mode)
    }
}

/// Decide the frame for a message about to go to the agent on `session`.
///
/// A spoken message turns Talk on first (the row, the broadcast, and a
/// connection that must send the full rules again). Then, while Talk is on,
/// the message carries the full rules if this connection has not carried
/// them yet for the current settings, else the reminder; in the `ending`
/// state it carries the Off note. Slash commands and messages without text
/// carry nothing and leave the state alone; `/clear` and `/compact` make the
/// next frame a full one.
///
/// Best-effort: a database error leaves the message without a frame rather
/// than failing the send.
pub async fn plan_frame(
    db: &DatabaseConnection,
    emitter: &EventEmitter,
    session: &Arc<RwLock<SessionState>>,
    conversation_id: Option<i32>,
    blocks: &[PromptInputBlock],
    spoken: bool,
) -> TalkSend {
    let mut send = TalkSend {
        spoken,
        ..TalkSend::default()
    };
    if clears_context(blocks) {
        session.write().await.talk_rules_key = None;
    }
    if !carries_frame(blocks) {
        return send;
    }
    let mut state = match conversation_id {
        Some(cid) => match conversation_service::read_talk_state(db, cid).await {
            Ok(state) => state.flatten(),
            Err(e) => {
                tracing::warn!(
                    conversation_id = cid,
                    "[talk] failed to read the state: {e}"
                );
                return send;
            }
        },
        None => None,
    };
    let mut turn_on_after = false;
    if spoken && state != Some(ConversationTalkState::On) {
        state = Some(ConversationTalkState::On);
        session.write().await.talk_rules_key = None;
        match conversation_id {
            Some(cid) => {
                turn_on(db, emitter, cid).await;
            }
            None => turn_on_after = true,
        }
    }
    let (agent_type, delivered_key) = {
        let s = session.read().await;
        (s.agent_type, s.talk_rules_key.clone())
    };
    let settings = load_talk_settings(db).await;
    let rules_key = rules_key(settings, agent_type);
    let Some(mode) = frame_mode(state, delivered_key.as_deref() == Some(rules_key.as_str())) else {
        return send;
    };
    let body = match mode {
        TalkFrameMode::Full => rules::full(settings, agent_type),
        TalkFrameMode::Compact => rules::compact(settings),
        TalkFrameMode::Off => rules::off().to_string(),
    };
    send.frame = Some(talk_frame::render(mode, spoken, &body));
    send.planned = Some(Planned {
        mode,
        rules_key,
        turn_on_after,
    });
    send
}

/// Record what reached the agent. `delivered` is true only once the prompt
/// was accepted or the insert reported `injected`; anything else leaves the
/// connection to send the full rules again next time.
pub async fn finish_frame(
    db: &DatabaseConnection,
    emitter: &EventEmitter,
    session: &Arc<RwLock<SessionState>>,
    conversation_id: Option<i32>,
    send: &TalkSend,
    delivered: bool,
) {
    let Some(planned) = send.planned.as_ref().filter(|_| delivered) else {
        return;
    };
    match planned.mode {
        TalkFrameMode::Full => {
            session.write().await.talk_rules_key = Some(planned.rules_key.clone());
        }
        TalkFrameMode::Compact => {}
        TalkFrameMode::Off => {
            session.write().await.talk_rules_key = None;
            if let Some(cid) = conversation_id {
                // Only from `ending`: Talk switched on again meanwhile stays on.
                match conversation_service::swap_talk_state(
                    db,
                    cid,
                    Some(ConversationTalkState::Ending),
                    None,
                )
                .await
                {
                    Ok(true) => {
                        crate::commands::conversations::emit_conversation_upsert(emitter, db, cid)
                            .await;
                    }
                    Ok(false) => {}
                    Err(e) => {
                        tracing::warn!(conversation_id = cid, "[talk] failed to end Talk: {e}")
                    }
                }
            }
        }
    }
    if planned.turn_on_after {
        if let Some(cid) = conversation_id {
            turn_on(db, emitter, cid).await;
        }
    }
}

/// Talk on for `conversation_id`, broadcast when it changed anything.
async fn turn_on(db: &DatabaseConnection, emitter: &EventEmitter, conversation_id: i32) {
    match conversation_service::set_talk_state(db, conversation_id, Some(ConversationTalkState::On))
        .await
    {
        Ok(true) => {
            crate::commands::conversations::emit_conversation_upsert(emitter, db, conversation_id)
                .await;
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(conversation_id, "[talk] failed to turn Talk on: {e}"),
    }
}

#[cfg(test)]
mod tests;
