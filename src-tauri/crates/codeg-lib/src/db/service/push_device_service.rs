//! The push device registry (`push_device`, see `crate::push`).

use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};

use crate::db::entities::push_device;
use crate::db::error::DbError;

/// What a device registers with.
#[derive(Debug, Clone)]
pub struct NewDevice {
    pub token: String,
    pub environment: String,
    pub bundle_id: String,
    pub name: String,
    pub platform: String,
}

pub async fn list(conn: &DatabaseConnection) -> Result<Vec<push_device::Model>, DbError> {
    Ok(push_device::Entity::find()
        .order_by_asc(push_device::Column::Id)
        .all(conn)
        .await?)
}

pub async fn find(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<push_device::Model>, DbError> {
    Ok(push_device::Entity::find_by_id(id).one(conn).await?)
}

pub async fn find_by_token(
    conn: &DatabaseConnection,
    token: &str,
) -> Result<Option<push_device::Model>, DbError> {
    Ok(push_device::Entity::find()
        .filter(push_device::Column::Token.eq(token))
        .one(conn)
        .await?)
}

/// Register a device, or refresh the row its token already has (keeping the
/// prefs the user set for it). `default_prefs` seeds a new row.
pub async fn upsert(
    conn: &DatabaseConnection,
    device: NewDevice,
    default_prefs: &str,
) -> Result<push_device::Model, DbError> {
    let now = Utc::now();
    if let Some(existing) = find_by_token(conn, &device.token).await? {
        let mut active: push_device::ActiveModel = existing.into();
        active.environment = Set(device.environment);
        active.bundle_id = Set(device.bundle_id);
        active.name = Set(device.name);
        active.platform = Set(device.platform);
        active.last_seen_at = Set(now);
        return Ok(active.update(conn).await?);
    }
    let row = push_device::ActiveModel {
        token: Set(device.token),
        environment: Set(device.environment),
        bundle_id: Set(device.bundle_id),
        name: Set(device.name),
        platform: Set(device.platform),
        prefs: Set(default_prefs.to_string()),
        created_at: Set(now),
        last_seen_at: Set(now),
        ..Default::default()
    };
    Ok(row.insert(conn).await?)
}

pub async fn update_prefs(
    conn: &DatabaseConnection,
    id: i32,
    prefs: &str,
) -> Result<Option<push_device::Model>, DbError> {
    let Some(existing) = find(conn, id).await? else {
        return Ok(None);
    };
    let mut active: push_device::ActiveModel = existing.into();
    active.prefs = Set(prefs.to_string());
    Ok(Some(active.update(conn).await?))
}

/// Delete one device; whether a row was removed.
pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let result = push_device::Entity::delete_by_id(id).exec(conn).await?;
    Ok(result.rows_affected > 0)
}

pub async fn delete_by_token(conn: &DatabaseConnection, token: &str) -> Result<bool, DbError> {
    let result = push_device::Entity::delete_many()
        .filter(push_device::Column::Token.eq(token))
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers;

    fn device(token: &str, name: &str) -> NewDevice {
        NewDevice {
            token: token.into(),
            environment: "sandbox".into(),
            bundle_id: "org.example.codeg".into(),
            name: name.into(),
            platform: "ios".into(),
        }
    }

    #[tokio::test]
    async fn register_twice_updates_the_row_and_keeps_its_prefs() {
        let db = test_helpers::fresh_in_memory_db().await;
        let conn = &db.conn;
        let first = upsert(conn, device("aa11", "Phone"), "{}").await.unwrap();
        update_prefs(conn, first.id, r#"{"errors":true}"#)
            .await
            .unwrap();
        let again = upsert(conn, device("aa11", "Renamed"), "{}").await.unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.name, "Renamed");
        assert_eq!(again.prefs, r#"{"errors":true}"#);
        assert_eq!(list(conn).await.unwrap().len(), 1);

        upsert(conn, device("bb22", "iPad"), "{}").await.unwrap();
        assert_eq!(list(conn).await.unwrap().len(), 2);
        assert!(delete_by_token(conn, "aa11").await.unwrap());
        assert!(!delete(conn, first.id).await.unwrap());
        assert_eq!(list(conn).await.unwrap().len(), 1);
    }
}
