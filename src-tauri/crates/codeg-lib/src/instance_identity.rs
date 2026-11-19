//! Which codeg this is: a stable id for the instance, and a name to show.
//!
//! A conversation id means something only on the instance that issued it: on
//! another one the same number is a different session, or none. So a session
//! link names its instance — `codeg://session/<id>?server=<instance id>` (see
//! `deep_link`) — and a desktop app that is handed one opens it in that
//! instance's workspace: its own, or a saved remote connection's.
//!
//! - The id is generated once, on the first launch that needs it, and kept in
//!   `app_metadata`. It is opaque: 16 lower-case hex digits.
//! - The name is `CODEG_INSTANCE_NAME` when that is set, or else this
//!   computer's name. Only for people to read; matching prefers the id.
//! - Both are in the answer to `POST /api/health`, which a desktop app sends
//!   whenever it saves or opens a remote connection. It keeps what the server
//!   said about itself beside the connection (also in `app_metadata`), so a
//!   link that names that server can be matched to it without guessing.
//!
//! Each binary loads the identity once, right after it opens its database
//! ([`init`]). Nothing else sets it, so a process that never did (a unit test)
//! has none, and writes links in the old form, without `server`.

use std::sync::OnceLock;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::db::error::DbError;
use crate::db::service::app_metadata_service;

/// Where the instance id is kept in `app_metadata`.
const INSTANCE_ID_KEY: &str = "instance_id";

/// Where what a saved remote connection's server said about itself is kept:
/// this prefix, then the connection's id.
const REMOTE_IDENTITY_KEY_PREFIX: &str = "remote_workspace_identity.";

/// Names this instance in place of the computer's name.
pub const INSTANCE_NAME_ENV: &str = "CODEG_INSTANCE_NAME";

/// Longest name kept, in characters.
const MAX_NAME_CHARS: usize = 80;

/// Shortest and longest instance id accepted from storage or from a server.
/// Ours are 16 digits; the range leaves room for another format later.
const INSTANCE_ID_LEN: std::ops::RangeInclusive<usize> = 8..=64;

/// Who an instance is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceIdentity {
    /// Opaque and stable: what a link's `server=` carries.
    pub instance_id: String,
    /// For people: `CODEG_INSTANCE_NAME`, or the computer's name.
    pub name: String,
}

static CURRENT: OnceLock<InstanceIdentity> = OnceLock::new();

/// This instance's identity, once [`init`] has loaded it.
pub fn current() -> Option<&'static InstanceIdentity> {
    CURRENT.get()
}

/// This instance's id, once [`init`] has loaded it: the value of the `server`
/// parameter on the links it writes.
pub fn current_id() -> Option<&'static str> {
    current().map(|identity| identity.instance_id.as_str())
}

/// Load this instance's identity, generating and storing the id the first time.
/// A database that cannot be read or written leaves the instance without one:
/// its links then go out in the old form, which still opens here.
pub async fn init(conn: &DatabaseConnection) -> Option<&'static InstanceIdentity> {
    if let Some(identity) = CURRENT.get() {
        return Some(identity);
    }
    match load_or_create_instance_id(conn).await {
        Ok(instance_id) => {
            let identity = CURRENT.get_or_init(|| InstanceIdentity {
                instance_id,
                name: instance_name(),
            });
            tracing::info!("[instance] {} ({})", identity.instance_id, identity.name);
            Some(identity)
        }
        Err(err) => {
            tracing::warn!("[instance] no instance id: {err}");
            None
        }
    }
}

/// The stored instance id, or a new one, stored now.
pub async fn load_or_create_instance_id(conn: &DatabaseConnection) -> Result<String, DbError> {
    if let Some(stored) = app_metadata_service::get_value(conn, INSTANCE_ID_KEY).await? {
        let stored = stored.trim();
        if is_instance_id(stored) {
            return Ok(stored.to_string());
        }
    }
    let id = new_instance_id();
    app_metadata_service::upsert_value(conn, INSTANCE_ID_KEY, &id).await?;
    Ok(id)
}

