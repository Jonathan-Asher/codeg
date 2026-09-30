//! OS notifications, and the two affordances the platform gives us for
//! diagnosing them.
//!
//! Neither notification backend we use exposes a permission state on desktop:
//! `tauri-plugin-notification`'s desktop implementation hard-codes
//! `PermissionState::Granted` for both `permission_state()` and
//! `request_permission()`, and `mac-notification-sys` has no authorization API
//! at all. So the frontend cannot render "allowed / blocked" without inventing
//! it. What it CAN do is send a test notification and offer a shortcut to the
//! system pane that actually owns the decision — which is why both commands
//! here return real errors instead of best-effort silence.
//!
//! On macOS there is a second thing the user needs to know and the OS will not
//! tell them: *which app* the notification is attributed to. `NSUserNotification`
//! has no notion of an unbundled process, so `mac-notification-sys` swizzles
//! `-[NSBundle bundleIdentifier]` to a bundle id of our choosing and the OS
//! files the notification — and its permission — under THAT app. Get it wrong
//! and every switch the user can see belongs to a different app, which is
//! exactly the state this module used to ship in (see
//! `resolve_notification_identity`). `notification_identity` reports the
//! resolved bundle id so the settings panel can name it instead of implying
//! the user's own toggles are in play.
//!
//! A notification about a session also carries the way back to it (see
//! "Click-to-open" below): clicking it brings the workspace window that owns
//! the session forward — the local one or a remote one — and opens the
//! session's tab there.

use std::collections::HashMap;
use std::sync::Mutex;
// Only the macOS identity static needs it; anywhere else this is an unused
// import, which `-D warnings` rejects.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
use std::sync::OnceLock;

use serde::Deserialize;
#[cfg(feature = "tauri-runtime")]
use serde::Serialize;
#[cfg(feature = "tauri-runtime")]
use tauri::AppHandle;
use tauri::{Emitter, Manager};

#[cfg(feature = "tauri-runtime")]
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::quick_ask::{workspace_backend_of, workspace_label_for};

/// Where `mac-notification-sys` lands when the bundle id we ask for cannot be
/// claimed. Not a policy of ours: it is the literal default baked into the
/// crate's swizzled `-[NSBundle bundleIdentifier]`, which returns
/// `@"com.apple.Terminal"` whenever `setApplication` bailed before assigning
/// `fakeBundleIdentifier`. Naming it here is how we report what the OS will
/// actually do, rather than guessing.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
const MACOS_FALLBACK_BUNDLE_ID: &str = "com.apple.Terminal";

/// Which app the OS believes is posting our notifications.
///
/// The distinction between the two ids is the whole point: permission, icon,
/// name and the System Settings pane all follow `bundle_id`, so when it differs
/// from `requested_bundle_id` the user's own notification switches are not the
/// ones in play.
///
/// Only ever populated on macOS — see `resolve_notification_identity` — but
/// the type exists everywhere because it is the return shape of a command the
/// frontend calls on every desktop platform.
#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationIdentity {
    /// The bundle id notifications are actually delivered under.
    pub bundle_id: String,
    /// The bundle id we asked for — this app's own identifier.
    pub requested_bundle_id: String,
    /// `bundle_id != requested_bundle_id`: delivery fell back to another app's
    /// identity, so that app's switches govern whether anything appears.
    pub degraded: bool,
}

#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
static NOTIFICATION_IDENTITY: OnceLock<NotificationIdentity> = OnceLock::new();

