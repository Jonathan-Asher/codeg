//! Talk on this Mac: the iPhone's hands-free voice conversation, held from
//! the desktop app with the Mac's own microphone and speakers.
//!
//! The voice loop (microphone, speech detection, transcription, end of turn,
//! speech, interruptions) runs in `codeg-talk`, a native helper shipped next
//! to the codeg executable on Apple Silicon Macs (`native/codeg-talk`). The
//! session is driven by the window that holds the Talk (its `TalkBridge`), so
//! a session on a remote server shown in this app works the same as a local
//! one. This module only:
//!
//! - starts the helper (with the model, voice and espeak-ng paths) and relays
//!   JSON lines between it and the window that holds the Talk: the window's
//!   messages go to the helper in order, the helper's go to that window only
//!   (`talk-voice://message`, each tagged with its Talk's id);
//! - keeps one Talk at a time: a new one replaces the old, and the Talk ends
//!   when its window is closed or reloaded, or when the helper exits
//!   (`ended{reason:"crashed"}`);
//! - refuses a helper that speaks another protocol version (Talk is then
//!   unsupported on this install);
//! - reports `talking` presence for a local session while the helper says the
//!   person is talking, under a key of its own, so nothing is pushed about it;
//! - downloads the speech models ([`models`]) and keeps the preferences
//!   ([`prefs`]).
//!
//! The protocol itself is the window's and the helper's business (see
//! `src/lib/talk-voice/protocol.ts` and `native/codeg-talk`); the relay reads
//! only `hello`, `flags` and `ended`, and adds `models` to `start`.

pub mod catalog;
pub mod models;
pub mod prefs;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use self::catalog::ModelPack;
use self::models::{TalkModels, TalkModelsStatus};

/// Explicit path of the helper (dev shells, tests, custom installs).
pub const HELPER_BIN_ENV: &str = "CODEG_TALK_BIN";
/// `CODEG_TALK=off` turns Talk on this Mac off.
pub const SWITCH_ENV: &str = "CODEG_TALK";
/// The window ↔ helper protocol this build speaks. A helper that says
/// another version in its `hello` is not used.
pub const PROTOCOL_VERSION: u32 = 1;
/// The helper's messages, to the window that holds the Talk:
/// `{"talkId": n, "message": {...}}`.
pub const MESSAGE_EVENT: &str = "talk-voice://message";
/// The status (models, helper, the Talk running), to every window.
pub const STATUS_EVENT: &str = "talk-voice://status";
/// The global shortcut was pressed with no Talk running: the focused
/// workspace window starts one on its session (`{"action":"start"}`).
pub const SHORTCUT_EVENT: &str = "talk-voice://shortcut";

/// How long the helper has to say `hello` after it starts.
const HELLO_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a Talk being ended has to answer `ended`.
const END_TIMEOUT: Duration = Duration::from_secs(3);
/// How often `talking` presence is refreshed (a report lives 90 s).
const HEARTBEAT: Duration = Duration::from_secs(20);
/// How long `codeg-talk --probe` may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

// ── Wire types ──

/// The helper's `hello`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloInfo {
    pub protocol: u32,
    /// The helper's own version, as it says it.
    #[serde(default)]
    pub version: Option<Value>,
    /// The microphone permission as the helper sees it.
    #[serde(default)]
    pub mic: Option<Value>,
}

