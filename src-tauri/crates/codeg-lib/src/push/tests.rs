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
pub(crate) struct Seen {
    pub(crate) token: String,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Value,
}

#[derive(Clone, Default)]
pub(crate) struct Mock {
    pub(crate) seen: Arc<Mutex<Vec<Seen>>>,
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

pub(crate) async fn mock_apns() -> (ApnsSender, Mock) {
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

pub(crate) fn setup() -> SendSetup {
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

pub(crate) async fn add_device(
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
        badge: None,
        pending: None,
    }
}

/// A question's reminder (or, with `reminder: false`, its first push).
fn question_push(conversation_id: i32, reminder: bool) -> PushMessage {
    PushMessage {
        kind: PushKind::NeedsYou,
        title: "Fix login".into(),
        body: "codeg · Claude Code is still waiting for your answer (5 min)".into(),
        conversation_id: Some(conversation_id),
        folder_id: Some(3),
        agent_type: Some("claude_code".into()),
        alert_id: "alert-2".into(),
        critical_kind: None,
        needs: Some(payload::NeedsKind::Question),
        permission: None,
        sound: true,
        badge: Some(2),
        pending: Some(payload::PendingPush {
            id: "question:q1".into(),
            kind: crate::pending::PendingKind::Question,
            since: chrono::Utc::now(),
            reminder,
            attempt: u32::from(reminder),
            connection_id: "conn-1".into(),
            asking_conversation_id: conversation_id,
            question: None,
            approval_id: None,
        }),
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
async fn a_reminder_reaches_the_desk_but_not_the_session_on_screen_nor_off() {
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let (sender, mock) = mock_apns().await;
    let off = DevicePrefs {
        needs_you: prefs::Delivery::Off,
        ..DevicePrefs::default()
    };
    add_device(conn, "aaaa0001", "Phone", DevicePrefs::default()).await;
    add_device(conn, "cccc0003", "Quiet", off).await;

    // At the desk, on another session: the first push waits for "away"...
    let at_desk = looking(true, &[2]);
    let report = deliver_with(&sender, conn, &setup(), &question_push(1, false), &at_desk).await;
    assert_eq!(report, DeliveryReport::default());
    // ...a reminder does not, but "off" stays off.
    let report = deliver_with(&sender, conn, &setup(), &question_push(1, true), &at_desk).await;
    assert_eq!(report.delivered, 1);
    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].token, "aaaa0001");
    assert_eq!(seen[0].body["reminder"], true);
    assert_eq!(seen[0].body["attempt"], 1);
    assert_eq!(seen[0].body["aps"]["badge"], 2);

    // Looking at that very session: nothing.
    let report = deliver_with(
        &sender,
        conn,
        &setup(),
        &question_push(1, true),
        &looking(true, &[1]),
    )
    .await;
    assert_eq!(report, DeliveryReport::default());
}

#[tokio::test]
async fn every_push_carries_the_badge_and_the_sync_tops_up_the_rest() {
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let (sender, mock) = mock_apns().await;
    add_device(conn, "dddd0001", "Phone", DevicePrefs::default()).await;
    add_device(
        conn,
        "eeee0002",
        "iPad",
        DevicePrefs {
            needs_you: prefs::Delivery::Off,
            ..DevicePrefs::default()
        },
    )
    .await;

    // The reminder reaches the phone with badge 2; the iPad wants none.
    deliver_with(&sender, conn, &setup(), &question_push(1, true), &looking(false, &[])).await;
    assert_eq!(mock.seen.lock().unwrap().len(), 1);

    // Syncing to 2 only tells the iPad, silently.
    mock.seen.lock().unwrap().clear();
    let report = sync_badges_with(&sender, conn, &setup(), 2).await;
    assert_eq!(report.delivered, 1);
    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].token, "eeee0002");
    assert_eq!(seen[0].body["aps"], json!({ "badge": 2 }));
    assert_eq!(seen[0].body["kind"], "badge");

