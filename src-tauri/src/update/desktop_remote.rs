//! Self-update of the desktop app, asked for by a remote window.
//!
//! A codeg window connected to this machine's embedded web server (a remote
//! workspace) can update the desktop app it is talking to. The work is the
//! same `tauri-plugin-updater` path the local Update button takes — check the
//! release feed, download, verify the signature, install, relaunch — but it is
//! driven here in the backend, so it survives the remote window sleeping or
//! losing its connection, and it is split so the install can wait for the
//! machine to go quiet:
//!
//! * `now` — download, install, restart. Turns the restart cuts off come back
//!   through the automatic resume (`acp::auto_resume`), when it is on.
//! * `when_idle` — download now, then wait until no session has been mid-turn
//!   for [`IDLE_QUIET`], then install and restart. It can be cancelled until
//!   the install starts, and told to go ahead now.
//! * no mode (an older client) — download and install, then stop at
//!   `ReadyToRestart` for the client's own `restart_app`, like the local
//!   button.
//!
//! The plugin's guarantees hold: only a release newer than the running build
//! is offered (and the version is checked again here, so nothing is ever
//! downgraded), and the download is rejected unless its signature verifies
//! against the public key built into the app. Both happen before anything on
//! disk is touched, so a failed or tampered download leaves the installed app
//! as it was. Every step is logged under `[update]`.
//!
//! The flow is written against small traits ([`ReleaseFeed`], [`Release`],
//! [`BusyProbe`], [`Relauncher`]) so it can be tested without a network, an
//! app bundle or a process to restart; [`start`] wires in the real ones.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::app_error::AppCommandError;
use crate::update::busy::{self, BusySession};
use crate::update::runtime::UpdateCapability;
use crate::update::state::{
    self as update_state, AppUpdateLifecycle, AppUpdateState, AppUpdateStateHandle, UpdateMode,
};
use crate::update::version;
use crate::web::event_bridge::EventEmitter;

/// How long no session may have been mid-turn before a `when_idle` update
/// installs and restarts.
pub const IDLE_QUIET: Duration = Duration::from_secs(60);

/// How often the `when_idle` wait looks at the sessions.
const IDLE_POLL: Duration = Duration::from_secs(2);

/// Pause between announcing `Restarting` and relaunching, so the event reaches
/// the connected windows before their sockets drop.
const RESTART_FLUSH: Duration = Duration::from_millis(750);

/// Bound on the release-feed check (the plugin applies none of its own). The
/// download itself stays unbounded: a slow but progressing transfer must not
/// be killed.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// What a remote-requested update needs to know before it may restart: that
/// the window asking for it can get back in afterwards. The app starts its web
/// service on launch only with auto-start on, and then on the saved port with
/// the saved token — so all three must match what is running now.
pub const I18N_KEY_WONT_RECONNECT: &str = "SystemSettings.updateErrors.remoteWontReconnect";

// ─── Seams ───────────────────────────────────────────────────────────────

/// Where releases come from.
#[async_trait]
pub trait ReleaseFeed: Send + Sync {
    /// The newer release on offer, or `None` when the running build is the
    /// newest.
    async fn check(&self) -> Result<Option<Box<dyn Release>>, String>;
}

/// One release on offer.
#[async_trait]
pub trait Release: Send + Sync {
    fn version(&self) -> String;
    /// Download the bundle and verify its signature; `on_chunk(len, total)`
    /// reports progress. Nothing on disk changes.
    async fn download(
        &self,
        on_chunk: Box<dyn FnMut(usize, Option<u64>) + Send>,
    ) -> Result<Vec<u8>, String>;
    /// Install verified bytes over the installed app.
    async fn install(&self, bytes: Vec<u8>) -> Result<(), String>;
}

/// Which sessions are mid-turn right now.
#[async_trait]
pub trait BusyProbe: Send + Sync {
    async fn busy_sessions(&self) -> Result<Vec<BusySession>, String>;
}

/// Restarts the app into what is installed.
pub trait Relauncher: Send + Sync {
    fn relaunch(&self);
}

// ─── Idle wait ───────────────────────────────────────────────────────────

/// Tracks how long the machine has been quiet: true once no observation in
/// the whole `quiet` window found a session mid-turn. Any busy observation
/// starts the window over.
#[derive(Debug)]
pub struct IdleGate {
    quiet: Duration,
    idle_since: Option<Instant>,
}

