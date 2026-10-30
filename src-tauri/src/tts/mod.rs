//! Natural read-aloud: the iPhone app's voice (BlueTTS 2.5 + RenikudPlus,
//! with `<en>` tagging of Latin and code spans) for the desktop and web
//! clients.
//!
//! Synthesis runs in `codeg-tts`, a Swift sidecar built from BlueTTSKit and
//! shipped next to the codeg executable on macOS (`native/codeg-tts`). This
//! module downloads the models into the data dir on request, keeps one
//! sidecar running while read aloud is in use (models loaded once), and hands
//! its audio to clients as a stream they poll:
//!
//! - `speak` starts a synthesis and returns a stream id,
//! - `poll` waits briefly for new 16-bit PCM chunks (base64) and says when the
//!   stream is done,
//! - `cancel` stops it.
//!
//! The same polling works over Tauri `invoke` and HTTP, so the desktop app,
//! a remote-workspace window (which calls its own local backend) and a
//! browser (which calls its server) share one code path. Nothing downloads
//! until a client asks, and the sidecar exits after `IDLE_SHUTDOWN` without
//! use, which returns its ~0.9 GB of memory.

pub mod catalog;
pub mod client;
pub mod protocol;
pub mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use self::catalog::ModelFile;
use self::client::{AudioChunk, DoneStats, SidecarClient, StreamEvent};
use self::store::{ModelStore, Progress, StoreError};

/// Explicit path of the sidecar binary (dev shells, tests, custom installs).
pub const SIDECAR_BIN_ENV: &str = "CODEG_TTS_BIN";
/// `CODEG_TTS=off` turns natural read-aloud off on this backend.
pub const SWITCH_ENV: &str = "CODEG_TTS";
/// The sidecar exits after this long without a request.
pub const IDLE_SHUTDOWN: Duration = Duration::from_secs(15 * 60);
/// A stream nobody has polled for this long is cancelled.
const STREAM_ABANDONED: Duration = Duration::from_secs(60);
/// Longest a poll waits for news.
const MAX_POLL_WAIT: Duration = Duration::from_secs(20);
const DEFAULT_POLL_WAIT: Duration = Duration::from_secs(10);
/// Longest text accepted in one `speak` (the sidecar's own limit).
pub const MAX_TEXT_CHARS: usize = 20_000;
pub const MIN_SPEED: f64 = 0.5;
pub const MAX_SPEED: f64 = 2.0;

