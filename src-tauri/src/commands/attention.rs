//! Which conversations are waiting on the user right now — a parked
//! permission, a blocking question, a plan awaiting approval.
//!
//! This is the snapshot half of the sidebar's "needs you" indicator; the live
//! half is the `conversation://attention` broadcast from `emit_with_state`.
//! Clients load it on start and after every reconnect (events fired while a
//! socket was down are dropped), and re-read it after live events so a
//! delegation sub-agent's request lands on the row the user can actually see.

use sea_orm::DatabaseConnection;
use serde::Serialize;

use crate::acp::background_status::{ConversationBackground, ConversationBackgroundEntry};
use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::AttentionKind;
use crate::app_error::AppCommandError;
use crate::db::service::conversation_service;

/// How far up a delegation chain to walk to the visible row. Sub-agents can
/// delegate in turn, but never this deep in practice; the bound only stops a
/// corrupt parent cycle from spinning.
const MAX_PARENT_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationAttention {
    /// The conversation the blocked connection is bound to.
    pub conversation_id: i32,
    pub kind: AttentionKind,
    /// The top-level conversation the sidebar shows for it: itself for an
    /// ordinary session, the root of the delegation chain for a sub-agent
    /// (sub-agent rows are hidden, and a blocked sub-agent otherwise surfaces
    /// only as its parent "running").
    pub root_conversation_id: i32,
    /// What the blocked session also has running in the background (see
    /// `acp::background_status`). Absent when nothing — and from a server
    /// that predates it. Sessions with background work and nothing to ask
    /// are not in this list: `list_conversation_background` has every one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<ConversationBackground>,
}

pub async fn list_conversation_attention_core(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
) -> Result<Vec<ConversationAttention>, AppCommandError> {
    let raw = manager.list_attention().await;
    let mut background = if raw.is_empty() {
        Default::default()
    } else {
        manager.background_by_conversation().await
    };
    let mut out = Vec::with_capacity(raw.len());
    for (conversation_id, kind) in raw {
        out.push(ConversationAttention {
            conversation_id,
            kind,
            root_conversation_id: root_of(db, conversation_id).await,
            background: background.remove(&conversation_id),
        });
    }
    Ok(out)
}

/// Every live session's background activity — background tasks running, the
/// agent working on a turn codeg didn't send, a turn held open for background
/// work. The snapshot half of the `conversation://background` broadcast:
/// clients load it on start and after every reconnect, and re-read it shortly
/// after live events, exactly like the attention snapshot above. Keyed by the
/// conversation the connection is bound to (no root walk: a sub-session's
/// background work shows on its own row).
pub async fn list_conversation_background_core(
    manager: &ConnectionManager,
) -> Result<Vec<ConversationBackgroundEntry>, AppCommandError> {
    let mut out: Vec<ConversationBackgroundEntry> = manager
        .background_by_conversation()
        .await
        .into_iter()
        .map(|(conversation_id, background)| ConversationBackgroundEntry {
            conversation_id,
            background,
        })
        .collect();
    out.sort_by_key(|e| e.conversation_id);
    Ok(out)
}

/// Fill `background` on conversation summaries from the live connections.
/// One pass over the connection map serves the whole list.
pub async fn fill_conversation_background(
    manager: &ConnectionManager,
    summaries: &mut [crate::models::DbConversationSummary],
) {
    if summaries.is_empty() {
        return;
    }
    let mut background = manager.background_by_conversation().await;
    if background.is_empty() {
        return;
    }
    for summary in summaries.iter_mut() {
        summary.background = background.remove(&summary.id);
    }
}

/// Walk `parent_id` up to the top-level row. A row that can't be read ends the
/// walk where it stands: flagging the nearest known ancestor beats dropping
/// the signal over a missing title.
async fn root_of(db: &DatabaseConnection, conversation_id: i32) -> i32 {
    let mut current = conversation_id;
    for _ in 0..MAX_PARENT_DEPTH {
        match conversation_service::get_by_id(db, current).await {
            Ok(summary) => match summary.parent_id {
                Some(parent) if parent != current => current = parent,
                _ => return current,
            },
            Err(_) => return current,
        }
    }
    current
}

/// Desktop-only command wrapper: `tauri::State` exists only with the
/// `tauri-runtime` feature.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_conversation_attention(
    manager: tauri::State<'_, ConnectionManager>,
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<Vec<ConversationAttention>, AppCommandError> {
    list_conversation_attention_core(manager.inner(), &db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_conversation_background(
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<Vec<ConversationBackgroundEntry>, AppCommandError> {
    list_conversation_background_core(manager.inner()).await
}
