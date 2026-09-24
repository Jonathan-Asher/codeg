//! Which workspace window is on screen: at launch, on a dock click or a second
//! launch, and after a remote workspace window closes.
//!
//! codeg has two kinds of workspace window: the local workspace (`main`) and
//! one `remote-workspace-{id}` per saved remote connection. A launch normally
//! leads with `main`, but someone who always works on another machine can have
//! it open a remote workspace instead (Settings › System, "When codeg starts,
//! open"). `main` is then built hidden behind that window — it still hosts the
//! local workspace, and the tray, the dock and the remote window's quick
//! actions all bring it back — and the rules below keep it out of the way
//! without ever leaving the app running with nothing on screen.
//!
//! The decisions are pure functions over window states, so they are tested
//! without a running app; the glue under them only reads those states and acts.

use std::path::Path;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};

use crate::app_error::AppCommandError;
use crate::commands::remote_workspace::REMOTE_WORKSPACE_LABEL_PREFIX;
use crate::commands::windows;

/// Route `main` loads when no `codeg://` link picked a conversation for it.
pub(crate) const MAIN_WORKSPACE_PATH: &str = "workspace";

/// Every window flag the window-state plugin persists and restores, except
/// decorations. Decorations are a per-platform decision made by
/// `apply_platform_window_style` (undecorated on Windows/Linux so the app
/// draws its own chrome), not a user preference. Restoring a stale
/// `decorated: true` saved by an older build would call `set_decorations(true)`
/// after the window is built and re-add the native title bar on top of the
/// app's own toolbar — the Linux "double title bar".
pub(crate) const WINDOW_STATE_FLAGS: StateFlags =
    StateFlags::all().difference(StateFlags::DECORATIONS);

/// What a launch builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StartupPlan {
    /// Saved remote connection whose window opens at launch.
    pub remote_connection_id: Option<i32>,
    /// Whether `main` is built hidden. Only ever true alongside a remote
    /// window that leads instead.
    pub hide_main: bool,
}

/// Decide what a launch opens.
///
/// * `local_link` — the launch URL resolved to a local conversation. That asks
///   for the local workspace by name, so it wins over the preference.
/// * `startup_remote` — the preferred remote connection, already known to
///   exist (`system_settings::resolve_startup_remote_connection`).
/// * `can_hide_main` — whether a hidden `main` stays reachable, i.e. whether
///   the tray is usable ([`windows::can_hide_to_tray`]). On Linux it is not,
///   so `main` stays on screen and the remote window opens on top of it.
pub(crate) fn plan_startup(
    local_link: bool,
    startup_remote: Option<i32>,
    can_hide_main: bool,
) -> StartupPlan {
    match startup_remote {
        Some(id) if !local_link => StartupPlan {
            remote_connection_id: Some(id),
            hide_main: can_hide_main,
        },
        _ => StartupPlan {
            remote_connection_id: None,
            hide_main: false,
        },
    }
}

/// How a workspace window sits on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowPresence {
    Visible,
    Minimized,
    /// Hidden with `hide()`, or built hidden.
    Hidden,
}

/// The workspace window a "bring codeg back" gesture brings forward.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReopenTarget {
    Main,
    Remote(String),
}

/// Pick the window a dock click (macOS) or a second launch (Windows, Linux)
/// brings forward. `main` is `None` when a close destroyed it; `remotes` are
/// the open remote workspace windows, in a stable order.
///
/// A workspace window already on screen wins, `main` first: the gesture means
/// "back to codeg", not "show me another window" — and unhiding a `main` the
/// user never asked for on every dock click is exactly what a launch into a
/// remote workspace must not do. With nothing on screen, a remote window
/// (minimized) comes back before `main`, because where one exists it is the
/// workspace the user was in. Only with no remote window left does `main`
/// return, rebuilt if it is gone.
pub(crate) fn reopen_target(
    main: Option<WindowPresence>,
    remotes: &[(String, WindowPresence)],
) -> ReopenTarget {
    if main == Some(WindowPresence::Visible) {
        return ReopenTarget::Main;
    }
    if let Some((label, _)) = remotes
        .iter()
        .find(|(_, presence)| *presence == WindowPresence::Visible)
    {
        return ReopenTarget::Remote(label.clone());
    }
    match remotes.first() {
        Some((label, _)) => ReopenTarget::Remote(label.clone()),
        None => ReopenTarget::Main,
    }
}

