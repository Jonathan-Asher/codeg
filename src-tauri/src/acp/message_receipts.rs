//! Receipts for user messages the server has accepted, keyed by the id the
//! sending client gave each message (`client_message_id`).
//!
//! A client that loses the answer to a send (a dropped connection, a request
//! that timed out, a server restart, a page reload) cannot tell whether the
//! message arrived. It sends it again with the same id, and a receipt turns
//! that second copy into a no-op instead of a second message to the agent.
//!
//! Prompts (`acp_prompt`) and messages delivered into a running turn
//! (`submit_session_feedback`) share one namespace per conversation: a message
//! whose insert went through but looked failed to the client is not sent
//! again as the next turn's prompt.
//!
//! Receipts live in memory and are written through to `app_metadata` (one row
//! per conversation holding its most recent receipts), so a retry that only
//! arrives after a restart is still recognised.
//!
//! Attempts with the same id are serialized by [`MessageReceipts::lock_id`]:
//! a retry that races the original waits for it, then finds its receipt.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::db::service::app_metadata_service;
use crate::db::AppDatabase;

/// Receipts kept per conversation. A retry follows its original within
/// minutes; this only has to outlast the messages a client could still be
/// holding unsent.
const PER_CONVERSATION: usize = 200;
/// Receipts older than this are dropped when the conversation's list is
/// written.
const MAX_AGE_SECS: i64 = 14 * 24 * 3600;
/// Longest id that is honoured. Clients send `optimistic-<uuid>`; anything
/// absurd is treated as "no id" rather than stored.
const MAX_ID_LEN: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Receipt {
    id: String,
    /// Unix seconds when the message was accepted.
    at: i64,
}

/// Whether `id` is usable as an idempotency key.
pub fn is_valid_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && id.len() <= MAX_ID_LEN && !id.chars().any(char::is_control)
}

fn storage_key(conversation_id: i32) -> String {
    format!("acp.message_receipts.{conversation_id}")
}

#[derive(Default)]
pub struct MessageReceipts {
    /// Conversation id -> its receipts, oldest first. A conversation is
    /// present once its persisted list has been read.
    by_conversation: Mutex<HashMap<i32, VecDeque<Receipt>>>,
    /// One async lock per id currently being admitted.
    id_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

/// Held while one attempt with a given id is admitted (see
/// [`MessageReceipts::lock_id`]). Dropping it lets the next attempt in.
pub struct IdGuard {
    receipts: Arc<MessageReceipts>,
    id: String,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for IdGuard {
    fn drop(&mut self) {
        let Ok(mut locks) = self.receipts.id_locks.lock() else {
            return;
        };
        // Drop the entry once nobody else waits on it (the map holds one
        // reference, this guard's lock another).
        if let Some(lock) = locks.get(&self.id) {
            if Arc::strong_count(lock) <= 2 {
                locks.remove(&self.id);
            }
        }
    }
}

impl MessageReceipts {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serialize every attempt that carries `id`, so an original and its
    /// retry are never admitted at the same time.
    pub async fn lock_id(self: &Arc<Self>, id: &str) -> IdGuard {
        let lock = {
            let mut locks = self
                .id_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locks
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let guard = lock.lock_owned().await;
        IdGuard {
            receipts: Arc::clone(self),
            id: id.to_string(),
            _guard: guard,
        }
    }

    async fn ensure_loaded(
        &self,
        db: &AppDatabase,
        map: &mut HashMap<i32, VecDeque<Receipt>>,
        conversation_id: i32,
    ) {
        if map.contains_key(&conversation_id) {
            return;
        }
        let loaded = match app_metadata_service::get_value(&db.conn, &storage_key(conversation_id))
            .await
        {
            Ok(Some(raw)) => serde_json::from_str::<VecDeque<Receipt>>(&raw).unwrap_or_default(),
            Ok(None) => VecDeque::new(),
            Err(e) => {
                tracing::warn!(
                    conversation_id,
                    error = %e,
                    "[receipts] could not read the stored message receipts"
                );
                VecDeque::new()
            }
        };
        map.insert(conversation_id, loaded);
    }

    /// Whether a message with `id` was already accepted for the conversation.
    pub async fn contains(&self, db: &AppDatabase, conversation_id: i32, id: &str) -> bool {
        let mut map = self.by_conversation.lock().await;
        self.ensure_loaded(db, &mut map, conversation_id).await;
        map.get(&conversation_id)
            .is_some_and(|list| list.iter().any(|r| r.id == id))
    }

    /// Record that the message with `id` was accepted for the conversation,
    /// and write the conversation's list through to the database.
    pub async fn record(&self, db: &AppDatabase, conversation_id: i32, id: &str) {
        let now = chrono::Utc::now().timestamp();
        let serialized = {
            let mut map = self.by_conversation.lock().await;
            self.ensure_loaded(db, &mut map, conversation_id).await;
            let list = map.entry(conversation_id).or_default();
            if list.iter().any(|r| r.id == id) {
                return;
            }
            list.push_back(Receipt {
                id: id.to_string(),
                at: now,
            });
            while list.front().is_some_and(|r| now - r.at > MAX_AGE_SECS) {
                list.pop_front();
            }
            while list.len() > PER_CONVERSATION {
                list.pop_front();
            }
            serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string())
        };
        if let Err(e) =
            app_metadata_service::upsert_value(&db.conn, &storage_key(conversation_id), &serialized)
                .await
        {
            // The in-memory receipt still covers retries until a restart.
            tracing::warn!(
                conversation_id,
                error = %e,
                "[receipts] could not store the message receipt"
            );
        }
    }