// ── Wire types ──

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DownloadState {
    Idle,
    #[serde(rename_all = "camelCase")]
    Downloading {
        bytes_done: u64,
        bytes_total: u64,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    /// This backend can synthesize (macOS with the sidecar present).
    pub supported: bool,
    /// Why not: `platform`, `sidecarMissing`, `disabled`, or a catalog error.
    pub unsupported_reason: Option<String>,
    /// The models are downloaded and verified.
    pub installed: bool,
    pub download: DownloadState,
    /// Size of the whole model pack.
    pub pack_bytes: u64,
    /// What of it is on disk now (partial downloads included).
    pub bytes_on_disk: u64,
    pub models_dir: String,
    pub voices: Vec<String>,
    pub default_voice: String,
    /// The sidecar is running / has its models in memory.
    pub engine_running: bool,
    pub engine_loaded: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakRequest {
    pub text: String,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub speed: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakStarted {
    pub stream_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollRequest {
    pub stream_id: String,
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRef {
    pub stream_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolledChunk {
    pub index: u32,
    pub sample_rate: u32,
    /// 16-bit little-endian mono PCM, base64.
    pub pcm: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub chunks: Vec<PolledChunk>,
    /// Nothing more will come; the stream is gone after this answer.
    pub done: bool,
    pub error: Option<String>,
    pub stats: Option<DoneStats>,
}

#[derive(Debug, thiserror::Error)]
pub enum TtsError {
    #[error("natural read aloud is not available here ({0})")]
    Unsupported(String),
    #[error("the natural voice is not downloaded")]
    NotInstalled,
    #[error("{0}")]
    InvalidInput(String),
    #[error("this read-aloud stream has ended or never existed")]
    StreamNotFound,
    #[error("{0}")]
    Engine(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

// ── Locating and starting the sidecar ──

pub fn sidecar_file_name() -> &'static str {
    if cfg!(windows) {
        "codeg-tts.exe"
    } else {
        "codeg-tts"
    }
}

/// An executable, non-empty file. Empty counts as missing: `build.rs` leaves a
/// 0-byte placeholder where a build skipped the sidecar.
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

/// `CODEG_TTS_BIN`, else `codeg-tts` next to the running executable — where
/// the Tauri bundle puts its sidecars (`codeg.app/Contents/MacOS/`) and where
/// a server install keeps its companion binaries.
pub fn locate_sidecar() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os(SIDECAR_BIN_ENV).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(raw);
        return is_executable_file(&path).then_some(path);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = dir.join(sidecar_file_name());
    is_executable_file(&candidate).then_some(candidate)
}

/// A started sidecar: its stdout and stdin, and the process when there is one.
pub struct SpawnedEngine {
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub child: Option<tokio::process::Child>,
}

/// Starts a sidecar for a models directory.
pub type EngineSpawner = Arc<dyn Fn(&Path) -> std::io::Result<SpawnedEngine> + Send + Sync>;

/// Runs the real `codeg-tts` binary.
pub fn process_spawner(binary: PathBuf) -> EngineSpawner {
    Arc::new(move |models: &Path| {
        let mut command = tokio::process::Command::new(&binary);
        crate::process::configure_tokio_command(&mut command);
        command
            .arg("--models")
            .arg(models)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let missing = || std::io::Error::other("codeg-tts started without its pipes");
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stdout = child.stdout.take().ok_or_else(missing)?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[TTS] {line}");
                }
            });
        }
        Ok(SpawnedEngine {
            stdout: Box::new(stdout),
            stdin: Box::new(stdin),
            child: Some(child),
        })
    })
}

// ── The service ──

pub struct TtsConfig {
    pub models_dir: PathBuf,
    pub catalog: Result<Vec<ModelFile>, String>,
    /// None where this backend can't synthesize; `unsupported_reason` says why.
    pub spawner: Option<EngineSpawner>,
    pub unsupported_reason: Option<String>,
    pub idle_shutdown: Duration,
    pub reap_every: Duration,
}

struct Engine {
    client: Arc<SidecarClient>,
    child: Option<tokio::process::Child>,
}

enum SlotEnd {
    Done(DoneStats),
    Failed(String),
}

struct SlotInner {
    chunks: Vec<AudioChunk>,
    end: Option<SlotEnd>,
    last_poll: Instant,
}

/// Told the new status whenever the models or a download change state, so
/// every window of the app, and every client of the server, learns that the
/// voice became ready (or stopped being) without asking.
pub type StatusListener = Arc<dyn Fn(TtsStatus) + Send + Sync>;

/// One synthesis as a client sees it: the chunks not yet polled.
struct Slot {
    sidecar_id: u64,
    client: Arc<SidecarClient>,
    inner: Mutex<SlotInner>,
    notify: Notify,
}

pub struct TtsService {
    store: Option<ModelStore>,
    catalog_error: Option<String>,
    spawner: Option<EngineSpawner>,
    unsupported_reason: Option<String>,
    idle_shutdown: Duration,
    reap_every: Duration,
    http: OnceLock<reqwest::Client>,
    download: Mutex<DownloadState>,
    download_cancel: Mutex<Option<CancellationToken>>,
    download_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    engine: tokio::sync::Mutex<Option<Engine>>,
    /// The running engine's client, readable without awaiting `engine`.
    current: Mutex<Option<Arc<SidecarClient>>>,
    engine_pid: Mutex<Option<u32>>,
    streams: Mutex<HashMap<String, Arc<Slot>>>,
    last_used: Mutex<Instant>,
    reaper_running: AtomicBool,
    status_listener: OnceLock<StatusListener>,
}

static SERVICE: OnceLock<Arc<TtsService>> = OnceLock::new();

/// The process-wide service. Desktop `invoke` and the HTTP API both come
/// here, so they share one download and one sidecar.
pub fn service_for(data_dir: &Path) -> Arc<TtsService> {
    SERVICE
        .get_or_init(|| Arc::new(TtsService::from_environment(data_dir)))
        .clone()
}

fn clamp_speed(speed: Option<f64>) -> f64 {
    match speed {
        Some(s) if s.is_finite() => s.clamp(MIN_SPEED, MAX_SPEED),
        _ => 1.0,
    }
}

/// Same rule as the sidecar: ASCII letters, digits, `-`, `_`.
fn is_safe_voice_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl TtsService {
    pub fn new(config: TtsConfig) -> Self {
        let (store, catalog_error) = match config.catalog {
            Ok(files) => (Some(ModelStore::new(config.models_dir, files)), None),
            Err(e) => (None, Some(e)),
        };
        Self {
            store,
            catalog_error,
            spawner: config.spawner,
            unsupported_reason: config.unsupported_reason,
            idle_shutdown: config.idle_shutdown,
            reap_every: config.reap_every,
            http: OnceLock::new(),
            download: Mutex::new(DownloadState::Idle),
            download_cancel: Mutex::new(None),
            download_task: Mutex::new(None),
            engine: tokio::sync::Mutex::new(None),
            current: Mutex::new(None),
            engine_pid: Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
            last_used: Mutex::new(Instant::now()),
            reaper_running: AtomicBool::new(false),
            status_listener: OnceLock::new(),
        }
    }

    /// Who hears about status changes. The first listener stays: a process
    /// has one event emitter, so later calls only build one to drop it.
    pub fn on_status_change(&self, listener: impl FnOnce() -> StatusListener) {
        self.status_listener.get_or_init(listener);
    }

    fn announce(&self) {
        if let Some(listener) = self.status_listener.get() {
            listener(self.status());
        }
    }

    /// Models under `<data dir>/tts/`, the sidecar found next to this binary
    /// on macOS, nothing anywhere else.
    pub fn from_environment(data_dir: &Path) -> Self {
        let switched_off = std::env::var(SWITCH_ENV)
            .map(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "off" | "0" | "false"
                )
            })
            .unwrap_or(false);
        let (spawner, reason) = if switched_off {
            (None, Some("disabled".to_string()))
        } else if !cfg!(target_os = "macos") {
            (None, Some("platform".to_string()))
        } else {
            match locate_sidecar() {
                Some(binary) => (Some(process_spawner(binary)), None),
                None => (None, Some("sidecarMissing".to_string())),
            }
        };
        Self::new(TtsConfig {
            models_dir: data_dir.join("tts").join(catalog::PACK_DIR),
            catalog: catalog::load(),
            spawner,
            unsupported_reason: reason,
            idle_shutdown: IDLE_SHUTDOWN,
            reap_every: Duration::from_secs(30),
        })
    }

    fn http(&self) -> &reqwest::Client {
        self.http.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(120))
                .user_agent(concat!("codeg/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default()
        })
    }

    fn store(&self) -> Result<&ModelStore, TtsError> {
        self.store.as_ref().ok_or_else(|| {
            TtsError::Unsupported(
                self.catalog_error
                    .clone()
                    .unwrap_or_else(|| "no model catalog".into()),
            )
        })
    }

    fn check_supported(&self) -> Result<&ModelStore, TtsError> {
        let store = self.store()?;
        if self.spawner.is_none() {
            return Err(TtsError::Unsupported(
                self.unsupported_reason
                    .clone()
                    .unwrap_or_else(|| "platform".into()),
            ));
        }
        Ok(store)
    }

    fn voices(&self) -> Vec<String> {
        self.store
            .as_ref()
            .map(|s| {
                s.files()
                    .iter()
                    .filter_map(|f| f.path.strip_prefix("voices/")?.strip_suffix(".json"))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }

    pub fn status(&self) -> TtsStatus {
        let store = self.store.as_ref();
        let client = self
            .current
            .lock()
            .unwrap()
            .clone()
            .filter(|c| c.is_alive());
        let voices = self.voices();
        let default_voice = if voices.iter().any(|v| v == catalog::DEFAULT_VOICE) {
            catalog::DEFAULT_VOICE.to_string()
        } else {
            voices.first().cloned().unwrap_or_default()
        };
        let unsupported_reason = if store.is_none() {
            self.catalog_error.clone()
        } else if self.spawner.is_none() {
            Some(
                self.unsupported_reason
                    .clone()
                    .unwrap_or_else(|| "platform".into()),
            )
        } else {
            None
        };
        TtsStatus {
            supported: unsupported_reason.is_none(),
            unsupported_reason,
            installed: store.map(|s| s.is_installed()).unwrap_or(false),
            download: self.download.lock().unwrap().clone(),
            pack_bytes: store.map(|s| s.total_bytes()).unwrap_or(0),
            bytes_on_disk: store.map(|s| s.bytes_on_disk()).unwrap_or(0),
            models_dir: store
                .map(|s| s.dir().display().to_string())
                .unwrap_or_default(),
            voices,
            default_voice,
            engine_running: client.is_some(),
            engine_loaded: client.map(|c| c.is_loaded()).unwrap_or(false),
        }
    }

    /// The running sidecar's process id (diagnostics and the E2E check).
    pub fn engine_pid(&self) -> Option<u32> {
        *self.engine_pid.lock().unwrap()
    }

    // ── Models ──

    /// Start downloading the pack in the background (no-op when it is
    /// installed or already downloading). Progress shows in `status`.
    pub fn start_download(self: &Arc<Self>) -> Result<TtsStatus, TtsError> {
        let store = self.check_supported()?;
        {
            let mut state = self.download.lock().unwrap();
            if matches!(*state, DownloadState::Downloading { .. }) || store.is_installed() {
                drop(state);
                return Ok(self.status());
            }
            *state = DownloadState::Downloading {
                bytes_done: store.bytes_on_disk(),
                bytes_total: store.total_bytes(),
            };
        }
        // Before the task starts, so its own announcement can't be overtaken.
        self.announce();
        let token = CancellationToken::new();
        *self.download_cancel.lock().unwrap() = Some(token.clone());
        let this = self.clone();
        let task = tokio::spawn(async move {
            let progress = |p: Progress| {
                *this.download.lock().unwrap() = DownloadState::Downloading {
                    bytes_done: p.bytes_done,
                    bytes_total: p.bytes_total,
                };
            };
            let result = match this.store.as_ref() {
                Some(store) => store.download(this.http(), &token, &progress).await,
                None => Ok(()),
            };
            let next = match result {
                Ok(()) => {
                    tracing::info!("[TTS] natural voice downloaded");
                    DownloadState::Idle
                }
                Err(StoreError::Cancelled) => DownloadState::Idle,
                Err(e) => {
                    tracing::warn!("[TTS] model download failed: {e}");
                    DownloadState::Failed {
                        message: e.to_string(),
                    }
                }
            };
            *this.download.lock().unwrap() = next;
            this.download_cancel.lock().unwrap().take();
            this.announce();
        });
        *self.download_task.lock().unwrap() = Some(task);
        Ok(self.status())
    }

    /// Stop a download; what arrived stays on disk for the next attempt.
    pub async fn cancel_download(&self) -> TtsStatus {
        if let Some(token) = self.download_cancel.lock().unwrap().take() {
            token.cancel();
        }
        let task = self.download_task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let mut state = self.download.lock().unwrap();
        if matches!(*state, DownloadState::Downloading { .. }) {
            *state = DownloadState::Idle;
        }
        drop(state);
        self.announce();
        self.status()
    }

    /// Stop the sidecar and remove the models, partial files included.
    pub async fn delete_models(&self) -> Result<TtsStatus, TtsError> {
        let store = self.store()?;
        self.cancel_download().await;
        self.stop_engine().await;
        store.delete()?;
        *self.download.lock().unwrap() = DownloadState::Idle;
        self.announce();
        Ok(self.status())
    }

    // ── Engine ──

    async fn ensure_engine(self: &Arc<Self>) -> Result<Arc<SidecarClient>, TtsError> {
        let store = self.check_supported()?;
        let mut engine = self.engine.lock().await;
        if let Some(current) = engine.as_ref() {
            if current.client.is_alive() {
                return Ok(current.client.clone());
            }
        }
        if let Some(dead) = engine.take() {
            Self::finish_engine(dead).await;
        }
        let spawner = self
            .spawner
            .clone()
            .ok_or_else(|| TtsError::Unsupported("platform".into()))?;
        let spawned = spawner(store.dir())
            .map_err(|e| TtsError::Engine(format!("could not start the speech engine: {e}")))?;
        let pid = spawned.child.as_ref().and_then(|c| c.id());
        let client = Arc::new(SidecarClient::new(spawned.stdout, spawned.stdin));
        // Warm start: the models load while the first request waits behind it.
        let _ = client.load().await;
        tracing::info!("[TTS] speech engine started (pid {pid:?})");
        *engine = Some(Engine {
            client: client.clone(),
            child: spawned.child,
        });
        *self.current.lock().unwrap() = Some(client.clone());
        *self.engine_pid.lock().unwrap() = pid;
        self.start_reaper();
        Ok(client)
    }

    async fn finish_engine(engine: Engine) {
        engine.client.shutdown().await;
        if let Some(mut child) = engine.child {
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }
    }

    async fn stop_engine(&self) {
        let mut engine = self.engine.lock().await;
        let streams: Vec<_> = self.streams.lock().unwrap().drain().collect();
        drop(streams);
        if let Some(e) = engine.take() {
            Self::finish_engine(e).await;
            tracing::info!("[TTS] speech engine stopped");
        }
        *self.current.lock().unwrap() = None;
        *self.engine_pid.lock().unwrap() = None;
    }

    /// Runs while an engine does: drops abandoned streams and stops the
    /// engine once it has been idle for `idle_shutdown`. Started (under the
    /// engine lock) with each engine; ends (under the lock) with it.
    fn start_reaper(self: &Arc<Self>) {
        if self.reaper_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        let every = self.reap_every;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(this) = weak.upgrade() else { return };
                this.sweep_abandoned().await;
                if this.reap_idle().await {
                    return;
                }
            }
        });
    }

    /// True when no engine is left (and the reaper should end).
    async fn reap_idle(&self) -> bool {
        let mut engine = self.engine.lock().await;
        let stop = match engine.as_ref() {
            None => true,
            Some(e) if !e.client.is_alive() => true,
            Some(e) => {
                let quiet = self.last_used.lock().unwrap().elapsed() >= self.idle_shutdown;
                quiet && self.streams.lock().unwrap().is_empty() && e.client.in_flight() == 0
            }
        };
        if stop {
            if let Some(e) = engine.take() {
                Self::finish_engine(e).await;
                tracing::info!("[TTS] speech engine idle; stopped it to free its memory");
            }
            *self.current.lock().unwrap() = None;
            *self.engine_pid.lock().unwrap() = None;
            self.reaper_running.store(false, Ordering::SeqCst);
        }
        stop
    }

    async fn sweep_abandoned(&self) {
        let abandoned: Vec<Arc<Slot>> = {
            let mut streams = self.streams.lock().unwrap();
            let ids: Vec<String> = streams
                .iter()
                .filter(|(_, s)| s.inner.lock().unwrap().last_poll.elapsed() > STREAM_ABANDONED)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| streams.remove(id)).collect()
        };
        for slot in abandoned {
            slot.client.cancel(slot.sidecar_id).await;
        }
    }

    // ── Streams ──

    pub async fn speak(self: &Arc<Self>, request: SpeakRequest) -> Result<SpeakStarted, TtsError> {
        let store = self.check_supported()?;
        if !store.is_installed() {
            return Err(TtsError::NotInstalled);
        }
        let text = request.text.trim();
        if text.is_empty() {
            return Err(TtsError::InvalidInput("nothing to read".into()));
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err(TtsError::InvalidInput(format!(
                "text is longer than {MAX_TEXT_CHARS} characters"
            )));
        }
        let voice = request.voice.as_deref().filter(|v| !v.is_empty());
        if let Some(v) = voice {
            if !is_safe_voice_name(v) {
                return Err(TtsError::InvalidInput(format!("unknown voice {v:?}")));
            }
        }
        self.touch();
        self.sweep_abandoned().await;
        let client = self.ensure_engine().await?;
        let synthesis = client
            .synthesize(text, voice, clamp_speed(request.speed))
            .await
            .map_err(|e| TtsError::Engine(e.to_string()))?;
        let slot = Arc::new(Slot {
            sidecar_id: synthesis.id,
            client,
            inner: Mutex::new(SlotInner {
                chunks: Vec::new(),
                end: None,
                last_poll: Instant::now(),
            }),
            notify: Notify::new(),
        });
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.streams
            .lock()
            .unwrap()
            .insert(stream_id.clone(), slot.clone());
        let mut events = synthesis.events;
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                let finished = !matches!(event, StreamEvent::Chunk(_));
                {
                    let mut inner = slot.inner.lock().unwrap();
                    match event {
                        StreamEvent::Chunk(c) => inner.chunks.push(c),
                        StreamEvent::Done(stats) => inner.end = Some(SlotEnd::Done(stats)),
                        StreamEvent::Failed(m) => inner.end = Some(SlotEnd::Failed(m)),
                    }
                }
                slot.notify.notify_waiters();
                if finished {
                    return;
                }
            }
            let mut inner = slot.inner.lock().unwrap();
            if inner.end.is_none() {
                inner.end = Some(SlotEnd::Failed("the speech engine stopped".into()));
            }
            drop(inner);
            slot.notify.notify_waiters();
        });
        Ok(SpeakStarted { stream_id })
    }

    /// New audio for a stream, waiting up to `wait_ms` for some. The answer
    /// with `done` carries the last chunks; the stream is gone after it.
    pub async fn poll(&self, request: PollRequest) -> Result<PollResult, TtsError> {
        let slot = self
            .streams
            .lock()
            .unwrap()
            .get(&request.stream_id)
            .cloned()
            .ok_or(TtsError::StreamNotFound)?;
        let wait = request
            .wait_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_POLL_WAIT)
            .min(MAX_POLL_WAIT);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = slot.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut inner = slot.inner.lock().unwrap();
                inner.last_poll = Instant::now();
                if !inner.chunks.is_empty() || inner.end.is_some() {
                    let chunks = std::mem::take(&mut inner.chunks);
                    let end = inner.end.take();
                    drop(inner);
                    if end.is_some() {
                        self.streams.lock().unwrap().remove(&request.stream_id);
                    }
                    self.touch();
                    let engine = base64::engine::general_purpose::STANDARD;
                    let mut result = PollResult {
                        chunks: chunks
                            .into_iter()
                            .map(|c| PolledChunk {
                                index: c.index,
                                sample_rate: c.sample_rate,
                                pcm: engine.encode(&c.pcm),
                            })
                            .collect(),
                        done: end.is_some(),
                        ..PollResult::default()
                    };
                    match end {
                        Some(SlotEnd::Done(stats)) => result.stats = Some(stats),
                        Some(SlotEnd::Failed(message)) => result.error = Some(message),
                        None => {}
                    }
                    return Ok(result);
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(PollResult::default());
            }
        }
    }

    /// Stop a stream (its audio is dropped).
    pub async fn cancel(&self, stream_id: &str) {
        let slot = self.streams.lock().unwrap().remove(stream_id);
        if let Some(slot) = slot {
            slot.client.cancel(slot.sidecar_id).await;
        }
    }
}

#[cfg(test)]
mod tests;