impl IdleGate {
    pub fn new(quiet: Duration) -> Self {
        Self {
            quiet,
            idle_since: None,
        }
    }

    /// Record one observation; true once the machine has been quiet long
    /// enough.
    pub fn observe(&mut self, busy: bool, now: Instant) -> bool {
        if busy {
            self.idle_since = None;
            return false;
        }
        let since = *self.idle_since.get_or_insert(now);
        now.saturating_duration_since(since) >= self.quiet
    }

    /// Quiet time still needed, or `None` while something is busy (or before
    /// the first observation).
    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        self.idle_since
            .map(|since| self.quiet.saturating_sub(now.saturating_duration_since(since)))
    }
}

/// What the client can tell an update in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Directive {
    /// Carry on as asked.
    Proceed,
    /// Stop before installing; leave the app as it is.
    Cancel,
    /// Stop waiting for idle and install now.
    Now,
}

// ─── The flow ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub quiet: Duration,
    pub poll: Duration,
    pub restart_flush: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            quiet: IDLE_QUIET,
            poll: IDLE_POLL,
            restart_flush: RESTART_FLUSH,
        }
    }
}

pub struct Deps {
    pub feed: Arc<dyn ReleaseFeed>,
    pub probe: Arc<dyn BusyProbe>,
    pub relauncher: Arc<dyn Relauncher>,
    pub handle: AppUpdateStateHandle,
    pub emitter: EventEmitter,
    /// The version running now; the release must be newer.
    pub running_version: String,
    pub timing: Timing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Installed; the app is relaunching.
    Restarting,
    /// Installed; waiting for the client's `restart_app` (no mode).
    Staged,
    /// Called off before the install; nothing changed.
    Cancelled,
    /// Failed; the state carries the message.
    Failed(String),
}

fn fail(deps: &Deps, message: impl Into<String>) -> Outcome {
    let message = message.into();
    tracing::warn!("[update] remote-requested update failed: {message}");
    update_state::set_error(&deps.handle, &deps.emitter, message.clone());
    Outcome::Failed(message)
}

fn cancelled(deps: &Deps, during: &str) -> Outcome {
    tracing::info!(
        "[update] remote-requested update cancelled during {during}; nothing was installed"
    );
    update_state::set_idle(&deps.handle, &deps.emitter);
    Outcome::Cancelled
}

/// Read a directive change. `None` when the sender is gone (treated as
/// "carry on": nobody is left to cancel).
async fn next_directive(rx: &mut watch::Receiver<Directive>) -> Option<Directive> {
    rx.changed().await.ok()?;
    Some(*rx.borrow_and_update())
}

async fn probe_busy(deps: &Deps) -> Option<Vec<BusySession>> {
    match deps.probe.busy_sessions().await {
        Ok(busy) => Some(busy),
        Err(e) => {
            // Unknown counts as busy: a failed read must never look quiet.
            tracing::warn!("[update] could not list busy sessions: {e}");
            None
        }
    }
}

enum WaitEnd {
    Quiet,
    Now,
    Cancelled,
}

/// Hold the verified download until the machine has been quiet for the whole
/// window, publishing what it waits on whenever that changes.
async fn wait_for_idle(
    deps: &Deps,
    gate: &mut IdleGate,
    directives: &mut watch::Receiver<Directive>,
    directives_open: &mut bool,
) -> WaitEnd {
    let quiet_secs = deps.timing.quiet.as_secs();
    let mut published: Option<(Vec<BusySession>, Option<u64>)> = None;
    tracing::info!("[update] waiting until no session has been mid-turn for {quiet_secs}s");
    loop {
        let busy = probe_busy(deps).await;
        let now = Instant::now();
        if gate.observe(busy.as_ref().is_none_or(|b| !b.is_empty()), now) {
            tracing::info!("[update] no session mid-turn for {quiet_secs}s; installing");
            return WaitEnd::Quiet;
        }
        let left = gate
            .remaining(now)
            .map(|d| d.as_secs() + u64::from(d.subsec_nanos() > 0));
        let view = (busy.unwrap_or_default(), left);
        if published.as_ref() != Some(&view) {
            if published.as_ref().map(|p| p.0.len()) != Some(view.0.len()) {
                tracing::info!("[update] {} session(s) mid-turn", view.0.len());
            }
            update_state::set_waiting_for_idle(
                &deps.handle,
                &deps.emitter,
                view.0.clone(),
                view.1,
                quiet_secs,
            );
            published = Some(view);
        }
        tokio::select! {
            _ = tokio::time::sleep(deps.timing.poll) => {}
            directive = next_directive(directives), if *directives_open => match directive {
                Some(Directive::Cancel) => return WaitEnd::Cancelled,
                Some(Directive::Now) => {
                    tracing::info!("[update] asked to stop waiting; installing now");
                    return WaitEnd::Now;
                }
                Some(Directive::Proceed) => {}
                None => *directives_open = false,
            },
        }
    }
}

