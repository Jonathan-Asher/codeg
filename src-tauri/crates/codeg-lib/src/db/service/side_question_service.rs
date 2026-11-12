//! The `/btw` exchanges of a conversation (`side_question`, see
//! `crate::acp::side_question`).

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Set,
};

use crate::db::entities::side_question;
use crate::db::error::DbError;

/// What one answered side question stores.
#[derive(Debug, Clone)]
pub struct NewSideQuestion {
    pub conversation_id: i32,
    pub question: String,
    pub answer: Option<String>,
    pub synthetic: bool,
    pub fallback_notice: Option<String>,
}

pub async fn insert(
    conn: &DatabaseConnection,
    exchange: NewSideQuestion,
) -> Result<side_question::Model, DbError> {
    let row = side_question::ActiveModel {
        conversation_id: Set(exchange.conversation_id),
        question: Set(exchange.question),
        answer: Set(exchange.answer),
        synthetic: Set(exchange.synthetic),
        fallback_notice: Set(exchange.fallback_notice),
        created_at: Set(Utc::now()),
        ..Default::default()
    };
    Ok(row.insert(conn).await?)
}

/// The conversation's newest `limit` exchanges, oldest first.
pub async fn list(
    conn: &DatabaseConnection,
    conversation_id: i32,
    limit: u64,
) -> Result<Vec<side_question::Model>, DbError> {
    let mut newest = side_question::Entity::find()
        .filter(side_question::Column::ConversationId.eq(conversation_id))
        .order_by_desc(side_question::Column::Id)
        .limit(limit)
        .all(conn)
        .await?;
    newest.reverse();
    Ok(newest)
}

/// The exchanges a new side question carries as `history`: the newest `limit`
/// the model itself answered, oldest first. A notice from Claude Code
/// (`synthetic`) and an empty answer are not part of the conversation the
/// model had, so they are left out.
pub async fn replay_history(
    conn: &DatabaseConnection,
    conversation_id: i32,
    limit: u64,
) -> Result<Vec<(String, String)>, DbError> {
    let mut newest = side_question::Entity::find()
        .filter(side_question::Column::ConversationId.eq(conversation_id))
        .filter(side_question::Column::Synthetic.eq(false))
        .filter(side_question::Column::Answer.is_not_null())
        .order_by_desc(side_question::Column::Id)
        .limit(limit)
        .all(conn)
        .await?;
    newest.reverse();
    Ok(newest
        .into_iter()
        .filter_map(|row| row.answer.map(|answer| (row.question, answer)))
        .collect())
}

/// Delete every exchange of the conversation; the number deleted.
pub async fn clear(conn: &DatabaseConnection, conversation_id: i32) -> Result<u64, DbError> {
    let result = side_question::Entity::delete_many()
        .filter(side_question::Column::ConversationId.eq(conversation_id))
        .exec(conn)
        .await?;
    Ok(result.rows_affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    fn exchange(conversation_id: i32, question: &str, answer: Option<&str>) -> NewSideQuestion {
        NewSideQuestion {
            conversation_id,
            question: question.to_string(),
            answer: answer.map(str::to_string),
            synthetic: false,
            fallback_notice: None,
        }
    }

    #[tokio::test]
    async fn lists_the_newest_exchanges_oldest_first_per_conversation() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/side-question").await;
        let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let b = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        for i in 0..5 {
            insert(&db.conn, exchange(a, &format!("q{i}"), Some("x")))
                .await
                .unwrap();
        }
        insert(&db.conn, exchange(b, "other", Some("y")))
            .await
            .unwrap();

        let rows = list(&db.conn, a, 3).await.unwrap();
        let questions: Vec<_> = rows.iter().map(|r| r.question.as_str()).collect();
        assert_eq!(questions, ["q2", "q3", "q4"]);
        assert_eq!(list(&db.conn, b, 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn replay_keeps_only_the_models_answers_and_the_newest_ones() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/side-question").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        insert(&db.conn, exchange(conversation, "first", Some("one")))
            .await
            .unwrap();
        // A notice from Claude Code and an empty answer are shown, never replayed.
        insert(
            &db.conn,
            NewSideQuestion {
                synthetic: true,
                ..exchange(conversation, "notice", Some("(API error: overloaded)"))
            },
        )
        .await
        .unwrap();
        insert(&db.conn, exchange(conversation, "empty", None))
            .await
            .unwrap();
        for i in 0..3 {
            insert(
                &db.conn,
                exchange(conversation, &format!("later{i}"), Some(&format!("a{i}"))),
            )
            .await
            .unwrap();
        }

        let history = replay_history(&db.conn, conversation, 2).await.unwrap();
        assert_eq!(
            history,
            [
                ("later1".to_string(), "a1".to_string()),
                ("later2".to_string(), "a2".to_string())
            ]
        );
        let all = replay_history(&db.conn, conversation, 20).await.unwrap();
        let questions: Vec<_> = all.iter().map(|(q, _)| q.as_str()).collect();
        assert_eq!(questions, ["first", "later0", "later1", "later2"]);
    }

    #[tokio::test]
    async fn clear_removes_only_that_conversations_exchanges() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/side-question").await;
        let a = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let b = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        insert(&db.conn, exchange(a, "q", Some("x"))).await.unwrap();
        insert(&db.conn, exchange(a, "q2", Some("x")))
            .await
            .unwrap();
        insert(&db.conn, exchange(b, "q", Some("y"))).await.unwrap();

        assert_eq!(clear(&db.conn, a).await.unwrap(), 2);
        assert!(list(&db.conn, a, 10).await.unwrap().is_empty());
        assert_eq!(list(&db.conn, b, 10).await.unwrap().len(), 1);
    }
}
