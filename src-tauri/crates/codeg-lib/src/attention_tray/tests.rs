use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use chrono::{DateTime, TimeZone, Utc};

use super::model::{
    entry_label, labels_for, plan_update, tray_view, waiting_sessions, with_attention_dot, Origin,
    RemoteSnapshot, RemoteSource, TrayUpdate, TrayView, WaitingItem, WaitingSession,
};
use super::poll::{
    fetch_pending, retry_delay, FetchError, RemoteTarget, Remotes, MAX_BACKOFF, POLL_INTERVAL,
    STALE_AFTER_FAILURES,
};
use crate::models::system::AppLocale;
use crate::models::RemoteWorkspaceHeader;
use crate::pending::{PendingItem, PendingKind, PendingSnapshot, PendingSource};

fn at(secs: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(1_800_000_000 + secs, 0).unwrap()
}

fn item(root: i32, kind: PendingKind, title: &str, secs: i64) -> WaitingItem {
    WaitingItem {
        root_conversation_id: root,
        kind,
        title: (!title.is_empty()).then(|| title.to_string()),
        asked_at: at(secs),
    }
}

fn remote(id: i32, name: &str, instance: Option<&str>, items: Vec<WaitingItem>) -> RemoteSource {
    RemoteSource {
        connection_id: id,
        name: name.to_string(),
        instance_id: instance.map(str::to_string),
        items,
    }
}

fn keys(sessions: &[WaitingSession]) -> Vec<(Origin, i32, PendingKind)> {
    sessions
        .iter()
        .map(|s| (s.origin, s.conversation_id, s.kind))
        .collect()
}

// ── Aggregation and dedupe ──

#[test]
fn one_entry_per_session_with_the_strongest_kind_and_the_first_ask() {
    let local = vec![
        // A sub-agent's question and its parent's permission: one row.
        item(7, PendingKind::Question, "Refactor", 30),
        item(7, PendingKind::Permission, "", 10),
        item(9, PendingKind::Plan, "Plan it", 20),
    ];
    let sessions = waiting_sessions(Some("local0000000000a"), &local, &[]);
    assert_eq!(
        keys(&sessions),
        vec![
            (Origin::Local, 7, PendingKind::Permission),
            (Origin::Local, 9, PendingKind::Plan),
        ]
    );
    assert_eq!(sessions[0].since, at(10));
    assert_eq!(sessions[0].title.as_deref(), Some("Refactor"));
    assert_eq!(sessions[0].server, None);
    assert_eq!(
        sessions[0].link,
        "codeg://session/7?server=local0000000000a"
    );
}

#[test]
fn remote_sessions_carry_their_server_and_a_link_that_names_it() {
    let sessions = waiting_sessions(
        Some("local0000000000a"),
        &[],
        &[
            remote(
                1,
                "Johnnysclawd",
                Some("box000000000000b"),
                vec![item(334, PendingKind::Question, "Codeg-refactor-cc", 5)],
            ),
            // A server that never said who it is: its link names the
            // connection's saved name instead.
            remote(
                2,
                "Old Box",
                None,
                vec![item(12, PendingKind::Permission, "Deploy", 1)],
            ),
        ],
    );
    assert_eq!(
        keys(&sessions),
        vec![
            (
                Origin::Remote { connection_id: 2 },
                12,
                PendingKind::Permission
            ),
            (
                Origin::Remote { connection_id: 1 },
                334,
                PendingKind::Question
            ),
        ]
    );
    assert_eq!(sessions[0].server.as_deref(), Some("Old Box"));
    assert_eq!(sessions[0].link, "codeg://session/12?server=Old%20Box");
    assert_eq!(sessions[1].server.as_deref(), Some("Johnnysclawd"));
    assert_eq!(
        sessions[1].link,
        "codeg://session/334?server=box000000000000b"
    );
}

#[test]
fn a_connection_to_this_instance_adds_nothing() {
    let local = vec![item(3, PendingKind::Question, "Here", 1)];
    let sessions = waiting_sessions(
        Some("LOCAL0000000000A"),
        &local,
        &[remote(
            1,
            "Myself",
            Some("local0000000000a"),
            vec![item(3, PendingKind::Question, "Here", 1)],
        )],
    );
    assert_eq!(
        keys(&sessions),
        vec![(Origin::Local, 3, PendingKind::Question)]
    );
}