fn new_instance_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// Whether `value` can be an instance id: lower-case letters, digits and
/// dashes, within [`INSTANCE_ID_LEN`].
pub fn is_instance_id(value: &str) -> bool {
    INSTANCE_ID_LEN.contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
}

/// `CODEG_INSTANCE_NAME`, or the computer's name, or `codeg`.
fn instance_name() -> String {
    let from_env = std::env::var(INSTANCE_NAME_ENV).ok();
    let from_host = crate::commands::config_sync::snapshot::source_device();
    resolve_name(from_env.as_deref(), &from_host)
}

/// Pure, so the precedence is testable without the process environment.
fn resolve_name(from_env: Option<&str>, from_host: &str) -> String {
    from_env
        .and_then(clean_name)
        .or_else(|| {
            (from_host != "unknown")
                .then(|| clean_name(from_host.strip_suffix(".local").unwrap_or(from_host)))
                .flatten()
        })
        .unwrap_or_else(|| "codeg".to_string())
}

/// A name as it is shown: control characters dropped, surrounding space
/// trimmed, at most [`MAX_NAME_CHARS`]. `None` when nothing is left.
fn clean_name(raw: &str) -> Option<String> {
    let kept: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let kept = kept.trim();
    (!kept.is_empty()).then(|| kept.to_string())
}

/// The fields `POST /api/health` adds for this instance: `instanceId` and
/// `instanceName`. Empty before [`init`].
pub fn health_fields() -> serde_json::Map<String, serde_json::Value> {
    let mut fields = serde_json::Map::new();
    if let Some(identity) = current() {
        fields.insert("instanceId".into(), identity.instance_id.clone().into());
        fields.insert("instanceName".into(), identity.name.clone().into());
    }
    fields
}

/// Who a server says it is, read from its `/api/health` answer. `None` from a
/// server that does not say (one from before instance ids), or says something
/// that is not an id.
pub fn identity_from_health(body: &serde_json::Value) -> Option<InstanceIdentity> {
    let instance_id = body.get("instanceId")?.as_str()?.trim();
    if !is_instance_id(instance_id) {
        return None;
    }
    let name = body
        .get("instanceName")
        .and_then(|value| value.as_str())
        .and_then(clean_name)
        .unwrap_or_default();
    Some(InstanceIdentity {
        instance_id: instance_id.to_string(),
        name,
    })
}

fn remote_identity_key(connection_id: i32) -> String {
    format!("{REMOTE_IDENTITY_KEY_PREFIX}{connection_id}")
}

/// What the server of saved connection `connection_id` last said about itself.
/// `None` when it never said, or what was kept cannot be read.
pub async fn remote_identity(
    conn: &DatabaseConnection,
    connection_id: i32,
) -> Option<InstanceIdentity> {
    let raw = app_metadata_service::get_value(conn, &remote_identity_key(connection_id))
        .await
        .ok()??;
    let identity: InstanceIdentity = serde_json::from_str(&raw).ok()?;
    is_instance_id(&identity.instance_id).then_some(identity)
}

/// Keep what the server of `connection_id` just said about itself, replacing
/// what it said before. `None` (a server that no longer says) forgets it.
pub async fn remember_remote_identity(
    conn: &DatabaseConnection,
    connection_id: i32,
    identity: Option<&InstanceIdentity>,
) -> Result<(), DbError> {
    let key = remote_identity_key(connection_id);
    match identity {
        Some(identity) => {
            let value = serde_json::to_string(identity)
                .map_err(|err| DbError::Validation(format!("instance identity: {err}")))?;
            app_metadata_service::upsert_value(conn, &key, &value).await
        }
        None => app_metadata_service::delete_value(conn, &key).await,
    }
}