/// What `codeg-talk --probe` found: macOS new enough, whisper loads, the
/// microphone permission.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub ok: bool,
    /// Why not, in the helper's words (or ours, when it did not run).
    pub error: Option<String>,
    /// The helper's report, as printed.
    pub report: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTalkView {
    pub talk_id: u64,
    /// The label of the window that holds the Talk.
    pub window: String,
    pub conversation_id: i32,
    /// The session runs on this Mac's backend.
    pub local: bool,
    /// The helper says the person is talking (presence carries it).
    pub talking: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkVoiceStatus {
    /// Talk can run here: macOS on Apple Silicon, the helper present and
    /// speaking this protocol, its probe passed, not switched off.
    pub supported: bool,
    /// Why not: `disabled`, `platform`, `arch`, `helperMissing`, `protocol`,
    /// `probe`.
    pub unsupported_reason: Option<String>,
    pub protocol: u32,
    /// The probe's result, once it ran.
    pub probe: Option<ProbeOutcome>,
    pub helper_running: bool,
    /// The running helper's `hello`.
    pub helper: Option<HelloInfo>,
    pub active: Option<ActiveTalkView>,
    pub models: TalkModelsStatus,
    /// The natural voice (BlueTTS) is downloaded; without it the helper
    /// speaks with the system voice.
    pub voice_installed: bool,
}

/// A Talk the window asks for.
#[derive(Debug, Clone)]
pub struct StartRequest {
    pub window: String,
    pub conversation_id: i32,
    pub local: bool,
    /// The protocol's `start` message; the relay adds `models`.
    pub message: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkStarted {
    pub talk_id: u64,
    pub hello: HelloInfo,
}

#[derive(Debug, thiserror::Error)]
pub enum TalkVoiceError {
    #[error("Talk on this Mac is not available here ({0})")]
    Unsupported(String),
    #[error("Talk's speech models are not downloaded")]
    ModelsMissing,
    #[error("no Talk is running")]
    NotRunning,
    #[error("another window holds the Talk")]
    NotOwner,
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    Helper(String),
}

// ── The helper process ──

/// What the helper is started with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperLaunch {
    /// espeak-ng's data (the natural voice's English); without it the helper
    /// looks next to itself, as codeg-tts does. The model paths travel in
    /// each `start` (`models`), so a pack downloaded meanwhile is used.
    pub espeak_data: Option<PathBuf>,
}

/// A started helper: its stdout and stdin, and the process when there is one.
pub struct SpawnedHelper {
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub child: Option<tokio::process::Child>,
}

/// Starts a helper.
pub type HelperSpawner = Arc<dyn Fn(&HelperLaunch) -> std::io::Result<SpawnedHelper> + Send + Sync>;
/// Runs `codeg-talk --probe`.
pub type HelperProber = Arc<dyn Fn() -> BoxFuture<'static, ProbeOutcome> + Send + Sync>;
/// The natural voice's model directory, when it is downloaded.
pub type VoiceLocator = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;
/// Lines for the helper's stdin, written in order by one task.
type HelperLines = mpsc::UnboundedSender<String>;
/// The helper's `hello`, once it said it.
type HelloWatch = watch::Receiver<Option<HelloInfo>>;

pub fn helper_file_name() -> &'static str {
    if cfg!(windows) {
        "codeg-talk.exe"
    } else {
        "codeg-talk"
    }
}

/// An executable, non-empty file (`build.rs` leaves a 0-byte placeholder
/// where a build skipped the helper).
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

/// `CODEG_TALK_BIN`, else `codeg-talk` next to the running executable (where
/// the bundle puts its sidecars, `codeg.app/Contents/MacOS/`).
pub fn locate_helper() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os(HELPER_BIN_ENV).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(raw);
        return is_executable_file(&path).then_some(path);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = dir.join(helper_file_name());
    is_executable_file(&candidate).then_some(candidate)
}

/// The espeak-ng data the app bundles for the natural voice
/// (`codeg.app/Contents/Resources/tts/espeak-ng-data`), or the copy next to a
/// dev binary.
pub fn locate_espeak_data() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        dir.parent()
            .map(|contents| contents.join("Resources/tts/espeak-ng-data")),
        Some(dir.join("tts/espeak-ng-data")),
        Some(dir.join("espeak-ng-data")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|candidate| candidate.join("phontab").is_file())
}

/// The arguments the helper gets.
pub fn helper_args(launch: &HelperLaunch) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    if let Some(espeak) = &launch.espeak_data {
        args.push("--espeak-data".into());
        args.push(espeak.clone().into());
    }
    args
}

/// Runs the real `codeg-talk`.
pub fn process_spawner(binary: PathBuf) -> HelperSpawner {
    Arc::new(move |launch: &HelperLaunch| {
        let mut command = tokio::process::Command::new(&binary);
        crate::process::configure_tokio_command(&mut command);
        command
            .args(helper_args(launch))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let missing = || std::io::Error::other("codeg-talk started without its pipes");
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stdout = child.stdout.take().ok_or_else(missing)?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[talk-voice] {line}");
                }
            });
        }
        Ok(SpawnedHelper {
            stdout: Box::new(stdout),
            stdin: Box::new(stdin),
            child: Some(child),
        })
    })
}

/// The oldest macOS Talk's engines run on.
const MIN_MACOS: u64 = 15;

/// Why a probe report rules Talk out, if it does. The report is
/// `{"arm64", "macos", "mic", "protocol", "version", "whisperLoads"}`; the
/// microphone permission is not a reason (Talk asks for it when it starts,
/// and the dock links to the setting when it is off).
fn probe_problem(report: &Value) -> Option<String> {
    if report.get("ok").and_then(Value::as_bool) == Some(false) {
        return Some(
            report
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the Talk helper's check failed")
                .to_string(),
        );
    }
    if report.get("arm64").and_then(Value::as_bool) == Some(false) {
        return Some("Talk on this Mac needs Apple Silicon".into());
    }
    if let Some(protocol) = report.get("protocol").and_then(Value::as_u64) {
        if protocol != u64::from(PROTOCOL_VERSION) {
            return Some(format!(
                "the Talk helper speaks protocol {protocol}, this app {PROTOCOL_VERSION}"
            ));
        }
    }
    let major = report
        .get("macos")
        .and_then(Value::as_str)
        .and_then(|v| v.split('.').next())
        .and_then(|m| m.trim().parse::<u64>().ok());
    if major.is_some_and(|m| m < MIN_MACOS) {
        return Some(format!("Talk on this Mac needs macOS {MIN_MACOS} or later"));
    }
    if report.get("whisperLoads").and_then(Value::as_bool) == Some(false) {
        return Some("the speech engine (whisper.cpp) did not load".into());
    }
    None
}