#[test]
fn a_server_saved_twice_counts_once_under_the_first_connection() {
    let items = vec![item(5, PendingKind::Question, "Same", 1)];
    let sessions = waiting_sessions(
        None,
        &[],
        &[
            remote(4, "Box (LAN)", Some("box000000000000b"), items.clone()),
            remote(
                6,
                "Box (Tailscale)",
                Some("BOX000000000000B"),
                items.clone(),
            ),
        ],
    );
    assert_eq!(
        keys(&sessions),
        vec![(
            Origin::Remote { connection_id: 4 },
            5,
            PendingKind::Question
        )]
    );
}

#[test]
fn the_same_id_on_two_servers_is_two_sessions() {
    let sessions = waiting_sessions(
        Some("local0000000000a"),
        &[item(5, PendingKind::Question, "Local five", 2)],
        &[
            remote(
                1,
                "Box",
                Some("box000000000000b"),
                vec![item(5, PendingKind::Question, "Box five", 1)],
            ),
            // No identity on either: nothing proves them the same server.
            remote(2, "A", None, vec![item(5, PendingKind::Plan, "", 3)]),
            remote(3, "B", None, vec![item(5, PendingKind::Plan, "", 4)]),
        ],
    );
    assert_eq!(sessions.len(), 4);
}

// ── What the tray shows ──

#[test]
fn the_view_names_what_waits_the_session_and_its_server() {
    let labels = labels_for(AppLocale::En);
    let sessions = waiting_sessions(
        Some("local0000000000a"),
        &[item(1, PendingKind::Permission, "", 1)],
        &[remote(
            1,
            "Johnnysclawd",
            Some("box000000000000b"),
            vec![item(334, PendingKind::Question, "Codeg-refactor-cc", 2)],
        )],
    );
    let view = tray_view(&sessions, &labels);
    assert_eq!(view.count, 2);
    assert_eq!(view.header.as_deref(), Some("Waiting for you (2)"));
    assert_eq!(view.tooltip(), "Codeg — Waiting for you (2)");
    assert_eq!(view.badge(), Some(2));
    assert_eq!(
        view.entries
            .iter()
            .map(|e| e.label.as_str())
            .collect::<Vec<_>>(),
        vec![
            "Permission · Untitled session — This computer",
            "Question · Codeg-refactor-cc — Johnnysclawd",
        ]
    );
    assert_eq!(
        view.entries[1].link,
        "codeg://session/334?server=box000000000000b"
    );
}

#[test]
fn a_long_title_is_clipped() {
    let labels = labels_for(AppLocale::En);
    let long = "x".repeat(200);
    let sessions = waiting_sessions(None, &[item(1, PendingKind::Plan, &long, 1)], &[]);
    let label = entry_label(&sessions[0], &labels);
    assert!(label.starts_with("Plan · xxxx"));
    assert!(label.contains('…'));
    assert!(label.chars().count() < 80, "{label}");
}

#[test]
fn every_language_has_its_words() {
    for locale in [
        AppLocale::En,
        AppLocale::ZhCn,
        AppLocale::ZhTw,
        AppLocale::Ja,
        AppLocale::Ko,
        AppLocale::Es,
        AppLocale::De,
        AppLocale::Fr,
        AppLocale::Pt,
        AppLocale::Ar,
    ] {
        let labels = labels_for(locale);
        assert!(labels.header.contains("{count}"), "{locale:?}");
        for word in [
            labels.permission,
            labels.question,
            labels.plan,
            labels.untitled,
            labels.this_computer,
        ] {
            assert!(!word.trim().is_empty(), "{locale:?}");
        }
    }
    assert_eq!(
        labels_for(AppLocale::De).header,
        "Wartet auf dich ({count})"
    );
}

#[test]
fn nothing_waiting_is_the_plain_tray() {
    let view = tray_view(&[], &labels_for(AppLocale::En));
    assert_eq!(view, TrayView::default());
    assert_eq!(view.badge(), None);
    assert_eq!(view.tooltip(), "Codeg");
}

// ── Tray and badge transitions ──