/// Claim a notification identity for this process, once, and report what we
/// got. `None` off macOS.
///
/// The `OnceLock` is not a cache — it is the only place the answer survives.
/// `mac_notification_sys::set_application` is guarded by its own `Once` and
/// returns `AlreadySet` for every call after the first *including when that
/// first call failed*, so a caller that does not record the first outcome can
/// never learn it again. That is how the previous `let _ = set_application(..)`
/// managed to lose a hard failure.
///
/// This deliberately does NOT special-case `is_dev()`. The old code passed
/// `"com.apple.Terminal"` in dev builds, copying `tauri-plugin-notification`,
/// which made every dev notification land under Terminal's permission — an app
/// most users have never granted, so nothing appeared and the codeg switches
/// the user could see governed nothing. Asking for our own identifier works
/// whenever codeg is registered with LaunchServices (the usual case: it is
/// installed), and when it is not, `setApplication` leaves `fakeBundleIdentifier`
/// nil and the crate's swizzle falls back to `com.apple.Terminal` on its own —
/// i.e. exactly the old behaviour, minus the silence about it.
///
/// Nothing is reported off macOS, and that is the honest answer rather than a
/// gap. macOS is the only platform where we impersonate another app, so it is
/// the only one where the delivering identity can differ from ours. Linux posts
/// over D-Bus under the name we pass. Windows has its own version of this
/// problem — `tauri-plugin-notification` only assigns the AppUserModelID when
/// the exe is outside `target/debug|release`, so a Windows dev build posts
/// under whatever AUMID `notify-rust` falls back to — but the plugin does not
/// tell us which, so claiming an identity there would be exactly the kind of
/// invented fact this module exists to avoid.
#[cfg(feature = "tauri-runtime")]
fn resolve_notification_identity(
    #[allow(unused_variables)] app: &AppHandle,
) -> Option<&'static NotificationIdentity> {
    #[cfg(target_os = "macos")]
    {
        Some(NOTIFICATION_IDENTITY.get_or_init(|| {
            use mac_notification_sys::error::{ApplicationError, Error as MacNotificationError};

            let requested = app.config().identifier.clone();
            let bundle_id = match mac_notification_sys::set_application(&requested) {
                Ok(()) => requested.clone(),
                // LaunchServices does not know this bundle id, so the swizzle
                // is serving `com.apple.Terminal` and that is where the OS will
                // file the notification.
                Err(MacNotificationError::Application(ApplicationError::CouldNotSet(_))) => {
                    MACOS_FALLBACK_BUNDLE_ID.to_string()
                }
                // Somebody else won the crate's `Once` before us — today only
                // `tauri-plugin-notification` could, and it asks for the same
                // identifier. We cannot read the value back out of the crate, so
                // report the one we asked for rather than invent a failure.
                Err(_) => requested.clone(),
            };

            NotificationIdentity {
                degraded: bundle_id != requested,
                bundle_id,
                requested_bundle_id: requested,
            }
        }))
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Report the app identity the OS files our notifications under, or `null`
/// where the platform gives us nothing trustworthy to report.
///
/// Cheap and idempotent after the first call, but the first call is what
/// establishes the identity — on macOS that means installing the crate's
/// `NSBundle` swizzle. That is the same swizzle the first notification would
/// install anyway, and in a packaged build it substitutes the app's real
/// identifier for itself, so mounting the settings panel does not change what
/// any other framework sees.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn notification_identity(app: AppHandle) -> Option<NotificationIdentity> {
    resolve_notification_identity(&app).cloned()
}

/// Post a notification for the window that asked.
///
/// `target` names the session the notification is about, in the calling
/// window's terms. The window itself — its label and the backend it is bound
/// to — is stamped here from the invoking webview rather than taken from the
/// renderer, so a click can only ever route back to a window that really
/// raised it.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn send_notification(
    app: AppHandle,
    window: tauri::WebviewWindow,
    title: String,
    body: String,
    target: Option<NotificationTarget>,
) -> Result<(), AppCommandError> {
    let route = target.map(|target| NotificationRoute {
        window: window.label().to_string(),
        remote_connection_id: backend_of_window(window.label(), window.url().ok().as_ref()),
        target,
    });
    deliver(&app, title, body, route).await
}

/// Post a notification the backend raises on its own (no window asked, so no
/// session to open on a click).
#[cfg(feature = "tauri-runtime")]
pub(crate) async fn send_app_notification(
    app: &AppHandle,
    title: String,
    body: String,
) -> Result<(), AppCommandError> {
    deliver(app, title, body, None).await
}

#[cfg(feature = "tauri-runtime")]
fn delivery_failed(detail: impl Into<String>) -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::ExternalCommandFailed,
        "Failed to post the system notification",
    )
    .with_detail(detail.into())
}

#[cfg(feature = "tauri-runtime")]
async fn deliver(
    app: &AppHandle,
    title: String,
    body: String,
    #[allow(unused_variables)] route: Option<NotificationRoute>,
) -> Result<(), AppCommandError> {
    #[cfg(target_os = "macos")]
    {
        // Must precede the send: this is what assigns the bundle id the OS
        // attributes the notification to. Its outcome is reported separately
        // by `notification_identity` — a degraded identity still delivers, so
        // it is not a reason to fail the send.
        let _identity = resolve_notification_identity(app);
        macos::remember_app(app);

        // Posted on the main thread, where the click delegate lives, and
        // waited for so the settings panel's test send still reports a real
        // failure. Never called from the main thread itself: commands and the
        // backend's own sends run on the async runtime.
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(macos::deliver_on_main_thread(&title, &body, route.as_ref()));
        })
        .map_err(|err| delivery_failed(err.to_string()))?;
        rx.await
            .map_err(|_| delivery_failed("the main thread dropped the notification"))?
            .map_err(delivery_failed)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        // `tauri-plugin-notification` has no click events on desktop, so a
        // notification here carries no route and a click only raises the app
        // the way the platform does on its own.
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|err| delivery_failed(err.to_string()))?;
    }

    Ok(())
}

