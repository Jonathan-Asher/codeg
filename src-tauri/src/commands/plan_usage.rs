//! Subscription plan usage: how much of each agent's rate-limit windows is
//! left (Claude Code's 5-hour session and weekly windows, Codex's windows).
//!
//! Two sources, one shape ([`PlanUsageSnapshot`]):
//!
//! * **Claude Code — live.** claude-agent-acp forwards the SDK's
//!   `rate_limit_event` as an ACP `usage_update` whose `_meta` carries
//!   `{"_claude/rateLimit": <rate limit info>}`. Nothing is written to disk by
//!   the agent, it fires only when the numbers move, and only once a turn has
//!   produced its first assistant usage — so the latest reading is kept in
//!   memory ([`CLAUDE_STORE`]), merged per window (a `five_hour` update must
//!   not erase a known `seven_day`), and every change is pushed to the frontend
//!   as [`PLAN_USAGE_CHANGED_EVENT`]. The limits are account-wide, so one
//!   process-wide snapshot serves every session and every window.
//!
//!   The merged snapshot is also saved to [`crate::paths::codeg_plan_usage_file`]
//!   and read back on first use, so a restart doesn't blank the screen until
//!   the next turn. A reading loaded that way is marked
//!   [`PlanUsageSource::Saved`]; each window keeps the time it was last
//!   reported, so a window carried over from an older reading never passes
//!   for a fresh one.
//!
//! * **Codex — from disk.** Codex stamps the account's rate limits on every
//!   `token_count` event in its session rollouts
//!   (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`). The newest reading is
//!   found by tailing the most recently written rollouts — never parsing a
//!   whole file — and cached for [`CODEX_CACHE_TTL`].
//!
//! Neither source spawns a process or touches credentials.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::web::event_bridge::{emit_event, EventEmitter, PLAN_USAGE_CHANGED_EVENT};

/// `_meta` key claude-agent-acp puts the SDK's rate-limit info under.
pub const CLAUDE_RATE_LIMIT_META_KEY: &str = "_claude/rateLimit";