/// Read what `codeg-talk --probe` printed: its report is the last JSON object
/// line. It passes with a clean exit and nothing in the report against it.
pub fn parse_probe(success: bool, stdout: &str, stderr: &str) -> ProbeOutcome {
    let report = stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .find_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object);
    let error = if success {
        report.as_ref().and_then(probe_problem)
    } else {
        let tail = stderr.trim();
        Some(if tail.is_empty() {
            "the Talk helper's check failed".to_string()
        } else {
            tail.lines().last().unwrap_or(tail).to_string()
        })
    };
    ProbeOutcome {
        ok: error.is_none(),
        error,
        report,
    }
}

/// Runs `codeg-talk --probe` on the real binary.
pub fn process_prober(binary: PathBuf) -> HelperProber {
    Arc::new(move || {
        let binary = binary.clone();
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&binary);
            crate::process::configure_tokio_command(&mut command);
            command
                .arg("--probe")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
                Ok(Ok(output)) => parse_probe(
                    output.status.success(),
                    &String::from_utf8_lossy(&output.stdout),
                    &String::from_utf8_lossy(&output.stderr),
                ),
                Ok(Err(e)) => ProbeOutcome {
                    ok: false,
                    error: Some(format!("could not run the Talk helper: {e}")),
                    report: None,
                },
                Err(_) => ProbeOutcome {
                    ok: false,
                    error: Some("the Talk helper's check timed out".into()),
                    report: None,
                },
            }
        })
    })
}

// ── Where the relay's output goes ──

/// The app around the relay. Tests record the calls.
pub trait TalkHost: Send + Sync + 'static {
    /// A helper message for the window that holds the Talk.
    fn deliver(&self, window: &str, payload: &Value);
    /// A Talk started (`true`) or ended (`false`): read-aloud steps aside.
    fn talk_active(&self, _active: bool) {}
    /// `talking` presence for a local session, under `key`; `false` takes it
    /// back.
    fn presence(&self, _key: &str, _conversation_id: i32, _talking: bool) {}
    /// The status changed (a Talk started or ended, the helper went away).
    fn status_changed(&self, _status: &TalkVoiceStatus) {}
}

/// Why a Talk ends, as the window hears it in `ended{reason}` when the relay
/// ends it itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// The window asked.
    Stopped,
    /// Another Talk started.
    Replaced,
    /// The window was closed or reloaded.
    WindowClosed,
    /// The helper exited while the Talk ran.
    Crashed,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::Stopped => "stopped",
            EndReason::Replaced => "replaced",
            EndReason::WindowClosed => "windowClosed",
            EndReason::Crashed => "crashed",
        }
    }
}

// ── The service ──

pub struct TalkVoiceConfig {
    /// `<data dir>/talk`.
    pub models_dir: PathBuf,
    pub catalog: Result<Vec<ModelPack>, String>,
    pub voice: VoiceLocator,
    pub espeak_data: Option<PathBuf>,
    /// None where Talk can't run; `unsupported_reason` says why.
    pub spawner: Option<HelperSpawner>,
    pub prober: Option<HelperProber>,
    pub unsupported_reason: Option<String>,
    pub hello_timeout: Duration,
    pub end_timeout: Duration,
    pub heartbeat: Duration,
}

struct HelperProc {
    generation: u64,
    lines: HelperLines,
    hello: HelloWatch,
    hello_tx: watch::Sender<Option<HelloInfo>>,
    /// Dropping it kills the process.
    _child: Option<tokio::process::Child>,
}

struct ActiveTalk {
    id: u64,
    window: String,
    conversation_id: i32,
    local: bool,
    talking: bool,
    /// The helper generation it runs on.
    generation: u64,
    /// `end` went to the helper for this reason; `ended` finishes the Talk.
    ending: Option<EndReason>,
    /// The window is gone: nothing more is delivered to it.
    window_gone: bool,
    /// Fired once the helper's `ended` arrives.
    ended_tx: Option<oneshot::Sender<()>>,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

impl ActiveTalk {
    fn view(&self) -> ActiveTalkView {
        ActiveTalkView {
            talk_id: self.id,
            window: self.window.clone(),
            conversation_id: self.conversation_id,
            local: self.local,
            talking: self.talking,
        }
    }

