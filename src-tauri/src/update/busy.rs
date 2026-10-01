//! Which sessions an app restart would cut off mid-turn.
//!
//! A restart (an update, most of all) kills every agent turn in flight. Before
//! one, the update flow asks this module which sessions are mid-turn, so the
//! user can decide whether to wait for them; the "update when idle" wait polls
//! it until the machine has been quiet long enough.
//!
//! A session is mid-turn when:
//!   * its live connection is prompting — the agent is working, or the turn is
//!     held open only for background work (sub-agents, background shells);
//!   * its live connection is blocked on the user (a permission, a question, a
//!     plan approval): the turn is waiting, not over;
//!   * its persisted `turn_state` is `running` and no live connection says
//!     otherwise.

use std::collections::{HashMap, HashSet};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::ConnectionStatus;
use crate::app_error::AppCommandError;
use crate::db::entities::conversation::{self, ConversationTurnState};
use crate::models::AgentType;

/// Why a session counts as mid-turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BusyReason {
    /// The agent is working on the turn.
    Working,
    /// The turn is waiting on the user: a permission, a question or a plan
    /// approval.
    NeedsYou,
    /// The turn is held open only for background work.
    Background,
}

/// One session a restart would interrupt, as clients list it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusySession {
    /// Absent for a live connection not bound to a conversation yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    pub reason: BusyReason,
}

/// What a live connection says about its session.
#[derive(Debug, Clone)]
pub struct LiveTurn {
    pub conversation_id: Option<i32>,
    pub folder_id: Option<i32>,
    pub agent_type: AgentType,
    pub status: ConnectionStatus,
    pub awaiting_background: bool,
    pub needs_you: bool,
}

/// A conversation whose persisted `turn_state` is `running`.
#[derive(Debug, Clone)]
pub struct PersistedTurn {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub title: Option<String>,
    pub agent_type: Option<AgentType>,
}

/// The busy sessions, from what the live connections and the database say.
/// A live connection is first-hand evidence and wins over the persisted
/// `running` mark of the same conversation (which may not have caught up with
/// a turn that just ended). Ordered by conversation id, unbound connections
/// last, so a polled list does not reshuffle.
pub fn classify(
    live: &[LiveTurn],
    running: &[PersistedTurn],
    titles: &HashMap<i32, String>,
) -> Vec<BusySession> {
    let mut out = Vec::new();
    let mut decided: HashSet<i32> = HashSet::new();
    for turn in live {
        if let Some(id) = turn.conversation_id {
            decided.insert(id);
        }
        let reason = if turn.needs_you {
            BusyReason::NeedsYou
        } else if turn.status == ConnectionStatus::Prompting {
            if turn.awaiting_background {
                BusyReason::Background
            } else {
                BusyReason::Working
            }
        } else {
            continue;
        };
        out.push(BusySession {
            conversation_id: turn.conversation_id,
            folder_id: turn.folder_id,
            title: turn.conversation_id.and_then(|id| titles.get(&id).cloned()),
            agent_type: Some(turn.agent_type),
            reason,
        });
    }
    for row in running {
        if decided.contains(&row.conversation_id) {
            continue;
        }
        out.push(BusySession {
            conversation_id: Some(row.conversation_id),
            folder_id: Some(row.folder_id),
            title: row.title.clone(),
            agent_type: row.agent_type,
            reason: BusyReason::Working,
        });
    }
    out.sort_by_key(|s| (s.conversation_id.is_none(), s.conversation_id));
    out
}

/// Read every live connection's side of [`classify`].
pub async fn collect_live_turns(manager: &ConnectionManager) -> Vec<LiveTurn> {
    let mut out = Vec::new();
    for info in manager.list_connections().await {
        let Some(state) = manager.get_state(&info.id).await else {
            continue;
        };
        let s = state.read().await;
        out.push(LiveTurn {
            conversation_id: s.conversation_id,
            folder_id: s.folder_id,
            agent_type: s.agent_type,
            status: s.status.clone(),
            awaiting_background: s.awaiting_background,
            needs_you: s.attention_kind().is_some(),
        });
    }
    out
}

/// Conversations whose persisted turn is still `running`.
async fn running_rows(db: &DatabaseConnection) -> Result<Vec<PersistedTurn>, AppCommandError> {
    let rows = conversation::Entity::find()
        .filter(conversation::Column::TurnState.eq(ConversationTurnState::Running))
        .filter(conversation::Column::DeletedAt.is_null())
        .all(db)
        .await
        .map_err(|e| AppCommandError::from(crate::db::error::DbError::from(e)))?;
    Ok(rows
        .into_iter()
        .map(|m| PersistedTurn {
            conversation_id: m.id,
            folder_id: m.folder_id,
            title: m.title,
            agent_type: AgentType::from_wire(&m.agent_type),
        })
        .collect())
}

/// Titles of the given conversations (those that have one).
async fn titles_for(
    db: &DatabaseConnection,
    ids: &[i32],
) -> Result<HashMap<i32, String>, AppCommandError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = conversation::Entity::find()
        .filter(conversation::Column::Id.is_in(ids.iter().copied()))
        .all(db)
        .await
        .map_err(|e| AppCommandError::from(crate::db::error::DbError::from(e)))?;
    Ok(rows
        .into_iter()
        .filter_map(|m| m.title.map(|t| (m.id, t)))
        .collect())
}

