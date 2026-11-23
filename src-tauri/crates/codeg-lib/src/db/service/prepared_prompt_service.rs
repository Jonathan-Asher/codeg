//! Prepared prompts (`prepared_prompt`, see `m20261123_000001_prepared_prompt`):
//! messages the user wrote ahead of time for one conversation, listed in the
//! right-hand panel's Prompts tab. Each conversation has its own list, in the
//! order the user dragged it into; nothing is shared between conversations.
//!
//! Only the user writes them: the desktop commands and the web handlers are
//! the only callers, and no agent-facing tool reaches this module.

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};

use crate::db::entities::prepared_prompt;
use crate::db::error::DbError;
use crate::db::service::conversation_service;

/// The longest prompt kept, in characters. Well past anything typed by hand;
/// it only stops a paste of a whole file from filling the database.
pub const MAX_CONTENT_CHARS: usize = 100_000;

/// The text to store, or why it can't be: a prompt is never blank (it would
/// send nothing) and never longer than [`MAX_CONTENT_CHARS`]. Kept as typed,
/// leading and trailing whitespace included; the send trims it like the
/// composer trims a typed message.
fn checked_content(content: &str) -> Result<String, DbError> {
    if content.trim().is_empty() {
        return Err(DbError::Validation("A prompt can't be empty".to_string()));
    }
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(DbError::Validation(format!(
            "A prompt can be at most {MAX_CONTENT_CHARS} characters"
        )));
    }
    Ok(content.to_string())
}

async fn find(conn: &DatabaseConnection, id: i32) -> Result<prepared_prompt::Model, DbError> {
    prepared_prompt::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("Prepared prompt {id} not found")))
}

