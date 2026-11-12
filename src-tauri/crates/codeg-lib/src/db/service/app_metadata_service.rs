use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::NotSet, ColumnTrait, EntityTrait, QueryFilter, Set};
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

use crate::db::entities::app_metadata;
use crate::db::error::DbError;

pub async fn upsert_value<C: ConnectionTrait>(
    conn: &C,
    key: &str,
    value: &str,
) -> Result<(), DbError> {
    let now = Utc::now();

    app_metadata::Entity::insert(app_metadata::ActiveModel {
        id: NotSet,
        key: Set(key.to_string()),
        value: Set(value.to_string()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .on_conflict(
        OnConflict::column(app_metadata::Column::Key)
            .update_columns([app_metadata::Column::Value, app_metadata::Column::UpdatedAt])
            .to_owned(),
    )
    .exec(conn)
    .await?;

    Ok(())
}

pub async fn get_value(conn: &DatabaseConnection, key: &str) -> Result<Option<String>, DbError> {
    get_value_conn(conn, key).await
}

/// Generic-over-connection variant of [`get_value`] so callers can read a value
/// inside a transaction (`&DatabaseTransaction`) and compose it with a write.
pub async fn get_value_conn<C: ConnectionTrait>(
    conn: &C,
    key: &str,
) -> Result<Option<String>, DbError> {
    let model = app_metadata::Entity::find()
        .filter(app_metadata::Column::Key.eq(key))
        .filter(app_metadata::Column::DeletedAt.is_null())
        .one(conn)
        .await?;
    Ok(model.map(|m| m.value))
}

/// Add one to the integer counter stored under `key` and return the new count.
/// A missing row starts at 0, and so does a value that is not a number. One
/// statement, so two increments racing each other never lose a count.
pub async fn increment_counter<C: ConnectionTrait>(conn: &C, key: &str) -> Result<i64, DbError> {
    let now = Utc::now();
    conn.execute(Statement::from_sql_and_values(
        conn.get_database_backend(),
        "INSERT INTO app_metadata (key, value, created_at, updated_at) VALUES (?, '1', ?, ?) \
         ON CONFLICT(key) DO UPDATE SET \
           value = CAST(CAST(app_metadata.value AS INTEGER) + 1 AS TEXT), \
           updated_at = excluded.updated_at, \
           deleted_at = NULL",
        [key.into(), now.into(), now.into()],
    ))
    .await?;
    read_counter(conn, key).await
}

/// The integer counter stored under `key`: 0 when there is none yet (or the
/// value is not a number).
pub async fn read_counter<C: ConnectionTrait>(conn: &C, key: &str) -> Result<i64, DbError> {
    Ok(get_value_conn(conn, key)
        .await?
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(0))
}

pub async fn update_app_version(
    conn: &DatabaseConnection,
    app_version: &str,
) -> Result<(), DbError> {
    let now = Utc::now();

    app_metadata::Entity::insert(app_metadata::ActiveModel {
        id: NotSet,
        key: Set("app_version".to_string()),
        value: Set(app_version.to_string()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .on_conflict(
        OnConflict::column(app_metadata::Column::Key)
            .update_columns([app_metadata::Column::Value, app_metadata::Column::UpdatedAt])
            .to_owned(),
    )
    .exec(conn)
    .await?;

    app_metadata::Entity::insert(app_metadata::ActiveModel {
        id: NotSet,
        key: Set("db_initialized_at".to_string()),
        value: Set(now.to_rfc3339()),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .on_conflict(
        OnConflict::column(app_metadata::Column::Key)
            .do_nothing()
            .to_owned(),
    )
    .do_nothing()
    .exec(conn)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn counters_start_at_zero_and_count_up() {
        let db = fresh_in_memory_db().await;
        assert_eq!(read_counter(&db.conn, "test.counter").await.unwrap(), 0);
        assert_eq!(increment_counter(&db.conn, "test.counter").await.unwrap(), 1);
        assert_eq!(increment_counter(&db.conn, "test.counter").await.unwrap(), 2);
        assert_eq!(read_counter(&db.conn, "test.counter").await.unwrap(), 2);
        // Other keys are their own counters, and the row still reads as a value.
        assert_eq!(increment_counter(&db.conn, "test.other").await.unwrap(), 1);
        assert_eq!(
            get_value(&db.conn, "test.counter").await.unwrap().as_deref(),
            Some("2")
        );
    }

    #[tokio::test]
    async fn a_value_that_is_not_a_number_restarts_the_count() {
        let db = fresh_in_memory_db().await;
        upsert_value(&db.conn, "test.counter", "garbage").await.unwrap();
        assert_eq!(read_counter(&db.conn, "test.counter").await.unwrap(), 0);
        assert_eq!(increment_counter(&db.conn, "test.counter").await.unwrap(), 1);
    }
}