/// How long a Codex reading is reused before the rollouts are tailed again.
const CODEX_CACHE_TTL: Duration = Duration::from_secs(60);
/// Most rollout files looked at per read, newest first.
const CODEX_MAX_FILES: usize = 24;
/// Most `YYYY/MM/DD` day directories walked to find those files.
const CODEX_MAX_DAY_DIRS: usize = 31;
/// Bytes read from the end of each rollout. A `token_count` event follows
/// every model round-trip, so an active session has one well inside this.
const CODEX_TAIL_BYTES: u64 = 512 * 1024;
/// Version of the saved-reading file; a file with another version is ignored.
const PERSISTED_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanUsageAgent {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanUsageWindowKind {
    /// The short rolling window (Claude's 5 hours, Codex's 300 minutes).
    Session,
    /// The account-wide weekly window.
    Weekly,
    /// A weekly window scoped to one model family (Claude's Opus / Sonnet).
    WeeklyModel,
    /// Anything else: overage, an unrecognized span.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanUsageSource {
    /// Pushed by a running agent during a turn.
    Live,
    /// Read back from the agent's own session log.
    Transcript,
    /// A live reading saved before codeg last restarted, not yet superseded.
    Saved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanUsageWindow {
    /// Stable id within the agent: Claude's `rateLimitType` (`five_hour`,
    /// `seven_day`, `seven_day_opus`, …) or Codex's `primary` / `secondary`.
    pub id: String,
    pub kind: PlanUsageWindowKind,
    /// Short, language-neutral label: `5h`, `7d`, `Opus`, `Sonnet`.
    pub label: String,
    /// 0–100.
    pub used_percent: f64,
    /// Epoch seconds.
    pub resets_at: Option<i64>,
    pub window_minutes: Option<u32>,
    /// Epoch seconds this window's numbers were reported at. Differs from the
    /// snapshot's `observed_at` when a Claude update left the window alone.
    #[serde(default)]
    pub observed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanUsageSnapshot {
    pub agent: PlanUsageAgent,
    pub windows: Vec<PlanUsageWindow>,
    pub plan_label: Option<String>,
    /// `ok` | `warning` | `limited` | `overage`, when the source says.
    pub status: Option<String>,
    /// Epoch seconds the newest numbers were observed at.
    pub observed_at: i64,
    pub source: PlanUsageSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PlanUsageReport {
    /// One entry per agent that has any data; empty when neither does.
    pub snapshots: Vec<PlanUsageSnapshot>,
    /// Where Codex rollouts were looked for, for the empty state.
    pub codex_sessions_dir: Option<String>,
    /// Whether any Codex rollout exists there, with or without limits. Tells
    /// "no Codex sessions" apart from "sessions, but none report limits".
    pub codex_rollouts_found: bool,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Epoch seconds from a number that may be seconds or milliseconds.
fn epoch_secs(value: &Value) -> Option<i64> {
    let raw = value.as_f64()?;
    if !raw.is_finite() || raw <= 0.0 {
        return None;
    }
    let secs = if raw > 1.0e12 { raw / 1000.0 } else { raw };
    Some(secs as i64)
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

/// Claude reports utilization as a 0–1 fraction; tolerate a 0–100 percent.
fn utilization_percent(value: &Value) -> Option<f64> {
    let raw = value.as_f64()?;
    if !raw.is_finite() {
        return None;
    }
    Some(clamp_percent(if raw <= 1.0 { raw * 100.0 } else { raw }))
}

fn kind_order(window: &PlanUsageWindow) -> (PlanUsageWindowKind, String) {
    (window.kind, window.id.clone())
}

// ─── Claude Code (live) ─────────────────────────────────────────────────

/// Latest Claude reading, merged across updates, plus whether the saved copy
/// has been read back yet. Process-wide: the limits are the account's, not a
/// session's.
struct ClaudeStore {
    loaded: bool,
    snapshot: Option<PlanUsageSnapshot>,
}

static CLAUDE_STORE: Mutex<ClaudeStore> = Mutex::new(ClaudeStore {
    loaded: false,
    snapshot: None,
});

/// Serializes saves, so the file always ends up holding the newest snapshot
/// even when two writes race on the blocking pool.
static CLAUDE_SAVE_LOCK: Mutex<()> = Mutex::new(());

/// What one `_claude/rateLimit` payload says.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeRateLimitUpdate {
    pub windows: Vec<PlanUsageWindow>,
    pub status: Option<String>,
}

/// Kind, label and span of a Claude `rateLimitType`.
fn claude_window_shape(id: &str) -> (PlanUsageWindowKind, String, Option<u32>) {
    match id {
        "five_hour" => (PlanUsageWindowKind::Session, "5h".into(), Some(300)),
        "seven_day" => (PlanUsageWindowKind::Weekly, "7d".into(), Some(10_080)),
        "seven_day_overage_included" => (PlanUsageWindowKind::Other, "7d+".into(), Some(10_080)),
        "overage" => (PlanUsageWindowKind::Other, "Extra".into(), None),
        other => match other.strip_prefix("seven_day_") {
            // `seven_day_opus`, `seven_day_sonnet`, and whichever model gets
            // its own weekly cap next.
            Some(model) if !model.is_empty() => {
                let mut chars = model.chars();
                let label = chars
                    .next()
                    .map(|c| c.to_uppercase().chain(chars).collect::<String>())
                    .unwrap_or_default()
                    .replace('_', " ");
                (PlanUsageWindowKind::WeeklyModel, label, Some(10_080))
            }
            _ => (PlanUsageWindowKind::Other, other.to_string(), None),
        },
    }
}

fn claude_window(id: &str, used_percent: f64, resets_at: Option<i64>) -> PlanUsageWindow {
    let (kind, label, window_minutes) = claude_window_shape(id);
    PlanUsageWindow {
        id: id.to_string(),
        kind,
        label,
        used_percent,
        resets_at,
        window_minutes,
        observed_at: None,
    }
}

fn claude_status(info: &Value) -> Option<String> {
    let status = info.get("status").and_then(Value::as_str);
    if status == Some("rejected") {
        return Some("limited".into());
    }
    if info.get("isUsingOverage").and_then(Value::as_bool) == Some(true) {
        return Some("overage".into());
    }
    match status? {
        "allowed_warning" => Some("warning".into()),
        "allowed" => Some("ok".into()),
        _ => None,
    }
}

/// Parse one `_claude/rateLimit` payload. `None` when it names no window with
/// a usable reading and no status.
pub(crate) fn parse_claude_rate_limit(info: &Value) -> Option<ClaudeRateLimitUpdate> {
    if !info.is_object() {
        return None;
    }
    let mut windows: Vec<PlanUsageWindow> = Vec::new();

    // Internal field, present on newer CLIs: every unified window at once.
    if let Some(unified) = info.get("unifiedWindows").and_then(Value::as_object) {
        for (id, window) in unified {
            let Some(used) = window.get("utilization").and_then(utilization_percent) else {
                continue;
            };
            let resets_at = window
                .get("resetsAt")
                .or_else(|| window.get("resets_at"))
                .and_then(epoch_secs);
            windows.push(claude_window(id, used, resets_at));
        }
    }

    // The window this event is about. `unifiedWindows` wins where both speak.
    if let Some(id) = info.get("rateLimitType").and_then(Value::as_str) {
        if !windows.iter().any(|w| w.id == id) {
            let used = info
                .get("utilization")
                .and_then(utilization_percent)
                // A rejection with no number still means the window is spent.
                .or_else(|| {
                    (info.get("status").and_then(Value::as_str) == Some("rejected"))
                        .then_some(100.0)
                });
            if let Some(used) = used {
                let resets_at = info.get("resetsAt").and_then(epoch_secs);
                windows.push(claude_window(id, used, resets_at));
            }
        }
    }

    let status = claude_status(info);
    if windows.is_empty() && status.is_none() {
        return None;
    }
    windows.sort_by_key(kind_order);
    Some(ClaudeRateLimitUpdate { windows, status })
}

/// Fold an update into the previous snapshot: windows are replaced by id, the
/// rest are kept (a `five_hour` event says nothing about `seven_day`) with the
/// time they were last reported.
pub(crate) fn merge_claude_snapshot(
    previous: Option<PlanUsageSnapshot>,
    update: ClaudeRateLimitUpdate,
    observed_at: i64,
) -> PlanUsageSnapshot {
    let mut windows = previous
        .as_ref()
        .map(|s| {
            s.windows
                .iter()
                .cloned()
                .map(|mut w| {
                    // Readings saved before per-window times existed.
                    w.observed_at = w.observed_at.or(Some(s.observed_at));
                    w
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for mut window in update.windows {
        window.observed_at = Some(observed_at);
        match windows.iter_mut().find(|w| w.id == window.id) {
            Some(slot) => *slot = window,
            None => windows.push(window),
        }
    }
    windows.sort_by_key(kind_order);
    PlanUsageSnapshot {
        agent: PlanUsageAgent::ClaudeCode,
        windows,
        plan_label: previous.as_ref().and_then(|s| s.plan_label.clone()),
        status: update.status.or_else(|| previous.and_then(|s| s.status)),
        observed_at,
        source: PlanUsageSource::Live,
    }
}

/// On-disk shape of [`crate::paths::codeg_plan_usage_file`].
#[derive(Debug, Serialize, Deserialize)]
struct PersistedPlanUsage {
    version: u32,
    claude_code: Option<PlanUsageSnapshot>,
}

/// Write the Claude snapshot to `path` (temp file + rename, so a crash
/// mid-write leaves the previous reading intact).
pub(crate) fn save_claude_snapshot(
    path: &Path,
    snapshot: &PlanUsageSnapshot,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(&PersistedPlanUsage {
        version: PERSISTED_VERSION,
        claude_code: Some(snapshot.clone()),
    })
    .map_err(std::io::Error::other)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "plan-usage.json".into());
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, body) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// The Claude snapshot saved at `path`, marked [`PlanUsageSource::Saved`].
/// `None` for a missing, unreadable, foreign-version or empty file.
pub(crate) fn load_claude_snapshot(path: &Path) -> Option<PlanUsageSnapshot> {
    let body = std::fs::read(path).ok()?;
    let persisted: PersistedPlanUsage = serde_json::from_slice(&body).ok()?;
    if persisted.version != PERSISTED_VERSION {
        return None;
    }
    let mut snapshot = persisted
        .claude_code
        .filter(|s| s.agent == PlanUsageAgent::ClaudeCode && !s.windows.is_empty())?;
    snapshot.source = PlanUsageSource::Saved;
    for window in &mut snapshot.windows {
        window.observed_at = window.observed_at.or(Some(snapshot.observed_at));
    }
    Some(snapshot)
}

/// Run `f` on the process-wide Claude snapshot, reading the saved copy back
/// the first time anything asks.
fn with_claude_store<R>(f: impl FnOnce(&mut Option<PlanUsageSnapshot>) -> R) -> R {
    let mut guard = CLAUDE_STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.loaded {
        guard.loaded = true;
        if guard.snapshot.is_none() {
            guard.snapshot = load_claude_snapshot(&crate::paths::codeg_plan_usage_file());
        }
    }
    f(&mut guard.snapshot)
}

/// Save the current Claude snapshot off the async runtime. Each save reads
/// the store under [`CLAUDE_SAVE_LOCK`], so whichever runs last writes the
/// newest reading regardless of the order the pool schedules them in.
fn persist_claude_snapshot() {
    let save = || {
        let _save = CLAUDE_SAVE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(snapshot) = claude_snapshot() else {
            return;
        };
        let path = crate::paths::codeg_plan_usage_file();
        if let Err(e) = save_claude_snapshot(&path, &snapshot) {
            tracing::warn!(
                "[plan-usage] failed to save the Claude reading to {}: {e}",
                path.display()
            );
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn_blocking(save);
        }
        Err(_) => save(),
    }
}

/// Called for every ACP `usage_update`: records the plan limits riding its
/// `_meta`, if any, saves them, and pushes the merged snapshot to every window.
pub fn observe_claude_usage_meta(emitter: &EventEmitter, meta: &serde_json::Map<String, Value>) {
    let Some(info) = meta.get(CLAUDE_RATE_LIMIT_META_KEY) else {
        return;
    };
    let Some(update) = parse_claude_rate_limit(info) else {
        return;
    };
    let snapshot = with_claude_store(|slot| {
        let next = merge_claude_snapshot(slot.take(), update, now_secs());
        *slot = Some(next.clone());
        next
    });
    persist_claude_snapshot();
    emit_event(emitter, PLAN_USAGE_CHANGED_EVENT, &snapshot);
}

fn claude_snapshot() -> Option<PlanUsageSnapshot> {
    with_claude_store(|slot| slot.clone())
}

// ─── Codex (session rollouts) ───────────────────────────────────────────

/// One look at the Codex sessions directory.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CodexScan {
    pub snapshot: Option<PlanUsageSnapshot>,
    pub rollouts_found: bool,
    pub sessions_dir: PathBuf,
}

static CODEX_CACHE: Mutex<Option<(Instant, CodexScan)>> = Mutex::new(None);

fn codex_plan_label(plan_type: &str) -> String {
    match plan_type {
        "free" => "Free".into(),
        "go" => "Go".into(),
        "plus" => "Plus".into(),
        "pro" => "Pro".into(),
        "prolite" => "Pro Lite".into(),
        "team" => "Team".into(),
        "business" => "Business".into(),
        "enterprise" => "Enterprise".into(),
        "edu" => "Edu".into(),
        other => other.to_string(),
    }
}

fn span_label(minutes: u32) -> String {
    if minutes > 0 && minutes.is_multiple_of(1440) {
        format!("{}d", minutes / 1440)
    } else if minutes > 0 && minutes.is_multiple_of(60) {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

fn codex_window_kind(minutes: Option<u32>) -> PlanUsageWindowKind {
    match minutes {
        Some(m) if m > 0 && m <= 6 * 60 => PlanUsageWindowKind::Session,
        Some(m) if (6 * 1440..=8 * 1440).contains(&m) => PlanUsageWindowKind::Weekly,
        _ => PlanUsageWindowKind::Other,
    }
}

fn codex_window(id: &str, value: &Value, observed_at: i64) -> Option<PlanUsageWindow> {
    let used = value.get("used_percent").and_then(Value::as_f64)?;
    let window_minutes = value
        .get("window_minutes")
        .and_then(Value::as_u64)
        .and_then(|m| u32::try_from(m).ok());
    // Older Codex builds wrote a relative `resets_in_seconds` instead.
    let resets_at = value.get("resets_at").and_then(epoch_secs).or_else(|| {
        value
            .get("resets_in_seconds")
            .and_then(Value::as_i64)
            .filter(|_| observed_at > 0)
            .map(|secs| observed_at + secs)
    });
    Some(PlanUsageWindow {
        id: id.to_string(),
        kind: codex_window_kind(window_minutes),
        label: window_minutes
            .map(span_label)
            .unwrap_or_else(|| id.to_string()),
        used_percent: clamp_percent(used),
        resets_at,
        window_minutes,
        observed_at: (observed_at > 0).then_some(observed_at),
    })
}

/// A snapshot from one `payload.rate_limits` object. `None` when neither
/// window carries a reading (an API-key account, say).
pub(crate) fn codex_snapshot_from_rate_limits(
    rate_limits: &Value,
    observed_at: i64,
) -> Option<PlanUsageSnapshot> {
    let mut windows: Vec<PlanUsageWindow> = ["primary", "secondary"]
        .iter()
        .filter_map(|id| {
            let value = rate_limits.get(*id).filter(|v| v.is_object())?;
            codex_window(id, value, observed_at)
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    windows.sort_by_key(kind_order);
    let limited = rate_limits
        .get("rate_limit_reached_type")
        .is_some_and(|v| !v.is_null());
    Some(PlanUsageSnapshot {
        agent: PlanUsageAgent::Codex,
        windows,
        plan_label: rate_limits
            .get("plan_type")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(codex_plan_label),
        status: limited.then(|| "limited".to_string()),
        observed_at,
        source: PlanUsageSource::Transcript,
    })
}

/// The newest rate-limit reading in a chunk of rollout lines, scanning from
/// the end. Codex's own `codex` limit is preferred over any other limit id; a
/// different one is only used when the chunk has nothing else.
pub(crate) fn codex_snapshot_from_tail(text: &str) -> Option<PlanUsageSnapshot> {
    let mut fallback = None;
    for line in text.lines().rev() {
        // Cheap pre-filter: most lines are messages and tool output.
        if !line.contains("\"token_count\"") || !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(payload) = record.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(rate_limits) = payload.get("rate_limits").filter(|v| v.is_object()) else {
            continue;
        };
        let observed_at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|dt| dt.timestamp())
            .unwrap_or(0);
        let Some(snapshot) = codex_snapshot_from_rate_limits(rate_limits, observed_at) else {
            continue;
        };
        match rate_limits.get("limit_id").and_then(Value::as_str) {
            None | Some("codex") => return Some(snapshot),
            Some(_) => {
                if fallback.is_none() {
                    fallback = Some(snapshot);
                }
            }
        }
    }
    fallback
}

/// The last `max_bytes` of a file as text, starting at a line boundary.
fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.take(max_bytes).read_to_end(&mut buf)?;
    let body = if start > 0 {
        // Started mid-line: drop the fragment.
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => &buf[i + 1..],
            None => &[][..],
        }
    } else {
        &buf[..]
    };
    Ok(String::from_utf8_lossy(body).into_owned())
}

/// Numeric subdirectories (`2026`, `09`, `25`), newest name first.
fn dated_subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (!name.is_empty() && name.chars().all(|c| c.is_ascii_digit())).then(|| (name, e.path()))
        })
        .collect();
    // Same-width names in practice; comparing numerically keeps a stray
    // unpadded one in order too.
    dirs.sort_by(|a, b| {
        let key = |s: &str| (s.len(), s.to_string());
        key(&b.0).cmp(&key(&a.0))
    });
    dirs.into_iter().map(|(_, p)| p).collect()
}

/// The most recently written rollouts, newest first. Walks the newest day
/// directories only, and orders by modification time rather than name: a
/// resumed session keeps appending to the file named for the day it began.
pub(crate) fn recent_codex_rollouts(sessions_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    let mut days = 0usize;
    'walk: for year in dated_subdirs_desc(sessions_dir) {
        for month in dated_subdirs_desc(&year) {
            for day in dated_subdirs_desc(&month) {
                days += 1;
                if let Ok(entries) = std::fs::read_dir(&day) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                            continue;
                        }
                        let modified = entry
                            .metadata()
                            .and_then(|m| m.modified())
                            .unwrap_or(SystemTime::UNIX_EPOCH);
                        files.push((modified, entry.path()));
                    }
                }
                if files.len() >= CODEX_MAX_FILES || days >= CODEX_MAX_DAY_DIRS {
                    break 'walk;
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    files.truncate(CODEX_MAX_FILES);
    files.into_iter().map(|(_, p)| p).collect()
}

/// The newest Codex reading under `sessions_dir`: the first recent rollout
/// whose tail holds a non-null `rate_limits`.
pub(crate) fn scan_codex_plan_usage(sessions_dir: &Path) -> CodexScan {
    let rollouts = recent_codex_rollouts(sessions_dir);
    let rollouts_found = !rollouts.is_empty();
    let snapshot = rollouts.into_iter().find_map(|path| {
        let text = read_tail(&path, CODEX_TAIL_BYTES).ok()?;
        codex_snapshot_from_tail(&text)
    });
    CodexScan {
        snapshot,
        rollouts_found,
        sessions_dir: sessions_dir.to_path_buf(),
    }
}

async fn codex_scan(force: bool) -> CodexScan {
    if !force {
        let guard = CODEX_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, scan)) = guard.as_ref() {
            if at.elapsed() < CODEX_CACHE_TTL {
                return scan.clone();
            }
        }
    }
    let sessions_dir = crate::parsers::codex::resolve_codex_home_dir().join("sessions");
    let fallback = CodexScan {
        snapshot: None,
        rollouts_found: false,
        sessions_dir: sessions_dir.clone(),
    };
    let scan = tokio::task::spawn_blocking(move || scan_codex_plan_usage(&sessions_dir))
        .await
        .unwrap_or(fallback);
    *CODEX_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), scan.clone()));
    scan
}

