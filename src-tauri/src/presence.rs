//! Who is looking at codeg right now.
//!
//! Every client window reports its own presence: whether it is visible,
//! whether it has the focus, how long since the user last touched it, and
//! which session it shows. Event WebSockets report over the socket
//! (`{"action":"presence", ...}`, see `web::ws`), the desktop app's own
//! windows through the `report_client_presence` command.
//!
//! The rule the alerts are built on: a client counts as **looking** only
//! while its latest report is fresh, says visible AND focused, and the user
//! touched it recently. An open socket by itself means nothing — a phone in a
//! pocket, a laptop asleep with its socket half-open, a browser tab left in
//! the background all hold one. Before this rule, any open socket suppressed
//! the critical alerts' chat-channel fallback.
//!
//! * **anyone looking** (the opposite of "away"): some desktop or web window
//!   is looking. iOS clients never count here — a phone is where the alert
//!   goes when the user is away, not a sign that they are at their desk.
//!   An iOS socket declares itself with the extra `codeg-client.ios`
//!   WebSocket subprotocol.
//! * **looking at a session**: some client, iOS included, is looking and
//!   shows that session. Nothing is pushed about it.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Extra WebSocket subprotocol an iOS client offers next to `codeg-events`.
pub const IOS_CLIENT_PROTOCOL: &str = "codeg-client.ios";

/// A report older than this says nothing (the client sends one at least
/// every 30 s while it lives; a sleeping machine sends none).
pub const STALE_AFTER: Duration = Duration::from_secs(90);

/// A focused window nobody touched for this long is not being looked at.
pub const IDLE_AWAY: Duration = Duration::from_secs(10 * 60);

/// What kind of client holds a presence entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    /// A desktop window (local or remote) or a browser tab.
    Window,
    /// The iOS app.
    Ios,
}

impl ClientKind {
    /// The kind a WebSocket declares in its `Sec-WebSocket-Protocol` list.
    pub fn from_ws_protocols(header: Option<&str>) -> Self {
        let ios = header.is_some_and(|value| {
            value
                .split(',')
                .any(|protocol| protocol.trim() == IOS_CLIENT_PROTOCOL)
        });
        if ios {
            ClientKind::Ios
        } else {
            ClientKind::Window
        }
    }
}

/// One presence report, as a client sends it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PresenceReport {
    /// The page is visible (`document.visibilityState == "visible"`; on iOS,
    /// the scene is active).
    pub visible: bool,
    /// The window has the keyboard focus (`document.hasFocus()`).
    pub focused: bool,
    /// Seconds since the user last touched the window, when reported.
    pub idle_secs: u64,
    /// The sessions the window shows (the active tab's conversation).
    pub conversation_ids: Vec<i32>,
}

/// Whether one report, `age` old, means the user is looking.
pub fn attentive(report: &PresenceReport, age: Duration) -> bool {
    age <= STALE_AFTER
        && report.visible
        && report.focused
        && Duration::from_secs(report.idle_secs).saturating_add(age) < IDLE_AWAY
}

/// Who is looking, at one instant.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Looking {
    /// A desktop or web window is looking; `false` is "away".
    pub anyone: bool,
    /// Sessions some looking client shows.
    pub conversations: HashSet<i32>,
}

impl Looking {
    pub fn away(&self) -> bool {
        !self.anyone
    }