/// Run one remote-requested update to its end. The caller has already
/// claimed the update state (`try_begin`), so the state reads `Downloading`.
pub async fn run(
    deps: Deps,
    mode: Option<UpdateMode>,
    mut directives: watch::Receiver<Directive>,
) -> Outcome {
    tracing::info!("[update] remote-requested update ({mode:?}): checking the release feed");
    let release = match deps.feed.check().await {
        Ok(Some(release)) => release,
        Ok(None) => return fail(&deps, "No update available"),
        Err(e) => return fail(&deps, format!("Update check failed: {e}")),
    };
    let target = release.version();
    if !version::is_newer(&target, &deps.running_version) {
        return fail(
            &deps,
            format!(
                "Refusing to install v{target}: it is not newer than the running v{}",
                deps.running_version
            ),
        );
    }
    update_state::set_target(&deps.handle, &deps.emitter, target.clone(), mode);
    tracing::info!(
        "[update] downloading v{target} (running v{})",
        deps.running_version
    );

    // The quiet window starts counting now, so a long download already counts
    // toward it.
    let when_idle = mode == Some(UpdateMode::WhenIdle);
    let mut gate = IdleGate::new(deps.timing.quiet);
    let mut directives_open = true;
    let mut skip_wait = false;

    let progress = Arc::new(update_state::ProgressEmitter::new(
        deps.handle.clone(),
        deps.emitter.clone(),
    ));
    let mut downloaded: u64 = 0;
    let download = release.download(Box::new(move |len: usize, total: Option<u64>| {
        downloaded += len as u64;
        progress.downloading(downloaded, total);
    }));
    tokio::pin!(download);
    let mut ticker = tokio::time::interval(deps.timing.poll);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let bytes = loop {
        tokio::select! {
            result = &mut download => match result {
                Ok(bytes) => break bytes,
                Err(e) => return fail(&deps, format!("Download failed: {e}")),
            },
            directive = next_directive(&mut directives), if directives_open => match directive {
                Some(Directive::Cancel) => return cancelled(&deps, "the download"),
                Some(Directive::Now) => skip_wait = true,
                Some(Directive::Proceed) => {}
                None => directives_open = false,
            },
            _ = ticker.tick(), if when_idle => {
                let busy = probe_busy(&deps).await;
                gate.observe(busy.is_none_or(|b| !b.is_empty()), Instant::now());
            }
        }
    };
    tracing::info!(
        "[update] v{target} downloaded ({} bytes) and its signature verified",
        bytes.len()
    );

    if when_idle && !skip_wait {
        match wait_for_idle(&deps, &mut gate, &mut directives, &mut directives_open).await {
            WaitEnd::Quiet | WaitEnd::Now => {}
            WaitEnd::Cancelled => return cancelled(&deps, "the wait for idle"),
        }
    }

    update_state::set_installing(&deps.handle, &deps.emitter);
    tracing::info!("[update] installing v{target}");
    if let Err(e) = release.install(bytes).await {
        return fail(&deps, format!("Install failed: {e}"));
    }
    tracing::info!("[update] v{target} installed");

    update_state::set_ready(
        &deps.handle,
        &deps.emitter,
        Some(target.clone()),
        None,
        None,
        Some(UpdateCapability::Desktop),
    );
    if mode.is_none() {
        tracing::info!("[update] v{target} staged; waiting for the client to restart");
        return Outcome::Staged;
    }
    // The same claim the restart buttons take, so a restart clicked on this
    // machine at the same moment can't relaunch twice.
    if !update_state::try_claim_restart(&deps.handle, &deps.emitter) {
        tracing::info!("[update] a restart is already under way");
        return Outcome::Restarting;
    }
    update_state::annotate_restarting(&deps.handle, &deps.emitter, Some(target.clone()), mode);
    tracing::info!("[update] restarting into v{target}");
    tokio::time::sleep(deps.timing.restart_flush).await;
    deps.relauncher.relaunch();
    Outcome::Restarting
}