fn view_of(count: usize) -> TrayView {
    let local: Vec<WaitingItem> = (0..count as i32)
        .map(|i| item(i + 1, PendingKind::Question, "S", i64::from(i)))
        .collect();
    tray_view(
        &waiting_sessions(None, &local, &[]),
        &labels_for(AppLocale::En),
    )
}

#[test]
fn the_first_pass_sets_everything() {
    let update = plan_update(None, &view_of(0));
    assert_eq!(
        update,
        TrayUpdate {
            attention_icon: Some(false),
            title: Some(None),
            tooltip: Some("Codeg".to_string()),
            menu: true,
        }
    );
}

#[test]
fn something_starts_waiting_then_more_then_nothing() {
    let none = view_of(0);
    let one = view_of(1);
    let two = view_of(2);

    let update = plan_update(Some(&none), &one);
    assert_eq!(update.attention_icon, Some(true));
    assert_eq!(update.title, Some(Some("1".to_string())));
    assert_eq!(
        update.tooltip.as_deref(),
        Some("Codeg — Waiting for you (1)")
    );
    assert!(update.menu);

    let update = plan_update(Some(&one), &two);
    assert_eq!(update.attention_icon, None, "already marked");
    assert_eq!(update.title, Some(Some("2".to_string())));
    assert!(update.menu);

    let update = plan_update(Some(&two), &none);
    assert_eq!(update.attention_icon, Some(false));
    assert_eq!(update.title, Some(None));
    assert_eq!(update.tooltip.as_deref(), Some("Codeg"));
    assert!(update.menu);
    assert_eq!(none.badge(), None);
}

#[test]
fn an_unchanged_view_touches_nothing() {
    let two = view_of(2);
    assert!(plan_update(Some(&two), &two.clone()).is_empty());
}

#[test]
fn a_new_title_rebuilds_only_the_menu() {
    let labels = labels_for(AppLocale::En);
    let before = tray_view(
        &waiting_sessions(None, &[item(1, PendingKind::Question, "Old", 1)], &[]),
        &labels,
    );
    let after = tray_view(
        &waiting_sessions(None, &[item(1, PendingKind::Question, "New", 1)], &[]),
        &labels,
    );
    assert_eq!(
        plan_update(Some(&before), &after),
        TrayUpdate {
            menu: true,
            ..TrayUpdate::default()
        }
    );
}

#[test]
fn the_attention_icon_gets_a_dot_in_its_corner() {
    let (w, h) = (22u32, 22u32);
    // A fully opaque glyph, to see the ring cut out of it.
    let rgba = vec![255u8; (w * h * 4) as usize];
    let out = with_attention_dot(&rgba, w, h);
    assert_eq!(out.len(), rgba.len());
    let alpha = |x: u32, y: u32| out[((y * w + x) * 4 + 3) as usize];
    // Top-right corner: the dot.
    assert_eq!(alpha(w - 3, 3), 255);
    // Bottom-left: the glyph as it was.
    assert_eq!(alpha(1, h - 2), 255);
    // Some pixel around the dot is cleared (the ring).
    let cleared = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .filter(|&(x, y)| alpha(x, y) == 0)
        .count();
    assert!(cleared > 0);
    // A buffer of the wrong size comes back untouched.
    assert_eq!(with_attention_dot(&[1, 2, 3], 22, 22), vec![1, 2, 3]);
}

// ── Polling ──

#[test]
fn backoff_doubles_from_the_interval_up_to_a_minute() {
    let secs: Vec<u64> = (0..7).map(|f| retry_delay(f).as_secs()).collect();
    assert_eq!(secs, vec![5, 10, 20, 40, 60, 60, 60]);
    assert_eq!(retry_delay(0), POLL_INTERVAL);
    assert_eq!(retry_delay(u32::MAX), MAX_BACKOFF);
}

fn target(id: i32, base: &str) -> RemoteTarget {
    RemoteTarget {
        connection_id: id,
        name: format!("conn{id}"),
        base_url: base.to_string(),
        token: format!("token-{id}"),
        headers: Vec::new(),
        instance_id: None,
    }
}

fn unreachable() -> Result<Vec<WaitingItem>, FetchError> {
    Err(FetchError::Unreachable("refused".into()))
}

