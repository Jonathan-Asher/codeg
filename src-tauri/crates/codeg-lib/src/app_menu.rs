//! The macOS app menu's close commands.
//!
//! Tauri's default macOS menu binds ⌘W to "Close Window" (in both File and
//! Window). The workspace answers ⌘W itself and cancels the key, which keeps
//! the menu out of it — but only while the workspace's own document has the
//! keystroke. Wherever it does not (a built-in browser page, which is a
//! separate webview, or any key the page leaves alone), ⌘W fell through to the
//! menu and closed the whole window.
//!
//! The menu here is Tauri's default with those two items swapped out:
//!
//! - **Close Tab** (⌘W): in a workspace window (`main`, `remote-workspace-*`)
//!   it asks that window's frontend to close its active tab
//!   ([`CLOSE_TAB_EVENT`]); it never closes the window. Any other window
//!   (settings, commit, Quick Ask, pets) is closed as ⌘W always closed it.
//! - **Close Window** (⇧⌘W): closes the focused window, the same close as its
//!   own close button (`CloseRequested`, so the main window's close-behaviour
//!   preference and Quick Ask's hide still apply).

/// Menu id of File › Close Tab.
pub const MENU_CLOSE_TAB: &str = "app:close-tab";
/// Menu ids of File › Close Window and Window › Close Window.
pub const MENU_CLOSE_WINDOW: &str = "app:close-window";
pub const MENU_CLOSE_WINDOW_WINDOW_MENU: &str = "app:close-window:window-menu";

/// Event a workspace window's frontend gets for File › Close Tab.
pub const CLOSE_TAB_EVENT: &str = "app://close-tab";

/// The label muda gives the predefined close-window item.
#[cfg(feature = "tauri-runtime")]
const PREDEFINED_CLOSE_WINDOW_TEXT: &str = "Close Window";

/// What ⌘W does in a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseTabTarget {
    /// A workspace window: close its active tab, keep the window.
    ActiveTab,
    /// Any other window: close the window.
    Window,
}

pub fn close_tab_target(window_label: &str) -> CloseTabTarget {
    if crate::commands::quick_ask::workspace_backend_of(window_label).is_some() {
        CloseTabTarget::ActiveTab
    } else {
        CloseTabTarget::Window
    }
}

/// Install the app menu: Tauri's default, with Close Tab (⌘W) and Close Window
/// (⇧⌘W) in place of the predefined Close Window (⌘W).
#[cfg(feature = "tauri-runtime")]
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    for top in menu.items()? {
        let MenuItemKind::Submenu(submenu) = top else {
            continue;
        };
        let in_window_menu = submenu.text()? == "Window";
        let children = submenu.items()?;
        let Some(position) = children.iter().position(|child| match child {
            MenuItemKind::Predefined(item) => {
                item.text().ok().as_deref() == Some(PREDEFINED_CLOSE_WINDOW_TEXT)
            }
            _ => false,
        }) else {
            continue;
        };
        submenu.remove_at(position)?;
        if in_window_menu {
            let close_window = MenuItem::with_id(
                app,
                MENU_CLOSE_WINDOW_WINDOW_MENU,
                "Close Window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?;
            submenu.insert(&close_window, position)?;
        } else {
            let close_tab =
                MenuItem::with_id(app, MENU_CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?;
            let close_window = MenuItem::with_id(
                app,
                MENU_CLOSE_WINDOW,
                "Close Window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?;
            submenu.insert(&close_tab, position)?;
            submenu.insert(&close_window, position + 1)?;
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

/// Handle a click (or accelerator) on one of the items above. Returns whether
/// `id` was one of them.
#[cfg(feature = "tauri-runtime")]
pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) -> bool {
    use tauri::{Emitter, Manager};

    let closes_window = id == MENU_CLOSE_WINDOW || id == MENU_CLOSE_WINDOW_WINDOW_MENU;
    if id != MENU_CLOSE_TAB && !closes_window {
        return false;
    }
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    else {
        return true;
    };
    if !closes_window && close_tab_target(window.label()) == CloseTabTarget::ActiveTab {
        if let Err(err) = app.emit_to(window.label(), CLOSE_TAB_EVENT, ()) {
            tracing::warn!("[menu] close tab in {} failed: {err}", window.label());
        }
    } else if let Err(err) = window.close() {
        tracing::warn!("[menu] close window {} failed: {err}", window.label());
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_windows_close_a_tab_and_other_windows_close() {
        assert_eq!(close_tab_target("main"), CloseTabTarget::ActiveTab);
        assert_eq!(
            close_tab_target("remote-workspace-3"),
            CloseTabTarget::ActiveTab
        );
        for label in [
            "settings",
            "quick-ask",
            "commit-7",
            "pet",
            "remote-settings-3",
        ] {
            assert_eq!(close_tab_target(label), CloseTabTarget::Window, "{label}");
        }
    }
}
