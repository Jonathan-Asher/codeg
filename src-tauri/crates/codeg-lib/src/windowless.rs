//! Windowless mode: the desktop app running with no window at all.
//!
//! An always-on machine that other devices reach through the built-in web
//! service has no use for a window nobody looks at, yet the window's WebKit
//! processes cost several times what the app itself does. Running the same
//! app windowless keeps everything that belongs to the app — above all the
//! macOS privacy permissions its agents rely on (Full Disk Access,
//! Accessibility, Automation, …), which a separate server binary would not
//! have — while building no webview until someone asks for one.
//!
//! The switch is read once, before the app starts:
//!
//! 1. `--windowless` on the command line turns it on;
//! 2. `CODEG_WINDOWLESS` turns it on (`1`, `true`, `yes`, `on`) or off (`0`,
//!    `false`, `no`, `off`) for this launch, over the file;
//! 3. a file named `windowless` in the data dir turns it on while it exists
//!    (its contents are ignored). This is what Settings writes, and what keeps
//!    every launch path windowless: a Dock click, `open`, a login item, an
//!    update's restart, a script that starts the app with a clean environment.
//!
//! macOS only: the Dock is what brings a window back, and App Nap is what has
//! to be held off. Elsewhere the switch is reported and ignored.
//!
//! What windowless changes, all in `lib.rs`: setup builds no window (see
//! `commands::workspace_windows::plan_startup`), App Nap stays off for the
//! life of the process ([`hold_app_nap_off`]), the global shortcuts are not
//! registered, closing the workspace window destroys it instead of hiding it
//! or quitting, and the last window closing does not quit the app. A Dock
//! click or the menu bar icon builds the workspace window on demand. Every
//! background service runs exactly as with a window.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// The file in the data dir whose presence turns windowless mode on.
pub const SWITCH_FILE_NAME: &str = "windowless";

/// Environment variable that turns windowless mode on or off for one launch.
pub const ENV_VAR: &str = "CODEG_WINDOWLESS";

/// Command-line flag that turns windowless mode on for one launch.
pub const FLAG: &str = "--windowless";

/// Written into the switch file, for whoever finds it in the data dir.
const SWITCH_FILE_CONTENTS: &str = "codeg starts without a window while this file exists \
     (Settings > General > Run without a window). Delete it to get the window back at the \
     next start.\n";

/// What decided this launch's mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// `--windowless` on the command line.
    Flag,
    /// `CODEG_WINDOWLESS`.
    Env,
    /// The switch file in the data dir.
    File,
}

/// Whether this launch is windowless, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Decision {
    pub windowless: bool,
    /// `None` when nothing asked for either mode (the default: a window).
    pub source: Option<Source>,
}