// ─── Click-to-open ──────────────────────────────────────────────────────────
//
// A notification about a session carries a `NotificationRoute`: the window
// that raised it, the backend that window is bound to, and the session in that
// window's terms. On macOS it rides in the notification's `userInfo`; a click
// reaches `open_notification_route`, which brings the owning workspace window
// forward — `main`, or a `remote-workspace-{id}` window, rebuilt if it was
// closed — and parks the session for that window's bridge to open, the same
// park-and-poke handoff Quick Ask's "Open in codeg" uses. The poke alone is not
// enough: a rebuilt window is still loading when it is sent, so it drains the
// slot when its bridge mounts instead.

/// The session a notification is about, as the window that raised it names it.
/// Mirror of the frontend's `NotificationTarget`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    /// The tab (connection context key) in the raising window. Covers a draft
    /// that has no conversation row yet; means nothing in any other window.
    #[serde(default)]
    pub context_key: Option<String>,
    #[serde(default)]
    pub folder_id: Option<i32>,
    /// The conversation behind the tab — what survives the tab being closed
    /// or its window being rebuilt.
    #[serde(default)]
    pub conversation_id: Option<i32>,
    #[serde(default)]
    pub agent_type: Option<String>,
}

impl NotificationTarget {
    fn names_a_session(&self) -> bool {
        self.context_key.as_deref().is_some_and(|key| !key.is_empty())
            || self.conversation_id.is_some()
    }
}

/// Everything a click needs to find its way back. Encoded into the
/// notification itself, so it must survive the app restarting in between.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRoute {
    /// Label of the window that raised the notification.
    pub window: String,
    /// The backend that window is bound to; `None` is the local workspace.
    #[serde(default)]
    pub remote_connection_id: Option<i32>,
    #[serde(default)]
    pub target: NotificationTarget,
}

/// `userInfo` key the encoded route is stored under.
pub const ROUTE_USER_INFO_KEY: &str = "codegRoute";

pub fn encode_route(route: &NotificationRoute) -> String {
    // Plain strings and integers: serialization cannot fail.
    serde_json::to_string(route).unwrap_or_default()
}

/// `None` for anything that is not a route this build wrote — a notification
/// from an older build, or another app's payload.
pub fn decode_route(raw: &str) -> Option<NotificationRoute> {
    serde_json::from_str::<NotificationRoute>(raw)
        .ok()
        .filter(|route| !route.window.is_empty())
}

/// The notification identifier for a session: a new notification about the
/// same session replaces the one already in Notification Center instead of
/// stacking under it. Keyed by window as well, because conversation ids are
/// per backend — conversation 5 on a remote box is not local conversation 5.
/// `None` for a notification that names no session, which then stands alone.
pub fn notification_group_id(route: &NotificationRoute) -> Option<String> {
    let target = &route.target;
    let session = match (target.conversation_id, target.context_key.as_deref()) {
        (Some(id), _) => format!("c{id}"),
        (None, Some(key)) if !key.is_empty() => format!("k{key}"),
        _ => return None,
    };
    Some(format!("codeg.session.{}.{session}", route.window))
}

/// The backend a window is bound to. A workspace window says so in its label;
/// any other window (Quick Ask) carries the id in its route's query string, as
/// every remote-bound window does.
pub fn backend_of_window(label: &str, url: Option<&tauri::Url>) -> Option<i32> {
    if let Some(backend) = workspace_backend_of(label) {
        return backend;
    }
    url?.query_pairs().find_map(|(key, value)| {
        if key == "remoteConnectionId" {
            value.parse().ok()
        } else {
            None
        }
    })
}

/// How the workspace window a click lands in is brought on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShowWindow {
    /// The local workspace: shown, and rebuilt first if a close destroyed it.
    Local,
    /// A remote workspace window that is still open.
    Focus(String),
    /// A remote workspace window that was closed: rebuilt from its saved
    /// connection.
    Reopen(i32),
}

/// What a click does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClickPlan {
    /// The workspace window the session opens in.
    pub label: String,
    pub show: ShowWindow,
    /// The session to hand that window, or `None` to only bring it forward.
    pub open: Option<NotificationTarget>,
}

