//! OS-level `codeg://` URL scheme.
//!
//! In-app markdown already uses `codeg://session/<id>` and `codeg://agent/<type>`
//! as reference links. Those stay in-process badges. This module is the
//! **system** handler: a click in another app, `open codeg://…`, or a browser
//! custom-scheme navigation should bring the desktop workspace forward and
//! focus the named conversation, or open the named Harness item.
//!
//! Supported forms:
//!
//! - `codeg://session/<id>` — Codeg's numeric conversation PK, or an agent's
//!   `external_id` (Grok UUID, Codex thread id, …)
//! - `codeg://session/<id>?server=<server>` — the same, on a named codeg
//!   instance (see [Servers](#servers))
//! - `codeg://workspace?conversationId=<id>` — same lookup; `folderId` and
//!   `agent` are optional and filled from the row when omitted; `server` as
//!   above
//! - `codeg://harness/install?ref=<publisher>/<name>` — the SpaceRing
//!   website's "Open in Codeg": that item on the Harness page's Discover
//!   section. It only ever opens; installing is the user's decision, made in
//!   Codeg. Any other `codeg://harness` link, and a `ref` that is not an
//!   item's address, is `codeg://open`
//! - `codeg://open` / `codeg://` — just show the main window
//!
//! `codeg://agent/…`, `codeg://commit/…`, and `codeg://embedded/…` are
//! in-app mention badges, not OS navigation, and are ignored here.
//!
//! # Servers
//!
//! A conversation id means something only on the instance that issued it, so
//! every link codeg writes names its instance: `server=<instance id>`
//! ([`crate::instance_identity`]). A desktop app handed a link matches the
//! value ([`match_server`]) against itself and against its saved remote
//! connections — by instance id, then by the connection's saved name (any
//! case), then by its base URL's host, then by the name the instance gives
//! itself — so `?server=MyBox` written by hand works too. A link with no
//! `server`, or naming this instance, opens here as it always did; one naming
//! a saved connection opens in that connection's workspace window, which looks
//! the session up on its own server; anything else shows the local workspace
//! with a notice saying why.

use std::sync::{Mutex, PoisonError};

use sea_orm::DatabaseConnection;

use crate::db::error::DbError;
use crate::db::service::{conversation_service, remote_workspace_connection_service};
use crate::db::AppDatabase;
use crate::instance_identity::InstanceIdentity;
use crate::models::DbConversationSummary;

/// What a parsed `codeg://` URL wants the desktop app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// Bring the workspace forward without targeting a conversation.
    Open,
    /// Focus a conversation looked up by `codeg://session/<ref>`, on `server`
    /// (`None`: this instance).
    Session {
        session_ref: String,
        server: Option<String>,
    },
    /// Explicit workspace query. `conversation_id` is required; folder and
    /// agent are filled from the database when omitted.
    Workspace {
        folder_id: Option<i32>,
        conversation_id: i32,
        agent: Option<String>,
        server: Option<String>,
    },
    /// Open a Harness item: `codeg://harness/install?ref=<publisher>/<name>`.
    /// `item_ref` has been checked, and is in its canonical lower-case form.
    Harness { item_ref: String },
}

impl DeepLink {
    /// The `server` a conversation link names; `None` for this instance, and
    /// for every other kind of link.
    pub fn server(&self) -> Option<&str> {
        match self {
            Self::Session { server, .. } | Self::Workspace { server, .. } => server.as_deref(),
            Self::Open | Self::Harness { .. } => None,
        }
    }

    /// Whether the link names a conversation (`session` / `workspace`).
    pub fn names_a_conversation(&self) -> bool {
        matches!(self, Self::Session { .. } | Self::Workspace { .. })
    }

    /// The conversation the link names, as another instance's lookup takes it:
    /// the ref, and the folder and agent the row must have.
    fn conversation_query(&self) -> Option<(String, Option<i32>, Option<String>)> {
        match self {
            Self::Session { session_ref, .. } => Some((session_ref.clone(), None, None)),
            Self::Workspace {
                folder_id,
                conversation_id,
                agent,
                ..
            } => Some((conversation_id.to_string(), *folder_id, agent.clone())),
            Self::Open | Self::Harness { .. } => None,
        }
    }
}

/// A `codeg://` link resolved to a conversation the workspace can open.
///
/// Serializes as the payload of [`take_pending_deep_link`], in the same
/// camelCase shape as the `workspace://focus-conversation` event so both
/// arrive at `PetFocusBridge` looking alike.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTarget {
    pub folder_id: i32,
    pub conversation_id: i32,
    pub agent: String,
}

impl FocusTarget {
    /// Path the main window should load on a cold start so
    /// `DeepLinkBootstrap` can open the tab after hydration.
    pub fn workspace_path(&self) -> String {
        format!(
            "workspace?folderId={}&conversationId={}&agent={}",
            self.folder_id,
            self.conversation_id,
            urlencoding::encode(&self.agent)
        )
    }

    fn from_summary(summary: DbConversationSummary) -> Self {
        Self {
            folder_id: summary.folder_id,
            conversation_id: summary.id,
            agent: summary.agent_type.as_wire().into_owned(),
        }
    }
}

/// Longest `server` value a link may carry, in characters.
const MAX_SERVER_CHARS: usize = 255;

/// `codeg://session/<conversation_id>`, naming `server` when there is one.
pub fn session_link_on(conversation_id: impl std::fmt::Display, server: Option<&str>) -> String {
    match server.map(str::trim).filter(|server| !server.is_empty()) {
        Some(server) => format!(
            "codeg://session/{conversation_id}?server={}",
            urlencoding::encode(server)
        ),
        None => format!("codeg://session/{conversation_id}"),
    }
}

/// The link to one of this instance's conversations: [`session_link_on`] with
/// this instance's id, or the old form when it has none.
pub fn session_link(conversation_id: impl std::fmt::Display) -> String {
    session_link_on(conversation_id, crate::instance_identity::current_id())
}

/// Parse a `codeg:` / `codeg://` URL. Returns `None` for a different scheme
/// or for in-app mention badges that must not navigate the workspace.
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let raw = raw.trim();
    let rest = raw
        .strip_prefix("codeg://")
        .or_else(|| raw.strip_prefix("codeg:"))?;
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() {
        return Some(DeepLink::Open);
    }

    let (path, query) = split_path_query(rest);
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.eq_ignore_ascii_case("open") {
        return Some(DeepLink::Open);
    }
    if path.eq_ignore_ascii_case("workspace") {
        return parse_workspace_query(query.unwrap_or(""));
    }
    // `session` is the URL's host component, which the `url` crate lower-cases
    // before we ever see it — but an argv-delivered link on Windows/Linux keeps
    // whatever case the caller typed, so match the segment case-insensitively
    // like `open`/`workspace` above. The ref itself stays case-sensitive: an
    // agent's `external_id` is an opaque, case-significant token.
    if let Some((head, session_ref)) = path.split_once('/') {
        if head.eq_ignore_ascii_case("session") {
            return parse_session_link(session_ref, query.unwrap_or(""));
        }
    }
    // A host component too, so matched the same way.
    let (head, action) = path.split_once('/').unwrap_or((path, ""));
    if head.eq_ignore_ascii_case("harness") {
        return Some(parse_harness_link(action, query.unwrap_or("")));
    }
    None
}

fn split_path_query(rest: &str) -> (&str, Option<&str>) {
    let without_fragment = rest.split('#').next().unwrap_or(rest);
    match without_fragment.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (without_fragment, None),
    }
}

/// `session/<ref>?<query>`. A `server` that cannot be one makes the link
/// [`DeepLink::Open`]: meant for Codeg, but for no session it can name.
fn parse_session_link(raw: &str, query: &str) -> Option<DeepLink> {
    let decoded = percent_decode(raw);
    let decoded = decoded.trim();
    if decoded.is_empty() || decoded.contains('/') || decoded.contains('\\') {
        return None;
    }
    if decoded.len() > 256 {
        return None;
    }
    let Ok(server) = parse_server(query) else {
        return Some(DeepLink::Open);
    };
    Some(DeepLink::Session {
        session_ref: decoded.to_string(),
        server,
    })
}

/// The `server` a link's query names, read as `URLSearchParams` reads it: the
/// first `server`, `+` as a space, percent-escapes decoded, surrounding space
/// trimmed. `Ok(None)` when there is none, or it is empty; `Err` for a value
/// that cannot name a server — over [`MAX_SERVER_CHARS`], or holding a
/// control character.
fn parse_server(query: &str) -> Result<Option<String>, ()> {
    let Some((_, value)) =
        url::form_urlencoded::parse(query.as_bytes()).find(|(key, _)| key == "server")
    else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > MAX_SERVER_CHARS || value.chars().any(char::is_control) {
        return Err(());
    }
    Ok(Some(value.to_string()))
}

fn parse_workspace_query(query: &str) -> Option<DeepLink> {
    let mut folder_id = None;
    let mut conversation_id = None;
    let mut agent = None;
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        let value = percent_decode(value);
        match key {
            "folderId" | "folder_id" => {
                folder_id = value.parse::<i32>().ok().filter(|id| *id > 0);
            }
            "conversationId" | "conversation_id" => {
                conversation_id = value.parse::<i32>().ok().filter(|id| *id > 0);
            }
            "agent" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    agent = Some(trimmed.to_string());
                }
            }
            _ => {}
        }
    }
    let conversation_id = conversation_id?;
    let Ok(server) = parse_server(query) else {
        return Some(DeepLink::Open);
    };
    Some(DeepLink::Workspace {
        folder_id,
        conversation_id,
        agent,
        server,
    })
}