/// Whether closing a remote workspace window stranded `main`: hidden, with no
/// other workspace window left to come back through. The app would then keep
/// running with nothing on screen and no obvious way back, so `main` is shown.
///
/// A minimized `main` already has its way back (the dock, the taskbar), and a
/// destroyed one was closed on purpose, so neither is brought back.
pub(crate) fn main_needs_resurfacing(
    remaining_remote_windows: usize,
    main: Option<WindowPresence>,
) -> bool {
    remaining_remote_windows == 0 && main == Some(WindowPresence::Hidden)
}

/// The flags `main` is restored with when it is built.
///
/// A visible `main` gets the full set. A hidden one leaves out every flag whose
/// restore puts a window on screen: VISIBLE is the plugin's `show()` +
/// `set_focus()`, MAXIMIZED is a `ShowWindow(SW_MAXIMIZE)` on Windows, and
/// FULLSCREEN is a native Space of its own on macOS. Size and position are safe
/// on a window nobody can see, and they are what it comes back with.
pub(crate) fn main_window_restore_flags(visible: bool) -> StateFlags {
    if visible {
        WINDOW_STATE_FLAGS
    } else {
        WINDOW_STATE_FLAGS.difference(
            StateFlags::VISIBLE
                .union(StateFlags::MAXIMIZED)
                .union(StateFlags::FULLSCREEN),
        )
    }
}

/// Create `main` if it is gone — at launch, or after a close destroyed it
/// while remote workspace windows kept the app alive. Workspace state (open
/// folders, opened tabs, active tab) is restored by the frontend inside the
/// window via `list_open_folder_details` / `list_opened_tabs`.
///
/// `visible: false` builds it hidden, for a launch that leads with a remote
/// workspace. The window-state plugin skips `main` on creation (see its
/// registration in `lib.rs`), because its restore would `show()` a window
/// meant to stay hidden; the restore runs here instead, with
/// [`main_window_restore_flags`].
pub(crate) fn ensure_main_window(app: &AppHandle, workspace_path: &Path, visible: bool) {
    if app.get_webview_window("main").is_some() {
        return;
    }
    let url = WebviewUrl::App(workspace_path.to_path_buf());
    let builder = WebviewWindowBuilder::new(app, "main", url)
        .title("Codeg")
        .inner_size(1260.0, 860.0)
        .min_inner_size(400.0, 600.0)
        .visible(visible);
    let builder = windows::apply_platform_window_style(builder);
    // The workspace title bar is taller than the shared default (it hosts
    // the tab strips), so nudge the native macOS traffic lights down to
    // stay vertically centred.
    #[cfg(target_os = "macos")]
    let builder =
        builder.traffic_light_position(windows::workspace_window_traffic_light_position());
    let window = match builder.build() {
        Ok(window) => window,
        Err(err) => {
            tracing::error!("[window] failed to create the main window: {err}");
            return;
        }
    };
    // On the main thread, like the plugin's own restore. From any other thread
    // `restore_state` would hold the plugin's state cache while it waits on the
    // main thread for the monitor list — and the main thread, registering this
    // very window with the plugin, would be waiting on that cache.
    let restored = window.clone();
    let flags = main_window_restore_flags(visible);
    let _ = app.run_on_main_thread(move || {
        let _ = restored.restore_state(flags);
    });
    windows::post_window_setup(&window);
}

/// Bring the local workspace forward, rebuilding `main` first if a close
/// destroyed it. What the tray's "Show Workspace" does, what a remote window's
/// "Local workspace" action asks for, and where a reopen lands on `main`.
pub(crate) fn show_local_workspace_window(app: &AppHandle) {
    ensure_main_window(app, Path::new(MAIN_WORKSPACE_PATH), true);
    windows::show_main_window(app);
}