/// Decide where a click goes.
///
/// The session belongs to the backend of the window that raised it, and only
/// that backend's workspace window can open it: `main` for local sessions,
/// `remote-workspace-{id}` for a remote one. A notification raised by a window
/// that is not a workspace window (Quick Ask) opens in its backend's workspace
/// window, where its tab key means nothing — only the conversation can travel.
pub fn plan_click(route: &NotificationRoute, is_open: impl Fn(&str) -> bool) -> ClickPlan {
    let origin_backend = workspace_backend_of(&route.window);
    let backend = origin_backend.unwrap_or(route.remote_connection_id);
    let label = workspace_label_for(backend);
    let show = match backend {
        None => ShowWindow::Local,
        Some(_) if is_open(&label) => ShowWindow::Focus(label.clone()),
        Some(id) => ShowWindow::Reopen(id),
    };
    let mut target = route.target.clone();
    if origin_backend.is_none() {
        target.context_key = None;
    }
    let open = target.names_a_session().then_some(target);
    ClickPlan { label, show, open }
}

/// Poke to a workspace window: a notification click left a session for it in
/// [`notification_take_pending_open`].
pub const NOTIFICATION_OPEN_PENDING_EVENT: &str = "notification://open-pending";

/// Sessions a click handed to a workspace window, keyed by that window's
/// label, until its bridge takes them.
static PENDING_OPEN: Mutex<Option<HashMap<String, Vec<NotificationTarget>>>> = Mutex::new(None);

fn park_open(label: &str, target: NotificationTarget) {
    let mut pending = PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner());
    pending
        .get_or_insert_with(HashMap::new)
        .entry(label.to_string())
        .or_default()
        .push(target);
}

fn take_parked(label: &str) -> Vec<NotificationTarget> {
    let mut pending = PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner());
    pending
        .as_mut()
        .and_then(|map| map.remove(label))
        .unwrap_or_default()
}

/// Take the sessions notification clicks left for the calling window.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn notification_take_pending_open(
    window: tauri::WebviewWindow,
) -> Result<Vec<NotificationTarget>, AppCommandError> {
    Ok(take_parked(window.label()))
}

/// Carry out a click: bring the owning workspace window forward and hand it
/// the session. Only macOS reports clicks today; public so the other
/// platforms, which have no caller yet, do not flag it as dead code.
#[cfg(feature = "tauri-runtime")]
pub async fn open_notification_route(app: &AppHandle, route: NotificationRoute) {
    let plan = plan_click(&route, |label| app.get_webview_window(label).is_some());
    if let Some(target) = plan.open.clone() {
        park_open(&plan.label, target);
    }
    match &plan.show {
        ShowWindow::Local => crate::commands::workspace_windows::show_local_workspace_window(app),
        ShowWindow::Focus(label) => crate::commands::windows::show_and_focus_window(app, label),
        ShowWindow::Reopen(id) => {
            let conn = app.state::<crate::db::AppDatabase>().conn.clone();
            let connection =
                crate::db::service::remote_workspace_connection_service::get(&conn, *id).await;
            let shown = match connection {
                Ok(Some(connection)) => {
                    crate::commands::remote_workspace::show_remote_workspace_window(
                        app,
                        &connection,
                    )
                    .map_err(|err| err.to_string())
                }
                Ok(None) => Err(format!("remote connection {id} no longer exists")),
                Err(err) => Err(err.to_string()),
            };
            if let Err(err) = shown {
                // Nowhere left to open the session: still answer the click by
                // bringing codeg forward.
                tracing::warn!("[notification] cannot reopen the remote workspace: {err}");
                let _ = take_parked(&plan.label);
                crate::commands::workspace_windows::reopen_workspace(app);
                return;
            }
        }
    }
    // A window already running takes it now; one still loading drains the
    // slot when its bridge mounts.
    let _ = app.emit_to(plan.label.as_str(), NOTIFICATION_OPEN_PENDING_EVENT, ());
}

/// Install the macOS click handler for notifications posted before this
/// process started (the app updated or restarted since). Notifications posted
/// by this process install it on their own.
#[cfg(feature = "tauri-runtime")]
pub(crate) fn install_click_handler(#[allow(unused_variables)] app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::install(app);
}

#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
mod macos {
    //! `NSUserNotificationCenter` delivery with a delegate of our own.
    //!
    //! `mac-notification-sys` posts through the same center but gives nothing
    //! back on a click unless the send blocks its thread until the user
    //! interacts — for a notification that may sit in Notification Center for
    //! hours — and it replaces the center's delegate on every send. So the
    //! crate is kept for claiming the bundle identity only, and delivery is
    //! done here: the same API, permission and identity as before, plus an
    //! `identifier` (a session's newer notification replaces its older one)
    //! and a `userInfo` route that a click hands to `open_notification_route`.
    #![allow(deprecated)]

