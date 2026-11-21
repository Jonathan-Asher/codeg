//! The pure half of the menu-bar attention: which sessions wait on the user
//! across this instance and every saved remote connection, one entry per
//! session, and what the tray icon, its menu and the Dock badge should show
//! for them. No I/O here — the runtime (`super`) feeds it and applies what it
//! decides, and the tests drive it directly.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::system::AppLocale;
use crate::pending::{PendingItem, PendingKind};

/// Longest session title a menu entry shows, in characters.
const MAX_TITLE_CHARS: usize = 48;

/// One item waiting on the user, as the tray needs it: from this instance's
/// pending list, or from a remote server's `list_pending_items` answer (its
/// other fields are ignored, so a newer server's additions do no harm).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WaitingItem {
    /// The session to open: itself, or the top of a delegation chain.
    pub root_conversation_id: i32,
    pub kind: PendingKind,
    #[serde(default)]
    pub title: Option<String>,
    pub asked_at: DateTime<Utc>,
}

impl From<&PendingItem> for WaitingItem {
    fn from(item: &PendingItem) -> Self {
        Self {
            root_conversation_id: item.root_conversation_id,
            kind: item.kind,
            title: item.title.clone(),
            asked_at: item.asked_at,
        }
    }
}

/// A remote server's answer to `list_pending_items`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct RemoteSnapshot {
    #[serde(default)]
    pub items: Vec<WaitingItem>,
}

/// What one saved connection's server last said waits on the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSource {
    pub connection_id: i32,
    /// The name the connection was saved under: what the menu calls it.
    pub name: String,
    /// The instance id its server gave (`instance_identity`), when it did.
    pub instance_id: Option<String>,
    pub items: Vec<WaitingItem>,
}

/// Where a waiting session lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Origin {
    Local,
    Remote { connection_id: i32 },
}

/// One session waiting on the user. A session with several things waiting
/// (a permission and a question, or a sub-agent's question beside its
/// parent's) is one entry: the strongest kind, the earliest ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitingSession {
    pub origin: Origin,
    /// The saved connection's name; `None` for this instance.
    pub server: Option<String>,
    pub conversation_id: i32,
    pub title: Option<String>,
    pub kind: PendingKind,
    pub since: DateTime<Utc>,
    /// The `codeg://session/…` link that opens it in the right window.
    pub link: String,
}

/// Permission outranks a question, which outranks a plan — the order the
/// sidebar uses (`AttentionKind`).
pub fn kind_rank(kind: PendingKind) -> u8 {
    match kind {
        PendingKind::Permission => 3,
        PendingKind::Question => 2,
        PendingKind::Plan => 1,
    }
}

/// Fold this instance's items and every remote's into one entry per waiting
/// session, oldest first.
///
/// Counted once each:
/// - a remote whose server is this instance (a connection saved to itself)
///   adds nothing: the local list has its sessions already;
/// - two connections to the same server (saved twice, under two addresses)
///   count it once, under the first in the saved order;
/// - several items of one session are one entry.
pub fn waiting_sessions(
    local_instance: Option<&str>,
    local: &[WaitingItem],
    remotes: &[RemoteSource],
) -> Vec<WaitingSession> {
    let mut by_key: HashMap<(Origin, i32), WaitingSession> = HashMap::new();
    let mut add =
        |origin: Origin, server: Option<&str>, link_server: Option<&str>, item: &WaitingItem| {
            let key = (origin, item.root_conversation_id);
            let title = item
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string);
            match by_key.get_mut(&key) {
                Some(entry) => {
                    if kind_rank(item.kind) > kind_rank(entry.kind) {
                        entry.kind = item.kind;
                    }
                    if item.asked_at < entry.since {
                        entry.since = item.asked_at;
                    }
                    if entry.title.is_none() {
                        entry.title = title;
                    }
                }
                None => {
                    by_key.insert(
                        key,
                        WaitingSession {
                            origin,
                            server: server.map(str::to_string),
                            conversation_id: item.root_conversation_id,
                            title,
                            kind: item.kind,
                            since: item.asked_at,
                            link: crate::deep_link::session_link_on(
                                item.root_conversation_id,
                                link_server,
                            ),
                        },
                    );
                }
            }
        };

    for item in local {
        add(Origin::Local, None, local_instance, item);
    }
    let mut seen_servers: HashSet<String> = HashSet::new();
    if let Some(local_instance) = local_instance {
        seen_servers.insert(local_instance.to_ascii_lowercase());
    }
    for remote in remotes {
        if let Some(instance_id) = remote.instance_id.as_deref() {
            if !seen_servers.insert(instance_id.to_ascii_lowercase()) {
                continue;
            }
        }
        // The link names the server by what identifies it outright, or else
        // by the connection's saved name (`deep_link::match_server`).
        let link_server = remote.instance_id.as_deref().unwrap_or(&remote.name);
        let origin = Origin::Remote {
            connection_id: remote.connection_id,
        };
        for item in &remote.items {
            add(origin, Some(remote.name.as_str()), Some(link_server), item);
        }
    }

    let mut out: Vec<WaitingSession> = by_key.into_values().collect();
    out.sort_by(|a, b| {
        a.since
            .cmp(&b.since)
            .then_with(|| origin_order(a.origin).cmp(&origin_order(b.origin)))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    out
}

fn origin_order(origin: Origin) -> (u8, i32) {
    match origin {
        Origin::Local => (0, 0),
        Origin::Remote { connection_id } => (1, connection_id),
    }
}

// ── What the tray shows ──

/// The tray's words, in the app's language. The kind names and the header
/// match the "Waiting for you" list (`PendingItems` in the frontend).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttentionLabels {
    /// `{count}` is replaced.
    pub header: &'static str,
    pub permission: &'static str,
    pub question: &'static str,
    pub plan: &'static str,
    pub untitled: &'static str,
    /// What the menu calls this instance.
    pub this_computer: &'static str,
}