    // Nothing more to say at the same count; an answered item drops both.
    mock.seen.lock().unwrap().clear();
    assert_eq!(
        sync_badges_with(&sender, conn, &setup(), 2).await,
        DeliveryReport::default()
    );
    assert_eq!(sync_badges_with(&sender, conn, &setup(), 1).await.delivered, 2);
    let seen = mock.seen.lock().unwrap().clone();
    assert!(seen.iter().all(|s| s.body["aps"] == json!({ "badge": 1 })));
    let header = seen[0].headers.get("apns-push-type").unwrap();
    assert_eq!(header, "alert");
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

fn register_with(token: &str, sounds: Option<Value>) -> RegisterDevice {
    RegisterDevice {
        token: token.into(),
        environment: Some("sandbox".into()),
        bundle_id: Some("org.example.codeg".into()),
        name: Some("Phone".into()),
        sounds,
        ..RegisterDevice::default()
    }
}

/// What each device's last push played: `None` for no sound.
fn sounds_heard(mock: &Mock) -> Vec<(String, Option<Value>)> {
    let seen = mock.seen.lock().unwrap().drain(..).collect::<Vec<_>>();
    seen.into_iter()
        .map(|s| {
            assert!(s.body["aps"]["alert"]["title"].is_string(), "{:?}", s.body);
            (s.token, s.body["aps"].get("sound").cloned())
        })
        .collect()
}

#[tokio::test]
async fn each_device_hears_its_own_sounds_session_over_project_over_critical_over_kind() {
    use crate::db::service::{conversation_service, folder_service};
    use crate::models::AgentType;
    let db = test_helpers::fresh_in_memory_db().await;
    let conn = &db.conn;
    let (sender, mock) = mock_apns().await;
    let quiet_folder = test_helpers::seed_folder(&db, "/tmp/codeg-push-sounds-a").await;
    let loud_folder = test_helpers::seed_folder(&db, "/tmp/codeg-push-sounds-b").await;
    let gone_folder = test_helpers::seed_folder(&db, "/tmp/codeg-push-sounds-c").await;
    let critical = test_helpers::seed_conversation(&db, quiet_folder, AgentType::ClaudeCode).await;
    conversation_service::update_critical(conn, critical, true, None)
        .await
        .unwrap();
    let plain = test_helpers::seed_conversation(&db, quiet_folder, AgentType::ClaudeCode).await;
    let critical_in_loud =
        test_helpers::seed_conversation(&db, loud_folder, AgentType::ClaudeCode).await;
    conversation_service::update_critical(conn, critical_in_loud, true, None)
        .await
        .unwrap();
    let own = test_helpers::seed_conversation(&db, loud_folder, AgentType::ClaudeCode).await;
    let worktree = folder_service::add_folder_with_parent(
        conn,
        "/tmp/codeg-push-sounds-b-wt",
        Some(loud_folder),
    )
    .await
    .unwrap()
    .id;
    let in_worktree = test_helpers::seed_conversation(&db, worktree, AgentType::ClaudeCode).await;

    let phone_token = "aaaa1111aaaa1111aaaa1111aaaa1111";
    let ipad_token = "bbbb2222bbbb2222bbbb2222bbbb2222";
    let chosen = json!({
        "kinds": {
            "turn_finished": "codeg-pop.caf",
            "needs_you": "none",
            "reminder": "../x.caf",
        },
        "critical": "codeg-bell.caf",
        "projects": {
            loud_folder.to_string(): "codeg-chime.caf",
            gone_folder.to_string(): "codeg-glass.caf",
            "999999": "codeg-glass.caf",
        },
        "sessions": { own.to_string(): "codeg-ping.caf", "888888": "none" },
    });
    folder_service::soft_delete_folder(conn, gone_folder)
        .await
        .unwrap();
    let phone = register_device(conn, register_with(phone_token, Some(chosen.clone())))
        .await
        .unwrap();
    // The bad name and the folders and session this server lacks are gone.
    assert_eq!(
        phone.device.sounds,
        json!({
            "kinds": { "turn_finished": "codeg-pop.caf", "needs_you": "none" },
            "critical": "codeg-bell.caf",
            "projects": { loud_folder.to_string(): "codeg-chime.caf" },
            "sessions": { own.to_string(): "codeg-ping.caf" },
        })
    );
    let ipad = register_device(conn, register_with(ipad_token, None))
        .await
        .unwrap();
    assert_eq!(
        ipad.device.sounds,
        json!({ "kinds": {}, "projects": {}, "sessions": {} })
    );

    let away = looking(false, &[]);
    let in_folder = |conversation_id: i32, folder_id: i32, msg: PushMessage| PushMessage {
        conversation_id: Some(conversation_id),
        folder_id: Some(folder_id),
        ..msg
    };
    let phone_heard = |heard: Vec<(String, Option<Value>)>| {
        let ipad_heard = heard.iter().find(|(t, _)| t == ipad_token).cloned();
        // A device that chose nothing always plays the default sound.
        assert_eq!(ipad_heard.and_then(|(_, s)| s), Some(json!("default")));
        heard
            .into_iter()
            .find(|(t, _)| t == phone_token)
            .and_then(|(_, sound)| sound)
    };

    // A finished turn of a plain session: the kind's sound.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(plain, quiet_folder, turn_finished(plain)),
        &away,
    )
    .await;
    assert_eq!(
        phone_heard(sounds_heard(&mock)),
        Some(json!("codeg-pop.caf"))
    );
    // Of a critical session: the critical sessions' sound.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(critical, quiet_folder, turn_finished(critical)),
        &away,
    )
    .await;
    assert_eq!(
        phone_heard(sounds_heard(&mock)),
        Some(json!("codeg-bell.caf"))
    );
    // Of a critical session in a project with a sound: the project's.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(
            critical_in_loud,
            loud_folder,
            turn_finished(critical_in_loud),
        ),
        &away,
    )
    .await;
    assert_eq!(
        phone_heard(sounds_heard(&mock)),
        Some(json!("codeg-chime.caf"))
    );
    // Of a session in a worktree of that project: the project's too.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(in_worktree, worktree, turn_finished(in_worktree)),
        &away,
    )
    .await;
    assert_eq!(
        phone_heard(sounds_heard(&mock)),
        Some(json!("codeg-chime.caf"))
    );
    // Of a session with its own sound: the session's.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(own, loud_folder, turn_finished(own)),
        &away,
    )
    .await;
    assert_eq!(
        phone_heard(sounds_heard(&mock)),
        Some(json!("codeg-ping.caf"))
    );
    // A question: "none" keeps the banner and drops the sound.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(plain, quiet_folder, question_push(plain, false)),
        &away,
    )
    .await;
    assert_eq!(phone_heard(sounds_heard(&mock)), None);
    // A reminder: its bad name was left out, so the default sound.
    deliver_with(
        &sender,
        conn,
        &setup(),
        &in_folder(plain, quiet_folder, question_push(plain, true)),
        &away,
    )
    .await;
    assert_eq!(phone_heard(sounds_heard(&mock)), Some(json!("default")));

    // The desktop changing the preferences keeps the sounds.
    let updated = update_device_prefs(
        conn,
        phone.device.id,
        DevicePrefs {
            errors: true,
            ..DevicePrefs::default()
        },
    )
    .await
    .unwrap();
    assert!(updated.prefs.errors);
    assert_eq!(updated.sounds, phone.device.sounds);
    // Registering without sounds (an app that predates them), or with
    // something that is not an object, keeps them too.
    for kept in [None, Some(json!("loud"))] {
        let again = register_device(conn, register_with(phone_token, kept))
            .await
            .unwrap();
        assert_eq!(again.device.id, phone.device.id);
        assert_eq!(again.device.sounds, phone.device.sounds);
        assert!(again.device.prefs.errors);
    }
    // A session deleted since is dropped at the next registration.
    conversation_service::soft_delete(conn, own).await.unwrap();
    let again = register_device(conn, register_with(phone_token, Some(chosen)))
        .await
        .unwrap();
    assert_eq!(again.device.sounds["sessions"], json!({}));
    assert!(again.device.prefs.errors);
    // New sounds replace the old; none clears them.
    let replaced = register_device(
        conn,
        register_with(
            phone_token,
            Some(json!({ "kinds": { "turn_finished": "codeg-knock.caf" } })),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        replaced.device.sounds,
        json!({ "kinds": { "turn_finished": "codeg-knock.caf" }, "projects": {}, "sessions": {} })
    );
    // The test push sounds like a finished turn.
    send_test_with(&sender, conn, &setup(), Some(phone.device.id))
        .await
        .unwrap();
    let heard = sounds_heard(&mock);
    assert_eq!(
        heard,
        [(phone_token.to_string(), Some(json!("codeg-knock.caf")))]
    );
    let cleared = register_device(conn, register_with(phone_token, Some(json!({}))))
        .await
        .unwrap();
    assert_eq!(cleared.device.sounds, ipad.device.sounds);
    let row = push_device_service::find(conn, phone.device.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(DevicePrefs::from_json(&row.prefs), updated.prefs);
    assert!(!row.prefs.contains("sounds"));
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
        last_line: None,
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
