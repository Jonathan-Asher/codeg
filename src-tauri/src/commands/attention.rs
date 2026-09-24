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
}

pub async fn list_conversation_attention_core(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
) -> Result<Vec<ConversationAttention>, AppCommandError> {
    let raw = manager.list_attention().await;
    let mut out = Vec::with_capacity(raw.len());
    for (conversation_id, kind) in raw {
        out.push(ConversationAttention {
            conversation_id,
            kind,
            root_conversation_id: root_of(db, conversation_id).await,
        });
    }
    Ok(out)
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