    use std::cell::OnceCell;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{class, define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{
        NSDictionary, NSString, NSUserNotification, NSUserNotificationCenter,
        NSUserNotificationCenterDelegate,
    };
    use tauri::AppHandle;

    use super::{
        decode_route, encode_route, notification_group_id, open_notification_route,
        NotificationRoute, ROUTE_USER_INFO_KEY,
    };

    /// The app a click is routed through. Set by the first install or send.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    thread_local! {
        /// The center holds its delegate weakly; this keeps ours alive. Main
        /// thread only, like the delegate itself.
        static DELEGATE: OnceCell<Retained<CodegNotificationDelegate>> = const { OnceCell::new() };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        struct CodegNotificationDelegate;

        unsafe impl NSObjectProtocol for CodegNotificationDelegate {}

        unsafe impl NSUserNotificationCenterDelegate for CodegNotificationDelegate {
            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                // Handled: take it out of Notification Center, as the
                // previous delivery path did after a click.
                center.removeDeliveredNotification(notification);
                let Some(app) = APP.get().cloned() else {
                    return;
                };
                match route_of(notification) {
                    Some(route) => {
                        tauri::async_runtime::spawn(async move {
                            open_notification_route(&app, route).await;
                        });
                    }
                    // No session named (a test send, a notice from the app
                    // itself, a notification from an older build): the click
                    // still means "back to codeg".
                    None => crate::commands::workspace_windows::reopen_workspace(&app),
                }
            }

            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                // Present even while codeg is the active app. Whether to
                // notify at all is decided by the window that raised it
                // (Settings › Notifications, "when"), and a session finishing
                // in one codeg window while the user works in another is
                // exactly what the system's default — stay silent for the
                // frontmost app — hid.
                true
            }
        }
    );

    impl CodegNotificationDelegate {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            // SAFETY: plain `-[NSObject init]`.
            unsafe { msg_send![super(this), init] }
        }
    }

    fn route_of(notification: &NSUserNotification) -> Option<NotificationRoute> {
        let info = notification.userInfo()?;
        let value = info.objectForKey(&NSString::from_str(ROUTE_USER_INFO_KEY))?;
        let raw = value.downcast_ref::<NSString>()?;
        decode_route(&raw.to_string())
    }

    /// The process's notification center, or `None` for a process without a
    /// bundle identifier (a dev build before `set_application` swizzled one
    /// in). Messaged directly because the binding's non-optional return would
    /// panic on that nil.
    fn default_center() -> Option<Retained<NSUserNotificationCenter>> {
        // SAFETY: a class method with no arguments, returning the shared center
        // or nil.
        unsafe { msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter] }
    }

    /// Whether the main bundle has an identifier of its own — a packaged app.
    /// Checked before touching the center at launch, since an unbundled
    /// process gets no center until the first send claims an identity.
    fn has_bundle_identifier() -> bool {
        // SAFETY: `+[NSBundle mainBundle]` and `-bundleIdentifier` take no
        // arguments and return an object or nil.
        unsafe {
            let bundle: Option<Retained<AnyObject>> = msg_send![class!(NSBundle), mainBundle];
            let Some(bundle) = bundle else {
                return false;
            };
            let id: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
            id.is_some()
        }
    }

    /// Point the center at our delegate. Repeated before every send: anything
    /// else posting through the center (the notification plugin, via
    /// `mac-notification-sys`) would otherwise take clicks away for good.
    fn install_delegate(center: &NSUserNotificationCenter, mtm: MainThreadMarker) {
        DELEGATE.with(|cell| {
            let delegate = cell.get_or_init(|| CodegNotificationDelegate::new(mtm));
            // SAFETY: `DELEGATE` keeps the delegate alive for the life of the
            // main thread, i.e. the process.
            unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&**delegate))) };
        });
    }

    pub(super) fn install(app: &AppHandle) {
        let _ = APP.set(app.clone());
        let _ = app.run_on_main_thread(|| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            if !has_bundle_identifier() {
                return;
            }
            if let Some(center) = default_center() {
                install_delegate(&center, mtm);
            }
        });
    }

    /// Deliver one notification. Runs on the main thread.
    pub(super) fn deliver_on_main_thread(
        title: &str,
        body: &str,
        route: Option<&NotificationRoute>,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        let center = default_center().ok_or("this process has no notification center")?;
        install_delegate(&center, mtm);

        let notification = NSUserNotification::new();
        let title = NSString::from_str(title);
        let body = NSString::from_str(body);
        notification.setTitle(Some(&*title));
        notification.setInformativeText(Some(&*body));
        notification.setHasActionButton(false);
        if let Some(route) = route {
            if let Some(id) = notification_group_id(route) {
                let id = NSString::from_str(&id);
                notification.setIdentifier(Some(&*id));
            }
            let key = NSString::from_str(ROUTE_USER_INFO_KEY);
            let value = NSString::from_str(&encode_route(route));
            let object: &AnyObject = &value;
            let user_info = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[object]);
            // SAFETY: the dictionary holds only NSString values, which is what
            // `userInfo` requires (property-list types).
            unsafe { notification.setUserInfo(Some(&*user_info)) };
        }
        center.deliverNotification(&notification);
        Ok(())
    }

    /// Remember the app a click is routed through, for a send that happens
    /// before the launch-time install ran.
    pub(super) fn remember_app(app: &AppHandle) {
        let _ = APP.set(app.clone());
    }
}