    /// Forget the in-memory copy, as a restart would (tests).
    #[cfg(test)]
    pub async fn forget_memory(&self) {
        self.by_conversation.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers;

    #[test]
    fn valid_ids() {
        assert!(is_valid_id("optimistic-3f1c"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("   "));
        assert!(!is_valid_id(&"x".repeat(MAX_ID_LEN + 1)));
        assert!(!is_valid_id("a\nb"));
    }

    #[tokio::test]
    async fn records_per_conversation_and_survive_a_restart() {
        let db = test_helpers::fresh_in_memory_db().await;
        let receipts = MessageReceipts::new();
        assert!(!receipts.contains(&db, 1, "m-1").await);
        receipts.record(&db, 1, "m-1").await;
        assert!(receipts.contains(&db, 1, "m-1").await);
        // Scoped to the conversation.
        assert!(!receipts.contains(&db, 2, "m-1").await);

        // A fresh process reads the stored list.
        let restarted = MessageReceipts::new();
        assert!(restarted.contains(&db, 1, "m-1").await);
        receipts.forget_memory().await;
        assert!(receipts.contains(&db, 1, "m-1").await);
    }

    #[tokio::test]
    async fn keeps_only_the_most_recent_receipts() {
        let db = test_helpers::fresh_in_memory_db().await;
        let receipts = MessageReceipts::new();
        for i in 0..(PER_CONVERSATION + 5) {
            receipts.record(&db, 7, &format!("m-{i}")).await;
        }
        assert!(!receipts.contains(&db, 7, "m-0").await);
        assert!(
            receipts
                .contains(&db, 7, &format!("m-{}", PER_CONVERSATION + 4))
                .await
        );
        let restarted = MessageReceipts::new();
        assert!(!restarted.contains(&db, 7, "m-4").await);
        assert!(restarted.contains(&db, 7, "m-5").await);
    }

    #[tokio::test]
    async fn lock_id_serializes_attempts_with_the_same_id() {
        let receipts = Arc::new(MessageReceipts::new());
        let first = receipts.lock_id("same").await;
        let other = receipts.clone();
        let waiter = tokio::spawn(async move {
            let _g = other.lock_id("same").await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(
            !waiter.is_finished(),
            "a second attempt waits for the first"
        );
        // A different id is not held up.
        let _unrelated = receipts.lock_id("other").await;
        drop(first);
        waiter.await.unwrap();
        assert!(receipts.id_locks.lock().unwrap().get("same").is_none());
    }
}