/// The conversation's prompts, top to bottom.
pub async fn list(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<prepared_prompt::Model>, DbError> {
    Ok(prepared_prompt::Entity::find()
        .filter(prepared_prompt::Column::ConversationId.eq(conversation_id))
        .order_by_asc(prepared_prompt::Column::SortOrder)
        .order_by_asc(prepared_prompt::Column::Id)
        .all(conn)
        .await?)
}

/// Add a prompt at the end of a live conversation's list.
pub async fn create(
    conn: &DatabaseConnection,
    conversation_id: i32,
    content: &str,
) -> Result<prepared_prompt::Model, DbError> {
    let content = checked_content(content)?;
    if conversation_service::find_live_row(conn, conversation_id)
        .await?
        .is_none()
    {
        return Err(DbError::NotFound(format!(
            "Conversation {conversation_id} not found"
        )));
    }
    let next_order = prepared_prompt::Entity::find()
        .filter(prepared_prompt::Column::ConversationId.eq(conversation_id))
        .order_by_desc(prepared_prompt::Column::SortOrder)
        .one(conn)
        .await?
        .map(|last| last.sort_order + 1)
        .unwrap_or(0);
    let now = Utc::now();
    let row = prepared_prompt::ActiveModel {
        conversation_id: Set(conversation_id),
        content: Set(content),
        sort_order: Set(next_order),
        last_sent_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    Ok(row.insert(conn).await?)
}

/// Replace a prompt's text. Its place in the list and its sent mark stay.
pub async fn update_content(
    conn: &DatabaseConnection,
    id: i32,
    content: &str,
) -> Result<prepared_prompt::Model, DbError> {
    let content = checked_content(content)?;
    let mut active = find(conn, id).await?.into_active_model();
    active.content = Set(content);
    active.updated_at = Set(Utc::now());
    Ok(active.update(conn).await?)
}

/// Record that the prompt was just sent. It stays in the list: a sequence of
/// follow-ups is worked through by sending them one after another, and the
/// mark shows how far that got.
pub async fn mark_sent(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<prepared_prompt::Model, DbError> {
    let mut active = find(conn, id).await?.into_active_model();
    active.last_sent_at = Set(Some(Utc::now()));
    Ok(active.update(conn).await?)
}

/// Delete one prompt. The conversation it belonged to, or `None` when there
/// was no such prompt.
pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<Option<i32>, DbError> {
    let Some(row) = prepared_prompt::Entity::find_by_id(id).one(conn).await? else {
        return Ok(None);
    };
    let result = prepared_prompt::Entity::delete_by_id(id).exec(conn).await?;
    Ok((result.rows_affected > 0).then_some(row.conversation_id))
}

/// Put the conversation's list in `ordered_ids` order (top to bottom) and
/// return it. Ids of other conversations' prompts, unknown ids and repeats are
/// ignored; a prompt of this conversation that `ordered_ids` leaves out (one
/// added in another window while this one was dragging) keeps its place
/// relative to the other left-out ones, after the listed ones.
pub async fn reorder(
    conn: &DatabaseConnection,
    conversation_id: i32,
    ordered_ids: &[i32],
) -> Result<Vec<prepared_prompt::Model>, DbError> {
    let txn = conn.begin().await?;
    let current = prepared_prompt::Entity::find()
        .filter(prepared_prompt::Column::ConversationId.eq(conversation_id))
        .order_by_asc(prepared_prompt::Column::SortOrder)
        .order_by_asc(prepared_prompt::Column::Id)
        .all(&txn)
        .await?;
    let mut order: Vec<i32> = Vec::with_capacity(current.len());
    for id in ordered_ids {
        if !order.contains(id) && current.iter().any(|row| row.id == *id) {
            order.push(*id);
        }
    }
    for row in &current {
        if !order.contains(&row.id) {
            order.push(row.id);
        }
    }
    for row in current {
        let position = order
            .iter()
            .position(|id| *id == row.id)
            .unwrap_or_default() as i32;
        if row.sort_order != position {
            let mut active = row.into_active_model();
            active.sort_order = Set(position);
            active.update(&txn).await?;
        }
    }
    txn.commit().await?;
    list(conn, conversation_id).await
}

/// Delete every prompt of a conversation; how many there were. Called when the
/// conversation is deleted, which only marks its row.
pub async fn delete_for_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<u64, DbError> {
    let result = prepared_prompt::Entity::delete_many()
        .filter(prepared_prompt::Column::ConversationId.eq(conversation_id))
        .exec(conn)
        .await?;
    Ok(result.rows_affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    async fn two_conversations() -> (crate::db::AppDatabase, i32, i32) {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/prepared-prompts").await;
        let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let b = seed_conversation(&db, folder, AgentType::Codex).await;
        (db, a, b)
    }

    fn contents(rows: &[prepared_prompt::Model]) -> Vec<&str> {
        rows.iter().map(|row| row.content.as_str()).collect()
    }

    #[tokio::test]
    async fn each_conversation_has_its_own_list_in_insertion_order() {
        let (db, a, b) = two_conversations().await;
        for text in ["first", "second", "third"] {
            create(&db.conn, a, text).await.unwrap();
        }
        create(&db.conn, b, "elsewhere").await.unwrap();

        let rows = list(&db.conn, a).await.unwrap();
        assert_eq!(contents(&rows), ["first", "second", "third"]);
        assert_eq!(
            rows.iter().map(|row| row.sort_order).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert!(rows.iter().all(|row| row.last_sent_at.is_none()));
        assert_eq!(contents(&list(&db.conn, b).await.unwrap()), ["elsewhere"]);
    }

    #[tokio::test]
    async fn keeps_the_text_as_typed_and_refuses_a_blank_or_huge_one() {
        let (db, a, _) = two_conversations().await;
        let row = create(&db.conn, a, "  line one\nline two\n").await.unwrap();
        assert_eq!(row.content, "  line one\nline two\n");

        for bad in ["", "   ", "\n\t "] {
            let refused = create(&db.conn, a, bad).await;
            assert!(matches!(refused, Err(DbError::Validation(_))), "{bad:?}");
        }
        let huge = "x".repeat(MAX_CONTENT_CHARS + 1);
        assert!(matches!(
            create(&db.conn, a, &huge).await,
            Err(DbError::Validation(_))
        ));
        assert!(matches!(
            update_content(&db.conn, row.id, " ").await,
            Err(DbError::Validation(_))
        ));
        assert_eq!(list(&db.conn, a).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_deleted_or_missing_conversation_takes_no_prompts() {
        let (db, a, _) = two_conversations().await;
        conversation_service::soft_delete(&db.conn, a)
            .await
            .unwrap();
        assert!(matches!(
            create(&db.conn, a, "too late").await,
            Err(DbError::NotFound(_))
        ));
        assert!(matches!(
            create(&db.conn, 9_999, "nowhere").await,
            Err(DbError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn editing_keeps_the_place_and_the_sent_mark() {
        let (db, a, _) = two_conversations().await;
        create(&db.conn, a, "one").await.unwrap();
        let two = create(&db.conn, a, "two").await.unwrap();
        mark_sent(&db.conn, two.id).await.unwrap();
        let sent = find(&db.conn, two.id).await.unwrap();
        assert!(sent.last_sent_at.is_some());

        let edited = update_content(&db.conn, two.id, "two, reworded")
            .await
            .unwrap();
        assert_eq!(edited.content, "two, reworded");
        assert_eq!(edited.sort_order, two.sort_order);
        assert_eq!(edited.last_sent_at, sent.last_sent_at);
        assert_eq!(
            contents(&list(&db.conn, a).await.unwrap()),
            ["one", "two, reworded"]
        );
        assert!(matches!(
            update_content(&db.conn, 9_999, "x").await,
            Err(DbError::NotFound(_))
        ));
        assert!(matches!(
            mark_sent(&db.conn, 9_999).await,
            Err(DbError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn sending_again_moves_the_mark_forward() {
        let (db, a, _) = two_conversations().await;
        let row = create(&db.conn, a, "again").await.unwrap();
        let earlier = Utc::now() - chrono::Duration::hours(2);
        let mut active = mark_sent(&db.conn, row.id)
            .await
            .unwrap()
            .into_active_model();
        active.last_sent_at = Set(Some(earlier));
        active.update(&db.conn).await.unwrap();

        let again = mark_sent(&db.conn, row.id).await.unwrap().last_sent_at;
        assert!(again.expect("sent") > earlier);
        // Still listed: a sent prompt is never removed by sending it.
        assert_eq!(list(&db.conn, a).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delete_removes_one_and_says_whose_it_was() {
        let (db, a, _) = two_conversations().await;
        let one = create(&db.conn, a, "one").await.unwrap();
        create(&db.conn, a, "two").await.unwrap();

        assert_eq!(delete(&db.conn, one.id).await.unwrap(), Some(a));
        assert_eq!(delete(&db.conn, one.id).await.unwrap(), None);
        assert_eq!(contents(&list(&db.conn, a).await.unwrap()), ["two"]);
    }

    #[tokio::test]
    async fn reorder_follows_the_given_order_and_ignores_strangers() {
        let (db, a, b) = two_conversations().await;
        let one = create(&db.conn, a, "one").await.unwrap();
        let two = create(&db.conn, a, "two").await.unwrap();
        let three = create(&db.conn, a, "three").await.unwrap();
        let other = create(&db.conn, b, "other").await.unwrap();

        let rows = reorder(&db.conn, a, &[three.id, one.id, two.id])
            .await
            .unwrap();
        assert_eq!(contents(&rows), ["three", "one", "two"]);
        assert_eq!(
            rows.iter().map(|row| row.sort_order).collect::<Vec<_>>(),
            [0, 1, 2]
        );

        // Another conversation's prompt, an unknown id and a repeat change
        // nothing for anyone; a left-out prompt stays after the listed ones.
        let rows = reorder(&db.conn, a, &[two.id, other.id, 9_999, two.id])
            .await
            .unwrap();
        assert_eq!(contents(&rows), ["two", "three", "one"]);
        let others = list(&db.conn, b).await.unwrap();
        assert_eq!(contents(&others), ["other"]);
        assert_eq!(others[0].sort_order, other.sort_order);

        // A prompt added after the reorder still goes to the end.
        create(&db.conn, a, "four").await.unwrap();
        assert_eq!(
            contents(&list(&db.conn, a).await.unwrap()),
            ["two", "three", "one", "four"]
        );
    }

    #[tokio::test]
    async fn delete_for_conversation_clears_only_that_list() {
        let (db, a, b) = two_conversations().await;
        create(&db.conn, a, "one").await.unwrap();
        create(&db.conn, a, "two").await.unwrap();
        create(&db.conn, b, "kept").await.unwrap();

        assert_eq!(delete_for_conversation(&db.conn, a).await.unwrap(), 2);
        assert!(list(&db.conn, a).await.unwrap().is_empty());
        assert_eq!(contents(&list(&db.conn, b).await.unwrap()), ["kept"]);
        assert_eq!(delete_for_conversation(&db.conn, a).await.unwrap(), 0);
    }
}