pub fn labels_for(locale: AppLocale) -> AttentionLabels {
    match locale {
        AppLocale::ZhCn => AttentionLabels {
            header: "等你处理（{count}）",
            permission: "授权",
            question: "问题",
            plan: "计划",
            untitled: "未命名会话",
            this_computer: "本机",
        },
        AppLocale::ZhTw => AttentionLabels {
            header: "等你處理（{count}）",
            permission: "授權",
            question: "問題",
            plan: "計畫",
            untitled: "未命名對話",
            this_computer: "本機",
        },
        AppLocale::Ja => AttentionLabels {
            header: "対応待ち（{count}）",
            permission: "許可",
            question: "質問",
            plan: "計画",
            untitled: "無題のセッション",
            this_computer: "このコンピュータ",
        },
        AppLocale::Ko => AttentionLabels {
            header: "응답 대기 ({count})",
            permission: "권한",
            question: "질문",
            plan: "계획",
            untitled: "제목 없는 세션",
            this_computer: "이 컴퓨터",
        },
        AppLocale::Es => AttentionLabels {
            header: "Esperándote ({count})",
            permission: "Permiso",
            question: "Pregunta",
            plan: "Plan",
            untitled: "Sesión sin título",
            this_computer: "Este equipo",
        },
        AppLocale::De => AttentionLabels {
            header: "Wartet auf dich ({count})",
            permission: "Berechtigung",
            question: "Frage",
            plan: "Plan",
            untitled: "Unbenannte Sitzung",
            this_computer: "Dieser Computer",
        },
        AppLocale::Fr => AttentionLabels {
            header: "En attente de vous ({count})",
            permission: "Autorisation",
            question: "Question",
            plan: "Plan",
            untitled: "Session sans titre",
            this_computer: "Cet ordinateur",
        },
        AppLocale::Pt => AttentionLabels {
            header: "Aguardando você ({count})",
            permission: "Permissão",
            question: "Pergunta",
            plan: "Plano",
            untitled: "Sessão sem título",
            this_computer: "Este computador",
        },
        AppLocale::Ar => AttentionLabels {
            header: "بانتظارك ({count})",
            permission: "إذن",
            question: "سؤال",
            plan: "خطة",
            untitled: "جلسة بلا عنوان",
            this_computer: "هذا الحاسوب",
        },
        AppLocale::En => AttentionLabels {
            header: "Waiting for you ({count})",
            permission: "Permission",
            question: "Question",
            plan: "Plan",
            untitled: "Untitled session",
            this_computer: "This computer",
        },
    }
}

/// One menu entry: what it says, and the link a click opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayEntry {
    pub label: String,
    pub link: String,
}