fn percent_decode(raw: &str) -> String {
    match urlencoding::decode(raw) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => raw.to_string(),
    }
}

/// `harness/<action>?<query>`. The one action is `install`, whose `ref` is read
/// the way `URLSearchParams` reads it — the first `ref`, `+` as a space,
/// percent-escapes decoded — as the Web address's `?harness=` is read. Every
/// other parameter is ignored.
///
/// Anything else sent to the Harness — another action, no `ref`, a `ref` that
/// is not an item's address — is [`DeepLink::Open`]: the link was meant for
/// Codeg, so the workspace comes forward, and nothing more.
fn parse_harness_link(action: &str, query: &str) -> DeepLink {
    if !action.eq_ignore_ascii_case("install") {
        return DeepLink::Open;
    }
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "ref")
        .and_then(|(_, value)| parse_item_ref(&value))
        .map_or(DeepLink::Open, |item_ref| DeepLink::Harness { item_ref })
}

/// An item's address as `parseItemRef` (`src/lib/harness/item-ref.ts`) reads
/// it, taking and refusing exactly what it does: surrounding space trimmed as
/// JavaScript's `trim` trims it, lower-cased, then the catalog's own rules
/// ([`ItemRef::parse`](crate::harness::ItemRef::parse)) — publisher
/// `[a-z0-9][a-z0-9.-]{0,252}`, name `[a-z0-9-]{1,64}`, which also cap the
/// length. Returns the canonical `publisher/name`.
///
/// `str::to_lowercase` and JavaScript's `toLowerCase` both apply Unicode's
/// full default mapping, so they agree on everything that comes out in
/// `[a-z]`: the ASCII capitals, and the Kelvin sign, which becomes `k`.
fn parse_item_ref(input: &str) -> Option<String> {
    let text = input.trim_matches(is_js_trim_space).to_lowercase();
    crate::harness::ItemRef::parse(&text)
        .ok()
        .map(|item_ref| item_ref.to_string())
}

/// What JavaScript's `String.prototype.trim` strips: Unicode `White_Space`,
/// which `char::is_whitespace` tests, less U+0085 (NEL) and plus U+FEFF (the
/// byte-order mark).
fn is_js_trim_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

/// Path the main window loads on a Windows/Linux cold start for a Harness
/// link: the Web address, `/workspace?harness=<ref>`, which
/// `HarnessLinkBootstrap` reads.
fn harness_workspace_path(item_ref: &str) -> String {
    format!("workspace?harness={}", urlencoding::encode(item_ref))
}

/// Look a parsed link up in the live conversation table — of THIS instance,
/// whatever `server` it names: [`plan_link`] decides where a link goes first.
pub async fn resolve_deep_link(
    db: &AppDatabase,
    link: &DeepLink,
) -> Result<Option<FocusTarget>, DbError> {
    match link.conversation_query() {
        // Neither names a conversation. A Harness link needs no lookup: its
        // callers park it, or point the startup path at it, as it is.
        None => Ok(None),
        Some((session_ref, folder_id, agent)) => {
            resolve_session_ref(&db.conn, &session_ref, folder_id, agent.as_deref()).await
        }
    }
}

/// The live conversation `session_ref` names, when it is in `folder_id` and
/// run by `agent` (each checked only when given).
async fn resolve_session_ref(
    conn: &DatabaseConnection,
    session_ref: &str,
    folder_id: Option<i32>,
    agent: Option<&str>,
) -> Result<Option<FocusTarget>, DbError> {
    let Some(summary) = conversation_service::find_live_by_session_ref(conn, session_ref).await?
    else {
        return Ok(None);
    };
    if folder_id.is_some_and(|id| id != summary.folder_id) {
        return Ok(None);
    }
    if agent.is_some_and(|wanted| summary.agent_type.as_wire() != wanted) {
        return Ok(None);
    }
    Ok(Some(FocusTarget::from_summary(summary)))
}

/// Look a session up for a workspace window that was handed a link for this
/// instance: a remote workspace window asks its server, a badge in a
/// transcript asks its own. `None` when no live conversation answers to it.
pub async fn resolve_session_link_core(
    db: &AppDatabase,
    session_ref: &str,
    folder_id: Option<i32>,
    agent: Option<&str>,
) -> Result<Option<FocusTarget>, crate::app_error::AppCommandError> {
    resolve_session_ref(&db.conn, session_ref, folder_id, agent)
        .await
        .map_err(crate::app_error::AppCommandError::db)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn resolve_session_link(
    db: tauri::State<'_, AppDatabase>,
    session_ref: String,
    folder_id: Option<i32>,
    agent: Option<String>,
) -> Result<Option<FocusTarget>, crate::app_error::AppCommandError> {
    resolve_session_link_core(&db, &session_ref, folder_id, agent.as_deref()).await
}

// ── Which instance a link is for ────────────────────────────────────────────

/// A saved remote connection, as a link's `server` is matched against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownServer {
    pub connection_id: i32,
    /// The name it was saved under.
    pub name: String,
    pub base_url: String,
    /// What its server last said about itself, if it ever did.
    pub identity: Option<InstanceIdentity>,
}

/// Where a link's `server` points.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerMatch {
    /// This instance.
    Local,
    /// The server of a saved remote connection.
    Remote { connection_id: i32 },
    /// Neither.
    Unknown,
}

/// Match a link's `server` against this instance (`local`) and the saved
/// connections (`known`, in their list order; the first that matches wins).
/// In this order, so that what identifies an instance outright is never
/// overridden by a name that only happens to match:
///
/// 1. an instance id — this instance's, or one a connection's server gave;
/// 2. the name a connection was saved under, in any case;
/// 3. a connection's host — alone, with its port, or as a whole base URL;
/// 4. the name an instance gives itself — this one's, then each server's.
pub fn match_server(
    wanted: &str,
    local: Option<&InstanceIdentity>,
    known: &[KnownServer],
) -> ServerMatch {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return ServerMatch::Local;
    }
    let remote = |server: &KnownServer| ServerMatch::Remote {
        connection_id: server.connection_id,
    };
    if local.is_some_and(|local| local.instance_id.eq_ignore_ascii_case(wanted)) {
        return ServerMatch::Local;
    }
    if let Some(server) = known.iter().find(|server| {
        server
            .identity
            .as_ref()
            .is_some_and(|identity| identity.instance_id.eq_ignore_ascii_case(wanted))
    }) {
        return remote(server);
    }
    if let Some(server) = known.iter().find(|server| same_name(&server.name, wanted)) {
        return remote(server);
    }
    if let Some(server) = known
        .iter()
        .find(|server| names_host_of(wanted, &server.base_url))
    {
        return remote(server);
    }
    if local.is_some_and(|local| same_name(&local.name, wanted)) {
        return ServerMatch::Local;
    }
    if let Some(server) = known.iter().find(|server| {
        server
            .identity
            .as_ref()
            .is_some_and(|identity| same_name(&identity.name, wanted))
    }) {
        return remote(server);
    }
    ServerMatch::Unknown
}

fn same_name(name: &str, wanted: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.to_lowercase() == wanted.to_lowercase()
}

/// Whether `wanted` names the host `base_url` points at: the host, the host
/// with the port the URL gives, or a URL to the same host and port.
fn names_host_of(wanted: &str, base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if wanted.contains("://") {
        return url::Url::parse(wanted).is_ok_and(|other| {
            other
                .host_str()
                .is_some_and(|other_host| other_host.eq_ignore_ascii_case(host))
                && other.port_or_known_default() == url.port_or_known_default()
        });
    }
    if wanted.eq_ignore_ascii_case(host) {
        return true;
    }
    url.port()
        .is_some_and(|port| wanted.eq_ignore_ascii_case(&format!("{host}:{port}")))
}

/// The saved remote connections, with what each one's server said about
/// itself.
pub async fn known_servers(conn: &DatabaseConnection) -> Result<Vec<KnownServer>, DbError> {
    let connections = remote_workspace_connection_service::list(conn).await?;
    let mut known = Vec::with_capacity(connections.len());
    for connection in connections {
        let identity = crate::instance_identity::remote_identity(conn, connection.id).await;
        known.push(KnownServer {
            connection_id: connection.id,
            name: connection.name,
            base_url: connection.base_url,
            identity,
        });
    }
    Ok(known)
}

/// Why a link opened nothing, as the workspace it lands on says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkNotice {
    /// No live conversation here answers to it.
    NotFound,
    /// It names a server that is neither this instance nor a saved connection.
    UnknownServer,
    /// It names a saved connection whose workspace window could not be opened.
    ServerUnavailable,
}

/// What a link leaves for a workspace window, claimed with
/// [`take_pending_deep_link`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingLink {
    /// A conversation of the window's own backend, looked up already.
    Focus(FocusTarget),
    /// For a remote workspace window: a session to look up on its server
    /// (with the folder and agent the row must have, when the link said), and
    /// the connection's name for the notice when there is none.
    #[serde(rename_all = "camelCase")]
    Session {
        session_ref: String,
        folder_id: Option<i32>,
        agent: Option<String>,
        server_name: String,
    },
    /// Nothing to open, and why.
    #[serde(rename_all = "camelCase")]
    Notice {
        reason: LinkNotice,
        /// The server as the link (or the saved connection) names it.
        server: Option<String>,
        session_ref: Option<String>,
    },
}

