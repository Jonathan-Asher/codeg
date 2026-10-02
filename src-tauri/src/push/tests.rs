//! Delivery against a mock APNs: device choice, the request Apple receives,
//! dead-token cleanup, the test push's errors, registration.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::*;
use crate::db::test_helpers;
use crate::presence::Looking;

#[derive(Debug, Clone)]
struct Seen {
    token: String,
    headers: HeaderMap,
    body: Value,
}

#[derive(Clone, Default)]
struct Mock {
    seen: Arc<Mutex<Vec<Seen>>>,
}

/// Answers by token prefix: `dead…` 410 Unregistered, `bad…` 400
/// BadDeviceToken, `f00…` 400 DeviceTokenNotForTopic, anything else 200.
async fn apns(
    State(mock): State<Mock>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    mock.seen.lock().unwrap().push(Seen {
        token: token.clone(),
        headers,
        body,
    });
    let reject = |status: StatusCode, reason: &str| {
        (status, Json(json!({ "reason": reason }))).into_response()
    };
    if token.starts_with("dead") {
        reject(StatusCode::GONE, "Unregistered")
    } else if token.starts_with("bad") {
        reject(StatusCode::BAD_REQUEST, "BadDeviceToken")
    } else if token.starts_with("f00") {
        reject(StatusCode::BAD_REQUEST, "DeviceTokenNotForTopic")
    } else {
        (
            StatusCode::OK,
            [("apns-id", "11111111-2222-3333-4444-555555555555")],
        )
            .into_response()
    }
}

async fn mock_apns() -> (ApnsSender, Mock) {
    let mock = Mock::default();
    let app = Router::new()
        .route("/3/device/{token}", post(apns))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (ApnsSender::with_base_url(format!("http://{addr}")), mock)
}

fn setup() -> SendSetup {
    SendSetup {
        settings: PushSettings {
            team_id: "TEAM123456".into(),
            key_id: "KEY1234567".into(),
            bundle_id: "org.example.codeg".into(),
            environment: ApnsEnvironment::Sandbox,
            language: "en".into(),
        },
        credentials: Credentials {
            team_id: "TEAM123456".into(),
            key_id: "KEY1234567".into(),
            key_pem: jwt::test_key::p8_pem(),
        },
    }
}

async fn add_device(
    conn: &DatabaseConnection,
    token: &str,
    name: &str,
    prefs: DevicePrefs,
) -> push_device::Model {
    push_device_service::upsert(
        conn,
        push_device_service::NewDevice {
            token: token.into(),
            environment: "sandbox".into(),
            bundle_id: "org.example.codeg".into(),
            name: name.into(),
            platform: "ios".into(),
        },
        &prefs.to_json(),
    )
    .await
    .unwrap()
}

fn turn_finished(conversation_id: i32) -> PushMessage {
    PushMessage {
        kind: PushKind::TurnFinished,
        title: "Fix login".into(),
        body: "codeg · Claude Code has finished responding".into(),
        conversation_id: Some(conversation_id),
        folder_id: Some(3),
        agent_type: Some("claude_code".into()),
        alert_id: "alert-1".into(),
        critical_kind: None,
        needs: None,
        permission: None,
        sound: true,
    }
}

fn looking(anyone: bool, at: &[i32]) -> Looking {
    Looking {
        anyone,
        conversations: at.iter().copied().collect::<HashSet<_>>(),
    }
}