/// Answer a dock click (macOS) or a second launch (Windows, Linux) with the
/// window [`reopen_target`] picks.
pub(crate) fn reopen_workspace(app: &AppHandle) {
    let main = app
        .get_webview_window("main")
        .map(|window| presence(&window));
    let remotes: Vec<(String, WindowPresence)> = remote_workspace_windows(app)
        .into_iter()
        .map(|(label, window)| (label, presence(&window)))
        .collect();
    match reopen_target(main, &remotes) {
        ReopenTarget::Main => show_local_workspace_window(app),
        ReopenTarget::Remote(label) => windows::show_and_focus_window(app, &label),
    }
}

/// Runs once the remote workspace window `closed` is gone: shows `main` when
/// [`main_needs_resurfacing`] finds it stranded. `closed` is left out of the
/// count by name rather than trusting it to have left the window registry
/// already.
pub(crate) fn resurface_main_if_stranded(app: &AppHandle, closed: &str) {
    let remaining = remote_workspace_windows(app)
        .iter()
        .filter(|(label, _)| label != closed)
        .count();
    let main = app
        .get_webview_window("main")
        .map(|window| presence(&window));
    if main_needs_resurfacing(remaining, main) {
        windows::show_main_window(app);
    }
}

/// Bring the local workspace forward from a remote workspace window — the way
/// back to `main` once a launch opened a remote workspace and kept `main`
/// hidden, or after a close destroyed it. Always the LOCAL app's command: a
/// remote window reaches it through the shell transport.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn show_local_workspace(app: AppHandle) -> Result<(), AppCommandError> {
    show_local_workspace_window(&app);
    Ok(())
}

/// The open remote workspace windows, ordered by label so that
/// [`reopen_target`]'s pick does not depend on hash order.
fn remote_workspace_windows(app: &AppHandle) -> Vec<(String, tauri::WebviewWindow)> {
    let mut open: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(REMOTE_WORKSPACE_LABEL_PREFIX))
        .collect();
    open.sort_by(|(a, _), (b, _)| a.cmp(b));
    open
}

fn presence(window: &tauri::WebviewWindow) -> WindowPresence {
    // Minimized first: Windows reports a minimized window as visible.
    if window.is_minimized().unwrap_or(false) {
        WindowPresence::Minimized
    } else if window.is_visible().unwrap_or(true) {
        WindowPresence::Visible
    } else {
        WindowPresence::Hidden
    }
}

#[cfg(test)]
mod tests {
    use super::WindowPresence::{Hidden, Minimized, Visible};
    use super::*;

    fn remote(label: &str, presence: WindowPresence) -> (String, WindowPresence) {
        (label.to_string(), presence)
    }

    fn remote_target(label: &str) -> ReopenTarget {
        ReopenTarget::Remote(label.to_string())
    }

    #[test]
    fn a_launch_without_a_startup_workspace_opens_main_alone() {
        assert_eq!(
            plan_startup(false, None, true),
            StartupPlan {
                remote_connection_id: None,
                hide_main: false,
            }
        );
    }

    #[test]
    fn a_startup_workspace_opens_with_main_hidden_behind_it() {
        assert_eq!(
            plan_startup(false, Some(7), true),
            StartupPlan {
                remote_connection_id: Some(7),
                hide_main: true,
            }
        );
    }

    /// A `codeg://` link to a local conversation names the local workspace;
    /// opening a remote window over it would bury what the link asked for.
    #[test]
    fn a_link_to_a_local_conversation_wins_over_the_startup_workspace() {
        assert_eq!(
            plan_startup(true, Some(7), true),
            StartupPlan {
                remote_connection_id: None,
                hide_main: false,
            }
        );
    }