#[test]
fn a_new_connection_is_polled_at_once_then_every_interval() {
    let t0 = Instant::now();
    let mut remotes = Remotes::default();
    remotes.sync(vec![target(1, "http://a")], t0);
    let due = remotes.take_due(t0);
    assert_eq!(due.len(), 1);
    assert!(remotes.take_due(t0).is_empty(), "in flight");
    assert!(remotes.apply_poll(
        1,
        due[0].generation,
        Ok(vec![item(9, PendingKind::Question, "Q", 1)]),
        t0
    ));
    assert_eq!(remotes.next_due(), Some(t0 + POLL_INTERVAL));
    assert!(remotes.take_due(t0 + Duration::from_secs(4)).is_empty());
    assert_eq!(remotes.take_due(t0 + POLL_INTERVAL).len(), 1);
    assert_eq!(remotes.sources()[0].items.len(), 1);
}

#[test]
fn an_offline_server_backs_off_and_its_list_goes_stale() {
    let mut now = Instant::now();
    let mut remotes = Remotes::default();
    remotes.sync(vec![target(1, "http://a")], now);
    let due = remotes.take_due(now);
    remotes.apply_poll(
        1,
        due[0].generation,
        Ok(vec![item(9, PendingKind::Question, "Q", 1)]),
        now,
    );
    for failure in 1..=STALE_AFTER_FAILURES {
        now = remotes.next_due().unwrap();
        let due = remotes.take_due(now);
        let changed = remotes.apply_poll(1, due[0].generation, unreachable(), now);
        assert_eq!(remotes.next_due(), Some(now + retry_delay(failure)));
        // A blip keeps the badge steady; the third failure in a row drops it.
        assert_eq!(
            changed,
            failure == STALE_AFTER_FAILURES,
            "failure {failure}"
        );
        assert_eq!(
            remotes.sources()[0].items.is_empty(),
            failure == STALE_AFTER_FAILURES
        );
    }
    // Back online: the interval again.
    now = remotes.next_due().unwrap();
    let due = remotes.take_due(now);
    remotes.apply_poll(1, due[0].generation, Ok(Vec::new()), now);
    assert_eq!(remotes.next_due(), Some(now + POLL_INTERVAL));
}

#[test]
fn a_socket_frame_wins_over_a_poll_that_was_already_out() {
    let t0 = Instant::now();
    let mut remotes = Remotes::default();
    remotes.sync(vec![target(1, "http://a")], t0);
    let due = remotes.take_due(t0);
    // Answered in the window: the frame says nothing waits any more…
    assert!(!remotes.apply_frame(1, Vec::new(), t0));
    // …and the poll that left before it still lists the question.
    let stale = Ok(vec![item(9, PendingKind::Question, "Q", 1)]);
    assert!(!remotes.apply_poll(1, due[0].generation, stale, t0));
    assert!(remotes.sources()[0].items.is_empty());
    assert_eq!(remotes.next_due(), Some(t0 + POLL_INTERVAL));
    // A frame for a connection that is not saved is ignored.
    assert!(!remotes.apply_frame(99, vec![item(1, PendingKind::Plan, "", 1)], t0));
}

#[test]
fn reloading_the_connections_keeps_state_follows_edits_and_forgets_deletions() {
    let t0 = Instant::now();
    let mut remotes = Remotes::default();
    remotes.sync(vec![target(1, "http://a"), target(2, "http://b")], t0);
    for due in remotes.take_due(t0) {
        let id = due.target.connection_id;
        remotes.apply_poll(
            id,
            due.generation,
            Ok(vec![item(id, PendingKind::Question, "Q", 1)]),
            t0,
        );
    }
    // Unchanged: nothing shown changes, the schedule stands.
    assert!(!remotes.sync(vec![target(1, "http://a"), target(2, "http://b")], t0));
    assert_eq!(remotes.next_due(), Some(t0 + POLL_INTERVAL));
    // Renamed: the menu names it anew, its list stays.
    let mut renamed = target(1, "http://a");
    renamed.name = "Box".into();
    assert!(remotes.sync(vec![renamed.clone(), target(2, "http://b")], t0));
    assert_eq!(remotes.sources()[0].name, "Box");
    assert_eq!(remotes.sources()[0].items.len(), 1);
    // Moved to another address: its old list goes, and it is asked at once.
    let old_poll = remotes.take_due(t0 + POLL_INTERVAL);
    let moved = target(2, "http://c");
    assert!(remotes.sync(vec![renamed.clone(), moved], t0));
    assert!(remotes.sources()[1].items.is_empty());
    let due = remotes.take_due(t0);
    assert_eq!(due.len(), 1);
    // A poll of the old address that comes back late changes nothing.
    let stale = old_poll
        .iter()
        .find(|p| p.target.connection_id == 2)
        .unwrap();
    assert!(!remotes.apply_poll(
        2,
        stale.generation,
        Ok(vec![item(2, PendingKind::Question, "Q", 1)]),
        t0
    ));
    assert!(remotes.sources()[1].items.is_empty());
    // Deleted: gone from the count.
    assert!(remotes.sync(vec![target(2, "http://c")], t0));
    assert_eq!(remotes.sources().len(), 1);
    assert_eq!(remotes.sources()[0].connection_id, 2);
}