/// Every session a restart right now would cut off mid-turn. An unreadable
/// database is an error, never an empty list: the "update when idle" wait must
/// not mistake a failed read for a quiet machine.
pub async fn list_busy_sessions(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
) -> Result<Vec<BusySession>, AppCommandError> {
    let live = collect_live_turns(manager).await;
    let running = running_rows(db).await?;
    let ids: Vec<i32> = live.iter().filter_map(|t| t.conversation_id).collect();
    let titles = titles_for(db, &ids).await?;
    Ok(classify(&live, &running, &titles))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(id: Option<i32>, status: ConnectionStatus) -> LiveTurn {
        LiveTurn {
            conversation_id: id,
            folder_id: Some(1),
            agent_type: AgentType::ClaudeCode,
            status,
            awaiting_background: false,
            needs_you: false,
        }
    }

    fn running(id: i32) -> PersistedTurn {
        PersistedTurn {
            conversation_id: id,
            folder_id: 1,
            title: Some(format!("row {id}")),
            agent_type: Some(AgentType::Codex),
        }
    }

    #[test]
    fn a_prompting_connection_is_working_or_held_for_background() {
        let mut held = live(Some(2), ConnectionStatus::Prompting);
        held.awaiting_background = true;
        let titles = HashMap::from([(1, "Fix the parser".to_string())]);
        let busy = classify(
            &[live(Some(1), ConnectionStatus::Prompting), held],
            &[],
            &titles,
        );
        assert_eq!(busy.len(), 2);
        assert_eq!(busy[0].reason, BusyReason::Working);
        assert_eq!(busy[0].title.as_deref(), Some("Fix the parser"));
        assert_eq!(busy[1].reason, BusyReason::Background);
        assert_eq!(busy[1].title, None);
    }

    #[test]
    fn a_turn_waiting_on_the_user_is_still_mid_turn() {
        let mut waiting = live(Some(3), ConnectionStatus::Connected);
        waiting.needs_you = true;
        let busy = classify(&[waiting], &[], &HashMap::new());
        assert_eq!(busy.len(), 1);
        assert_eq!(busy[0].reason, BusyReason::NeedsYou);
    }

    #[test]
    fn an_idle_connection_is_not_busy_and_overrides_a_stale_running_row() {
        // The persisted `running` lags a turn that just ended; the live
        // connection sitting idle is the first-hand answer.
        let busy = classify(
            &[live(Some(4), ConnectionStatus::Connected)],
            &[running(4)],
            &HashMap::new(),
        );
        assert!(busy.is_empty());
    }

    #[test]
    fn a_running_row_without_a_live_connection_counts_as_working() {
        let busy = classify(&[], &[running(5)], &HashMap::new());
        assert_eq!(busy.len(), 1);
        assert_eq!(busy[0].conversation_id, Some(5));
        assert_eq!(busy[0].reason, BusyReason::Working);
        assert_eq!(busy[0].title.as_deref(), Some("row 5"));
        assert_eq!(busy[0].agent_type, Some(AgentType::Codex));
    }

    #[test]
    fn the_list_is_ordered_with_unbound_connections_last() {
        let busy = classify(
            &[
                live(None, ConnectionStatus::Prompting),
                live(Some(9), ConnectionStatus::Prompting),
            ],
            &[running(2)],
            &HashMap::new(),
        );
        let ids: Vec<Option<i32>> = busy.iter().map(|s| s.conversation_id).collect();
        assert_eq!(ids, vec![Some(2), Some(9), None]);
    }

    #[test]
    fn the_wire_shape_is_camel_case_with_snake_case_reasons() {
        let busy = classify(&[], &[running(7)], &HashMap::new());
        let wire = serde_json::to_value(&busy[0]).unwrap();
        assert_eq!(wire["conversationId"], 7);
        assert_eq!(wire["folderId"], 1);
        assert_eq!(wire["reason"], "working");
        assert_eq!(wire["agentType"], "codex");
    }

    #[tokio::test]
    async fn lists_live_and_persisted_turns_with_their_titles() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
        use crate::web::event_bridge::EventEmitter;
        use sea_orm::{ActiveModelTrait, Set};

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/busy-sessions").await;
        let working = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let idle = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let orphan = seed_conversation(&db, folder, AgentType::Codex).await;
        for (id, title) in [(working, "Working one"), (idle, "Idle one"), (orphan, "Orphan")] {
            let model = conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .unwrap()
                .unwrap();
            let mut active: conversation::ActiveModel = model.into();
            active.title = Set(Some(title.to_string()));
            if id != working {
                active.turn_state = Set(Some(ConversationTurnState::Running));
            }
            active.update(&db.conn).await.unwrap();
        }

        let manager = ConnectionManager::new();
        for (conn_id, conversation_id, status) in [
            ("c-working", working, ConnectionStatus::Prompting),
            ("c-idle", idle, ConnectionStatus::Connected),
        ] {
            manager
                .insert_test_connection(conn_id, AgentType::ClaudeCode, None, EventEmitter::Noop)
                .await;
            let state = manager.get_state(conn_id).await.unwrap();
            let mut s = state.write().await;
            s.conversation_id = Some(conversation_id);
            s.folder_id = Some(folder);
            s.status = status;
        }

        let busy = list_busy_sessions(&manager, &db.conn).await.unwrap();
        let summary: Vec<(Option<i32>, Option<&str>, BusyReason)> = busy
            .iter()
            .map(|s| (s.conversation_id, s.title.as_deref(), s.reason))
            .collect();
        // The idle connection overrides its stale `running` row; the orphaned
        // `running` row (no live connection) still counts.
        assert_eq!(
            summary,
            vec![
                (Some(working), Some("Working one"), BusyReason::Working),
                (Some(orphan), Some("Orphan"), BusyReason::Working),
            ]
        );
    }
}
