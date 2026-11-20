//! "A session is waiting on me", visible while the user works in other apps:
//! the menu-bar icon gets a "needs you" mark and the count beside it, its
//! menu lists every waiting session (title, server, what it waits for) and
//! opens one in the right window, and the Dock badge shows the count.
//!
//! The count covers this instance AND every saved remote connection, whether
//! or not that connection's window is open, so the native side learns each
//! server's list itself ([`poll`]). Sources, each counted once:
//! - this instance: the pending watch hands over its list whenever it
//!   changes ([`note_local`]);
//! - each saved connection: a poll of its `list_pending_items`, plus the
//!   `app://pending-items` frames of its event socket while its window is
//!   open ([`observe_remote_frame`]) — the same server's list either way, so
//!   one replaces the other instead of adding to it.
//!
//! Windows never report counts here, so a session a window shows is never
//! added a second time. [`model`] folds the sources into one entry per
//! session and decides what changes on screen; it is pure and tested.

pub mod model;
pub mod poll;

#[cfg(test)]
mod tests;

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use model::{plan_update, tray_view, waiting_sessions, RemoteSnapshot, TrayView, WaitingItem};
use poll::{fetch_pending, FetchError, RemoteTarget, Remotes};

/// How often the saved connections (and what each server said it is) are
/// read again, so one added, edited or deleted is followed without a restart.
const CONNECTIONS_REFRESH: Duration = Duration::from_secs(30);

/// The event channel whose frames carry a server's whole pending list.
const PENDING_ITEMS_CHANNEL: &str = crate::pending::PENDING_ITEMS_EVENT;

enum Msg {
    /// This instance's list changed.
    Local(Vec<WaitingItem>),
    /// A remote window's socket carried its server's list.
    Frame {
        connection_id: i32,
        items: Vec<WaitingItem>,
    },
    /// A poll came back.
    Polled {
        connection_id: i32,
        generation: u64,
        result: Result<Vec<WaitingItem>, FetchError>,
    },
    /// The app's language changed: say it all again.
    Relabel,
    /// The saved connections changed: read them again now.
    Connections,
}

static TX: OnceLock<mpsc::UnboundedSender<Msg>> = OnceLock::new();

fn send(msg: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(msg);
    }
}

/// This instance's pending list changed (from `pending::watch`).
pub fn note_local(snapshot: &crate::pending::PendingSnapshot) {
    send(Msg::Local(
        snapshot.items.iter().map(WaitingItem::from).collect(),
    ));
}

/// A frame of saved connection `connection_id`'s event socket (from the
/// remote proxy). Only the pending list is read; everything else is one
/// string comparison.
pub fn observe_remote_frame(connection_id: i32, frame: &serde_json::Value) {
    if frame.get("channel").and_then(serde_json::Value::as_str) != Some(PENDING_ITEMS_CHANNEL) {
        return;
    }
    let Some(payload) = frame.get("payload") else {
        return;
    };
    match serde_json::from_value::<RemoteSnapshot>(payload.clone()) {
        Ok(snapshot) => send(Msg::Frame {
            connection_id,
            items: snapshot.items,
        }),
        Err(e) => tracing::debug!("[attention] unreadable pending list from {connection_id}: {e}"),
    }
}

/// The tray's language changed (`windows::refresh_tray_menu`).
pub fn relabel() {
    send(Msg::Relabel);
}

/// A saved connection was added, edited or deleted.
pub fn connections_changed() {
    send(Msg::Connections);
}