// ── Against a stub server ──

#[derive(Clone, Default)]
struct Stub {
    reply: Arc<Mutex<(StatusCode, String)>>,
    seen: Arc<Mutex<Vec<HeaderMap>>>,
}

async fn stub_answer(State(stub): State<Stub>, headers: HeaderMap) -> Response {
    stub.seen.lock().unwrap().push(headers);
    let (status, body) = stub.reply.lock().unwrap().clone();
    (status, [("content-type", "application/json")], body).into_response()
}

async fn stub_server(status: StatusCode, body: String) -> (String, Stub) {
    let stub = Stub {
        reply: Arc::new(Mutex::new((status, body))),
        ..Stub::default()
    };
    let app = Router::new()
        .route("/api/list_pending_items", post(stub_answer))
        .with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), stub)
}

/// The list as a real server serializes it (`PendingSnapshot`), so the wire
/// shape the tray reads is the one the server writes.
fn server_list(items: &[(i32, i32, PendingKind, &str)]) -> String {
    let items: Vec<PendingItem> = items
        .iter()
        .enumerate()
        .map(|(n, (conversation, root, kind, title))| PendingItem {
            id: format!("question:{n}"),
            kind: *kind,
            source: PendingSource::Question,
            conversation_id: *conversation,
            root_conversation_id: *root,
            folder_id: Some(1),
            folder_name: Some("proj".into()),
            title: Some(title.to_string()),
            agent_type: Some("claude_code".into()),
            agent_label: "Claude Code".into(),
            connection_id: "c".into(),
            request_id: format!("r{n}"),
            asked_at: at(n as i64),
            text: "Which approach?".into(),
            options: Vec::new(),
            question: None,
            queued: 0,
            reminders_sent: 0,
            last_reminded_at: None,
            next_reminder_at: None,
            phone_notified: false,
        })
        .collect();
    let count = items.len() as u32;
    serde_json::to_string(&PendingSnapshot { items, count }).unwrap()
}

#[tokio::test]
async fn reads_a_servers_list_with_the_connections_credentials() {
    let body = server_list(&[(41, 40, PendingKind::Question, "Parent")]);
    let (base, stub) = stub_server(StatusCode::OK, body).await;
    let mut target = target(1, &format!("{base}/"));
    target.headers = vec![RemoteWorkspaceHeader {
        name: "CF-Access-Client-Id".into(),
        value: "abc".into(),
    }];
    let items = fetch_pending(&super::poll::client(), &target)
        .await
        .unwrap();
    assert_eq!(items, vec![item(40, PendingKind::Question, "Parent", 0)]);
    let seen = stub.seen.lock().unwrap();
    assert_eq!(seen[0]["authorization"].to_str().unwrap(), "Bearer token-1");
    assert_eq!(seen[0]["cf-access-client-id"].to_str().unwrap(), "abc");
}

#[tokio::test]
async fn failures_are_told_apart() {
    let client = super::poll::client();
    let (base, _) = stub_server(StatusCode::UNAUTHORIZED, "{}".into()).await;
    assert!(matches!(
        fetch_pending(&client, &target(1, &base)).await,
        Err(FetchError::Unauthorized)
    ));
    let (base, _) = stub_server(StatusCode::NOT_FOUND, "{}".into()).await;
    assert!(matches!(
        fetch_pending(&client, &target(1, &base)).await,
        Err(FetchError::Status(404))
    ));
    let (base, _) = stub_server(StatusCode::OK, "<html>proxy</html>".into()).await;
    assert!(matches!(
        fetch_pending(&client, &target(1, &base)).await,
        Err(FetchError::Malformed(_))
    ));
    // Nothing listening there.
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap()
    };
    assert!(matches!(
        fetch_pending(&client, &target(1, &format!("http://{closed}"))).await,
        Err(FetchError::Unreachable(_))
    ));
}