// ─── The one update in flight ─────────────────────────────────────────────

/// Directive channel of the remote-requested update in flight, tagged with an
/// id so a finished run never clears a newer one's.
static ACTIVE: Mutex<Option<(u64, watch::Sender<Directive>)>> = Mutex::new(None);
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn register() -> (u64, watch::Receiver<Directive>) {
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = watch::channel(Directive::Proceed);
    *ACTIVE.lock().unwrap_or_else(|p| p.into_inner()) = Some((id, tx));
    (id, rx)
}

fn unregister(id: u64) {
    let mut slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    if slot.as_ref().is_some_and(|(active, _)| *active == id) {
        *slot = None;
    }
}

/// Send a directive to the remote-requested update in flight. False when
/// there is none (e.g. the update was started from this machine's own
/// window, which these directives don't reach).
fn send_directive(directive: Directive) -> bool {
    let slot = ACTIVE.lock().unwrap_or_else(|p| p.into_inner());
    slot.as_ref().is_some_and(|(_, tx)| tx.send(directive).is_ok())
}

/// Begin (or attach to) a remote-requested update and return the snapshot
/// right away; the work runs detached. Attaching with `now` to an update that
/// waits for idle makes it go ahead.
pub fn begin(deps: Deps, mode: Option<UpdateMode>) -> AppUpdateState {
    let (started, snap) = update_state::try_begin(&deps.handle, &deps.emitter);
    if !started {
        if mode == Some(UpdateMode::Now)
            && snap.status == AppUpdateLifecycle::WaitingForIdle
            && send_directive(Directive::Now)
        {
            tracing::info!("[update] remote client asked the waiting update to go ahead now");
        }
        return snap;
    }
    let (id, rx) = register();
    tokio::spawn(async move {
        let outcome = run(deps, mode, rx).await;
        unregister(id);
        tracing::info!("[update] remote-requested update ended: {outcome:?}");
    });
    snap
}

/// Call off the remote-requested update in flight, while it is still
/// downloading or waiting for idle. Returns the current snapshot; the state
/// moves to `Idle` once the flow has stopped.
pub fn cancel(handle: &AppUpdateStateHandle) -> Result<AppUpdateState, AppCommandError> {
    let snap = update_state::snapshot(handle);
    match snap.status {
        AppUpdateLifecycle::Downloading | AppUpdateLifecycle::WaitingForIdle => {
            if send_directive(Directive::Cancel) {
                tracing::info!("[update] remote client cancelled the update");
                Ok(snap)
            } else {
                Err(AppCommandError::invalid_input(
                    "This update was started on the machine itself and can only be stopped there",
                ))
            }
        }
        _ => Err(AppCommandError::invalid_input(
            "Nothing to cancel: no update is downloading or waiting",
        )),
    }
}

/// Why a remote window could not get back in after this machine restarts, if
/// it couldn't: see [`I18N_KEY_WONT_RECONNECT`]. `running` is the port and
/// token the web service runs on now.
pub fn reconnect_blocker(
    config: &crate::web::WebServiceConfig,
    running: Option<(u16, String)>,
) -> Option<AppCommandError> {
    let why = match running {
        _ if !config.auto_start => "the web service is not set to start with the app",
        None => "the web service is not running",
        Some((port, _))
            if config.port.unwrap_or(crate::web::DEFAULT_WEB_SERVICE_PORT) != port =>
        {
            "the web service would come back on a different port"
        }
        Some((_, token)) if config.token.as_deref() != Some(token.as_str()) => {
            "the web service would come back with a different access token"
        }
        Some(_) => return None,
    };
    Some(
        AppCommandError::invalid_input(format!(
            "A remote window can't update this app: {why}, so it could not reconnect after the restart"
        ))
        .with_i18n(I18N_KEY_WONT_RECONNECT, BTreeMap::new()),
    )
}

/// [`reconnect_blocker`] for this app as it runs now. A configuration that
/// can't be read blocks too: an update that might strand the remote window is
/// not worth the risk.
pub async fn update_blocker(
    app: &tauri::AppHandle,
    state: &crate::app_state::AppState,
) -> Option<AppCommandError> {
    use tauri::Manager;
    let config = match crate::web::load_web_service_config(&state.db.conn).await {
        Ok(config) => config,
        Err(e) => return Some(e),
    };
    let running = app
        .try_state::<crate::web::WebServerState>()
        .and_then(|ws| ws.running_endpoint());
    reconnect_blocker(&config, running)
}