/// What one conversation link comes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPlan {
    /// Open this conversation in the local workspace.
    Local(FocusTarget),
    /// Hand this [`PendingLink::Session`] to saved connection
    /// `connection_id`'s workspace window.
    Remote {
        connection_id: i32,
        pending: PendingLink,
    },
    /// Show the local workspace with this [`PendingLink::Notice`].
    Notice(PendingLink),
}

/// Decide where a conversation link goes: no `server`, or this instance's,
/// is looked up here; a saved connection's goes to its window as it is; any
/// other is a notice. `None` for a link that names no conversation.
pub async fn plan_link(
    db: &AppDatabase,
    link: &DeepLink,
    local: Option<&InstanceIdentity>,
    known: &[KnownServer],
) -> Result<Option<LinkPlan>, DbError> {
    let Some((session_ref, folder_id, agent)) = link.conversation_query() else {
        return Ok(None);
    };
    let route = match link.server() {
        None => ServerMatch::Local,
        Some(server) => match_server(server, local, known),
    };
    let plan = match route {
        ServerMatch::Local => match resolve_deep_link(db, link).await? {
            Some(target) => LinkPlan::Local(target),
            None => LinkPlan::Notice(PendingLink::Notice {
                reason: LinkNotice::NotFound,
                server: None,
                session_ref: Some(session_ref),
            }),
        },
        ServerMatch::Remote { connection_id } => LinkPlan::Remote {
            connection_id,
            pending: PendingLink::Session {
                session_ref,
                folder_id,
                agent,
                server_name: known
                    .iter()
                    .find(|server| server.connection_id == connection_id)
                    .map(|server| server.name.clone())
                    .unwrap_or_default(),
            },
        },
        ServerMatch::Unknown => LinkPlan::Notice(PendingLink::Notice {
            reason: LinkNotice::UnknownServer,
            server: link.server().map(str::to_string),
            session_ref: Some(session_ref),
        }),
    };
    Ok(Some(plan))
}

// ── Handing a link to a window ──────────────────────────────────────────────

/// Label of the local workspace window, which every link that is not for a
/// remote workspace window lands on.
#[cfg(any(feature = "tauri-runtime", test))]
const LOCAL_WINDOW: &str = "main";

/// Nudge telling a workspace window that a deep link is waiting for it in
/// [`PENDING_LINKS`] (or, for `main`, in [`PENDING_HARNESS_LINK`]).
/// Deliberately carries no payload — see [`PENDING_LINKS`].
#[cfg(feature = "tauri-runtime")]
pub const PENDING_EVENT: &str = "workspace://deep-link-pending";

/// The one channel a link's outcome travels on to a workspace window: one
/// slot per window label, holding the newest. (A Harness item has
/// [`PENDING_HARNESS_LINK`], on the same terms.)
///
/// The obvious design — emit the target like the pet panel does — cannot work
/// here, in both directions. An emit reaches only webviews that *already*
/// registered a JS listener (Tauri's `emit_js_filter` skips the rest and
/// queues nothing), so a cold-start link is dropped: on macOS the launch URL
/// arrives as `RunEvent::Opened` after the setup hook, long before React
/// mounts `PetFocusBridge`. And an emitted target that is *also* parked can be
/// consumed twice — once from the payload, once from the slot — or linger and
/// re-open on a later mount.
///
/// So the outcome is only ever handed over by [`take_pending_deep_link`],
/// which is an atomic take of the calling window's slot: the mount-time drain
/// and every nudge-driven drain compete for it and exactly one of them wins.
/// [`PENDING_EVENT`] is a bare "come and get it" — dropping it during boot
/// costs nothing because the mount drain follows. A remote workspace window
/// claims its slot through the local shell, like the local window does.
///
/// A single slot per window means a launch carrying several URLs focuses the
/// last one the window gets to, which is all a focus operation can mean
/// anyway.
static PENDING_LINKS: Mutex<Vec<(String, PendingLink)>> = Mutex::new(Vec::new());

/// Only the desktop URL handler parks links; `codeg-server` compiles the
/// parser and the lookup but has no OS scheme to feed them.
#[cfg(any(feature = "tauri-runtime", test))]
fn park_link(label: &str, link: PendingLink) {
    let mut slots = PENDING_LINKS.lock().unwrap_or_else(PoisonError::into_inner);
    slots.retain(|(parked_for, _)| parked_for != label);
    slots.push((label.to_string(), link));
}

/// Take what a link left for the window labelled `label`. `None` when there is
/// nothing, or when another drain already claimed it.
pub fn take_pending_link(label: &str) -> Option<PendingLink> {
    let mut slots = PENDING_LINKS.lock().unwrap_or_else(PoisonError::into_inner);
    let index = slots
        .iter()
        .position(|(parked_for, _)| parked_for == label)?;
    Some(slots.remove(index).1)
}

/// Take the deep link the calling workspace window was handed: the local one,
/// or a remote workspace window (through the shell transport).
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn take_pending_deep_link(window: tauri::WebviewWindow) -> Option<PendingLink> {
    take_pending_link(window.label())
}

/// The Harness item a `codeg://harness/install` link asked for, waiting for
/// the local workspace window to claim it with [`take_pending_harness_link`].
///
/// A slot of its own beside [`PENDING_LINKS`], so that neither kind can be
/// taken for the other, and handed over on the same terms: an atomic take,
/// announced by the payload-less [`PENDING_EVENT`]. One slot, holding the
/// newest link: one that arrives before the last was claimed names the item
/// the user is after now.
///
/// A Windows/Linux cold start never comes through here. Its link is in the
/// startup path ([`startup_link_path`]), and parked as well, the item
/// would open a second time.
static PENDING_HARNESS_LINK: Mutex<Option<String>> = Mutex::new(None);

#[cfg(any(feature = "tauri-runtime", test))]
fn set_pending_harness_link(item_ref: String) {
    if let Ok(mut slot) = PENDING_HARNESS_LINK.lock() {
        *slot = Some(item_ref);
    }
}

/// Park the Harness items `urls` ask for, in their order, so the last of them
/// is the one left waiting. Whether there was one.
#[cfg(any(feature = "tauri-runtime", test))]
fn park_harness_links(urls: &[String]) -> bool {
    let mut parked = false;
    for raw in urls {
        if let Some(DeepLink::Harness { item_ref }) = parse_deep_link(raw) {
            set_pending_harness_link(item_ref);
            parked = true;
        }
    }
    parked
}

/// Take the Harness item a link asked for, as its canonical `publisher/name`.
/// Returns `None` when there was none, or when another drain already claimed
/// it. Desktop only, like [`take_pending_deep_link`]: Codeg Web has
/// `/workspace?harness=` instead, and no OS scheme.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn take_pending_harness_link() -> Option<String> {
    PENDING_HARNESS_LINK
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