#[tokio::test]
async fn polls_every_saved_server_and_counts_each_session_once() {
    let client = super::poll::client();
    let (box_a, box_a_stub) = stub_server(
        StatusCode::OK,
        server_list(&[
            (334, 334, PendingKind::Question, "Codeg-refactor-cc"),
            // A delegated sub-agent's permission under the same parent.
            (335, 334, PendingKind::Permission, "Codeg-refactor-cc"),
        ]),
    )
    .await;
    // The same box saved a second time, under another address.
    let (box_b, _) = stub_server(
        StatusCode::OK,
        server_list(&[(334, 334, PendingKind::Question, "Codeg-refactor-cc")]),
    )
    .await;
    let (other, _) = stub_server(StatusCode::OK, server_list(&[])).await;

    let mut a = target(1, &box_a);
    a.name = "Johnnysclawd".into();
    a.instance_id = Some("box000000000000b".into());
    let mut b = target(2, &box_b);
    b.instance_id = Some("box000000000000b".into());
    let c = target(3, &other);

    let t0 = Instant::now();
    let mut remotes = Remotes::default();
    remotes.sync(vec![a, b, c], t0);
    for due in remotes.take_due(t0) {
        let result = fetch_pending(&client, &due.target).await;
        remotes.apply_poll(due.target.connection_id, due.generation, result, t0);
    }
    let local = vec![item(2, PendingKind::Plan, "Local plan", 9)];
    let sessions = waiting_sessions(Some("local0000000000a"), &local, &remotes.sources());
    assert_eq!(
        keys(&sessions),
        vec![
            (
                Origin::Remote { connection_id: 1 },
                334,
                PendingKind::Permission
            ),
            (Origin::Local, 2, PendingKind::Plan),
        ]
    );
    let view = tray_view(&sessions, &labels_for(AppLocale::En));
    assert_eq!(view.badge(), Some(2));
    assert_eq!(
        view.entries[0].label,
        "Permission · Codeg-refactor-cc — Johnnysclawd"
    );

    // Answered on the box: the next poll clears it.
    *box_a_stub.reply.lock().unwrap() = (StatusCode::OK, server_list(&[]));
    let later = t0 + POLL_INTERVAL;
    for due in remotes.take_due(later) {
        let result = fetch_pending(&client, &due.target).await;
        remotes.apply_poll(due.target.connection_id, due.generation, result, later);
    }
    let sessions = waiting_sessions(Some("local0000000000a"), &local, &remotes.sources());
    assert_eq!(keys(&sessions), vec![(Origin::Local, 2, PendingKind::Plan)]);
}

#[test]
fn a_socket_frame_reads_like_a_poll() {
    let frame: serde_json::Value = serde_json::from_str(&format!(
        r#"{{"channel":"app://pending-items","payload":{}}}"#,
        server_list(&[(5, 4, PendingKind::Plan, "T")])
    ))
    .unwrap();
    let snapshot: RemoteSnapshot = serde_json::from_value(frame["payload"].clone()).unwrap();
    assert_eq!(snapshot.items, vec![item(4, PendingKind::Plan, "T", 0)]);
    // Never fails on what it does not read.
    let snapshot: RemoteSnapshot = serde_json::from_str("{}").unwrap();
    assert!(snapshot.items.is_empty());
}

#[test]
fn a_tray_entry_id_carries_its_link() {
    use crate::commands::windows::{tray_attention_link, TRAY_MENU_ID_ATTENTION_PREFIX};
    let id = format!("{TRAY_MENU_ID_ATTENTION_PREFIX}codeg://session/7?server=abc");
    assert_eq!(
        tray_attention_link(&id),
        Some("codeg://session/7?server=abc")
    );
    assert_eq!(tray_attention_link("tray:show"), None);
    assert_eq!(tray_attention_link(TRAY_MENU_ID_ATTENTION_PREFIX), None);
}