/// Reads `CODEG_WINDOWLESS`. `None` for an empty or unrecognised value, which
/// leaves the decision to the file.
pub fn parse_env_value(value: &OsStr) -> Option<bool> {
    let value = value.to_str()?.trim().to_ascii_lowercase();
    match value.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Decide this launch's mode. `args` are the process arguments without the
/// program name; `env` is `CODEG_WINDOWLESS`; `file_present` is whether the
/// switch file exists.
///
/// The flag wins, because it is the most deliberate; an explicit environment
/// value comes next, in both directions, so one launch can get a window back
/// without deleting the file; the file decides the rest.
pub fn decide<I>(args: I, env: Option<&OsStr>, file_present: bool) -> Decision
where
    I: IntoIterator,
    I::Item: AsRef<OsStr>,
{
    if args.into_iter().any(|arg| arg.as_ref() == OsStr::new(FLAG)) {
        return Decision {
            windowless: true,
            source: Some(Source::Flag),
        };
    }
    if let Some(on) = env.and_then(parse_env_value) {
        return Decision {
            windowless: on,
            source: Some(Source::Env),
        };
    }
    if file_present {
        return Decision {
            windowless: true,
            source: Some(Source::File),
        };
    }
    Decision::default()
}

/// Where the switch file lives.
pub fn switch_file(data_dir: &Path) -> PathBuf {
    data_dir.join(SWITCH_FILE_NAME)
}

/// Whether the switch file exists. A file that cannot be checked counts as
/// absent: a window is the safe side to fail on.
pub fn switch_file_present(data_dir: &Path) -> bool {
    switch_file(data_dir).is_file()
}

/// Turn the persisted switch on (create the file) or off (remove it).
pub fn write_switch_file(data_dir: &Path, on: bool) -> io::Result<()> {
    let path = switch_file(data_dir);
    if on {
        std::fs::create_dir_all(data_dir)?;
        std::fs::write(&path, SWITCH_FILE_CONTENTS)
    } else {
        match std::fs::remove_file(&path) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// Whether this build can run windowless at all: the desktop app on macOS.
pub const fn supported() -> bool {
    cfg!(all(feature = "tauri-runtime", target_os = "macos"))
}

/// Decide this launch's mode from the process itself. Ignored (and turned
/// off) where it is not [`supported`].
pub fn decide_for_process(data_dir: Option<&Path>) -> Decision {
    let env = std::env::var_os(ENV_VAR);
    let decision = decide(
        std::env::args_os().skip(1),
        env.as_deref(),
        data_dir.is_some_and(switch_file_present),
    );
    if supported() {
        decision
    } else {
        Decision {
            windowless: false,
            source: decision.source,
        }
    }
}

static ACTIVE: OnceLock<Decision> = OnceLock::new();

/// Record this launch's mode. Only the first call counts.
pub fn set_active(decision: Decision) {
    let _ = ACTIVE.set(decision);
}

/// This launch's mode; a window unless [`set_active`] said otherwise.
pub fn active() -> Decision {
    ACTIVE.get().copied().unwrap_or_default()
}

/// Whether this launch runs without a window.
pub fn is_active() -> bool {
    active().windowless
}

/// Whether an exit request leaves the app running. Tauri asks to exit with no
/// code when the last window has closed, and with a code for a real quit
/// (`AppHandle::exit`, `restart`). A windowless app outlives its last window;
/// any other app, and any real quit, exits as before.
pub fn keeps_running_after_last_window(windowless: bool, exit_code: Option<i32>) -> bool {
    windowless && exit_code.is_none()
}

/// What Settings shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowlessSettingsView {
    /// False where the switch does nothing (codeg-server, Windows, Linux):
    /// the settings page hides it.
    pub supported: bool,
    /// The persisted switch: whether the file exists.
    pub enabled: bool,
    /// Whether the running process is windowless.
    pub active: bool,
    /// What decided the running process's mode.
    pub source: Option<Source>,
    /// Whether the web service starts with the app. Without it a windowless
    /// codeg is out of everyone's reach, so the settings page warns.
    pub web_service_auto_start: bool,
}

/// The settings view for the process running in `data_dir`.
pub fn settings_view(data_dir: &Path, web_service_auto_start: bool) -> WindowlessSettingsView {
    if !supported() {
        return WindowlessSettingsView {
            supported: false,
            enabled: false,
            active: false,
            source: None,
            web_service_auto_start,
        };
    }
    let decision = active();
    WindowlessSettingsView {
        supported: true,
        enabled: switch_file_present(data_dir),
        active: decision.windowless,
        source: decision.source,
        web_service_auto_start,
    }
}

/// Keep App Nap off for the rest of the process.
///
/// macOS naps an app with no visible window: its timers are coalesced and
/// delayed, its network and disk I/O deprioritised. That is right for an app
/// nobody is using and wrong for one that serves other devices, runs agents and
/// fires reminders. A user-initiated activity is what tells the system the
/// work matters; the variant that allows idle system sleep leaves the Mac's own
/// sleep settings in charge, as they are with a window (codeg holds no sleep
/// assertion of its own). The activity is never ended: it lasts as long as the
/// process.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
pub fn hold_app_nap_off() {
    use objc2_foundation::{ns_string, NSActivityOptions, NSProcessInfo};

    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        ns_string!("codeg runs without a window and serves other devices"),
    );
    // Ending the activity is releasing this token; it must live as long as the
    // process does.
    std::mem::forget(activity);
    tracing::info!("[windowless] App Nap held off for the life of the process");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn nothing_set_means_a_window() {
        assert_eq!(decide(args(&[]), None, false), Decision::default());
        assert!(!Decision::default().windowless);
    }

    #[test]
    fn the_file_turns_it_on() {
        assert_eq!(
            decide(args(&[]), None, true),
            Decision {
                windowless: true,
                source: Some(Source::File),
            }
        );
    }

    #[test]
    fn the_flag_turns_it_on_wherever_it_is() {
        for list in [
            &["--windowless"][..],
            &["-psn_0_12345", "--windowless"][..],
            &["--windowless", "codeg://open"][..],
        ] {
            assert_eq!(
                decide(args(list), None, false),
                Decision {
                    windowless: true,
                    source: Some(Source::Flag),
                },
                "{list:?}"
            );
        }
    }

    #[test]
    fn only_the_exact_flag_counts() {
        for list in [
            &["--windowless=1"][..],
            &["windowless"][..],
            &["--Windowless"][..],
            &["codeg://windowless"][..],
        ] {
            assert_eq!(decide(args(list), None, false), Decision::default(), "{list:?}");
        }
    }

    #[test]
    fn the_flag_wins_over_an_env_value_that_says_off() {
        let off = OsString::from("0");
        assert_eq!(
            decide(args(&["--windowless"]), Some(&off), false),
            Decision {
                windowless: true,
                source: Some(Source::Flag),
            }
        );
    }

    #[test]
    fn the_env_var_turns_it_on() {
        for value in ["1", "true", "TRUE", "yes", "on", " 1 "] {
            let value = OsString::from(value);
            assert_eq!(
                decide(args(&[]), Some(&value), false),
                Decision {
                    windowless: true,
                    source: Some(Source::Env),
                },
                "{value:?}"
            );
        }
    }

    /// One launch can get its window back without deleting the file.
    #[test]
    fn an_env_value_that_says_off_wins_over_the_file() {
        for value in ["0", "false", "no", "off", "OFF"] {
            let value = OsString::from(value);
            assert_eq!(
                decide(args(&[]), Some(&value), true),
                Decision {
                    windowless: false,
                    source: Some(Source::Env),
                },
                "{value:?}"
            );
        }
    }

    #[test]
    fn an_empty_or_unknown_env_value_leaves_it_to_the_file() {
        for value in ["", "  ", "maybe", "2"] {
            let value = OsString::from(value);
            assert_eq!(
                decide(args(&[]), Some(&value), false),
                Decision::default(),
                "{value:?}"
            );
            assert_eq!(
                decide(args(&[]), Some(&value), true),
                Decision {
                    windowless: true,
                    source: Some(Source::File),
                },
                "{value:?}"
            );
        }
    }

    #[test]
    fn the_env_value_is_parsed_strictly() {
        assert_eq!(parse_env_value(OsStr::new("1")), Some(true));
        assert_eq!(parse_env_value(OsStr::new("off")), Some(false));
        assert_eq!(parse_env_value(OsStr::new("enabled")), None);
        assert_eq!(parse_env_value(OsStr::new("")), None);
    }

    #[test]
    fn a_windowless_app_outlives_its_last_window_but_not_a_quit() {
        // The last window closed.
        assert!(keeps_running_after_last_window(true, None));
        assert!(!keeps_running_after_last_window(false, None));
        // A real quit or restart, windowless or not.
        assert!(!keeps_running_after_last_window(true, Some(0)));
        assert!(!keeps_running_after_last_window(true, Some(1)));
        assert!(!keeps_running_after_last_window(false, Some(0)));
    }

    #[test]
    fn the_switch_file_round_trips() {
        let dir = tempfile::tempdir().expect("tempdir");
        let data_dir = dir.path().join("data");
        assert!(!switch_file_present(&data_dir));

        write_switch_file(&data_dir, true).expect("turn on");
        assert!(switch_file_present(&data_dir));
        assert_eq!(switch_file(&data_dir), data_dir.join("windowless"));
        // Turning it on twice is fine.
        write_switch_file(&data_dir, true).expect("turn on again");
        assert!(switch_file_present(&data_dir));

        write_switch_file(&data_dir, false).expect("turn off");
        assert!(!switch_file_present(&data_dir));
        // Turning it off when it is already off is fine.
        write_switch_file(&data_dir, false).expect("turn off again");
    }

    /// A directory with the switch's name is not the switch.
    #[test]
    fn a_directory_named_like_the_switch_does_not_turn_it_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join(SWITCH_FILE_NAME)).expect("mkdir");
        assert!(!switch_file_present(dir.path()));
    }

    #[test]
    fn the_settings_view_reports_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let view = settings_view(dir.path(), true);
        assert_eq!(view.supported, supported());
        assert!(!view.enabled);
        assert!(view.web_service_auto_start);

        write_switch_file(dir.path(), true).expect("turn on");
        let view = settings_view(dir.path(), false);
        assert_eq!(view.enabled, supported());
        // The running test process was never made windowless.
        assert!(!view.active);
        assert!(!view.web_service_auto_start);
    }

    #[test]
    fn the_settings_view_speaks_snake_case() {
        let view = WindowlessSettingsView {
            supported: true,
            enabled: true,
            active: false,
            source: Some(Source::File),
            web_service_auto_start: true,
        };
        assert_eq!(
            serde_json::to_value(&view).expect("json"),
            serde_json::json!({
                "supported": true,
                "enabled": true,
                "active": false,
                "source": "file",
                "web_service_auto_start": true,
            })
        );
    }
}