/// Collect `codeg:` URLs from a process argv (Windows / Linux second launch).
pub fn urls_from_argv(argv: &[impl AsRef<str>]) -> Vec<String> {
    argv.iter()
        .map(|arg| arg.as_ref().to_string())
        .filter(|arg| parse_deep_link(arg).is_some())
        .collect()
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_raw_urls(app: &tauri::AppHandle, urls: &[String]) {
    // Rebuilds `main` when it is gone — a windowless launch never built it, a
    // close destroyed it — and is `show_main_window` when it exists. A link
    // that lands on no window would otherwise do nothing visible and leave its
    // target parked for whenever a window opens next.
    use crate::commands::workspace_windows::show_local_workspace_window;
    use tauri::Manager;

    // No link at all is codeg launched again while it runs (Windows / Linux):
    // the same "bring codeg back" as a macOS dock click — the last-used
    // workspace window, which after a launch into a remote workspace is that
    // window, not the hidden main one.
    if urls.is_empty() {
        crate::commands::workspace_windows::activate_workspace(app);
        return;
    }

    // Harness links are parked here and now, not in the task below. They need
    // nothing from the database, so a database that is not ready yet does not
    // lose them; and they are parked in the order they came, so the newer of
    // two is the one left waiting, which tasks running side by side could not
    // promise. Then the nudge, as for a conversation: to the local main window
    // only.
    let harness_parked = park_harness_links(urls);
    if harness_parked {
        show_local_workspace_window(app);
        nudge(app, LOCAL_WINDOW);
    }

    let Some(db) = app.try_state::<AppDatabase>() else {
        tracing::warn!(
            "[deep-link] database not ready; showing workspace for {} url(s)",
            urls.len()
        );
        show_local_workspace_window(app);
        return;
    };
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let app = app.clone();
    let urls = urls.to_vec();
    tauri::async_runtime::spawn(async move {
        let mut shown = harness_parked;
        // Read once, when the first conversation link needs them.
        let mut known: Option<Vec<KnownServer>> = None;
        for raw in &urls {
            let Some(link) = parse_deep_link(raw) else {
                continue;
            };
            if !link.names_a_conversation() {
                continue; // `open`, or a Harness link parked above
            }
            if known.is_none() {
                known = Some(known_servers(&db.conn).await.unwrap_or_else(|err| {
                    tracing::warn!("[deep-link] cannot read the saved connections: {err}");
                    Vec::new()
                }));
            }
            let local = crate::instance_identity::current();
            let mut plan = plan_link(&db, &link, local, known.as_deref().unwrap_or_default()).await;
            if is_unknown_server(&plan) {
                // A connection saved before servers said who they are, or a
                // server whose identity changed since: ask them all, then match
                // once more.
                crate::commands::remote_workspace::relearn_remote_identities(&db.conn).await;
                if let Ok(relearned) = known_servers(&db.conn).await {
                    plan = plan_link(&db, &link, local, &relearned).await;
                    known = Some(relearned);
                }
            }
            match plan {
                Ok(Some(plan)) => {
                    carry_out(&app, &db, plan).await;
                    shown = true;
                }
                Ok(None) => {}
                Err(err) => tracing::warn!("[deep-link] {raw}: {err}"),
            }
        }
        if !shown {
            show_local_workspace_window(&app);
        }
    });
}

#[cfg(feature = "tauri-runtime")]
fn is_unknown_server(plan: &Result<Option<LinkPlan>, DbError>) -> bool {
    matches!(
        plan,
        Ok(Some(LinkPlan::Notice(PendingLink::Notice {
            reason: LinkNotice::UnknownServer,
            ..
        })))
    )
}

/// Park what `plan` leaves for a workspace window, bring that window forward
/// (building it if need be), and nudge it.
#[cfg(feature = "tauri-runtime")]
async fn carry_out(app: &tauri::AppHandle, db: &AppDatabase, plan: LinkPlan) {
    use crate::commands::workspace_windows::WorkspaceWindow;
    use tauri::Manager;

    let (connection_id, pending) = match plan {
        LinkPlan::Local(target) => return deliver_locally(app, PendingLink::Focus(target)),
        LinkPlan::Notice(notice) => return deliver_locally(app, notice),
        LinkPlan::Remote {
            connection_id,
            pending,
        } => (connection_id, pending),
    };
    let unavailable = |name: String| PendingLink::Notice {
        reason: LinkNotice::ServerUnavailable,
        server: Some(name),
        session_ref: match &pending {
            PendingLink::Session { session_ref, .. } => Some(session_ref.clone()),
            _ => None,
        },
    };
    let connection = match remote_workspace_connection_service::get(&db.conn, connection_id).await {
        Ok(Some(connection)) => connection,
        Ok(None) => return deliver_locally(app, unavailable(String::new())),
        Err(err) => {
            tracing::warn!("[deep-link] remote connection {connection_id}: {err}");
            return deliver_locally(app, unavailable(String::new()));
        }
    };
    let label = WorkspaceWindow::Remote { connection_id }.label();
    let notice = unavailable(connection.name.clone());
    park_link(&label, pending);
    if let Err(err) =
        crate::commands::remote_workspace::show_remote_workspace_window(app, &connection)
    {
        if app.get_webview_window(&label).is_some() {
            // Built meanwhile, by the launch reopening it.
            crate::commands::windows::show_and_focus_window(app, &label);
        } else {
            tracing::warn!(
                "[deep-link] cannot open the workspace of {}: {} {}",
                connection.name,
                err.message,
                err.detail.as_deref().unwrap_or_default()
            );
            let _ = take_pending_link(&label);
            return deliver_locally(app, notice);
        }
    }
    nudge(app, &label);
}

/// Park `pending` for the local workspace window, bring it forward, nudge it.
#[cfg(feature = "tauri-runtime")]
fn deliver_locally(app: &tauri::AppHandle, pending: PendingLink) {
    park_link(LOCAL_WINDOW, pending);
    crate::commands::workspace_windows::show_local_workspace_window(app);
    nudge(app, LOCAL_WINDOW);
}

#[cfg(feature = "tauri-runtime")]
fn nudge(app: &tauri::AppHandle, label: &str) {
    use tauri::Emitter;
    if let Err(err) = app.emit_to(label, PENDING_EVENT, ()) {
        tracing::warn!("[deep-link] failed to signal {label}: {err}");
    }
}

/// Open a `codeg://` conversation link from inside the app, as if the OS had
/// handed it over: a transcript's session badge that names another server.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn open_deep_link(
    app: tauri::AppHandle,
    url: String,
) -> Result<(), crate::app_error::AppCommandError> {
    if !parse_deep_link(&url).is_some_and(|link| link.names_a_conversation()) {
        return Err(crate::app_error::AppCommandError::invalid_input(
            "Not a codeg session link",
        ));
    }
    handle_raw_urls(&app, &[url]);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_argv(app: &tauri::AppHandle, argv: &[String]) {
    handle_raw_urls(app, &urls_from_argv(argv));
}

/// Resolve the first startup URL that names something here, so the main
/// window starts on it on a cold start. A live local conversation is
/// `/workspace?folderId=…`, which `DeepLinkBootstrap` opens after folders/tabs
/// hydrate — an event emitted here would race the webview's subscription. A
/// Harness item is the Web address, `/workspace?harness=<ref>`, which
/// `HarnessLinkBootstrap` opens; it is not parked as well, since a slot
/// claimed after the address was read would open the item again. `Some` also
/// tells setup that this launch is about the local workspace, which overrides
/// a startup remote workspace. A link for another server, or to no live
/// conversation, is not one: [`startup_links_left_over`] hands those to
/// [`handle_raw_urls`] once the windows are up.
///
/// This only fires where the plugin already knows the launch URL by the time
/// the setup hook runs, i.e. Windows/Linux (argv, parsed during plugin setup).
/// On macOS the URL arrives later as `RunEvent::Opened`, so `get_current()` is
/// empty here and the cold start is carried by the slots ([`PENDING_LINKS`],
/// [`PENDING_HARNESS_LINK`]) instead. The
/// two paths are mutually exclusive: whichever delivery populated the plugin
/// before our `on_open_url` listener existed is the one that wins.
pub async fn startup_link_path(db: &AppDatabase, urls: &[String]) -> Option<String> {
    let mut known: Option<Vec<KnownServer>> = None;
    for raw in urls {
        let Some(link) = parse_deep_link(raw) else {
            continue;
        };
        match &link {
            DeepLink::Open => continue,
            DeepLink::Harness { item_ref } => return Some(harness_workspace_path(item_ref)),
            DeepLink::Session { .. } | DeepLink::Workspace { .. } => {}
        }
        if known.is_none() && link.server().is_some() {
            known = Some(known_servers(&db.conn).await.unwrap_or_default());
        }
        let local = crate::instance_identity::current();
        match plan_link(db, &link, local, known.as_deref().unwrap_or_default()).await {
            Ok(Some(LinkPlan::Local(target))) => return Some(target.workspace_path()),
            Ok(_) => tracing::info!("[deep-link] startup url is not a live local session: {raw}"),
            Err(err) => tracing::warn!("[deep-link] startup {raw}: {err}"),
        }
    }
    None
}

/// [`startup_link_path`], or the plain workspace when no startup URL names
/// anything.
pub async fn startup_workspace_path(db: &AppDatabase, urls: &[String]) -> String {
    startup_link_path(db, urls)
        .await
        .unwrap_or_else(|| "workspace".into())
}

/// The startup URLs that are left to [`handle_raw_urls`] once the windows are
/// built: when [`startup_link_path`] found nothing to start the main window
/// on, its conversation links — one for another server opens there, one to no
/// live conversation says so. None when it did find something: that launch is
/// about the local workspace.
pub fn startup_links_left_over(urls: &[String], startup_path: Option<&str>) -> Vec<String> {
    if startup_path.is_some() {
        return Vec::new();
    }
    urls.iter()
        .filter(|raw| parse_deep_link(raw).is_some_and(|link| link.names_a_conversation()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use sea_orm::{ActiveModelTrait, EntityTrait, Set};

    /// Held by every test that parks or takes, for as long as it does: the
    /// slots are process-global, and tests run side by side. Both slots are
    /// empty when it is handed out.
    fn hold_slots() -> std::sync::MutexGuard<'static, ()> {
        static SLOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
        // A failing test poisons it on its way out; the slots are emptied
        // here regardless, so the next test can go ahead.
        let guard = SLOTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        PENDING_LINKS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        let _ = take_pending_harness_link();
        guard
    }

    fn harness_link(item_ref: &str) -> Option<DeepLink> {
        Some(DeepLink::Harness {
            item_ref: item_ref.into(),
        })
    }

    /// `codeg://harness/install?<query>`, parsed.
    fn install_link(query: &str) -> Option<DeepLink> {
        parse_deep_link(&format!("codeg://harness/install?{query}"))
    }

    #[test]
    fn parses_session_numeric_id() {
        assert_eq!(
            parse_deep_link("codeg://session/214"),
            Some(DeepLink::Session {
                session_ref: "214".into(),
                server: None,
            })
        );
        assert_eq!(
            parse_deep_link("codeg:session/214"),
            Some(DeepLink::Session {
                session_ref: "214".into(),
                server: None,
            })
        );
        assert_eq!(
            parse_deep_link("codeg://session/214/"),
            Some(DeepLink::Session {
                session_ref: "214".into(),
                server: None,
            })
        );
    }

    #[test]
    fn parses_session_external_id() {
        assert_eq!(
            parse_deep_link("codeg://session/0193c0de-aaaa-7bbb-8ccc-ddddeeeeffff"),
            Some(DeepLink::Session {
                session_ref: "0193c0de-aaaa-7bbb-8ccc-ddddeeeeffff".into(),
                server: None,
            })
        );
        assert_eq!(
            parse_deep_link("codeg://session/codex_abc%20123"),
            Some(DeepLink::Session {
                session_ref: "codex_abc 123".into(),
                server: None,
            })
        );
    }

    /// The `url` crate lower-cases a URL's host before `event.urls()` hands it
    /// over, but an argv-delivered link keeps the caller's casing, so the
    /// `session` segment must match either way. The ref after it must not — an
    /// `external_id` is an opaque token.
    #[test]
    fn session_segment_is_case_insensitive_but_the_ref_is_not() {
        for raw in [
            "codeg://SESSION/Codex_AbC",
            "codeg://Session/Codex_AbC",
            "codeg://sEsSiOn/Codex_AbC",
        ] {
            assert_eq!(
                parse_deep_link(raw),
                Some(DeepLink::Session {
                    session_ref: "Codex_AbC".into(),
                    server: None,
                }),
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_and_in_app_badges() {
        assert_eq!(parse_deep_link("codeg://session/../etc/passwd"), None);
        assert_eq!(parse_deep_link("codeg://session/"), None);
        assert_eq!(parse_deep_link("codeg://agent/grok"), None);
        assert_eq!(parse_deep_link("codeg://commit/abc"), None);
        assert_eq!(parse_deep_link("https://example.com/session/1"), None);
    }

    #[test]
    fn parses_open_and_workspace_query() {
        assert_eq!(parse_deep_link("codeg://"), Some(DeepLink::Open));
        assert_eq!(parse_deep_link("codeg://open"), Some(DeepLink::Open));
        assert_eq!(
            parse_deep_link("codeg://workspace?conversationId=9&folderId=3&agent=grok"),
            Some(DeepLink::Workspace {
                folder_id: Some(3),
                conversation_id: 9,
                agent: Some("grok".into()),
                server: None,
            })
        );
        assert_eq!(
            parse_deep_link("codeg://workspace?conversationId=9"),
            Some(DeepLink::Workspace {
                folder_id: None,
                conversation_id: 9,
                agent: None,
                server: None,
            })
        );
        assert_eq!(parse_deep_link("codeg://workspace"), None);
    }

    #[test]
    fn argv_keeps_only_codeg_urls() {
        let argv = [
            "/Applications/codeg.app/Contents/MacOS/codeg",
            "codeg://session/12",
            "--flag",
        ];
        assert_eq!(
            urls_from_argv(&argv),
            vec!["codeg://session/12".to_string()]
        );
    }

    #[tokio::test]
    async fn resolves_numeric_and_external_ids() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        let by_pk = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: id.to_string(),
                server: None,
            },
        )
        .await
        .expect("lookup pk");
        assert_eq!(
            by_pk,
            Some(FocusTarget {
                folder_id: folder,
                conversation_id: id,
                agent: "grok".into(),
            })
        );

        let mut active: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("load")
                .expect("row")
                .into();
        active.external_id = Set(Some("grok-session-uuid".into()));
        active.update(&db.conn).await.expect("set external_id");

        let by_ext = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: "grok-session-uuid".into(),
                server: None,
            },
        )
        .await
        .expect("lookup external");
        assert_eq!(by_ext.as_ref().map(|t| t.conversation_id), Some(id));

        let missing = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: "999999".into(),
                server: None,
            },
        )
        .await
        .expect("missing");
        assert_eq!(missing, None);
    }

    /// Nothing stops an agent from issuing all-digit session ids, so an
    /// all-digit ref that matches no live primary key must still be tried as
    /// an `external_id` rather than reported as a dead link.
    #[tokio::test]
    async fn numeric_ref_falls_back_to_external_id() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-numeric").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;

        // An external id that can never collide with a live PK.
        let external = "90210";
        assert_ne!(external.parse::<i32>().ok(), Some(id));
        let mut active: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("load")
                .expect("row")
                .into();
        active.external_id = Set(Some(external.into()));
        active.update(&db.conn).await.expect("set external_id");

        let resolved = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: external.into(),
                server: None,
            },
        )
        .await
        .expect("lookup numeric external");
        assert_eq!(resolved.as_ref().map(|t| t.conversation_id), Some(id));
    }

    /// The parked-target handoff that carries a macOS cold start, where the
    /// `workspace://focus-conversation` emit lands before the webview listens.
    /// Under [`hold_slots`]: `PENDING_FOCUS` is process-global.
    #[test]
    fn pending_focus_is_taken_exactly_once() {
        let _slots = hold_slots();
        assert_eq!(take_pending_link(LOCAL_WINDOW), None);
        let target = PendingLink::Focus(FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "grok".into(),
        });
        park_link(LOCAL_WINDOW, target.clone());
        assert_eq!(take_pending_link(LOCAL_WINDOW), Some(target));
        assert_eq!(take_pending_link(LOCAL_WINDOW), None);
    }

    #[test]
    fn pending_focus_serializes_like_the_focus_event() {
        let json = serde_json::to_value(FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "claude_code".into(),
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "folderId": 3,
                "conversationId": 9,
                "agent": "claude_code",
            })
        );
    }

    #[tokio::test]
    async fn startup_link_resolves_the_first_session_url_only() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-startup").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        assert_eq!(startup_link_path(&db, &[]).await, None);
        assert_eq!(startup_link_path(&db, &["codeg://open".into()]).await, None);
        assert_eq!(
            startup_link_path(&db, &["codeg://session/999999".into()]).await,
            None
        );
        let path = startup_link_path(
            &db,
            &[
                "--some-flag".into(),
                "codeg://open".into(),
                format!("codeg://session/{id}"),
            ],
        )
        .await
        .expect("the session url resolves");
        assert_eq!(
            path,
            format!("workspace?folderId={folder}&conversationId={id}&agent=grok")
        );
    }

    #[tokio::test]
    async fn workspace_query_fills_agent_and_rejects_mismatch() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-ws").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        let filled = resolve_deep_link(
            &db,
            &DeepLink::Workspace {
                folder_id: None,
                conversation_id: id,
                agent: None,
                server: None,
            },
        )
        .await
        .expect("fill");
        assert_eq!(filled.unwrap().agent, "grok");

        let mismatch = resolve_deep_link(
            &db,
            &DeepLink::Workspace {
                folder_id: None,
                conversation_id: id,
                agent: Some("codex".into()),
                server: None,
            },
        )
        .await
        .expect("mismatch");
        assert_eq!(mismatch, None);
    }

    #[test]
    fn workspace_path_encodes_query() {
        let path = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "claude_code".into(),
        }
        .workspace_path();
        assert_eq!(
            path,
            "workspace?folderId=3&conversationId=9&agent=claude_code"
        );
    }

    #[test]
    fn parses_a_harness_install_link() {
        for raw in [
            "codeg://harness/install?ref=acme/pdf-tools",
            "codeg:harness/install?ref=acme/pdf-tools",
            "codeg:///harness/install?ref=acme/pdf-tools",
            "codeg://harness/install/?ref=acme/pdf-tools",
            "codeg://harness/install?ref=acme/pdf-tools#readme",
            // The route is matched in any case, as `session` is.
            "codeg://HARNESS/Install?ref=acme/pdf-tools",
        ] {
            assert_eq!(
                parse_deep_link(raw),
                harness_link("acme/pdf-tools"),
                "{raw}"
            );
        }
        // After its first character a publisher may hold dots, as a domain
        // does; `a..` is one publisher, not a path segment.
        for good in ["a/b", "0x/1-2-3", "browser-use.com/browser-use", "a../b"] {
            assert_eq!(
                install_link(&format!("ref={good}")),
                harness_link(good),
                "{good}"
            );
        }
        let longest = format!("{}/{}", "a".repeat(253), "b".repeat(64));
        assert_eq!(
            install_link(&format!("ref={longest}")),
            harness_link(&longest)
        );
    }

    /// Case for case, `parseItemRef`'s own tests (`item-ref.test.ts`), and
    /// where `trim` differs between the two languages.
    #[test]
    fn an_item_address_is_read_as_parse_item_ref_reads_it() {
        for good in [
            "anthropics/pdf",
            "browser-use.com/browser-use",
            "a/b",
            "0x/1-2-3",
        ] {
            assert_eq!(parse_item_ref(good).as_deref(), Some(good));
        }
        assert_eq!(
            parse_item_ref("  Anthropics/PDF \n").as_deref(),
            Some("anthropics/pdf")
        );
        let longest = format!("{}/{}", "a".repeat(253), "b".repeat(64));
        assert_eq!(parse_item_ref(&longest).as_deref(), Some(longest.as_str()));

        let too_long_name = format!("anthropics/{}", "a".repeat(65));
        let too_long_publisher = format!("{}/pdf", "a".repeat(254));
        for bad in [
            "",
            "pdf",
            "/pdf",
            "anthropics/",
            "anthropics/pdf/extra",
            "anthropics/pdf tools",
            "anthropics/pdf_tools",
            "-anthropics/pdf",
            ".anthropics/pdf",
            "anthropics//pdf",
            "anthropics/pdf?x=1",
            "anthropics/pdf#top",
            "https://spacering.net/harness/anthropics/pdf",
            "../../other/name",
            too_long_name.as_str(),
            too_long_publisher.as_str(),
            "用户/技能",
        ] {
            assert_eq!(parse_item_ref(bad), None, "{bad:?}");
        }

        // JavaScript's `trim` takes the byte-order mark and leaves NEL, which
        // Rust's `trim` does the other way round.
        assert_eq!(
            parse_item_ref("\u{feff}anthropics/pdf\u{feff}").as_deref(),
            Some("anthropics/pdf")
        );
        assert_eq!(parse_item_ref("\u{85}anthropics/pdf"), None);
        assert_eq!(parse_item_ref("anthropics/pdf\u{85}"), None);
    }

    /// `ref` is a query value, decoded as `URLSearchParams` decodes the Web
    /// address's `?harness=`.
    #[test]
    fn a_harness_ref_is_decoded_like_a_query_value() {
        for query in [
            "ref=acme%2Fpdf-tools",
            "ref=%61cme%2fpdf%2Dtools",
            "r%65f=acme/pdf-tools",
            // `+` is a space, and surrounding space is forgiven as
            // `parseItemRef` forgives it.
            "ref=+acme/pdf-tools+",
            "ref=%20%09acme/pdf-tools%0A",
            "ref=%E2%80%83acme/pdf-tools%E3%80%80",
            "ref=%EF%BB%BFacme/pdf-tools",
        ] {
            assert_eq!(
                install_link(query),
                harness_link("acme/pdf-tools"),
                "{query}"
            );
        }
    }

    #[test]
    fn other_parameters_are_ignored() {
        for query in [
            "ref=acme/pdf-tools&intent=install",
            "utm_source=spacering&ref=acme/pdf-tools&utm_medium=web",
            "&ref=acme/pdf-tools&&",
            // The first `ref` is the one read, as `URLSearchParams.get` has it…
            "ref=acme/pdf-tools&ref=other/thing",
        ] {
            assert_eq!(
                install_link(query),
                harness_link("acme/pdf-tools"),
                "{query}"
            );
        }
        // …even when it is not an address.
        assert_eq!(
            install_link("ref=nothing&ref=acme/pdf-tools"),
            Some(DeepLink::Open)
        );
    }

    /// `parseItemRef` forgives capitals, so a link with them opens the item,
    /// under its canonical lower-case address: no other form is ever parked.
    /// Not forgiven: a capital that does not lower-case to ASCII, or the
    /// parameter's name in capitals (`URLSearchParams` is case-sensitive).
    #[test]
    fn capitals_in_a_harness_ref_come_out_lower_case() {
        for query in ["ref=Acme/PDF-Tools", "ref=ACME%2FPDF-TOOLS"] {
            assert_eq!(
                install_link(query),
                harness_link("acme/pdf-tools"),
                "{query}"
            );
        }
        // As in JavaScript, where `"\u212A".toLowerCase()` is `"k"`.
        assert_eq!(install_link("ref=%E2%84%AAit/x"), harness_link("kit/x"));
        for query in [
            "REF=acme/pdf-tools",
            "Ref=acme/pdf-tools",
            // Fullwidth `Ａ` lower-cases to fullwidth `ａ`, and `İ` to `i̇`.
            "ref=%EF%BC%A1cme/pdf-tools",
            "ref=%C4%B0cme/pdf-tools",
        ] {
            assert_eq!(install_link(query), Some(DeepLink::Open), "{query}");
        }
    }

    /// A Harness link that names no item only shows the workspace.
    #[test]
    fn a_harness_link_without_an_item_address_is_codeg_open() {
        let too_long_publisher = format!("ref={}/b", "a".repeat(254));
        let too_long_name = format!("ref=a/{}", "b".repeat(65));
        for query in [
            "",
            "ref",
            "ref=",
            "ref=+",
            "intent=install",
            "ref=acme",
            "ref=/",
            "ref=/pdf-tools",
            "ref=acme/",
            "ref=acme//pdf-tools",
            "ref=acme/pdf-tools/",
            "ref=acme/pdf-tools/extra",
            "ref=.acme/pdf-tools",
            "ref=-acme/pdf-tools",
            "ref=acme/pdf.tools",
            "ref=acme/pdf_tools",
            "ref=acme/pdf%20tools",
            "ref=acme/pdf+tools",
            "ref=acme/pdf-tools%00",
            "ref=ac%25me/pdf-tools",
            "ref=%FF/pdf-tools",
            "ref=acme/pdf-tools%3Fv%3D2",
            "ref=%C2%85acme/pdf-tools",
            "ref=https://spacering.net/harness/acme/pdf-tools",
            too_long_publisher.as_str(),
            too_long_name.as_str(),
        ] {
            assert_eq!(install_link(query), Some(DeepLink::Open), "{query:?}");
        }
        for raw in [
            "codeg://harness",
            "codeg://harness/",
            "codeg://harness/install",
            "codeg://harness/uninstall?ref=acme/pdf-tools",
            "codeg://harness/install/now?ref=acme/pdf-tools",
            "codeg://harness/acme/pdf-tools",
        ] {
            assert_eq!(parse_deep_link(raw), Some(DeepLink::Open), "{raw}");
        }
    }

    #[test]
    fn path_tricks_in_a_harness_ref_are_refused() {
        for query in [
            "ref=../pdf-tools",
            "ref=./pdf-tools",
            "ref=acme/..",
            "ref=acme/.",
            "ref=acme/../pdf-tools",
            "ref=acme/pdf-tools/../other",
            "ref=..%2F..%2Fetc%2Fpasswd",
            "ref=%2e%2e/pdf-tools",
            "ref=acme/%2E%2E",
            "ref=%2Facme/pdf-tools",
            "ref=acme%2F%2Fpdf-tools",
            "ref=acme%5Cpdf-tools",
            "ref=acme\\pdf-tools",
            "ref=acme/pdf-tools%5C..",
            "ref=~/pdf-tools",
            "ref=c:%5Cacme/pdf-tools",
            "ref=acme/pdf-tools%23readme",
        ] {
            assert_eq!(install_link(query), Some(DeepLink::Open), "{query}");
        }
    }

    /// A Windows/Linux second launch reaches the handler only through
    /// `urls_from_argv`, and whether a launch shows the local window is the
    /// same `parse_deep_link(..).is_some()` (`load_restore` in `lib.rs`). A
    /// Harness link must get through both, naming an item or not, or the main
    /// window would not come forward for it.
    #[test]
    fn harness_links_get_through_the_argv_and_restore_filters() {
        let valid = "codeg://harness/install?ref=acme/pdf-tools";
        let invalid = "codeg://harness/install?ref=not-an-address";
        let argv = [r"C:\Program Files\Codeg\codeg.exe", valid, "--flag"];
        assert_eq!(urls_from_argv(&argv), vec![valid.to_string()]);
        let argv = ["/usr/bin/codeg", invalid];
        assert_eq!(urls_from_argv(&argv), vec![invalid.to_string()]);
        assert!(parse_deep_link(valid).is_some());
        assert!(parse_deep_link(invalid).is_some());
    }

    #[test]
    fn the_harness_slot_is_claimed_once_and_the_newest_link_wins() {
        let _slots = hold_slots();
        assert_eq!(take_pending_harness_link(), None);

        assert!(park_harness_links(&[
            "codeg://harness/install?ref=Acme/PDF-Tools".into()
        ]));
        assert_eq!(
            take_pending_harness_link().as_deref(),
            Some("acme/pdf-tools")
        );
        assert_eq!(take_pending_harness_link(), None);

        // Two links in one delivery, then two deliveries one after the other.
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/first".into(),
            "codeg://harness/install?ref=acme/second".into(),
        ]));
        assert_eq!(take_pending_harness_link().as_deref(), Some("acme/second"));
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/first".into()
        ]));
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/second".into()
        ]));
        assert_eq!(take_pending_harness_link().as_deref(), Some("acme/second"));
        assert_eq!(take_pending_harness_link(), None);

        // A link that names no item parks nothing, and leaves a waiting one be.
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/waiting".into()
        ]));
        assert!(!park_harness_links(&[
            "codeg://harness/install?ref=../other".into(),
            "codeg://open".into(),
            "codeg://session/9".into(),
            "https://example.com/harness/install?ref=acme/other".into(),
        ]));
        assert_eq!(take_pending_harness_link().as_deref(), Some("acme/waiting"));
        assert_eq!(take_pending_harness_link(), None);
    }

    #[test]
    fn the_harness_slot_and_the_conversation_slot_are_apart() {
        let _slots = hold_slots();
        let target = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "grok".into(),
        };

        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/pdf-tools".into()
        ]));
        assert_eq!(take_pending_link(LOCAL_WINDOW), None);
        park_link(LOCAL_WINDOW, PendingLink::Focus(target.clone()));
        assert_eq!(
            take_pending_harness_link().as_deref(),
            Some("acme/pdf-tools")
        );
        assert_eq!(take_pending_harness_link(), None);
        assert_eq!(
            take_pending_link(LOCAL_WINDOW),
            Some(PendingLink::Focus(target.clone()))
        );

        // The other way round: a parked conversation is no Harness link.
        park_link(LOCAL_WINDOW, PendingLink::Focus(target.clone()));
        assert_eq!(take_pending_harness_link(), None);
        assert_eq!(
            take_pending_link(LOCAL_WINDOW),
            Some(PendingLink::Focus(target))
        );
    }

    /// The Windows/Linux cold start: the window starts on the Web address,
    /// encoded so that `URLSearchParams` hands `HarnessLinkBootstrap` the ref
    /// back, and nothing is parked besides — a slot claimed after the address
    /// was read would open the item a second time.
    ///
    /// Not a `tokio::test`: the slots stay held across the awaits, and a lock
    /// held inside async code is what clippy's `await_holding_lock` refuses.
    /// Held out here, it is not.
    #[test]
    fn a_cold_start_harness_link_is_in_the_startup_path_only() {
        let _slots = hold_slots();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (path, invalid, after_a_dead_session) = runtime.block_on(async {
            let db = fresh_in_memory_db().await;
            let path = startup_workspace_path(
                &db,
                &["codeg://harness/install?ref=Acme%2FPDF-Tools&utm_source=spacering".into()],
            )
            .await;
            let invalid =
                startup_workspace_path(&db, &["codeg://harness/install?ref=../other".into()]).await;
            let after_a_dead_session = startup_workspace_path(
                &db,
                &[
                    "codeg://session/999999".into(),
                    "codeg://harness/install?ref=acme/pdf-tools".into(),
                ],
            )
            .await;
            (path, invalid, after_a_dead_session)
        });

        assert_eq!(path, "workspace?harness=acme%2Fpdf-tools");
        let (_, query) = path.split_once('?').expect("a query");
        let read_back: Vec<String> = url::form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == "harness")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(read_back, ["acme/pdf-tools"]);
        assert_eq!(
            harness_workspace_path("example.com/notes-mcp"),
            "workspace?harness=example.com%2Fnotes-mcp"
        );

        // Like `codeg://open`: the plain workspace.
        assert_eq!(invalid, "workspace");
        assert_eq!(after_a_dead_session, "workspace?harness=acme%2Fpdf-tools");

        assert_eq!(take_pending_harness_link(), None);
    }

    // ── Servers ──────────────────────────────────────────────────────────────

    const BOX_ID: &str = "0123456789abcdef";
    const MAC_ID: &str = "fedcba9876543210";
    const BOX_URL: &str = "http://johnnyss-macbook-pro.tailfa9991.ts.net:3080";

    fn on_server(session_ref: &str, server: Option<&str>) -> Option<DeepLink> {
        Some(DeepLink::Session {
            session_ref: session_ref.into(),
            server: server.map(str::to_string),
        })
    }

    fn identity(instance_id: &str, name: &str) -> InstanceIdentity {
        InstanceIdentity {
            instance_id: instance_id.into(),
            name: name.into(),
        }
    }

    fn the_box(identity: Option<InstanceIdentity>) -> KnownServer {
        KnownServer {
            connection_id: 1,
            name: "Johnnysclawd".into(),
            base_url: BOX_URL.into(),
            identity,
        }
    }

    #[test]
    fn a_session_link_may_name_its_server() {
        assert_eq!(
            parse_deep_link(&format!("codeg://session/319?server={BOX_ID}")),
            on_server("319", Some(BOX_ID))
        );
        assert_eq!(
            parse_deep_link("codeg://session/319/?server=Johnnysclawd#top"),
            on_server("319", Some("Johnnysclawd"))
        );
        // `codeg:` without slashes, and the segment in another case.
        assert_eq!(
            parse_deep_link("codeg:SESSION/codex_AbC?server=box"),
            on_server("codex_AbC", Some("box"))
        );
        // Read as `URLSearchParams` reads it: decoded, `+` a space, trimmed,
        // the first `server`, every other parameter ignored.
        for query in [
            "server=My%20Box",
            "server=My+Box",
            "server=+My+Box+",
            "utm_source=notes&server=My%20Box&x",
            "server=My%20Box&server=Other",
            "s%65rver=My%20Box",
        ] {
            assert_eq!(
                parse_deep_link(&format!("codeg://session/7?{query}")),
                on_server("7", Some("My Box")),
                "{query}"
            );
        }
    }

    #[test]
    fn an_empty_server_is_no_server() {
        for raw in [
            "codeg://session/7?server=",
            "codeg://session/7?server=%20%20",
            "codeg://session/7?server",
            "codeg://session/7?",
            "codeg://session/7?Server=box",
        ] {
            assert_eq!(parse_deep_link(raw), on_server("7", None), "{raw}");
        }
    }

    /// A value that cannot name a server still shows the workspace; a ref that
    /// cannot be one is still no link at all.
    #[test]
    fn a_junk_server_only_opens_the_workspace() {
        let too_long = format!("codeg://session/7?server={}", "a".repeat(256));
        let longest = format!("codeg://session/7?server={}", "a".repeat(255));
        for raw in [
            "codeg://session/7?server=box%07",
            "codeg://session/7?server=a%0Ab",
            "codeg://workspace?conversationId=7&server=%00",
            too_long.as_str(),
        ] {
            assert_eq!(parse_deep_link(raw), Some(DeepLink::Open), "{raw}");
        }
        assert_eq!(
            parse_deep_link(&longest),
            on_server("7", Some("a".repeat(255).as_str()))
        );
        assert_eq!(parse_deep_link("codeg://session/../x?server=box"), None);
        assert_eq!(parse_deep_link("codeg://session/?server=box"), None);
        assert_eq!(parse_deep_link("codeg://agent/codex?server=box"), None);
        // A Harness link has no server.
        assert_eq!(
            parse_deep_link("codeg://harness/install?ref=acme/pdf-tools&server=box"),
            harness_link("acme/pdf-tools")
        );
    }

    #[test]
    fn a_workspace_link_may_name_its_server() {
        assert_eq!(
            parse_deep_link(&format!(
                "codeg://workspace?conversationId=9&folderId=3&agent=grok&server={BOX_ID}"
            )),
            Some(DeepLink::Workspace {
                folder_id: Some(3),
                conversation_id: 9,
                agent: Some("grok".into()),
                server: Some(BOX_ID.into()),
            })
        );
        assert_eq!(
            parse_deep_link("codeg://workspace?server=box")
                .map(|link| link.server().map(String::from)),
            None,
            "still needs a conversation"
        );
    }

    #[test]
    fn links_are_written_with_their_server() {
        assert_eq!(
            session_link_on(42, Some(BOX_ID)),
            format!("codeg://session/42?server={BOX_ID}")
        );
        assert_eq!(session_link_on(42, None), "codeg://session/42");
        assert_eq!(session_link_on(42, Some("  ")), "codeg://session/42");
        assert_eq!(
            session_link_on(42, Some("My Box/1")),
            "codeg://session/42?server=My%20Box%2F1"
        );
        // What is written reads back as what was meant.
        for server in [Some(BOX_ID), Some("My Box/1"), Some("ünïcode"), None] {
            assert_eq!(
                parse_deep_link(&session_link_on(42, server)),
                on_server("42", server),
                "{server:?}"
            );
        }
        // This instance's links name it once it has an id, and never anything
        // else.
        assert_eq!(
            parse_deep_link(&session_link(42)),
            on_server("42", crate::instance_identity::current_id())
        );
    }

    #[test]
    fn a_server_is_matched_by_id_name_or_host() {
        let local = identity(MAC_ID, "Jonathans-MacBook-Pro");
        let known = [
            KnownServer {
                connection_id: 2,
                name: "Staging".into(),
                base_url: "https://staging.example.com".into(),
                identity: None,
            },
            the_box(Some(identity(BOX_ID, "Johnnyss-MacBook-Pro"))),
        ];
        let remote = ServerMatch::Remote { connection_id: 1 };
        for (wanted, expected) in [
            // Instance ids, any case.
            (MAC_ID, ServerMatch::Local),
            ("FEDCBA9876543210", ServerMatch::Local),
            (BOX_ID, remote),
            // The name a connection was saved under, any case.
            ("Johnnysclawd", remote),
            ("johnnysCLAWD", remote),
            (" Johnnysclawd ", remote),
            ("staging", ServerMatch::Remote { connection_id: 2 }),
            // Its host: alone, with the port, or as the URL.
            ("johnnyss-macbook-pro.tailfa9991.ts.net", remote),
            ("Johnnyss-MacBook-Pro.tailfa9991.ts.net:3080", remote),
            (
                "http://johnnyss-macbook-pro.tailfa9991.ts.net:3080/",
                remote,
            ),
            (
                "staging.example.com",
                ServerMatch::Remote { connection_id: 2 },
            ),
            (
                "https://staging.example.com:443",
                ServerMatch::Remote { connection_id: 2 },
            ),
            // The names instances give themselves.
            ("jonathans-macbook-pro", ServerMatch::Local),
            ("Johnnyss-MacBook-Pro", remote),
            // Nothing that only looks close.
            (
                "johnnyss-macbook-pro.tailfa9991.ts.net:3081",
                ServerMatch::Unknown,
            ),
            (
                "http://johnnyss-macbook-pro.tailfa9991.ts.net/",
                ServerMatch::Unknown,
            ),
            (
                "https://johnnyss-macbook-pro.tailfa9991.ts.net:3080",
                remote,
            ),
            ("johnnyss", ServerMatch::Unknown),
            ("0123456789abcde", ServerMatch::Unknown),
            ("somewhere-else", ServerMatch::Unknown),
        ] {
            assert_eq!(
                match_server(wanted, Some(&local), &known),
                expected,
                "{wanted}"
            );
        }
    }

    /// An instance id outranks every name, and a saved name outranks the name
    /// an instance gives itself: the user's own label for a server is the one
    /// a hand-written link means.
    #[test]
    fn what_identifies_a_server_outright_wins() {
        // This instance calls itself what the box is saved as.
        let local = identity(MAC_ID, "Johnnysclawd");
        let known = [the_box(Some(identity(BOX_ID, "box")))];
        assert_eq!(
            match_server("Johnnysclawd", Some(&local), &known),
            ServerMatch::Remote { connection_id: 1 }
        );
        assert_eq!(
            match_server(MAC_ID, Some(&local), &known),
            ServerMatch::Local
        );
        // A connection saved under this instance's id is still this instance.
        let impostor = KnownServer {
            name: MAC_ID.into(),
            ..the_box(None)
        };
        assert_eq!(
            match_server(MAC_ID, Some(&local), &[impostor]),
            ServerMatch::Local
        );
        // The first of two connections with one name.
        let twins = [
            the_box(None),
            KnownServer {
                connection_id: 5,
                ..the_box(None)
            },
        ];
        assert_eq!(
            match_server("johnnysclawd", None, &twins),
            ServerMatch::Remote { connection_id: 1 }
        );
    }

    #[test]
    fn without_an_identity_only_the_saved_connections_match() {
        let known = [the_box(None)];
        assert_eq!(
            match_server("Johnnysclawd", None, &known),
            ServerMatch::Remote { connection_id: 1 }
        );
        assert_eq!(match_server(BOX_ID, None, &known), ServerMatch::Unknown);
        assert_eq!(match_server(MAC_ID, None, &[]), ServerMatch::Unknown);
    }

    async fn save_the_box(db: &AppDatabase, learned: Option<&InstanceIdentity>) -> i32 {
        let connection = remote_workspace_connection_service::create(
            &db.conn,
            "Johnnysclawd",
            BOX_URL,
            "token",
            &[],
        )
        .await
        .expect("save the box");
        crate::instance_identity::remember_remote_identity(&db.conn, connection.id, learned)
            .await
            .expect("remember");
        connection.id
    }

    #[tokio::test]
    async fn the_saved_connections_carry_what_their_servers_said() {
        let db = fresh_in_memory_db().await;
        let learned = identity(BOX_ID, "Johnnyss-MacBook-Pro");
        let id = save_the_box(&db, Some(&learned)).await;
        let known = known_servers(&db.conn).await.expect("known");
        assert_eq!(
            known,
            [KnownServer {
                connection_id: id,
                name: "Johnnysclawd".into(),
                base_url: BOX_URL.into(),
                identity: Some(learned),
            }]
        );
    }

    #[tokio::test]
    async fn a_link_is_planned_for_the_instance_it_names() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-servers").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;
        let box_id = save_the_box(&db, Some(&identity(BOX_ID, "box"))).await;
        let known = known_servers(&db.conn).await.expect("known");
        let local = identity(MAC_ID, "mac");
        let plan = |raw: String| {
            let db = &db;
            let known = &known;
            let local = &local;
            async move {
                let link = parse_deep_link(&raw).expect("a link");
                plan_link(db, &link, Some(local), known)
                    .await
                    .expect("plan")
            }
        };
        let here = LinkPlan::Local(FocusTarget {
            folder_id: folder,
            conversation_id: id,
            agent: "grok".into(),
        });

        // No server, and this instance's: looked up here.
        assert_eq!(
            plan(format!("codeg://session/{id}")).await,
            Some(here.clone())
        );
        assert_eq!(
            plan(format!("codeg://session/{id}?server={MAC_ID}")).await,
            Some(here.clone())
        );
        assert_eq!(
            plan(format!("codeg://workspace?conversationId={id}&server=MAC")).await,
            Some(here)
        );

        // Missing here: a notice, never another conversation.
        assert_eq!(
            plan("codeg://session/999999".into()).await,
            Some(LinkPlan::Notice(PendingLink::Notice {
                reason: LinkNotice::NotFound,
                server: None,
                session_ref: Some("999999".into()),
            }))
        );

        // The box's: handed to its window as it is, by id or by name — even
        // when the same number is a live conversation here.
        let to_the_box = |session_ref: String, folder_id, agent| {
            Some(LinkPlan::Remote {
                connection_id: box_id,
                pending: PendingLink::Session {
                    session_ref,
                    folder_id,
                    agent,
                    server_name: "Johnnysclawd".into(),
                },
            })
        };
        assert_eq!(
            plan(format!("codeg://session/{id}?server={BOX_ID}")).await,
            to_the_box(id.to_string(), None, None)
        );
        assert_eq!(
            plan("codeg://session/319?server=johnnysclawd".into()).await,
            to_the_box("319".into(), None, None)
        );
        assert_eq!(
            plan(format!(
                "codeg://workspace?conversationId=319&folderId=4&agent=codex&server={BOX_ID}"
            ))
            .await,
            to_the_box("319".into(), Some(4), Some("codex".into()))
        );

        // Anyone else's: a notice naming the server as the link did.
        assert_eq!(
            plan("codeg://session/319?server=Elsewhere".into()).await,
            Some(LinkPlan::Notice(PendingLink::Notice {
                reason: LinkNotice::UnknownServer,
                server: Some("Elsewhere".into()),
                session_ref: Some("319".into()),
            }))
        );

        // Not about a conversation at all.
        assert_eq!(plan("codeg://open".into()).await, None);
        assert_eq!(
            plan("codeg://harness/install?ref=acme/pdf-tools".into()).await,
            None
        );
    }

    #[test]
    fn what_a_window_is_handed_serializes_for_the_bridge() {
        let as_json = |pending: PendingLink| serde_json::to_value(pending).expect("json");
        assert_eq!(
            as_json(PendingLink::Focus(FocusTarget {
                folder_id: 3,
                conversation_id: 9,
                agent: "claude_code".into(),
            })),
            serde_json::json!({
                "kind": "focus",
                "folderId": 3,
                "conversationId": 9,
                "agent": "claude_code",
            })
        );
        assert_eq!(
            as_json(PendingLink::Session {
                session_ref: "319".into(),
                folder_id: None,
                agent: Some("codex".into()),
                server_name: "Johnnysclawd".into(),
            }),
            serde_json::json!({
                "kind": "session",
                "sessionRef": "319",
                "folderId": null,
                "agent": "codex",
                "serverName": "Johnnysclawd",
            })
        );
        assert_eq!(
            as_json(PendingLink::Notice {
                reason: LinkNotice::UnknownServer,
                server: Some("Elsewhere".into()),
                session_ref: Some("319".into()),
            }),
            serde_json::json!({
                "kind": "notice",
                "reason": "unknown_server",
                "server": "Elsewhere",
                "sessionRef": "319",
            })
        );
        assert_eq!(
            as_json(PendingLink::Notice {
                reason: LinkNotice::NotFound,
                server: None,
                session_ref: None,
            })["reason"],
            "not_found"
        );
    }

    /// Each workspace window has a slot of its own: a link for the box's
    /// window is never claimed by the local one, nor the other way round.
    #[test]
    fn each_window_claims_only_its_own_link() {
        let _slots = hold_slots();
        let remote = "remote-workspace-1";
        let for_the_box = PendingLink::Session {
            session_ref: "319".into(),
            folder_id: None,
            agent: None,
            server_name: "Johnnysclawd".into(),
        };
        let notice = PendingLink::Notice {
            reason: LinkNotice::NotFound,
            server: None,
            session_ref: Some("7".into()),
        };
        park_link(remote, for_the_box);
        park_link(LOCAL_WINDOW, notice.clone());
        assert_eq!(take_pending_link("remote-workspace-2"), None);
        assert_eq!(take_pending_link(LOCAL_WINDOW), Some(notice));
        assert_eq!(take_pending_link(LOCAL_WINDOW), None);
        // The newest link for a window replaces one it has not claimed yet.
        park_link(
            remote,
            PendingLink::Session {
                session_ref: "320".into(),
                folder_id: None,
                agent: None,
                server_name: "Johnnysclawd".into(),
            },
        );
        assert!(matches!(
            take_pending_link(remote),
            Some(PendingLink::Session { session_ref, .. }) if session_ref == "320"
        ));
        assert_eq!(take_pending_link(remote), None);
    }

    /// A cold start's link for another server, or to no live conversation, does
    /// not start the main window on it; it is handed on once the windows are
    /// up, unless something did start the main window.
    #[tokio::test]
    async fn a_startup_link_for_another_server_is_handed_on() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-startup-servers").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;
        save_the_box(&db, None).await;

        let remote = vec![
            "--flag".to_string(),
            "codeg://open".to_string(),
            format!("codeg://session/{id}?server=Johnnysclawd"),
        ];
        let path = startup_link_path(&db, &remote).await;
        assert_eq!(path, None);
        assert_eq!(
            startup_links_left_over(&remote, path.as_deref()),
            [format!("codeg://session/{id}?server=Johnnysclawd")]
        );

        let local = vec![format!("codeg://session/{id}")];
        let path = startup_link_path(&db, &local).await;
        assert_eq!(
            path.as_deref(),
            Some(format!("workspace?folderId={folder}&conversationId={id}&agent=grok").as_str())
        );
        assert!(startup_links_left_over(&local, path.as_deref()).is_empty());

        let dead = vec!["codeg://session/999999".to_string()];
        assert_eq!(startup_link_path(&db, &dead).await, None);
        assert_eq!(startup_links_left_over(&dead, None), dead);
    }

    #[tokio::test]
    async fn a_session_is_resolved_for_a_window_that_asks() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-resolve").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let found = resolve_session_link_core(&db, &id.to_string(), None, None)
            .await
            .expect("resolve");
        assert_eq!(
            found,
            Some(FocusTarget {
                folder_id: folder,
                conversation_id: id,
                agent: "codex".into(),
            })
        );
        assert_eq!(
            resolve_session_link_core(&db, &id.to_string(), Some(folder), Some("codex"))
                .await
                .expect("matching"),
            found
        );
        for (folder_id, agent) in [(Some(folder + 1), None), (None, Some("grok"))] {
            assert_eq!(
                resolve_session_link_core(&db, &id.to_string(), folder_id, agent)
                    .await
                    .expect("mismatch"),
                None
            );
        }
        assert_eq!(
            resolve_session_link_core(&db, "999999", None, None)
                .await
                .expect("missing"),
            None
        );
    }
}
