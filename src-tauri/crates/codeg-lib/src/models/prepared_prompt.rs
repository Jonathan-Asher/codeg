use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::db::entities::prepared_prompt;

/// A prepared prompt as the UI sees it: one message the user wrote ahead of
/// time for one conversation (see `db::service::prepared_prompt_service`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPromptInfo {
    pub id: i32,
    pub conversation_id: i32,
    pub content: String,
    /// Position in the conversation's list, top to bottom.
    pub sort_order: i32,
    /// When it was last sent from the panel; `None` until then.
    pub last_sent_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<prepared_prompt::Model> for PreparedPromptInfo {
    fn from(row: prepared_prompt::Model) -> Self {
        Self {
            id: row.id,
            conversation_id: row.conversation_id,
            content: row.content,
            sort_order: row.sort_order,
            last_sent_at: row.last_sent_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}