/// Candidate commands that open the OS pane governing notification permission,
/// most specific first.
///
/// `bundle_id` is the only non-literal, and it never comes from the renderer:
/// it is either this app's identifier (compiled in from `tauri.conf.json`) or
/// the hard-coded fallback above. It is passed as one argv element to a
/// program spawned directly — there is no shell to inject into. That matters
/// because it is the reason this is a dedicated command rather than a widened
/// `opener` scope: `tauri-plugin-opener`'s default scope only permits
/// `http`/`https`/`mailto`/`tel`, and allowing arbitrary custom schemes through
/// it would open that door for every other piece of renderer code too,
/// including the markdown we render from agent output.
#[cfg(feature = "tauri-runtime")]
fn system_notification_settings_candidates(
    #[allow(unused_variables)] bundle_id: &str,
) -> Vec<(&'static str, Vec<String>)> {
    #[cfg(target_os = "macos")]
    {
        // `?id=` selects the app's own notification page — the one with the
        // "Allow notifications" switch — instead of dropping the user on the
        // list of every app on the machine. Verified on macOS 26 for both the
        // legacy pane id used here and the Ventura-era
        // `com.apple.Notifications-Settings.extension`; the legacy id is kept
        // because it also resolves on macOS 12 and earlier, where the
        // extension id does not exist.
        vec![(
            "open",
            vec![format!(
                "x-apple.systempreferences:com.apple.preference.notifications?id={bundle_id}"
            )],
        )]
    }
    #[cfg(target_os = "windows")]
    {
        // `start` is a `cmd` builtin, not an executable. The empty string is
        // the window title `start` would otherwise take the URL for. No
        // per-app deep link exists here — `ms-settings:notifications` is the
        // finest granularity Windows offers.
        vec![(
            "cmd",
            vec![
                "/C".to_string(),
                "start".to_string(),
                String::new(),
                "ms-settings:notifications".to_string(),
            ],
        )]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No cross-desktop standard exists, so try the two big desktops' panes
        // and give up honestly rather than opening something unrelated.
        vec![
            ("gnome-control-center", vec!["notifications".to_string()]),
            ("systemsettings", vec!["kcm_notifications".to_string()]),
            ("kcmshell6", vec!["kcm_notifications".to_string()]),
            ("kcmshell5", vec!["kcm_notifications".to_string()]),
        ]
    }
}

/// How long to wait for a candidate to fail before treating it as "the pane is
/// open". `open` and `cmd /C start` hand off and exit within milliseconds, but
/// a Linux settings binary launched directly runs for as long as its window is
/// on screen — waiting for THAT to exit would leave the command pending until
/// the user closed System Settings.
#[cfg(feature = "tauri-runtime")]
const SETTINGS_LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_millis(700);

/// Open the OS pane where notification permission for this app is granted or
/// revoked.
///
/// Targets the identity notifications are *actually* delivered under, not
/// necessarily this app's own — sending the user to codeg's page while the OS
/// files the notifications under another app would point them at switches that
/// change nothing.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_system_notification_settings(app: AppHandle) -> Result<(), AppCommandError> {
    // `Some` on exactly the platform whose candidates interpolate it; the
    // others take a literal URL and ignore the argument entirely.
    let bundle_id = resolve_notification_identity(&app)
        .map(|identity| identity.bundle_id.clone())
        .unwrap_or_default();
    let mut last_error: Option<String> = None;

    for (program, args) in system_notification_settings_candidates(&bundle_id) {
        let child = crate::process::tokio_command(program).args(&args).spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(err) => {
                // The binary isn't installed — this desktop isn't the one this
                // candidate is for. Move on to the next.
                last_error = Some(format!("`{program}` could not be started: {err}"));
                continue;
            }
        };

        // Waiting (rather than detaching immediately) is what turns "this
        // desktop has no such pane" into a signal instead of a silent no-op:
        // `gnome-control-center` exits non-zero for a panel it doesn't know.
        // Dropping the `Child` on timeout leaves the process running; tokio's
        // orphan queue reaps it, so nothing becomes a zombie.
        match tokio::time::timeout(SETTINGS_LAUNCH_GRACE, child.wait()).await {
            Err(_elapsed) => return Ok(()),
            Ok(Ok(status)) if status.success() => return Ok(()),
            Ok(Ok(status)) => {
                last_error = Some(format!("`{program}` exited with {status}"));
            }
            Ok(Err(err)) => {
                last_error = Some(format!("`{program}` could not be waited on: {err}"));
            }
        }
    }

    Err(
        AppCommandError::new(
            AppErrorCode::DependencyMissing,
            "Could not open the system notification settings on this desktop",
        )
        .with_detail(last_error.unwrap_or_else(|| "no candidate command available".to_string())),
    )
}