/// Everything the tray icon, its menu and the Dock badge show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrayView {
    /// Sessions waiting on the user: the badge and the icon's title.
    pub count: usize,
    /// The menu's header (`Waiting for you (N)`); `None` when nothing waits.
    pub header: Option<String>,
    pub entries: Vec<TrayEntry>,
}

impl TrayView {
    pub fn waiting(&self) -> bool {
        self.count > 0
    }

    /// The Dock badge: the count, or none.
    pub fn badge(&self) -> Option<i64> {
        self.waiting().then_some(self.count as i64)
    }

    /// The icon's tooltip.
    pub fn tooltip(&self) -> String {
        match &self.header {
            Some(header) => format!("Codeg — {header}"),
            None => "Codeg".to_string(),
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// `Question · Fix the login bug — Johnnysclawd`: what waits, the session,
/// and where it lives.
pub fn entry_label(session: &WaitingSession, labels: &AttentionLabels) -> String {
    let kind = match session.kind {
        PendingKind::Permission => labels.permission,
        PendingKind::Question => labels.question,
        PendingKind::Plan => labels.plan,
    };
    let title = session
        .title
        .as_deref()
        .map(|t| clip(t, MAX_TITLE_CHARS))
        .unwrap_or_else(|| labels.untitled.to_string());
    let server = session.server.as_deref().unwrap_or(labels.this_computer);
    format!("{kind} · {title} — {server}")
}

pub fn tray_view(sessions: &[WaitingSession], labels: &AttentionLabels) -> TrayView {
    if sessions.is_empty() {
        return TrayView::default();
    }
    TrayView {
        count: sessions.len(),
        header: Some(
            labels
                .header
                .replace("{count}", &sessions.len().to_string()),
        ),
        entries: sessions
            .iter()
            .map(|session| TrayEntry {
                label: entry_label(session, labels),
                link: session.link.clone(),
            })
            .collect(),
    }
}

/// What has to change on the tray icon to go from `shown` (`None`: nothing
/// applied yet) to `next`. Each field is `None` when it stays as it is, so an
/// unchanged view touches nothing — the loop recomputes it every few seconds.
/// (The Dock badge is followed on its own: it can only be set while a window
/// exists, see `super::run`.)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrayUpdate {
    /// Which icon: `Some(true)` the one with the "needs you" mark.
    pub attention_icon: Option<bool>,
    /// The text beside the menu-bar icon: `Some(None)` clears it.
    pub title: Option<Option<String>>,
    pub tooltip: Option<String>,
    /// The menu has to be rebuilt.
    pub menu: bool,
}

impl TrayUpdate {
    pub fn is_empty(&self) -> bool {
        *self == TrayUpdate::default()
    }
}

pub fn plan_update(shown: Option<&TrayView>, next: &TrayView) -> TrayUpdate {
    let count_changed = shown.is_none_or(|shown| shown.count != next.count);
    let waiting_changed = shown.is_none_or(|shown| shown.waiting() != next.waiting());
    TrayUpdate {
        attention_icon: waiting_changed.then_some(next.waiting()),
        title: count_changed.then(|| next.waiting().then(|| next.count.to_string())),
        tooltip: shown
            .is_none_or(|shown| shown.header != next.header)
            .then(|| next.tooltip()),
        menu: shown
            .is_none_or(|shown| shown.header != next.header || shown.entries != next.entries),
    }
}

// ── The "needs you" icon ──

/// The menu-bar template image with a "needs you" dot in its top-right
/// corner, cut out of the glyph with a clear ring so it reads at menu-bar
/// size. Template images are alpha masks (AppKit tints them), so the dot is
/// drawn as opaque alpha like the glyph itself.
pub fn with_attention_dot(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    if width == 0 || height == 0 || rgba.len() < (width * height * 4) as usize {
        return out;
    }
    let size = width.min(height) as f32;
    let radius = size * 0.22;
    let ring = size * 0.09;
    let cx = width as f32 - radius - 0.5;
    let cy = radius + 0.5;
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            let i = ((y * width + x) * 4) as usize;
            if d <= radius {
                out[i] = 0;
                out[i + 1] = 0;
                out[i + 2] = 0;
                out[i + 3] = 255;
            } else if d <= radius + ring {
                out[i + 3] = 0;
            }
        }
    }
    out
}