    fn presence_key(&self) -> String {
        format!("talk-voice:{}", self.id)
    }
}

#[derive(Default)]
struct RelayState {
    helper: Option<HelperProc>,
    talk: Option<ActiveTalk>,
    next_generation: u64,
    /// A helper said this protocol version instead of ours.
    protocol_mismatch: Option<u32>,
    probe: Option<ProbeOutcome>,
}

pub struct TalkVoiceService {
    models: Arc<TalkModels>,
    voice: VoiceLocator,
    espeak_data: Option<PathBuf>,
    spawner: Option<HelperSpawner>,
    prober: Option<HelperProber>,
    unsupported_reason: Option<String>,
    hello_timeout: Duration,
    end_timeout: Duration,
    heartbeat: Duration,
    host: OnceLock<Arc<dyn TalkHost>>,
    state: Mutex<RelayState>,
    /// Starting and ending Talks one at a time.
    lifecycle: tokio::sync::Mutex<()>,
    probing: tokio::sync::Mutex<()>,
    probe_started: AtomicBool,
    next_talk: AtomicU64,
    weak: Weak<TalkVoiceService>,
}

static SERVICE: OnceLock<Arc<TalkVoiceService>> = OnceLock::new();

/// The process-wide service.
pub fn service_for(data_dir: &Path) -> Arc<TalkVoiceService> {
    SERVICE
        .get_or_init(|| TalkVoiceService::from_environment(data_dir))
        .clone()
}

/// The process-wide service, if something started it.
pub fn running_service() -> Option<Arc<TalkVoiceService>> {
    SERVICE.get().cloned()
}

/// `CODEG_TALK` says off.
fn switched_off() -> bool {
    std::env::var(SWITCH_ENV)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "off" | "0" | "false"
            )
        })
        .unwrap_or(false)
}

impl TalkVoiceService {
    pub fn new(config: TalkVoiceConfig) -> Arc<Self> {
        let models = Arc::new(TalkModels::new(config.models_dir, config.catalog));
        Arc::new_cyclic(|weak| Self {
            models,
            voice: config.voice,
            espeak_data: config.espeak_data,
            spawner: config.spawner,
            prober: config.prober,
            unsupported_reason: config.unsupported_reason,
            hello_timeout: config.hello_timeout,
            end_timeout: config.end_timeout,
            heartbeat: config.heartbeat,
            host: OnceLock::new(),
            state: Mutex::new(RelayState::default()),
            lifecycle: tokio::sync::Mutex::new(()),
            probing: tokio::sync::Mutex::new(()),
            probe_started: AtomicBool::new(false),
            next_talk: AtomicU64::new(1),
            weak: weak.clone(),
        })
    }

    /// Models under `<data dir>/talk/`, the helper found next to this binary
    /// on an Apple Silicon Mac, nothing anywhere else.
    pub fn from_environment(data_dir: &Path) -> Arc<Self> {
        let (spawner, prober, reason) = if switched_off() {
            (None, None, Some("disabled".to_string()))
        } else if !cfg!(target_os = "macos") {
            (None, None, Some("platform".to_string()))
        } else if !cfg!(target_arch = "aarch64") {
            (None, None, Some("arch".to_string()))
        } else {
            match locate_helper() {
                Some(binary) => (
                    Some(process_spawner(binary.clone())),
                    Some(process_prober(binary)),
                    None,
                ),
                None => (None, None, Some("helperMissing".to_string())),
            }
        };
        let data = data_dir.to_path_buf();
        let voice: VoiceLocator = Arc::new(move || {
            crate::tts::service_for(&data)
                .status()
                .installed
                .then(|| data.join("tts").join(crate::tts::catalog::PACK_DIR))
        });
        Self::new(TalkVoiceConfig {
            models_dir: data_dir.join("talk"),
            catalog: catalog::load(),
            voice,
            espeak_data: locate_espeak_data(),
            spawner,
            prober,
            unsupported_reason: reason,
            hello_timeout: HELLO_TIMEOUT,
            end_timeout: END_TIMEOUT,
            heartbeat: HEARTBEAT,
        })
    }

    /// The app around the relay. The first host stays: a process has one.
    pub fn set_host(&self, host: impl FnOnce() -> Arc<dyn TalkHost>) {
        self.host.get_or_init(host);
    }

    fn host(&self) -> Option<&Arc<dyn TalkHost>> {
        self.host.get()
    }

    pub fn models(&self) -> &Arc<TalkModels> {
        &self.models
    }

    fn announce(&self) {
        if let Some(host) = self.host() {
            host.status_changed(&self.status());
        }
    }

    /// Why Talk can't run here, if it can't (the probe aside).
    fn blocked_reason(&self) -> Option<String> {
        if self.spawner.is_none() {
            return Some(
                self.unsupported_reason
                    .clone()
                    .unwrap_or_else(|| "platform".into()),
            );
        }
        let state = self.state.lock().unwrap();
        if state.protocol_mismatch.is_some() {
            return Some("protocol".into());
        }
        if state.probe.as_ref().is_some_and(|p| !p.ok) {
            return Some("probe".into());
        }
        None
    }