    pub fn at(&self, conversation_id: i32) -> bool {
        self.conversations.contains(&conversation_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ClientKey {
    Socket(u64),
    Window(String),
}

#[derive(Debug, Clone)]
struct Client {
    kind: ClientKind,
    report: Option<(PresenceReport, Instant)>,
}

/// Every client's latest report. One per process (see [`snapshot`]); tests
/// build their own.
#[derive(Debug, Default)]
pub struct PresenceRegistry {
    next_socket: u64,
    clients: HashMap<ClientKey, Client>,
}

impl PresenceRegistry {
    pub fn connect_socket(&mut self, kind: ClientKind) -> u64 {
        self.next_socket = self.next_socket.wrapping_add(1);
        let id = self.next_socket;
        self.clients
            .insert(ClientKey::Socket(id), Client { kind, report: None });
        id
    }

    pub fn disconnect_socket(&mut self, id: u64) {
        self.clients.remove(&ClientKey::Socket(id));
    }

    pub fn report_socket(&mut self, id: u64, report: PresenceReport, now: Instant) {
        if let Some(client) = self.clients.get_mut(&ClientKey::Socket(id)) {
            client.report = Some((report, now));
        }
    }

    /// A desktop window of this process, by its label.
    pub fn report_window(&mut self, label: &str, report: PresenceReport, now: Instant) {
        self.clients.insert(
            ClientKey::Window(label.to_string()),
            Client {
                kind: ClientKind::Window,
                report: Some((report, now)),
            },
        );
    }

    pub fn looking(&self, now: Instant) -> Looking {
        let mut looking = Looking::default();
        for client in self.clients.values() {
            let Some((report, at)) = &client.report else {
                continue;
            };
            if !attentive(report, now.saturating_duration_since(*at)) {
                continue;
            }
            if client.kind == ClientKind::Window {
                looking.anyone = true;
            }
            looking
                .conversations
                .extend(report.conversation_ids.iter().copied());
        }
        looking
    }

    /// Drop desktop-window entries nobody refreshed in a long time (a closed
    /// window never says goodbye).
    fn prune(&mut self, now: Instant) {
        self.clients.retain(|key, client| match key {
            ClientKey::Socket(_) => true,
            ClientKey::Window(_) => client
                .report
                .as_ref()
                .is_some_and(|(_, at)| now.saturating_duration_since(*at) <= STALE_AFTER * 10),
        });
    }

    pub fn socket_count(&self) -> usize {
        self.clients
            .keys()
            .filter(|key| matches!(key, ClientKey::Socket(_)))
            .count()
    }
}

static REGISTRY: LazyLock<Mutex<PresenceRegistry>> =
    LazyLock::new(|| Mutex::new(PresenceRegistry::default()));

fn with_registry<R>(f: impl FnOnce(&mut PresenceRegistry) -> R) -> R {
    let mut guard = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// Who is looking now.
pub fn snapshot() -> Looking {
    let now = Instant::now();
    with_registry(|r| {
        r.prune(now);
        r.looking(now)
    })
}

/// A desktop window of this process reported its presence.
pub fn report_window(label: &str, report: PresenceReport) {
    let now = Instant::now();
    with_registry(|r| r.report_window(label, report, now));
}

/// How many event WebSockets are connected (diagnostics).
pub fn socket_count() -> usize {
    with_registry(|r| r.socket_count())
}

/// One live event WebSocket's presence entry, for as long as it is held.
pub struct SocketPresence {
    id: u64,
    kind: ClientKind,
}

impl SocketPresence {
    pub fn register(kind: ClientKind) -> Self {
        let id = with_registry(|r| r.connect_socket(kind));
        Self { id, kind }
    }

    pub fn kind(&self) -> ClientKind {
        self.kind
    }

    pub fn report(&self, report: PresenceReport) {
        let now = Instant::now();
        with_registry(|r| r.report_socket(self.id, report, now));
    }
}

impl Drop for SocketPresence {
    fn drop(&mut self) {
        with_registry(|r| r.disconnect_socket(self.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(visible: bool, focused: bool, idle_secs: u64, ids: &[i32]) -> PresenceReport {
        PresenceReport {
            visible,
            focused,
            idle_secs,
            conversation_ids: ids.to_vec(),
        }
    }

    #[test]
    fn a_connected_socket_without_a_report_is_not_looking() {
        let mut r = PresenceRegistry::default();
        r.connect_socket(ClientKind::Window);
        let now = Instant::now();
        assert_eq!(r.looking(now), Looking::default());
        assert!(r.looking(now).away());
    }

    #[test]
    fn only_a_visible_focused_recent_window_is_looking() {
        let now = Instant::now();
        let mut r = PresenceRegistry::default();
        let hidden = r.connect_socket(ClientKind::Window);
        let unfocused = r.connect_socket(ClientKind::Window);
        let idle = r.connect_socket(ClientKind::Window);
        r.report_socket(hidden, report(false, true, 0, &[1]), now);
        r.report_socket(unfocused, report(true, false, 0, &[2]), now);
        r.report_socket(idle, report(true, true, 11 * 60, &[3]), now);
        assert!(r.looking(now).away());
        assert!(r.looking(now).conversations.is_empty());

        let focused = r.connect_socket(ClientKind::Window);
        r.report_socket(focused, report(true, true, 5, &[4]), now);
        let looking = r.looking(now);
        assert!(looking.anyone);
        assert!(looking.at(4));
        assert!(!looking.at(1));
    }

    #[test]
    fn a_report_goes_stale_and_idle_time_keeps_counting() {
        let t0 = Instant::now();
        let mut r = PresenceRegistry::default();
        let id = r.connect_socket(ClientKind::Window);
        r.report_socket(id, report(true, true, 0, &[7]), t0);
        assert!(r.looking(t0 + Duration::from_secs(60)).anyone);
        // A sleeping laptop keeps its socket but stops reporting.
        assert!(r.looking(t0 + STALE_AFTER + Duration::from_secs(1)).away());

        // 9.5 minutes idle at report time, plus a minute since: away.
        let t1 = t0 + Duration::from_secs(1000);
        r.report_socket(id, report(true, true, 570, &[7]), t1);
        assert!(r.looking(t1).anyone);
        assert!(r.looking(t1 + Duration::from_secs(60)).away());
    }

    #[test]
    fn an_ios_client_never_makes_the_user_present_but_shows_its_session() {
        let now = Instant::now();
        let mut r = PresenceRegistry::default();
        let phone = r.connect_socket(ClientKind::Ios);
        r.report_socket(phone, report(true, true, 0, &[9]), now);
        let looking = r.looking(now);
        assert!(looking.away(), "a phone in hand is not a desk");
        assert!(looking.at(9), "but the session on its screen is seen");
    }

    #[test]
    fn closing_a_socket_drops_its_presence() {
        let now = Instant::now();
        let mut r = PresenceRegistry::default();
        let id = r.connect_socket(ClientKind::Window);
        r.report_socket(id, report(true, true, 0, &[]), now);
        assert!(r.looking(now).anyone);
        r.disconnect_socket(id);
        assert!(r.looking(now).away());
        assert_eq!(r.socket_count(), 0);
    }

    #[test]
    fn desktop_windows_report_by_label_and_expire() {
        let t0 = Instant::now();
        let mut r = PresenceRegistry::default();
        r.report_window("main", report(true, true, 0, &[5]), t0);
        assert!(r.looking(t0).at(5));
        r.report_window("main", report(true, false, 0, &[5]), t0);
        assert!(r.looking(t0).away(), "the newer report replaces the older");
        r.prune(t0 + STALE_AFTER * 11);
        assert!(r.clients.is_empty());
    }

    #[test]
    fn the_ios_subprotocol_marks_the_client_kind() {
        assert_eq!(
            ClientKind::from_ws_protocols(Some("codeg-events, codeg-client.ios, codeg-token.abc")),
            ClientKind::Ios
        );
        assert_eq!(
            ClientKind::from_ws_protocols(Some("codeg-events, codeg-token.abc")),
            ClientKind::Window
        );
        assert_eq!(ClientKind::from_ws_protocols(None), ClientKind::Window);
    }

    #[test]
    fn a_presence_message_parses_with_missing_fields() {
        let parsed: PresenceReport = serde_json::from_str(r#"{"visible":true}"#).unwrap();
        assert_eq!(parsed, report(true, false, 0, &[]));
    }
}