/// The relaunch delay reported to clients for a desktop restart — roughly how
/// long the app takes to quit, relaunch and bring its web service back.
pub const DESKTOP_RESTART_DELAY_MS: u64 = 4000;

// ─── The real seams ───────────────────────────────────────────────────────

struct TauriFeed(tauri::AppHandle);

#[async_trait]
impl ReleaseFeed for TauriFeed {
    async fn check(&self) -> Result<Option<Box<dyn Release>>, String> {
        use tauri_plugin_updater::UpdaterExt;
        let updater = self.0.updater().map_err(|e| e.to_string())?;
        let update = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
            .await
            // "timed out" is what the frontend keys on to call it a network
            // problem.
            .map_err(|_| "Update check timed out".to_string())?
            .map_err(|e| e.to_string())?;
        Ok(update.map(|u| Box::new(TauriRelease(u)) as Box<dyn Release>))
    }
}

struct TauriRelease(tauri_plugin_updater::Update);

#[async_trait]
impl Release for TauriRelease {
    fn version(&self) -> String {
        self.0.version.clone()
    }

    async fn download(
        &self,
        on_chunk: Box<dyn FnMut(usize, Option<u64>) + Send>,
    ) -> Result<Vec<u8>, String> {
        // `download` verifies the minisign signature against the app's
        // built-in public key before returning the bytes.
        self.0
            .download(on_chunk, || {})
            .await
            .map_err(|e| e.to_string())
    }

    async fn install(&self, bytes: Vec<u8>) -> Result<(), String> {
        let update = self.0.clone();
        tokio::task::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| format!("install task failed: {e}"))?
            .map_err(|e| e.to_string())
    }
}

struct LiveProbe {
    manager: crate::acp::manager::ConnectionManager,
    db: sea_orm::DatabaseConnection,
}

#[async_trait]
impl BusyProbe for LiveProbe {
    async fn busy_sessions(&self) -> Result<Vec<BusySession>, String> {
        busy::list_busy_sessions(&self.manager, &self.db)
            .await
            .map_err(|e| e.to_string())
    }
}

struct TauriRelauncher(tauri::AppHandle);

impl Relauncher for TauriRelauncher {
    fn relaunch(&self) {
        // Goes through `RunEvent::ExitRequested`, which marks the turns being
        // cut off for the automatic resume, exactly like a quit.
        self.0.request_restart();
    }
}