    /// Linux, or a tray that failed to install: nothing could bring a hidden
    /// `main` back, so it stays on screen under the remote window.
    #[test]
    fn without_a_usable_tray_main_stays_on_screen() {
        assert_eq!(
            plan_startup(false, Some(7), false),
            StartupPlan {
                remote_connection_id: Some(7),
                hide_main: false,
            }
        );
    }

    #[test]
    fn a_visible_main_is_brought_forward_as_before() {
        assert_eq!(reopen_target(Some(Visible), &[]), ReopenTarget::Main);
        assert_eq!(
            reopen_target(Some(Visible), &[remote("remote-workspace-1", Visible)]),
            ReopenTarget::Main
        );
    }

    /// The dock click of a session that launched into a remote workspace:
    /// the remote window comes forward, the hidden `main` stays hidden.
    #[test]
    fn a_visible_remote_window_wins_over_a_hidden_main() {
        assert_eq!(
            reopen_target(Some(Hidden), &[remote("remote-workspace-1", Visible)]),
            remote_target("remote-workspace-1")
        );
        assert_eq!(
            reopen_target(Some(Minimized), &[remote("remote-workspace-1", Visible)]),
            remote_target("remote-workspace-1")
        );
    }

    #[test]
    fn with_nothing_on_screen_a_remote_window_comes_back_before_main() {
        assert_eq!(
            reopen_target(Some(Hidden), &[remote("remote-workspace-1", Minimized)]),
            remote_target("remote-workspace-1")
        );
        assert_eq!(
            reopen_target(Some(Minimized), &[remote("remote-workspace-1", Minimized)]),
            remote_target("remote-workspace-1")
        );
    }

    #[test]
    fn the_visible_remote_window_wins_over_one_listed_before_it() {
        assert_eq!(
            reopen_target(
                Some(Hidden),
                &[
                    remote("remote-workspace-1", Minimized),
                    remote("remote-workspace-2", Visible),
                ]
            ),
            remote_target("remote-workspace-2")
        );
    }

    #[test]
    fn without_remote_windows_main_comes_back_even_if_it_is_gone() {
        assert_eq!(reopen_target(Some(Hidden), &[]), ReopenTarget::Main);
        assert_eq!(reopen_target(Some(Minimized), &[]), ReopenTarget::Main);
        assert_eq!(reopen_target(None, &[]), ReopenTarget::Main);
    }

    #[test]
    fn a_closed_main_does_not_come_back_over_a_remote_window() {
        assert_eq!(
            reopen_target(None, &[remote("remote-workspace-1", Visible)]),
            remote_target("remote-workspace-1")
        );
    }

    #[test]
    fn closing_the_last_remote_window_shows_a_hidden_main() {
        assert!(main_needs_resurfacing(0, Some(Hidden)));
    }

    #[test]
    fn main_is_left_alone_while_it_has_another_way_back() {
        // Another remote workspace window is still open.
        assert!(!main_needs_resurfacing(1, Some(Hidden)));
        // Already on screen, or in the dock / taskbar.
        assert!(!main_needs_resurfacing(0, Some(Visible)));
        assert!(!main_needs_resurfacing(0, Some(Minimized)));
        // Closed on purpose.
        assert!(!main_needs_resurfacing(0, None));
    }

    #[test]
    fn a_visible_main_restores_every_persisted_flag() {
        let flags = main_window_restore_flags(true);
        assert_eq!(flags.bits(), WINDOW_STATE_FLAGS.bits());
        assert!(flags.contains(StateFlags::VISIBLE));
        assert!(!flags.contains(StateFlags::DECORATIONS));
    }

    /// Restoring any of these on a hidden `main` would put it on screen.
    #[test]
    fn a_hidden_main_restores_nothing_that_would_show_it() {
        let flags = main_window_restore_flags(false);
        assert!(!flags.intersects(
            StateFlags::VISIBLE
                .union(StateFlags::MAXIMIZED)
                .union(StateFlags::FULLSCREEN)
        ));
        assert!(!flags.contains(StateFlags::DECORATIONS));
        assert!(flags.contains(StateFlags::SIZE.union(StateFlags::POSITION)));
    }
}