/// Start the watch. Once per process, in the desktop setup after the tray
/// icon is installed; the Dock badge works without the tray.
pub fn spawn(app: AppHandle, db: DatabaseConnection) {
    let (tx, rx) = mpsc::unbounded_channel();
    if TX.set(tx.clone()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(tracing::Instrument::instrument(
        run(app, db, tx, rx),
        tracing::info_span!("bg", task = "attention-tray"),
    ));
}

async fn load_targets(db: &DatabaseConnection) -> Option<Vec<RemoteTarget>> {
    let connections = match crate::db::service::remote_workspace_connection_service::list(db).await
    {
        Ok(connections) => connections,
        Err(e) => {
            tracing::warn!("[attention] cannot list the saved connections: {e}");
            return None;
        }
    };
    let mut targets = Vec::with_capacity(connections.len());
    for connection in connections {
        let instance_id = crate::instance_identity::remote_identity(db, connection.id)
            .await
            .map(|identity| identity.instance_id);
        targets.push(RemoteTarget {
            connection_id: connection.id,
            name: connection.name,
            base_url: connection.base_url,
            token: connection.token,
            headers: connection.headers,
            instance_id,
        });
    }
    Some(targets)
}

async fn run(
    app: AppHandle,
    db: DatabaseConnection,
    tx: mpsc::UnboundedSender<Msg>,
    mut rx: mpsc::UnboundedReceiver<Msg>,
) {
    let client = poll::client();
    let mut remotes = Remotes::default();
    // The watch may have published before this task subscribed.
    let mut local: Vec<WaitingItem> = crate::pending::snapshot()
        .items
        .iter()
        .map(WaitingItem::from)
        .collect();
    let mut shown: Option<TrayView> = None;
    // What the Dock shows, once a window let it be set.
    let mut badge_shown: Option<Option<i64>> = None;
    let mut connections_read: Option<Instant> = None;
    loop {
        let now = Instant::now();
        if connections_read.is_none_or(|at| now.duration_since(at) >= CONNECTIONS_REFRESH) {
            if let Some(targets) = load_targets(&db).await {
                remotes.sync(targets, now);
            }
            connections_read = Some(now);
        }
        for due in remotes.take_due(now) {
            let client = client.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let result = fetch_pending(&client, &due.target).await;
                let _ = tx.send(Msg::Polled {
                    connection_id: due.target.connection_id,
                    generation: due.generation,
                    result,
                });
            });
        }

        let view = tray_view(
            &waiting_sessions(
                crate::instance_identity::current_id(),
                &local,
                &remotes.sources(),
            ),
            &model::labels_for(crate::commands::windows::tray_locale()),
        );
        let update = plan_update(shown.as_ref(), &view);
        if !update.is_empty() {
            crate::commands::windows::show_tray_attention(&app, &view, &update);
        }
        let badge = view.badge();
        if badge_shown != Some(badge) && set_dock_badge(&app, badge) {
            badge_shown = Some(badge);
        }
        shown = Some(view);

        let next_read = connections_read.map_or(now, |at| at + CONNECTIONS_REFRESH);
        let wake = remotes
            .next_due()
            .map_or(next_read, |due| due.min(next_read));
        let msg = tokio::select! {
            msg = rx.recv() => match msg {
                Some(msg) => Some(msg),
                None => break,
            },
            _ = tokio::time::sleep(wake.saturating_duration_since(Instant::now())) => None,
        };
        // Take everything already queued, so a burst renders once.
        let mut pending = msg.into_iter().collect::<Vec<_>>();
        while let Ok(msg) = rx.try_recv() {
            pending.push(msg);
        }
        let now = Instant::now();
        for msg in pending {
            match msg {
                Msg::Local(items) => local = items,
                Msg::Frame {
                    connection_id,
                    items,
                } => {
                    remotes.apply_frame(connection_id, items, now);
                }
                Msg::Polled {
                    connection_id,
                    generation,
                    result,
                } => {
                    remotes.apply_poll(connection_id, generation, result, now);
                }
                // Forget what was shown, so the menu is built again in the
                // new language.
                Msg::Relabel => shown = None,
                Msg::Connections => connections_read = None,
            }
        }
    }
}

/// The Dock badge (the taskbar's where the platform has one). Set through a
/// window, the only handle Tauri gives it; any window sets the app's badge.
/// Whether it was set: with no window yet (a windowless launch), the loop
/// tries again on its next pass.
fn set_dock_badge(app: &AppHandle, badge: Option<i64>) -> bool {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    let Some(window) = window else {
        return false;
    };
    if let Err(e) = window.set_badge_count(badge) {
        // The platform has no badge (Windows): nothing to retry.
        tracing::debug!("[attention] could not set the dock badge: {e}");
    }
    true
}
