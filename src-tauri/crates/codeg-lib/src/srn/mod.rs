//! Signing in to SpaceRing (SRN), the account behind spacering.net.
//!
//! The desktop app signs in with OAuth 2.0's authorization code grant, PKCE
//! (S256) and a loopback redirect (RFC 8252 §7.3), as `api/clients/` on the
//! SpaceRing side expects of a public client:
//!
//! 1. Codeg makes a `state` and a `verifier` (32 random bytes each), listens on
//!    `127.0.0.1` at a port the system picks, and creates a login request whose
//!    redirect is `http://127.0.0.1:<port>/auth/callback`.
//! 2. The system browser opens the authorization page; the request travels in
//!    its fragment, which no server ever receives.
//! 3. The page sends the browser back to the loopback address with a code (or
//!    `error=access_denied`). The listener takes exactly one such answer, whose
//!    `state` matches, and closes.
//! 4. Codeg exchanges the code once — never again, whatever happens to the
//!    answer — keeps the token in the OS keychain, and confirms who it belongs
//!    to with `/me`.
//!
//! What is here:
//!
//! - [`client`] — the SRN account API (login requests, the code exchange,
//!   `/me`, `logout`) under the rules of the Harness client it shares its
//!   pieces with: the user's proxy, HTTPS, bounded answers, and no redirect
//!   followed. Compiled in both runtimes: the Web sign-in builds on it.
//! - [`pkce`] — the flow's secrets and the opaque values SpaceRing hands out,
//!   none of which can be printed by accident.
//! - [`error`] — what can go wrong, as the stable codes and i18n keys the
//!   status-bar popover explains.
//! - The desktop account, desktop builds only: `account` (the app-level
//!   account service: the current account, the flow generations, the online
//!   check), `loopback` (the one-shot listener), `page` (what the browser
//!   shows when it comes back), `store` (the keychain record), `environment`
//!   (which client and keychain entry this build uses) and `desktop` (the
//!   Tauri side: the singleton, the event, the system browser, the window).
//!   The commands are in `commands::srn`.
//! - [`web`] — Codeg Web's own sign-in, both runtimes: the server completes
//!   the flow for the browser and keeps the session in `codeg.db`.
//!
//! The account belongs to this desktop app. No command hands the token out,
//! the account event reaches the desktop's own windows only (never the
//! embedded web server's clients, which hold SRN sessions of their own), and
//! neither codeg-server nor codeg-mcp compiles any of it. Nothing here logs a
//! token, a code, a verifier, a state or a request ID.

pub mod client;
pub mod error;
pub mod pkce;
pub mod web;

/// This fork's switch for the desktop's SRN account: `CODEG_SRN_SIGN_IN=on`
/// turns it on. Off by default: nothing reads the keychain for a sign-in or
/// asks SpaceRing at startup or when a window comes forward, and every
/// `srn_*` command refuses. The frontend has the build-time twin,
/// `NEXT_PUBLIC_CODEG_SRN_SIGN_IN` (`src/lib/srn-account/enabled.ts`), which
/// leaves the account out of the status bar's menu. Codeg Web's own sign-in
/// is off anyway until its operator configures it (`web::config`).
pub const SIGN_IN_SWITCH_ENV: &str = "CODEG_SRN_SIGN_IN";

/// Whether the desktop's SRN account is on (see [`SIGN_IN_SWITCH_ENV`]).
pub fn sign_in_enabled() -> bool {
    sign_in_enabled_by(std::env::var(SIGN_IN_SWITCH_ENV).ok().as_deref())
}

/// [`sign_in_enabled`], for the variable's value: on only for `on`, `1`,
/// `true` or `yes`, in any case. Unset, empty or anything else is off.
fn sign_in_enabled_by(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "on" | "1" | "true" | "yes"
        )
    })
}

#[cfg(feature = "tauri-runtime")]
pub(crate) mod account;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod desktop;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod environment;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod loopback;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod page;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod store;
#[cfg(feature = "tauri-runtime")]
pub mod types;

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(all(test, feature = "tauri-runtime"))]
mod tests;

#[cfg(test)]
mod switch_tests {
    use super::sign_in_enabled_by;

    #[test]
    fn the_sign_in_is_off_unless_switched_on() {
        for off in [
            None,
            Some(""),
            Some("off"),
            Some("0"),
            Some("onn"),
            Some("no"),
        ] {
            assert!(!sign_in_enabled_by(off), "{off:?}");
        }
        for on in [
            Some("on"),
            Some(" ON "),
            Some("1"),
            Some("true"),
            Some("yes"),
        ] {
            assert!(sign_in_enabled_by(on), "{on:?}");
        }
    }
}