/// [`Deps`] wired to the running app.
pub fn live_deps(app: &tauri::AppHandle, state: &crate::app_state::AppState) -> Deps {
    Deps {
        feed: Arc::new(TauriFeed(app.clone())),
        probe: Arc::new(LiveProbe {
            manager: state.connection_manager.clone_ref(),
            db: state.db.conn.clone(),
        }),
        relauncher: Arc::new(TauriRelauncher(app.clone())),
        handle: state.update_state.clone(),
        emitter: state.emitter.clone(),
        running_version: version::running_app_version().to_string(),
        timing: Timing::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::busy::BusyReason;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    // ── Fakes ──

    #[derive(Clone)]
    struct FakeRelease {
        version: String,
        chunks: Vec<usize>,
        /// Delay before the download completes.
        download_time: Duration,
        download_error: Option<String>,
        install_error: Option<String>,
        installed: Arc<AtomicBool>,
    }

    impl FakeRelease {
        fn new(version: &str) -> Self {
            Self {
                version: version.to_string(),
                chunks: vec![40, 60],
                download_time: Duration::from_secs(1),
                download_error: None,
                install_error: None,
                installed: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    #[async_trait]
    impl Release for FakeRelease {
        fn version(&self) -> String {
            self.version.clone()
        }
        async fn download(
            &self,
            mut on_chunk: Box<dyn FnMut(usize, Option<u64>) + Send>,
        ) -> Result<Vec<u8>, String> {
            let total: usize = self.chunks.iter().sum();
            for c in &self.chunks {
                on_chunk(*c, Some(total as u64));
            }
            tokio::time::sleep(self.download_time).await;
            match &self.download_error {
                Some(e) => Err(e.clone()),
                None => Ok(vec![0; total]),
            }
        }
        async fn install(&self, _bytes: Vec<u8>) -> Result<(), String> {
            match &self.install_error {
                Some(e) => Err(e.clone()),
                None => {
                    self.installed.store(true, Ordering::SeqCst);
                    Ok(())
                }
            }
        }
    }

    struct FakeFeed(Option<FakeRelease>);

    #[async_trait]
    impl ReleaseFeed for FakeFeed {
        async fn check(&self) -> Result<Option<Box<dyn Release>>, String> {
            Ok(self.0.clone().map(|r| Box::new(r) as Box<dyn Release>))
        }
    }

    /// Busy for the first `busy_polls` probes, then quiet.
    struct FakeProbe {
        busy_polls: usize,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl BusyProbe for FakeProbe {
        async fn busy_sessions(&self) -> Result<Vec<BusySession>, String> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(if n < self.busy_polls {
                vec![BusySession {
                    conversation_id: Some(1),
                    folder_id: Some(1),
                    title: Some("Busy".into()),
                    agent_type: None,
                    reason: BusyReason::Working,
                }]
            } else {
                Vec::new()
            })
        }
    }

    #[derive(Default)]
    struct FakeRelauncher(AtomicBool);

    impl Relauncher for FakeRelauncher {
        fn relaunch(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    struct Rig {
        deps: Deps,
        relauncher: Arc<FakeRelauncher>,
        handle: AppUpdateStateHandle,
    }

    fn rig(release: Option<FakeRelease>, busy_polls: usize) -> Rig {
        let handle = update_state::new_handle();
        let relauncher = Arc::new(FakeRelauncher::default());
        let deps = Deps {
            feed: Arc::new(FakeFeed(release)),
            probe: Arc::new(FakeProbe {
                busy_polls,
                calls: AtomicUsize::new(0),
            }),
            relauncher: relauncher.clone(),
            handle: handle.clone(),
            emitter: EventEmitter::Noop,
            running_version: "1.0.0-fork.1".into(),
            timing: Timing::default(),
        };
        // `run` expects the caller to have claimed the state already.
        assert!(update_state::try_begin(&handle, &EventEmitter::Noop).0);
        Rig {
            deps,
            relauncher,
            handle,
        }
    }

    fn status(h: &AppUpdateStateHandle) -> AppUpdateLifecycle {
        update_state::snapshot(h).status
    }

    // ── Idle gate ──

    #[tokio::test(start_paused = true)]
    async fn the_gate_opens_only_after_a_full_quiet_window() {
        let mut gate = IdleGate::new(Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(!gate.observe(false, t0));
        assert_eq!(gate.remaining(t0), Some(Duration::from_secs(60)));
        assert!(!gate.observe(false, t0 + Duration::from_secs(59)));
        assert!(gate.observe(false, t0 + Duration::from_secs(60)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_observation_starts_the_window_over() {
        let mut gate = IdleGate::new(Duration::from_secs(60));
        let t0 = Instant::now();
        gate.observe(false, t0);
        assert!(!gate.observe(true, t0 + Duration::from_secs(50)));
        assert_eq!(gate.remaining(t0 + Duration::from_secs(50)), None);
        assert!(!gate.observe(false, t0 + Duration::from_secs(70)));
        assert!(!gate.observe(false, t0 + Duration::from_secs(129)));
        assert!(gate.observe(false, t0 + Duration::from_secs(130)));
    }

    // ── The flow ──

    #[tokio::test(start_paused = true)]
    async fn now_downloads_installs_and_restarts() {
        let release = FakeRelease::new("1.0.0-fork.2");
        let installed = release.installed.clone();
        let r = rig(Some(release), 0);
        let (_tx, rx) = watch::channel(Directive::Proceed);

        let outcome = run(r.deps, Some(UpdateMode::Now), rx).await;

        assert_eq!(outcome, Outcome::Restarting);
        assert!(installed.load(Ordering::SeqCst));
        assert!(r.relauncher.0.load(Ordering::SeqCst));
        let snap = update_state::snapshot(&r.handle);
        assert_eq!(snap.status, AppUpdateLifecycle::Restarting);
        // Clients attaching mid-restart still learn the target.
        assert_eq!(snap.version.as_deref(), Some("1.0.0-fork.2"));
    }

    #[tokio::test(start_paused = true)]
    async fn no_mode_stops_at_ready_to_restart_for_an_older_client() {
        let r = rig(Some(FakeRelease::new("1.0.0-fork.2")), 0);
        let (_tx, rx) = watch::channel(Directive::Proceed);

        assert_eq!(run(r.deps, None, rx).await, Outcome::Staged);
        let snap = update_state::snapshot(&r.handle);
        assert_eq!(snap.status, AppUpdateLifecycle::ReadyToRestart);
        assert_eq!(snap.capability, Some(UpdateCapability::Desktop));
        assert!(!r.relauncher.0.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn when_idle_waits_for_a_full_quiet_window_then_installs() {
        let release = FakeRelease::new("1.0.0-fork.2");
        let installed = release.installed.clone();
        // Busy for the first 5 probes (10 s at the 2 s poll), then quiet.
        let r = rig(Some(release), 5);
        let handle = r.handle.clone();
        let relauncher = r.relauncher.clone();
        let (_tx, rx) = watch::channel(Directive::Proceed);
        let started = Instant::now();

        let task = tokio::spawn(run(r.deps, Some(UpdateMode::WhenIdle), rx));
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(status(&handle), AppUpdateLifecycle::WaitingForIdle);
        let waiting = update_state::snapshot(&handle);
        assert_eq!(waiting.busy_sessions.as_ref().map(Vec::len), Some(1));
        assert_eq!(waiting.quiet_secs_left, None, "busy: no countdown yet");
        assert_eq!(waiting.quiet_secs, Some(60));
        assert!(!installed.load(Ordering::SeqCst));

        tokio::time::sleep(Duration::from_secs(30)).await;
        let waiting = update_state::snapshot(&handle);
        assert_eq!(waiting.busy_sessions.as_ref().map(Vec::len), Some(0));
        assert!(waiting.quiet_secs_left.is_some_and(|s| s > 0 && s <= 60));
        assert!(!installed.load(Ordering::SeqCst), "not quiet long enough yet");

        assert_eq!(task.await.unwrap(), Outcome::Restarting);
        assert!(installed.load(Ordering::SeqCst));
        assert!(relauncher.0.load(Ordering::SeqCst));
        let waited = Instant::now().duration_since(started);
        assert!(
            waited >= Duration::from_secs(60 + 8),
            "installed after {waited:?}, before 60 s of quiet followed the busy stretch"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn when_idle_counts_quiet_time_during_the_download() {
        let mut release = FakeRelease::new("1.0.0-fork.2");
        release.download_time = Duration::from_secs(90);
        let r = rig(Some(release), 0);
        let (_tx, rx) = watch::channel(Directive::Proceed);
        let started = Instant::now();

        assert_eq!(
            run(r.deps, Some(UpdateMode::WhenIdle), rx).await,
            Outcome::Restarting
        );
        // Quiet all along: installs right after the 90 s download instead of
        // waiting another full window.
        assert!(Instant::now().duration_since(started) < Duration::from_secs(95));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_the_wait_leaves_the_app_untouched() {
        let release = FakeRelease::new("1.0.0-fork.2");
        let installed = release.installed.clone();
        let r = rig(Some(release), usize::MAX);
        let handle = r.handle.clone();
        let relauncher = r.relauncher.clone();
        let (tx, rx) = watch::channel(Directive::Proceed);

        let task = tokio::spawn(run(r.deps, Some(UpdateMode::WhenIdle), rx));
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(status(&handle), AppUpdateLifecycle::WaitingForIdle);
        tx.send(Directive::Cancel).unwrap();

        assert_eq!(task.await.unwrap(), Outcome::Cancelled);
        assert_eq!(status(&handle), AppUpdateLifecycle::Idle);
        assert!(!installed.load(Ordering::SeqCst));
        assert!(!relauncher.0.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_the_download_leaves_the_app_untouched() {
        let mut release = FakeRelease::new("1.0.0-fork.2");
        release.download_time = Duration::from_secs(30);
        let installed = release.installed.clone();
        let r = rig(Some(release), 0);
        let handle = r.handle.clone();
        let (tx, rx) = watch::channel(Directive::Proceed);

        let task = tokio::spawn(run(r.deps, Some(UpdateMode::Now), rx));
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(status(&handle), AppUpdateLifecycle::Downloading);
        tx.send(Directive::Cancel).unwrap();

        assert_eq!(task.await.unwrap(), Outcome::Cancelled);
        assert_eq!(status(&handle), AppUpdateLifecycle::Idle);
        assert!(!installed.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn now_while_waiting_installs_without_the_quiet_window() {
        let release = FakeRelease::new("1.0.0-fork.2");
        let installed = release.installed.clone();
        let r = rig(Some(release), usize::MAX);
        let handle = r.handle.clone();
        let (tx, rx) = watch::channel(Directive::Proceed);

        let task = tokio::spawn(run(r.deps, Some(UpdateMode::WhenIdle), rx));
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(status(&handle), AppUpdateLifecycle::WaitingForIdle);
        tx.send(Directive::Now).unwrap();

        assert_eq!(task.await.unwrap(), Outcome::Restarting);
        assert!(installed.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_download_installs_nothing_and_reports_it() {
        let mut release = FakeRelease::new("1.0.0-fork.2");
        release.download_error = Some("signature verification failed".into());
        let installed = release.installed.clone();
        let r = rig(Some(release), 0);
        let handle = r.handle.clone();
        let (_tx, rx) = watch::channel(Directive::Proceed);

        let outcome = run(r.deps, Some(UpdateMode::Now), rx).await;

        assert!(matches!(outcome, Outcome::Failed(ref m) if m.starts_with("Download failed")));
        assert!(!installed.load(Ordering::SeqCst));
        assert!(!r.relauncher.0.load(Ordering::SeqCst));
        let snap = update_state::snapshot(&handle);
        assert_eq!(snap.status, AppUpdateLifecycle::Error);
        assert!(snap.error.unwrap().contains("signature verification failed"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_install_does_not_restart() {
        let mut release = FakeRelease::new("1.0.0-fork.2");
        release.install_error = Some("disk full".into());
        let r = rig(Some(release), 0);
        let (_tx, rx) = watch::channel(Directive::Proceed);

        let outcome = run(r.deps, Some(UpdateMode::Now), rx).await;

        assert!(matches!(outcome, Outcome::Failed(ref m) if m.starts_with("Install failed")));
        assert!(!r.relauncher.0.load(Ordering::SeqCst));
        assert_eq!(status(&r.handle), AppUpdateLifecycle::Error);
    }

    #[tokio::test(start_paused = true)]
    async fn never_downgrades_or_reinstalls() {
        // The running build is 1.0.0-fork.1: an older release and the same
        // one are both refused before anything is downloaded.
        for offered in ["0.9.0", "1.0.0-fork.0", "1.0.0-fork.1"] {
            let release = FakeRelease::new(offered);
            let installed = release.installed.clone();
            let r = rig(Some(release), 0);
            let relauncher = r.relauncher.clone();
            let (_tx, rx) = watch::channel(Directive::Proceed);
            let outcome = run(r.deps, Some(UpdateMode::Now), rx).await;
            assert!(
                matches!(outcome, Outcome::Failed(ref m) if m.starts_with("Refusing")),
                "{offered}: {outcome:?}"
            );
            assert!(!installed.load(Ordering::SeqCst));
            assert!(!relauncher.0.load(Ordering::SeqCst));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_feed_is_an_error_not_a_restart() {
        let r = rig(None, 0);
        let (_tx, rx) = watch::channel(Directive::Proceed);
        assert!(matches!(
            run(r.deps, Some(UpdateMode::Now), rx).await,
            Outcome::Failed(ref m) if m == "No update available"
        ));
        assert!(!r.relauncher.0.load(Ordering::SeqCst));
    }

    // ── Reconnect preflight ──

    fn config(
        auto_start: bool,
        port: Option<u16>,
        token: Option<&str>,
    ) -> crate::web::WebServiceConfig {
        crate::web::WebServiceConfig {
            token: token.map(str::to_string),
            port,
            auto_start,
        }
    }

    #[test]
    fn a_remote_update_needs_the_web_service_to_come_back_as_it_is() {
        let running = Some((3080, "tok".to_string()));
        let clear = [
            config(true, None, Some("tok")),
            config(true, Some(3080), Some("tok")),
        ];
        for cfg in clear {
            assert!(reconnect_blocker(&cfg, running.clone()).is_none());
        }

        for (cfg, why) in [
            (config(false, None, Some("tok")), "not set to start"),
            (config(true, Some(4000), Some("tok")), "different port"),
            (config(true, None, None), "different access token"),
            (config(true, None, Some("other")), "different access token"),
        ] {
            let err = reconnect_blocker(&cfg, running.clone()).expect("blocked");
            assert!(err.message.contains(why), "{}", err.message);
            assert_eq!(err.i18n_key.as_deref(), Some(I18N_KEY_WONT_RECONNECT));
        }
        assert!(reconnect_blocker(&config(true, None, Some("tok")), None).is_some());
    }
}