    pub fn status(&self) -> TalkVoiceStatus {
        let unsupported_reason = self.blocked_reason();
        let state = self.state.lock().unwrap();
        TalkVoiceStatus {
            supported: unsupported_reason.is_none(),
            unsupported_reason,
            protocol: PROTOCOL_VERSION,
            probe: state.probe.clone(),
            helper_running: state.helper.is_some(),
            helper: state.helper.as_ref().and_then(|h| h.hello.borrow().clone()),
            active: state.talk.as_ref().map(ActiveTalk::view),
            models: self.models.status(),
            voice_installed: (self.voice)().is_some(),
        }
    }

    /// The Talk running now.
    pub fn active(&self) -> Option<ActiveTalkView> {
        self.state
            .lock()
            .unwrap()
            .talk
            .as_ref()
            .map(ActiveTalk::view)
    }

    /// Start the helper's probe in the background unless it ran (or runs);
    /// the status is announced when it is done.
    pub fn ensure_probe(&self) {
        if self.prober.is_none() || self.state.lock().unwrap().probe.is_some() {
            return;
        }
        if self.probe_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(this) = self.weak.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            this.probe(false).await;
            this.announce();
        });
    }

    /// Run the helper's probe once (again with `refresh`), and return the
    /// status with its result.
    pub async fn probe(&self, refresh: bool) -> TalkVoiceStatus {
        if let Some(prober) = self.prober.clone() {
            let _guard = self.probing.lock().await;
            let needed = refresh || self.state.lock().unwrap().probe.is_none();
            if needed {
                let outcome = prober().await;
                if !outcome.ok {
                    tracing::warn!(
                        "[talk-voice] the helper's probe failed: {:?}",
                        outcome.error
                    );
                }
                let other_protocol = outcome
                    .report
                    .as_ref()
                    .and_then(|r| r.get("protocol"))
                    .and_then(Value::as_u64)
                    .filter(|p| *p != u64::from(PROTOCOL_VERSION));
                let mut state = self.state.lock().unwrap();
                if let Some(protocol) = other_protocol {
                    state.protocol_mismatch = Some(u32::try_from(protocol).unwrap_or(u32::MAX));
                }
                state.probe = Some(outcome);
            }
        }
        self.status()
    }

    // ── Talks ──

    /// Start a Talk for `request.window`, replacing any Talk running now.
    pub async fn start(&self, request: StartRequest) -> Result<TalkStarted, TalkVoiceError> {
        let mut message = request.message;
        if message.get("type").and_then(Value::as_str) != Some("start") {
            return Err(TalkVoiceError::InvalidInput(
                "a Talk starts with a `start` message".into(),
            ));
        }
        let _lifecycle = self.lifecycle.lock().await;
        if let Some(reason) = self.blocked_reason() {
            return Err(TalkVoiceError::Unsupported(reason));
        }
        if !self.models.ready() {
            return Err(TalkVoiceError::ModelsMissing);
        }
        // One Talk at a time.
        self.end_current(|_| true, EndReason::Replaced).await;
        if let Some(host) = self.host() {
            host.talk_active(true);
        }
        let (generation, lines, hello) = match self.ensure_helper().await {
            Ok(started) => started,
            Err(e) => {
                if let Some(host) = self.host() {
                    host.talk_active(false);
                }
                self.announce();
                return Err(e);
            }
        };
        // The window's prefs say whether whisper makes the final transcript
        // (`useWhisper`, ours; the helper ignores it).
        let use_whisper = message
            .pointer("/prefs/useWhisper")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let models = self.start_models(use_whisper);
        if let Some(object) = message.as_object_mut() {
            object.insert("models".into(), models);
        }
        let id = self.next_talk.fetch_add(1, Ordering::Relaxed);
        let line = serde_json::to_string(&message)
            .map_err(|e| TalkVoiceError::InvalidInput(e.to_string()))?;
        {
            // Registered before the line goes out, so everything the helper
            // says about it finds its window.
            let mut state = self.state.lock().unwrap();
            state.talk = Some(ActiveTalk {
                id,
                window: request.window.clone(),
                conversation_id: request.conversation_id,
                local: request.local,
                talking: false,
                generation,
                ending: None,
                window_gone: false,
                ended_tx: None,
                heartbeat: None,
            });
        }
        if lines.send(line).is_err() {
            let talk = self.state.lock().unwrap().talk.take();
            if let Some(talk) = talk {
                self.after_ended(talk);
            }
            return Err(TalkVoiceError::Helper("the Talk helper stopped".into()));
        }
        tracing::info!(
            "[talk-voice] Talk {id} started for conversation {} in {}",
            request.conversation_id,
            request.window
        );
        self.announce();
        Ok(TalkStarted { talk_id: id, hello })
    }

    /// The model paths for a `start`: `zipformer` `{encoder, decoder, joiner,
    /// tokens}`, `vad`, `smartTurn`, `whisper`, `languageID`, `bluetts`,
    /// `espeakData`; absolute paths, null where absent.
    pub fn start_models(&self, use_whisper: bool) -> Value {
        use self::catalog::{SMART_TURN, WHISPER, ZIPFORMER};
        let path = |pack: &str, role: &str| {
            self.models
                .part_path(pack, role)
                .map(|p| p.display().to_string())
        };
        let zipformer = match (
            path(ZIPFORMER, "encoder"),
            path(ZIPFORMER, "decoder"),
            path(ZIPFORMER, "joiner"),
            path(ZIPFORMER, "tokens"),
        ) {
            (Some(encoder), Some(decoder), Some(joiner), Some(tokens)) => json!({
                "encoder": encoder,
                "decoder": decoder,
                "joiner": joiner,
                "tokens": tokens,
            }),
            _ => Value::Null,
        };
        let whisper = |role: &str| {
            if use_whisper {
                path(WHISPER, role)
            } else {
                None
            }
        };
        json!({
            "zipformer": zipformer,
            "vad": path(ZIPFORMER, "vad").or_else(|| path(WHISPER, "vad")),
            "smartTurn": path(SMART_TURN, "weights"),
            "whisper": whisper("weights"),
            "languageID": whisper("languageID"),
            "bluetts": (self.voice)().map(|d| d.display().to_string()),
            "espeakData": self.espeak_data.as_ref().map(|d| d.display().to_string()),
        })
    }

    /// A message from the window that holds Talk `talk_id`, for the helper.
    pub fn send(&self, window: &str, talk_id: u64, message: Value) -> Result<(), TalkVoiceError> {
        let kind = message.get("type").and_then(Value::as_str);
        match kind {
            None => {
                return Err(TalkVoiceError::InvalidInput(
                    "a message needs a `type`".into(),
                ))
            }
            Some("start") => {
                return Err(TalkVoiceError::InvalidInput(
                    "start a Talk with talk_voice_start".into(),
                ))
            }
            Some(_) => {}
        }
        let line = serde_json::to_string(&message)
            .map_err(|e| TalkVoiceError::InvalidInput(e.to_string()))?;
        let state = self.state.lock().unwrap();
        let talk = state.talk.as_ref().ok_or(TalkVoiceError::NotRunning)?;
        if talk.id != talk_id {
            return Err(TalkVoiceError::NotRunning);
        }
        if talk.window != window {
            return Err(TalkVoiceError::NotOwner);
        }
        if talk.ending.is_some() {
            return Err(TalkVoiceError::NotRunning);
        }
        let helper = state
            .helper
            .as_ref()
            .filter(|h| h.generation == talk.generation)
            .ok_or(TalkVoiceError::NotRunning)?;
        helper
            .lines
            .send(line)
            .map_err(|_| TalkVoiceError::Helper("the Talk helper stopped".into()))
    }

    /// A control from this app itself (the global shortcut) for the Talk
    /// running now. False when none runs.
    pub fn control(&self, control: Value) -> bool {
        let Ok(line) = serde_json::to_string(&control) else {
            return false;
        };
        let state = self.state.lock().unwrap();
        let Some(talk) = state.talk.as_ref().filter(|t| t.ending.is_none()) else {
            return false;
        };
        state
            .helper
            .as_ref()
            .filter(|h| h.generation == talk.generation)
            .is_some_and(|h| h.lines.send(line).is_ok())
    }

    /// End Talk `talk_id` for the window that holds it.
    pub async fn stop(&self, window: &str, talk_id: u64) -> Result<(), TalkVoiceError> {
        let _lifecycle = self.lifecycle.lock().await;
        {
            let state = self.state.lock().unwrap();
            let talk = state.talk.as_ref().ok_or(TalkVoiceError::NotRunning)?;
            if talk.id != talk_id {
                return Err(TalkVoiceError::NotRunning);
            }
            if talk.window != window {
                return Err(TalkVoiceError::NotOwner);
            }
        }
        self.end_current(|t| t.id == talk_id, EndReason::Stopped)
            .await;
        Ok(())
    }

    /// A window was closed, or its page reloaded: its Talk ends.
    pub async fn window_gone(&self, window: &str) {
        let holds = self
            .state
            .lock()
            .unwrap()
            .talk
            .as_ref()
            .is_some_and(|t| t.window == window);
        if !holds {
            return;
        }
        let _lifecycle = self.lifecycle.lock().await;
        {
            let mut state = self.state.lock().unwrap();
            if let Some(talk) = state.talk.as_mut().filter(|t| t.window == window) {
                talk.window_gone = true;
            }
        }
        self.end_current(|t| t.window == window, EndReason::WindowClosed)
            .await;
    }

    /// End the Talk running now, when `matches` says so: `end` to the helper,
    /// then its `ended` (delivered as it comes), or after `end_timeout` an
    /// `ended{reason}` of our own and a helper that is let go. Called under
    /// the lifecycle lock.
    async fn end_current(&self, matches: impl Fn(&ActiveTalk) -> bool, reason: EndReason) {
        let ended_rx = {
            let mut state = self.state.lock().unwrap();
            let RelayState { helper, talk, .. } = &mut *state;
            let Some(current) = talk.as_mut().filter(|t| matches(t)) else {
                return;
            };
            let (tx, rx) = oneshot::channel();
            current.ended_tx = Some(tx);
            current.ending = Some(reason);
            let sent = helper
                .as_ref()
                .filter(|h| h.generation == current.generation)
                .is_some_and(|h| {
                    h.lines
                        .send(json!({"type": "end", "reason": reason.as_str()}).to_string())
                        .is_ok()
                });
            sent.then_some(rx)
        };
        let answered = match ended_rx {
            Some(rx) => tokio::time::timeout(self.end_timeout, rx)
                .await
                .is_ok_and(|r| r.is_ok()),
            None => false,
        };
        if answered {
            return;
        }
        // No `ended` in time (or no helper to ask): finish it here, and let
        // go of a helper that stopped answering.
        let (talk, helper) = {
            let mut state = self.state.lock().unwrap();
            let talk = state
                .talk
                .take_if(|t| t.ending == Some(reason) && matches(t));
            let helper = talk
                .as_ref()
                .and_then(|t| state.helper.take_if(|h| h.generation == t.generation));
            (talk, helper)
        };
        if helper.is_some() {
            tracing::warn!("[talk-voice] the helper did not answer `end`; stopped it");
        }
        drop(helper);
        if let Some(talk) = talk {
            self.deliver_to(&talk, json!({"type": "ended", "reason": reason.as_str()}));
            self.after_ended(talk);
        }
    }

    /// Everything that follows a Talk's end: presence taken back, the
    /// waiter told, read-aloud back.
    fn after_ended(&self, mut talk: ActiveTalk) {
        if let Some(heartbeat) = talk.heartbeat.take() {
            heartbeat.abort();
        }
        if let Some(host) = self.host() {
            if talk.local && talk.talking {
                host.presence(&talk.presence_key(), talk.conversation_id, false);
            }
            host.talk_active(false);
        }
        if let Some(tx) = talk.ended_tx.take() {
            let _ = tx.send(());
        }
        tracing::info!("[talk-voice] Talk {} ended", talk.id);
        self.announce();
    }

    fn deliver_to(&self, talk: &ActiveTalk, message: Value) {
        if talk.window_gone {
            return;
        }
        if let Some(host) = self.host() {
            host.deliver(
                &talk.window,
                &json!({"talkId": talk.id, "message": message}),
            );
        }
    }

    // ── The helper ──

    /// The running helper, started (and its `hello` checked) when needed.
    async fn ensure_helper(&self) -> Result<(u64, HelperLines, HelloInfo), TalkVoiceError> {
        let running = {
            let state = self.state.lock().unwrap();
            state
                .helper
                .as_ref()
                .map(|h| (h.generation, h.lines.clone(), h.hello.clone()))
        };
        let (generation, lines, mut hello_rx) = match running {
            Some(running) if !running.1.is_closed() => running,
            _ => self.spawn_helper()?,
        };
        let waited = tokio::time::timeout(self.hello_timeout, async {
            loop {
                // Read in a statement of its own: the borrow is a lock that
                // must not live across the await below.
                let said = hello_rx.borrow_and_update().clone();
                if let Some(hello) = said {
                    return Some(hello);
                }
                if hello_rx.changed().await.is_err() {
                    return None;
                }
            }
        })
        .await;
        let hello = match waited {
            Ok(Some(hello)) => hello,
            Ok(None) => {
                self.drop_helper(generation);
                return Err(TalkVoiceError::Helper(
                    "the Talk helper stopped as it started".into(),
                ));
            }
            Err(_) => {
                self.drop_helper(generation);
                return Err(TalkVoiceError::Helper(
                    "the Talk helper did not answer".into(),
                ));
            }
        };
        if hello.protocol != PROTOCOL_VERSION {
            tracing::warn!(
                "[talk-voice] the helper speaks protocol {} (this build: {PROTOCOL_VERSION}); Talk is off",
                hello.protocol
            );
            self.state.lock().unwrap().protocol_mismatch = Some(hello.protocol);
            self.drop_helper(generation);
            return Err(TalkVoiceError::Unsupported("protocol".into()));
        }
        Ok((generation, lines, hello))
    }

    fn drop_helper(&self, generation: u64) {
        let helper = self
            .state
            .lock()
            .unwrap()
            .helper
            .take_if(|h| h.generation == generation);
        drop(helper);
    }

    fn spawn_helper(&self) -> Result<(u64, HelperLines, HelloWatch), TalkVoiceError> {
        let spawner = self
            .spawner
            .clone()
            .ok_or_else(|| TalkVoiceError::Unsupported("platform".into()))?;
        let launch = HelperLaunch {
            espeak_data: self.espeak_data.clone(),
        };
        let spawned = spawner(&launch)
            .map_err(|e| TalkVoiceError::Helper(format!("could not start the Talk helper: {e}")))?;
        let pid = spawned.child.as_ref().and_then(|c| c.id());
        let (lines_tx, mut lines_rx) = mpsc::unbounded_channel::<String>();
        let (hello_tx, hello_rx) = watch::channel(None);
        let generation = {
            let mut state = self.state.lock().unwrap();
            state.next_generation += 1;
            let generation = state.next_generation;
            state.helper = Some(HelperProc {
                generation,
                lines: lines_tx.clone(),
                hello: hello_rx.clone(),
                hello_tx,
                _child: spawned.child,
            });
            generation
        };
        // One writer, so lines reach the helper whole and in order.
        let mut stdin = spawned.stdin;
        tokio::spawn(async move {
            while let Some(mut line) = lines_rx.recv().await {
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    return;
                }
            }
        });
        let weak = self.weak.clone();
        let stdout = spawned.stdout;
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let Some(this) = weak.upgrade() else { return };
                this.on_line(generation, &line);
            }
            if let Some(this) = weak.upgrade() {
                this.on_exit(generation);
            }
        });
        tracing::info!("[talk-voice] helper started (pid {pid:?})");
        Ok((generation, lines_tx, hello_rx))
    }

    /// One line from helper `generation`.
    fn on_line(&self, generation: u64, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let message = match serde_json::from_str::<Value>(line) {
            Ok(message @ Value::Object(_)) => message,
            _ => {
                tracing::warn!("[talk-voice] unreadable line from the helper");
                return;
            }
        };
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if kind == "hello" {
            match serde_json::from_value::<HelloInfo>(message) {
                Ok(hello) => {
                    let state = self.state.lock().unwrap();
                    if let Some(helper) =
                        state.helper.as_ref().filter(|h| h.generation == generation)
                    {
                        helper.hello_tx.send_replace(Some(hello));
                    }
                }
                Err(e) => tracing::warn!("[talk-voice] unreadable hello: {e}"),
            }
            return;
        }
        let mut message = message;
        let mut finished = None;
        let mut presence = None;
        let mut target = None;
        {
            let mut state = self.state.lock().unwrap();
            let Some(talk) = state.talk.as_mut().filter(|t| t.generation == generation) else {
                return;
            };
            if kind == "flags" {
                if let Some(talking) = message.get("isTalking").and_then(Value::as_bool) {
                    if talking != talk.talking {
                        talk.talking = talking;
                        if talk.local {
                            presence = Some(talking);
                        }
                    }
                }
            }
            if !talk.window_gone {
                target = Some((talk.window.clone(), talk.id));
            }
            if kind == "ended" {
                // Ended to make way for another Talk: the window hears so,
                // whatever the helper calls its answer to `end`.
                if talk.ending == Some(EndReason::Replaced) {
                    message["reason"] = json!(EndReason::Replaced.as_str());
                }
                finished = state.talk.take();
            }
        }
        if let (Some((window, id)), Some(host)) = (target, self.host()) {
            host.deliver(&window, &json!({"talkId": id, "message": message}));
        }
        if let Some(talking) = presence {
            self.presence_changed(talking);
        }
        if let Some(talk) = finished {
            self.after_ended(talk);
        }
    }

    /// The person started or stopped talking in the local Talk running now.
    fn presence_changed(&self, talking: bool) {
        let Some(host) = self.host().cloned() else {
            return;
        };
        let mut state = self.state.lock().unwrap();
        let Some(talk) = state.talk.as_mut() else {
            return;
        };
        if let Some(heartbeat) = talk.heartbeat.take() {
            heartbeat.abort();
        }
        let key = talk.presence_key();
        let conversation_id = talk.conversation_id;
        if talking {
            let every = self.heartbeat;
            talk.heartbeat = Some(tokio::spawn(async move {
                loop {
                    host.presence(&key, conversation_id, true);
                    tokio::time::sleep(every).await;
                }
            }));
        } else {
            drop(state);
            host.presence(&key, conversation_id, false);
        }
    }

    /// Helper `generation` exited (or closed its stdout).
    fn on_exit(&self, generation: u64) {
        let (helper, talk) = {
            let mut state = self.state.lock().unwrap();
            let helper = state.helper.take_if(|h| h.generation == generation);
            let talk = state.talk.take_if(|t| t.generation == generation);
            (helper, talk)
        };
        drop(helper);
        match talk {
            Some(talk) => {
                let reason = talk.ending.unwrap_or(EndReason::Crashed);
                if reason == EndReason::Crashed {
                    tracing::warn!("[talk-voice] the helper exited during Talk {}", talk.id);
                }
                self.deliver_to(&talk, json!({"type": "ended", "reason": reason.as_str()}));
                self.after_ended(talk);
            }
            None => {
                tracing::info!("[talk-voice] helper exited");
                self.announce();
            }
        }
    }
}

#[cfg(test)]
mod tests;