/// The current identity, for the frontend: the window's own instance, which
/// its transport reaches (the local app, or the server of a remote window).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn get_instance_identity() -> Option<InstanceIdentity> {
    current().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn the_instance_id_is_made_once_and_kept() {
        let db = fresh_in_memory_db().await;
        let first = load_or_create_instance_id(&db.conn).await.expect("first");
        assert!(is_instance_id(&first), "{first}");
        assert_eq!(first.len(), 16);
        let again = load_or_create_instance_id(&db.conn).await.expect("again");
        assert_eq!(first, again);
    }

    #[tokio::test]
    async fn an_unreadable_stored_id_is_replaced() {
        let db = fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, INSTANCE_ID_KEY, "Not An Id!")
            .await
            .expect("seed");
        let id = load_or_create_instance_id(&db.conn).await.expect("load");
        assert!(is_instance_id(&id));
        assert_eq!(
            app_metadata_service::get_value(&db.conn, INSTANCE_ID_KEY)
                .await
                .expect("read")
                .as_deref(),
            Some(id.as_str())
        );
    }

    #[test]
    fn instance_ids_are_plain_lower_case_tokens() {
        let too_long = "a".repeat(65);
        assert!(is_instance_id("0123456789abcdef"));
        assert!(is_instance_id("3f2a9c1e-77d0-4b1a"));
        for bad in [
            "",
            "short",
            "0123456789ABCDEF",
            "0123456789abcdef ",
            "0123456789abcdef?x=1",
            "0123456789abcdé01",
            too_long.as_str(),
        ] {
            assert!(!is_instance_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_name_prefers_the_setting_then_the_computer() {
        assert_eq!(resolve_name(Some("  Box  "), "mac.local"), "Box");
        assert_eq!(
            resolve_name(None, "Adas-MacBook-Pro.local"),
            "Adas-MacBook-Pro"
        );
        assert_eq!(resolve_name(Some("   "), "build-box"), "build-box");
        assert_eq!(resolve_name(None, "unknown"), "codeg");
        assert_eq!(resolve_name(Some("a\u{7}b"), "x"), "ab");
        assert_eq!(
            resolve_name(Some("名".repeat(200).as_str()), "x")
                .chars()
                .count(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn a_health_answer_says_who_the_server_is() {
        let identity = identity_from_health(&serde_json::json!({
            "status": "ok",
            "version": "0.46.1",
            "instanceId": "0123456789abcdef",
            "instanceName": "Johnnyss-MacBook-Pro",
        }));
        assert_eq!(
            identity,
            Some(InstanceIdentity {
                instance_id: "0123456789abcdef".into(),
                name: "Johnnyss-MacBook-Pro".into(),
            })
        );
        // A server from before instance ids, and one that sends junk.
        assert_eq!(
            identity_from_health(&serde_json::json!({ "status": "ok" })),
            None
        );
        assert_eq!(
            identity_from_health(&serde_json::json!({ "instanceId": "NOPE" })),
            None
        );
        assert_eq!(
            identity_from_health(&serde_json::json!({ "instanceId": 7 })),
            None
        );
        // No name is still an identity.
        assert_eq!(
            identity_from_health(&serde_json::json!({ "instanceId": "0123456789abcdef" }))
                .map(|identity| identity.name),
            Some(String::new())
        );
    }

    #[tokio::test]
    async fn a_remote_identity_is_kept_per_connection_and_forgotten() {
        let db = fresh_in_memory_db().await;
        let identity = InstanceIdentity {
            instance_id: "0123456789abcdef".into(),
            name: "Box".into(),
        };
        assert_eq!(remote_identity(&db.conn, 1).await, None);
        remember_remote_identity(&db.conn, 1, Some(&identity))
            .await
            .expect("remember");
        assert_eq!(remote_identity(&db.conn, 1).await, Some(identity.clone()));
        assert_eq!(remote_identity(&db.conn, 2).await, None);
        remember_remote_identity(&db.conn, 1, None)
            .await
            .expect("forget");
        assert_eq!(remote_identity(&db.conn, 1).await, None);
    }
}