#[tokio::test]
async fn fan_out_reaches_the_devices_that_want_it_and_drops_dead_tokens() {
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let (sender, mock) = mock_apns().await;
    let always = DevicePrefs {
        turn_finished: prefs::Delivery::Always,
        ..DevicePrefs::default()
    };
    add_device(conn, "aaaa0001", "Phone", DevicePrefs::default()).await;
    add_device(conn, "bbbb0002", "iPad", always).await;
    add_device(conn, "dead0003", "Old phone", DevicePrefs::default()).await;

    // Away: every device that takes turns gets one; the dead token goes.
    let report = deliver_with(
        &sender,
        conn,
        &setup(),
        &turn_finished(1),
        &looking(false, &[]),
    )
    .await;
    assert_eq!(report.delivered, 2);
    assert_eq!(report.removed, 1);
    assert!(report.failed.is_empty());
    let left: Vec<String> = push_device_service::list(conn)
        .await
        .unwrap()
        .into_iter()
        .map(|d| d.name)
        .collect();
    assert_eq!(left, vec!["Phone", "iPad"]);

    // What Apple received.
    let server = server_id(conn).await;
    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 3);
    let first = &seen[0];
    assert_eq!(first.token, "aaaa0001");
    let header = |name: &str| {
        first
            .headers
            .get(name)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    };
    assert!(header("authorization").starts_with("bearer "));
    assert_eq!(header("authorization").split('.').count(), 3);
    assert_eq!(header("apns-topic"), "org.example.codeg");
    assert_eq!(header("apns-push-type"), "alert");
    assert_eq!(header("apns-priority"), "10");
    assert_eq!(header("apns-collapse-id"), format!("{server}-c1"));
    assert_eq!(first.body["kind"], "turn_finished");
    assert_eq!(first.body["conversation_id"], 1);
    assert_eq!(first.body["server_id"], server.as_str());
    assert_eq!(first.body["aps"]["thread-id"], format!("{server}-1"));
    assert_eq!(first.body["aps"]["alert"]["title"], "Fix login");

    // At the desk on another session: only "always".
    mock.seen.lock().unwrap().clear();
    let report = deliver_with(
        &sender,
        conn,
        &setup(),
        &turn_finished(1),
        &looking(true, &[2]),
    )
    .await;
    assert_eq!(report.delivered, 1);
    assert_eq!(mock.seen.lock().unwrap()[0].token, "bbbb0002");

    // Looking at this session: nothing at all.
    mock.seen.lock().unwrap().clear();
    let report = deliver_with(
        &sender,
        conn,
        &setup(),
        &turn_finished(1),
        &looking(true, &[1]),
    )
    .await;
    assert_eq!(report, DeliveryReport::default());
    assert!(mock.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_bad_device_token_is_removed_too() {
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let (sender, _mock) = mock_apns().await;
    add_device(conn, "bad00001", "Phone", DevicePrefs::default()).await;
    let report = deliver_with(
        &sender,
        conn,
        &setup(),
        &turn_finished(1),
        &looking(false, &[]),
    )
    .await;
    assert_eq!(report.removed, 1);
    assert!(push_device_service::list(conn).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_test_push_ignores_prefs_and_explains_failures() {
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let (sender, mock) = mock_apns().await;
    let off = DevicePrefs {
        turn_finished: prefs::Delivery::Off,
        needs_you: prefs::Delivery::Off,
        critical: false,
        errors: false,
    };
    let ok = add_device(conn, "aaaa0001", "Phone", off).await;
    let wrong_app = add_device(conn, "f00f0002", "Other app", off).await;

    let results = send_test_with(&sender, conn, &setup(), None).await.unwrap();
    assert_eq!(results.len(), 2);
    assert!(results[0].ok);
    assert_eq!(results[0].device_id, ok.id);
    assert!(!results[1].ok);
    assert_eq!(results[1].device_id, wrong_app.id);
    let error = results[1].error.as_deref().unwrap();
    assert!(error.contains("400"), "{error}");
    assert!(error.contains("another bundle ID"), "{error}");

    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen[0].body["kind"], "test");
    assert_eq!(seen[0].headers.get("apns-expiration").unwrap(), "0");

    let only = send_test_with(&sender, conn, &setup(), Some(ok.id))
        .await
        .unwrap();
    assert_eq!(only.len(), 1);

    let none = send_test_with(&sender, conn, &setup(), Some(999)).await;
    assert!(none.is_err());
}

#[tokio::test]
async fn registration_normalizes_the_token_and_defaults_from_settings() {
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let settings = PushSettings {
        bundle_id: "org.example.codeg".into(),
        environment: ApnsEnvironment::Sandbox,
        ..PushSettings::default()
    };
    app_metadata_service::upsert_value(
        conn,
        PUSH_SETTINGS_KEY,
        &serde_json::to_string(&settings).unwrap(),
    )
    .await
    .unwrap();
    let token = "<ABCD 1234 abcd 1234 ABCD 1234 abcd 1234>";
    let registered = register_device(
        conn,
        RegisterDevice {
            token: token.into(),
            name: Some("Jonathan's iPhone".into()),
            ..RegisterDevice::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(registered.device.environment, "sandbox");
    assert_eq!(registered.device.bundle_id, "org.example.codeg");
    assert_eq!(registered.device.platform, "ios");
    assert_eq!(registered.device.prefs, DevicePrefs::default());
    assert_eq!(registered.device.token_hint, "…abcd1234");
    assert_eq!(registered.server_id, server_id(conn).await);
    let row = push_device_service::list(conn).await.unwrap().remove(0);
    assert_eq!(row.token, "abcd1234abcd1234abcd1234abcd1234");

    let again = register_device(
        conn,
        RegisterDevice {
            token: "abcd1234abcd1234abcd1234abcd1234".into(),
            environment: Some("production".into()),
            ..RegisterDevice::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(again.device.id, registered.device.id);
    assert_eq!(again.device.environment, "production");

    assert!(register_device(
        conn,
        RegisterDevice {
            token: "not-a-token".into(),
            ..RegisterDevice::default()
        },
    )
    .await
    .is_err());

    let updated = update_device_prefs(
        conn,
        again.device.id,
        DevicePrefs {
            errors: true,
            ..DevicePrefs::default()
        },
    )
    .await
    .unwrap();
    assert!(updated.prefs.errors);
    assert!(
        unregister_device(conn, None, Some("ABCD1234ABCD1234ABCD1234ABCD1234".into()))
            .await
            .unwrap()
    );
    assert!(list_devices(conn).await.unwrap().is_empty());
}

#[test]
fn settings_are_trimmed_and_checked() {
    let settings = PushSettings {
        team_id: " abcde12345 ".into(),
        key_id: "k1".into(),
        ..PushSettings::default()
    }
    .sanitized();
    assert_eq!(settings.team_id, "ABCDE12345");
    assert!(settings.validate().is_err(), "a 2-character key id");
    let ok = PushSettings {
        team_id: "ABCDE12345".into(),
        key_id: "KEY1234567".into(),
        bundle_id: "org.example.codeg".into(),
        ..PushSettings::default()
    };
    assert!(ok.validate().is_ok());
    assert!(PushSettings::default().validate().is_ok(), "not set up yet");
    let bad_bundle = PushSettings {
        bundle_id: "no dots here".into(),
        ..PushSettings::default()
    };
    assert!(bad_bundle.validate().is_err());
}

#[test]
fn a_critical_alert_pushes_with_its_own_id() {
    use crate::acp::critical_watch::{CriticalAlert, CriticalAlertKind};
    use crate::models::AgentType;
    let alert = CriticalAlert {
        id: "abc-c5-e1-n2".into(),
        conversation_id: 5,
        folder_id: 2,
        agent_type: AgentType::ClaudeCode,
        title: Some("Deploy".into()),
        kind: CriticalAlertKind::Stalled,
        since: chrono::Utc::now(),
        count: 2,
        fired_at: chrono::Utc::now(),
        sound: true,
        resets_at: None,
    };
    let msg = fanout::critical_message(Lang::En, &alert, Some("claude_code".into()));
    let body = msg.body_json("srv");
    assert_eq!(body["kind"], "critical");
    assert_eq!(body["alert_id"], "abc-c5-e1-n2");
    assert_eq!(body["critical_kind"], "stalled");
    assert_eq!(body["conversation_id"], 5);
    assert_eq!(body["aps"]["category"], "CODEG_CRITICAL");
    assert_eq!(body["aps"]["interruption-level"], "time-sensitive");
    assert_eq!(
        body["aps"]["alert"]["title"],
        "⚑ Critical session may be stuck: Deploy"
    );
}