// ─── Entry points ───────────────────────────────────────────────────────

/// Every agent's latest plan usage. `force` skips the Codex cache (the
/// screen's refresh button); Claude's reading is always the latest one held.
pub async fn get_plan_usage_core(force: bool) -> Result<PlanUsageReport, AppCommandError> {
    let codex = codex_scan(force).await;
    let snapshots = [claude_snapshot(), codex.snapshot]
        .into_iter()
        .flatten()
        .collect();
    Ok(PlanUsageReport {
        snapshots,
        codex_sessions_dir: Some(codex.sessions_dir.to_string_lossy().into_owned()),
        codex_rollouts_found: codex.rollouts_found,
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_plan_usage(force: Option<bool>) -> Result<PlanUsageReport, AppCommandError> {
    get_plan_usage_core(force.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn window<'a>(snapshot: &'a PlanUsageSnapshot, id: &str) -> &'a PlanUsageWindow {
        snapshot
            .windows
            .iter()
            .find(|w| w.id == id)
            .unwrap_or_else(|| panic!("no window {id}"))
    }

    #[test]
    fn claude_fraction_utilization_is_scaled_to_percent() {
        let update = parse_claude_rate_limit(&json!({
            "status": "allowed",
            "resetsAt": 1_790_000_000,
            "rateLimitType": "five_hour",
            "utilization": 0.42,
        }))
        .expect("update");
        assert_eq!(update.windows.len(), 1);
        let w = &update.windows[0];
        assert_eq!(w.id, "five_hour");
        assert_eq!(w.kind, PlanUsageWindowKind::Session);
        assert_eq!(w.label, "5h");
        assert!((w.used_percent - 42.0).abs() < 1e-9);
        assert_eq!(w.resets_at, Some(1_790_000_000));
        assert_eq!(update.status.as_deref(), Some("ok"));
    }

    #[test]
    fn claude_percent_utilization_is_kept_and_clamped() {
        let update = parse_claude_rate_limit(&json!({
            "status": "allowed_warning",
            "rateLimitType": "seven_day",
            "utilization": 61.5,
        }))
        .expect("update");
        assert!((update.windows[0].used_percent - 61.5).abs() < 1e-9);
        assert_eq!(update.windows[0].kind, PlanUsageWindowKind::Weekly);
        assert_eq!(update.status.as_deref(), Some("warning"));

        let over = parse_claude_rate_limit(&json!({
            "rateLimitType": "seven_day",
            "utilization": 140.0,
        }))
        .expect("update");
        assert_eq!(over.windows[0].used_percent, 100.0);
    }

    #[test]
    fn claude_exact_one_is_full_not_one_percent() {
        let update = parse_claude_rate_limit(&json!({
            "rateLimitType": "five_hour",
            "utilization": 1.0,
        }))
        .expect("update");
        assert_eq!(update.windows[0].used_percent, 100.0);
    }

    #[test]
    fn claude_millisecond_reset_is_read_as_seconds() {
        let update = parse_claude_rate_limit(&json!({
            "rateLimitType": "five_hour",
            "utilization": 0.1,
            "resetsAt": 1_790_000_000_000_i64,
        }))
        .expect("update");
        assert_eq!(update.windows[0].resets_at, Some(1_790_000_000));
    }

    #[test]
    fn claude_rejection_without_utilization_reads_as_full() {
        let update = parse_claude_rate_limit(&json!({
            "status": "rejected",
            "rateLimitType": "five_hour",
            "resetsAt": 1_790_000_000,
        }))
        .expect("update");
        assert_eq!(update.windows[0].used_percent, 100.0);
        assert_eq!(update.status.as_deref(), Some("limited"));
    }

    #[test]
    fn claude_status_only_update_is_kept_but_unknown_windows_are_not_invented() {
        let update = parse_claude_rate_limit(&json!({
            "status": "allowed",
            "rateLimitType": "five_hour",
        }))
        .expect("update");
        assert!(update.windows.is_empty());
        assert_eq!(update.status.as_deref(), Some("ok"));

        assert!(parse_claude_rate_limit(&json!({})).is_none());
        assert!(parse_claude_rate_limit(&json!("nope")).is_none());
    }

    #[test]
    fn claude_unified_windows_carry_every_window_and_win_over_the_top_level() {
        let update = parse_claude_rate_limit(&json!({
            "status": "allowed",
            "rateLimitType": "five_hour",
            "utilization": 0.10,
            "resetsAt": 1,
            "unifiedWindows": {
                "five_hour": { "utilization": 0.42, "resetsAt": 1_790_000_000 },
                "seven_day": { "utilization": 0.61, "resetsAt": 1_790_500_000 },
                "seven_day_overage_included": { "utilization": 0.05 },
            },
        }))
        .expect("update");
        assert_eq!(update.windows.len(), 3);
        // Ordered session → weekly → other.
        let ids: Vec<_> = update.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(
            ids,
            ["five_hour", "seven_day", "seven_day_overage_included"]
        );
        assert!((update.windows[0].used_percent - 42.0).abs() < 1e-9);
        assert_eq!(update.windows[0].resets_at, Some(1_790_000_000));
        assert!((update.windows[1].used_percent - 61.0).abs() < 1e-9);
        assert_eq!(update.windows[2].kind, PlanUsageWindowKind::Other);
    }

    #[test]
    fn claude_model_weekly_windows_are_labelled_by_model() {
        let opus = parse_claude_rate_limit(&json!({
            "rateLimitType": "seven_day_opus",
            "utilization": 0.3,
        }))
        .expect("update");
        assert_eq!(opus.windows[0].kind, PlanUsageWindowKind::WeeklyModel);
        assert_eq!(opus.windows[0].label, "Opus");

        let overage = parse_claude_rate_limit(&json!({
            "rateLimitType": "overage",
            "utilization": 0.3,
            "isUsingOverage": true,
            "status": "allowed",
        }))
        .expect("update");
        assert_eq!(overage.windows[0].kind, PlanUsageWindowKind::Other);
        assert_eq!(overage.status.as_deref(), Some("overage"));
    }

    #[test]
    fn claude_merge_keeps_windows_the_update_does_not_mention() {
        let first = parse_claude_rate_limit(&json!({
            "status": "allowed",
            "unifiedWindows": {
                "five_hour": { "utilization": 0.2, "resetsAt": 100 },
                "seven_day": { "utilization": 0.5, "resetsAt": 200 },
            },
        }))
        .expect("first");
        let snapshot = merge_claude_snapshot(None, first, 10);
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.source, PlanUsageSource::Live);
        assert_eq!(snapshot.agent, PlanUsageAgent::ClaudeCode);
        assert_eq!(window(&snapshot, "seven_day").observed_at, Some(10));

        let second = parse_claude_rate_limit(&json!({
            "rateLimitType": "five_hour",
            "utilization": 0.9,
            "resetsAt": 150,
        }))
        .expect("second");
        let merged = merge_claude_snapshot(Some(snapshot), second, 20);
        assert_eq!(merged.windows.len(), 2);
        assert!((window(&merged, "five_hour").used_percent - 90.0).abs() < 1e-9);
        assert_eq!(window(&merged, "five_hour").resets_at, Some(150));
        assert!((window(&merged, "seven_day").used_percent - 50.0).abs() < 1e-9);
        // Each window remembers when it was last reported.
        assert_eq!(window(&merged, "five_hour").observed_at, Some(20));
        assert_eq!(window(&merged, "seven_day").observed_at, Some(10));
        // A status-less update keeps the last known status.
        assert_eq!(merged.status.as_deref(), Some("ok"));
        assert_eq!(merged.observed_at, 20);
    }

    #[test]
    fn claude_merge_adds_a_model_window_next_to_the_account_ones() {
        let base = merge_claude_snapshot(
            None,
            parse_claude_rate_limit(&json!({
                "rateLimitType": "five_hour",
                "utilization": 0.3,
            }))
            .unwrap(),
            5,
        );
        let merged = merge_claude_snapshot(
            Some(base),
            parse_claude_rate_limit(&json!({
                "status": "allowed_warning",
                "rateLimitType": "seven_day_sonnet",
                "utilization": 0.8,
            }))
            .unwrap(),
            6,
        );
        let ids: Vec<_> = merged.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["five_hour", "seven_day_sonnet"]);
        assert_eq!(window(&merged, "seven_day_sonnet").label, "Sonnet");
        assert_eq!(merged.status.as_deref(), Some("warning"));
    }

    #[test]
    fn claude_saved_reading_round_trips_and_comes_back_marked_saved() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("plan-usage.json");
        let snapshot = merge_claude_snapshot(
            None,
            parse_claude_rate_limit(&json!({
                "status": "allowed",
                "rateLimitType": "five_hour",
                "utilization": 0.25,
                "resetsAt": 1_790_000_000,
            }))
            .unwrap(),
            1_789_990_000,
        );
        save_claude_snapshot(&path, &snapshot).expect("save");
        // Temp file renamed away, nothing else left beside it.
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["plan-usage.json"]);

        let loaded = load_claude_snapshot(&path).expect("loaded");
        assert_eq!(loaded.source, PlanUsageSource::Saved);
        assert_eq!(loaded.observed_at, 1_789_990_000);
        assert_eq!(loaded.windows, snapshot.windows);

        // A live update after a restart supersedes the saved reading but
        // keeps the windows it doesn't mention, with their old times.
        let merged = merge_claude_snapshot(
            Some(loaded),
            parse_claude_rate_limit(&json!({
                "rateLimitType": "seven_day",
                "utilization": 0.4,
            }))
            .unwrap(),
            1_790_000_100,
        );
        assert_eq!(merged.source, PlanUsageSource::Live);
        assert_eq!(
            window(&merged, "five_hour").observed_at,
            Some(1_789_990_000)
        );
        assert_eq!(
            window(&merged, "seven_day").observed_at,
            Some(1_790_000_100)
        );
    }

    #[test]
    fn claude_saved_reading_ignores_bad_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plan-usage.json");
        assert!(load_claude_snapshot(&path).is_none());

        std::fs::write(&path, "{not json").unwrap();
        assert!(load_claude_snapshot(&path).is_none());

        std::fs::write(&path, r#"{"version":99,"claude_code":null}"#).unwrap();
        assert!(load_claude_snapshot(&path).is_none());

        std::fs::write(&path, r#"{"version":1,"claude_code":null}"#).unwrap();
        assert!(load_claude_snapshot(&path).is_none());

        // A file written before per-window times existed still loads, each
        // window taking the snapshot's time.
        std::fs::write(
            &path,
            r#"{"version":1,"claude_code":{"agent":"claude_code","windows":[{"id":"five_hour","kind":"session","label":"5h","used_percent":12.0,"resets_at":null,"window_minutes":300}],"plan_label":null,"status":"ok","observed_at":42,"source":"live"}}"#,
        )
        .unwrap();
        let loaded = load_claude_snapshot(&path).expect("legacy file");
        assert_eq!(loaded.windows[0].observed_at, Some(42));
    }

    const LINE_NULL: &str = r#"{"timestamp":"2026-09-25T15:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#;
    const LINE_OLD: &str = r#"{"timestamp":"2026-09-25T14:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":50.0,"window_minutes":10080,"resets_at":1790440222},"secondary":null,"plan_type":"prolite","rate_limit_reached_type":null}}}"#;
    const LINE_NEW: &str = r#"{"timestamp":"2026-09-25T15:05:50.570Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":99.0,"window_minutes":10080,"resets_at":1790440222},"secondary":{"used_percent":12.5,"window_minutes":300,"resets_at":1790400000},"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"plan_type":"prolite","rate_limit_reached_type":null}}}"#;
    const LINE_MESSAGE: &str = r#"{"timestamp":"2026-09-25T15:06:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"token_count rate_limits"}]}}"#;

    #[test]
    fn codex_tail_takes_the_last_non_null_rate_limits() {
        let text = [LINE_OLD, LINE_NEW, LINE_NULL, LINE_MESSAGE].join("\n");
        let snapshot = codex_snapshot_from_tail(&text).expect("snapshot");
        assert_eq!(snapshot.agent, PlanUsageAgent::Codex);
        assert_eq!(snapshot.source, PlanUsageSource::Transcript);
        assert_eq!(snapshot.plan_label.as_deref(), Some("Pro Lite"));
        assert_eq!(snapshot.status, None);
        let observed = chrono::DateTime::parse_from_rfc3339("2026-09-25T15:05:50.570Z")
            .unwrap()
            .timestamp();
        assert_eq!(snapshot.observed_at, observed);
        // Session (300 min) sorts before weekly (10080 min).
        assert_eq!(snapshot.windows.len(), 2);
        let session = &snapshot.windows[0];
        assert_eq!(session.id, "secondary");
        assert_eq!(session.kind, PlanUsageWindowKind::Session);
        assert_eq!(session.label, "5h");
        assert_eq!(session.window_minutes, Some(300));
        assert_eq!(session.observed_at, Some(observed));
        let weekly = &snapshot.windows[1];
        assert_eq!(weekly.id, "primary");
        assert_eq!(weekly.kind, PlanUsageWindowKind::Weekly);
        assert_eq!(weekly.label, "7d");
        assert_eq!(weekly.used_percent, 99.0);
        assert_eq!(weekly.resets_at, Some(1_790_440_222));
    }

    #[test]
    fn codex_tail_with_only_null_rate_limits_has_nothing() {
        let text = [LINE_NULL, LINE_MESSAGE].join("\n");
        assert!(codex_snapshot_from_tail(&text).is_none());
        assert!(codex_snapshot_from_tail("not json\n{}").is_none());
    }

    #[test]
    fn codex_tail_survives_a_torn_last_line() {
        // A rollout being appended to mid-read ends in half a record.
        let torn = &LINE_NEW[..LINE_NEW.len() / 2];
        let text = [LINE_OLD, torn].join("\n");
        let snapshot = codex_snapshot_from_tail(&text).expect("snapshot");
        assert_eq!(snapshot.windows[0].used_percent, 50.0);
    }

    #[test]
    fn codex_limit_reached_marks_the_snapshot_limited() {
        let snapshot = codex_snapshot_from_rate_limits(
            &json!({
                "primary": { "used_percent": 100.0, "window_minutes": 300, "resets_in_seconds": 60 },
                "secondary": null,
                "rate_limit_reached_type": "primary",
            }),
            1_000,
        )
        .expect("snapshot");
        assert_eq!(snapshot.status.as_deref(), Some("limited"));
        // Relative reset from older builds is anchored at the observation.
        assert_eq!(snapshot.windows[0].resets_at, Some(1_060));
        assert!(
            codex_snapshot_from_rate_limits(&json!({ "primary": null, "secondary": null }), 1)
                .is_none()
        );
    }

    #[test]
    fn codex_prefers_its_own_limit_id() {
        let other = r#"{"timestamp":"2026-09-25T16:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"other_model","primary":{"used_percent":3.0,"window_minutes":10080}}}}"#;
        let text = [LINE_OLD, other].join("\n");
        let snapshot = codex_snapshot_from_tail(&text).expect("snapshot");
        assert_eq!(snapshot.windows[0].used_percent, 50.0);
        // …but a lone foreign limit is still better than nothing.
        let alone = codex_snapshot_from_tail(other).expect("fallback");
        assert_eq!(alone.windows[0].used_percent, 3.0);
    }

    fn write_rollout(dir: &Path, name: &str, lines: &[&str], modified: SystemTime) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        path
    }

    #[test]
    fn codex_reads_the_most_recently_written_rollout_with_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        // Older day, but written last (a resumed session): wins.
        write_rollout(
            &sessions.join("2026").join("09").join("20"),
            "rollout-2026-09-20T10-00-00-a.jsonl",
            &[LINE_NEW],
            base + Duration::from_secs(300),
        );
        // Newest day by name, written earlier.
        write_rollout(
            &sessions.join("2026").join("09").join("25"),
            "rollout-2026-09-25T10-00-00-b.jsonl",
            &[LINE_OLD],
            base + Duration::from_secs(100),
        );
        // Newest of all, but only null limits: skipped.
        write_rollout(
            &sessions.join("2026").join("09").join("25"),
            "rollout-2026-09-25T11-00-00-c.jsonl",
            &[LINE_NULL],
            base + Duration::from_secs(900),
        );
        // Not a rollout.
        write_rollout(
            &sessions.join("2026").join("09").join("25"),
            "notes.jsonl",
            &[LINE_OLD],
            base + Duration::from_secs(1_000),
        );

        let order: Vec<String> = recent_codex_rollouts(&sessions)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            order,
            [
                "rollout-2026-09-25T11-00-00-c.jsonl",
                "rollout-2026-09-20T10-00-00-a.jsonl",
                "rollout-2026-09-25T10-00-00-b.jsonl",
            ]
        );
        let scan = scan_codex_plan_usage(&sessions);
        assert!(scan.rollouts_found);
        assert_eq!(scan.sessions_dir, sessions);
        let snapshot = scan.snapshot.expect("snapshot");
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(window(&snapshot, "primary").used_percent, 99.0);
    }

    #[test]
    fn codex_rollouts_without_limits_are_found_but_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        write_rollout(
            &sessions.join("2026").join("09").join("25"),
            "rollout-2026-09-25T11-00-00-c.jsonl",
            &[LINE_NULL, LINE_MESSAGE],
            SystemTime::now(),
        );
        let scan = scan_codex_plan_usage(&sessions);
        assert!(scan.rollouts_found);
        assert!(scan.snapshot.is_none());
    }

    #[test]
    fn codex_missing_sessions_dir_has_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let scan = scan_codex_plan_usage(&tmp.path().join("nope"));
        assert!(!scan.rollouts_found);
        assert!(scan.snapshot.is_none());
    }

    #[test]
    fn tail_read_drops_the_partial_first_line() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("f.jsonl");
        std::fs::write(&path, "first line\nsecond\nthird\n").unwrap();
        assert_eq!(read_tail(&path, 13).unwrap(), "third\n");
        assert_eq!(
            read_tail(&path, 1_000).unwrap(),
            "first line\nsecond\nthird\n"
        );
    }

    #[test]
    fn span_labels_read_naturally() {
        assert_eq!(span_label(300), "5h");
        assert_eq!(span_label(10_080), "7d");
        assert_eq!(span_label(90), "90m");
        assert_eq!(codex_window_kind(Some(43_200)), PlanUsageWindowKind::Other);
    }

    #[test]
    fn report_serializes_in_the_shape_the_frontend_reads() {
        let snapshot = merge_claude_snapshot(
            None,
            parse_claude_rate_limit(&json!({
                "rateLimitType": "seven_day_opus",
                "utilization": 0.5,
                "resetsAt": 5,
            }))
            .unwrap(),
            7,
        );
        let value = serde_json::to_value(PlanUsageReport {
            snapshots: vec![snapshot],
            codex_sessions_dir: Some("/home/u/.codex/sessions".into()),
            codex_rollouts_found: false,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({
                "snapshots": [{
                    "agent": "claude_code",
                    "windows": [{
                        "id": "seven_day_opus",
                        "kind": "weekly_model",
                        "label": "Opus",
                        "used_percent": 50.0,
                        "resets_at": 5,
                        "window_minutes": 10080,
                        "observed_at": 7,
                    }],
                    "plan_label": null,
                    "status": null,
                    "observed_at": 7,
                    "source": "live",
                }],
                "codex_sessions_dir": "/home/u/.codex/sessions",
                "codex_rollouts_found": false,
            })
        );
    }
}