#[cfg(all(test, feature = "tauri-runtime"))]
mod tests {
    use super::*;

    #[test]
    fn every_candidate_has_a_program_to_run() {
        let candidates = system_notification_settings_candidates("app.example");
        assert!(!candidates.is_empty());
        for (program, _) in &candidates {
            assert!(!program.is_empty());
        }
    }

    /// The `?id=` suffix is the difference between landing on the app's own
    /// notification page and dumping the user on the list of every app
    /// installed, which is what shipped before.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_deep_links_to_the_delivering_app() {
        let candidates = system_notification_settings_candidates("app.example");
        let (program, args) = &candidates[0];
        assert_eq!(*program, "open");
        assert_eq!(
            args,
            &vec![
                "x-apple.systempreferences:com.apple.preference.notifications?id=app.example"
                    .to_string()
            ]
        );
    }

    /// The fallback is the crate's, not ours — if this constant ever drifts
    /// from the literal in `mac-notification-sys`'s swizzled getter, the
    /// settings panel starts naming an app that isn't the one receiving the
    /// notifications.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_fallback_matches_the_crate_default() {
        assert_eq!(MACOS_FALLBACK_BUNDLE_ID, "com.apple.Terminal");
    }

    fn target(context_key: Option<&str>, conversation_id: Option<i32>) -> NotificationTarget {
        NotificationTarget {
            context_key: context_key.map(str::to_string),
            folder_id: conversation_id.map(|_| 4),
            conversation_id,
            agent_type: conversation_id.map(|_| "claude_code".to_string()),
        }
    }

    fn route(window: &str, remote: Option<i32>, target: NotificationTarget) -> NotificationRoute {
        NotificationRoute {
            window: window.to_string(),
            remote_connection_id: remote,
            target,
        }
    }

    #[test]
    fn a_route_survives_the_round_trip_through_user_info() {
        let original = route(
            "remote-workspace-3",
            Some(3),
            target(Some("conv-4-claude_code-17"), Some(17)),
        );
        let encoded = encode_route(&original);
        assert_eq!(decode_route(&encoded), Some(original));
    }

    #[test]
    fn the_encoding_is_the_frontends_camel_case() {
        let encoded = encode_route(&route("main", None, target(Some("t1"), Some(9))));
        let json: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(json["window"], "main");
        assert_eq!(json["remoteConnectionId"], serde_json::Value::Null);
        assert_eq!(json["target"]["contextKey"], "t1");
        assert_eq!(json["target"]["folderId"], 4);
        assert_eq!(json["target"]["conversationId"], 9);
        assert_eq!(json["target"]["agentType"], "claude_code");
    }

    /// Notifications outlive the build that posted them: a payload missing
    /// fields still routes, and anything that is not a route is ignored
    /// rather than guessed at.
    #[test]
    fn decoding_tolerates_missing_fields_and_rejects_garbage() {
        assert_eq!(
            decode_route(r#"{"window":"main"}"#),
            Some(route("main", None, NotificationTarget::default()))
        );
        assert_eq!(
            decode_route(r#"{"window":"main","target":{"conversationId":5}}"#)
                .map(|r| r.target.conversation_id),
            Some(Some(5))
        );
        assert_eq!(decode_route(""), None);
        assert_eq!(decode_route("not json"), None);
        assert_eq!(decode_route(r#"{"target":{}}"#), None);
        assert_eq!(decode_route(r#"{"window":""}"#), None);
    }

    #[test]
    fn a_session_keeps_one_notification_per_window() {
        let first = route("main", None, target(Some("t1"), Some(9)));
        // A later notification from the same session, raised from another tab
        // key (a canvas card, a re-opened tab), is the same session.
        let again = route("main", None, target(Some("t2"), Some(9)));
        assert_eq!(notification_group_id(&first), notification_group_id(&again));
        assert_eq!(
            notification_group_id(&first).as_deref(),
            Some("codeg.session.main.c9")
        );

        // Conversation ids are per backend.
        let remote = route("remote-workspace-3", Some(3), target(Some("t1"), Some(9)));
        assert_ne!(notification_group_id(&first), notification_group_id(&remote));

        // A draft is identified by its tab until it has a row.
        let draft = route("main", None, target(Some("new-1"), None));
        assert_eq!(
            notification_group_id(&draft).as_deref(),
            Some("codeg.session.main.knew-1")
        );

        // Naming no session, a notification stands alone.
        assert_eq!(
            notification_group_id(&route("main", None, NotificationTarget::default())),
            None
        );
    }

    #[test]
    fn a_windows_backend_comes_from_its_label_or_its_route() {
        assert_eq!(backend_of_window("main", None), None);
        assert_eq!(backend_of_window("remote-workspace-7", None), Some(7));
        let quick_ask =
            tauri::Url::parse("tauri://localhost/quick-ask?remoteConnectionId=4&remoteWindowId=x")
                .unwrap();
        assert_eq!(backend_of_window("quick-ask", Some(&quick_ask)), Some(4));
        let local_quick_ask = tauri::Url::parse("tauri://localhost/quick-ask").unwrap();
        assert_eq!(backend_of_window("quick-ask", Some(&local_quick_ask)), None);
        // The label wins: a workspace window's backend is its identity.
        assert_eq!(backend_of_window("main", Some(&quick_ask)), None);
    }

    #[test]
    fn a_local_session_opens_in_the_local_workspace() {
        let t = target(Some("conv-4-claude_code-17"), Some(17));
        let plan = plan_click(&route("main", None, t.clone()), |_| false);
        assert_eq!(
            plan,
            ClickPlan {
                label: "main".to_string(),
                show: ShowWindow::Local,
                open: Some(t),
            }
        );
    }

    #[test]
    fn a_remote_session_opens_in_its_open_remote_window() {
        let t = target(Some("conv-4-claude_code-17"), Some(17));
        let plan = plan_click(&route("remote-workspace-3", Some(3), t.clone()), |label| {
            label == "remote-workspace-3"
        });
        assert_eq!(
            plan,
            ClickPlan {
                label: "remote-workspace-3".to_string(),
                show: ShowWindow::Focus("remote-workspace-3".to_string()),
                open: Some(t),
            }
        );
    }

    #[test]
    fn a_closed_remote_window_is_rebuilt_for_the_click() {
        let t = target(Some("conv-4-claude_code-17"), Some(17));
        let plan = plan_click(&route("remote-workspace-3", Some(3), t.clone()), |_| false);
        assert_eq!(plan.label, "remote-workspace-3");
        assert_eq!(plan.show, ShowWindow::Reopen(3));
        // The rebuilt window has none of the old tabs, but the conversation
        // still opens there.
        assert_eq!(plan.open, Some(t));
    }

    /// The route's own backend field never overrides the window it came from:
    /// a workspace window's label is what it is bound to.
    #[test]
    fn the_raising_windows_label_decides_the_backend() {
        let t = target(Some("t1"), Some(2));
        let plan = plan_click(&route("main", Some(3), t), |_| true);
        assert_eq!(plan.label, "main");
        assert_eq!(plan.show, ShowWindow::Local);
    }

    #[test]
    fn quick_ask_sessions_open_in_their_backends_workspace() {
        let t = target(Some("quick-ask-tab"), Some(21));
        let plan = plan_click(&route("quick-ask", Some(5), t), |label| {
            label == "remote-workspace-5"
        });
        assert_eq!(plan.label, "remote-workspace-5");
        assert_eq!(plan.show, ShowWindow::Focus("remote-workspace-5".to_string()));
        // Its tab key names a tab in the Quick Ask window, not the workspace.
        let open = plan.open.expect("the conversation travels");
        assert_eq!(open.context_key, None);
        assert_eq!(open.conversation_id, Some(21));

        // A Quick Ask draft has nothing that could open elsewhere.
        let draft = plan_click(
            &route("quick-ask", None, target(Some("quick-ask-tab"), None)),
            |_| true,
        );
        assert_eq!(draft.label, "main");
        assert_eq!(draft.open, None);
    }

    #[test]
    fn a_notification_naming_no_session_only_brings_the_window_forward() {
        let plan = plan_click(
            &route("remote-workspace-2", Some(2), NotificationTarget::default()),
            |_| true,
        );
        assert_eq!(plan.show, ShowWindow::Focus("remote-workspace-2".to_string()));
        assert_eq!(plan.open, None);
    }

    #[test]
    fn parked_sessions_are_taken_once_per_window() {
        let a = target(Some("a"), Some(1));
        let b = target(Some("b"), Some(2));
        park_open("test-window-x", a.clone());
        park_open("test-window-x", b.clone());
        park_open("test-window-y", a.clone());
        assert_eq!(take_parked("test-window-x"), vec![a.clone(), b]);
        assert!(take_parked("test-window-x").is_empty());
        assert_eq!(take_parked("test-window-y"), vec![a]);
    }
}
