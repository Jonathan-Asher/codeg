//! Crash reports sent by the iPhone app (Codeg Plus): MetricKit diagnostics,
//! uncaught Objective-C exceptions, and the audio errors it caught instead of
//! crashing. Each report is one JSON file under
//! `<data dir>/client-diagnostics/`, newest kept: at most [`MAX_REPORTS`]
//! files and [`MAX_TOTAL_BYTES`], the oldest go first.
//!
//! A report carries stack frames, the app's build, the device and OS, and
//! the app's recent events (screens, microphone and audio-route changes);
//! the app never puts message text, file names or tokens in one. The server
//! stores it as sent and logs only its kind and size, never its content.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::app_error::AppCommandError;

/// Largest report accepted, serialized.
pub const MAX_REPORT_BYTES: usize = 1024 * 1024;
/// Reports kept at most.
pub const MAX_REPORTS: usize = 300;
/// Bytes kept at most, across all reports.
pub const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
/// Frames shown in a list row.
const SUMMARY_FRAMES: usize = 8;

/// One write at a time: storing and evicting must not interleave.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// What the app gets back: the stored report's id.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticReceipt {
    pub id: String,
    /// `true` also when this id was already stored (a resend).
    pub stored: bool,
}

/// One row of the desktop's "iPhone crash reports" list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnosticSummary {
    pub id: String,
    pub received_at_ms: u64,
    pub kind: String,
    pub source: Option<String>,
    pub occurred_at: Option<String>,
    pub app_version: Option<String>,
    pub app_build: Option<String>,
    pub device_model: Option<String>,
    pub os: Option<String>,
    pub exception_type: Option<String>,
    pub signal: Option<String>,
    pub exception_name: Option<String>,
    pub reason: Option<String>,
    pub context: Option<String>,
    pub top_frames: Vec<String>,
    pub breadcrumb_count: usize,
    pub size_bytes: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// An id safe to put in a file name: letters, digits and `-`, 1 to 64.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn cut(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// `<received ms>-<id>.json`: sorts oldest first by name.
fn file_name(received_ms: u64, id: &str) -> String {
    format!("{received_ms:013}-{id}.json")
}

/// The id part of a stored file's name.
fn id_of(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".json")?;
    let (_, id) = stem.split_once('-')?;
    valid_id(id).then_some(id)
}

/// Stored reports, oldest first: (path, name, size).
fn stored_files(dir: &Path) -> Vec<(PathBuf, String, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(PathBuf, String, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            id_of(&name)?;
            let size = entry.metadata().ok().filter(|m| m.is_file())?.len();
            Some((path, name, size))
        })
        .collect();
    files.sort_by(|a, b| a.1.cmp(&b.1));
    files
}

/// Drop the oldest reports until both limits hold.
fn evict(dir: &Path, max_reports: usize, max_total_bytes: u64) {
    let mut files = stored_files(dir);
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    while !files.is_empty() && (files.len() > max_reports || total > max_total_bytes) {
        let (path, _, size) = files.remove(0);
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Store one report from the app. `report` is the app's JSON object; it must
/// carry a `kind`. Its `id` (when valid) makes a resend a no-op.
pub fn report_client_diagnostic_core(
    dir: &Path,
    report: Value,
) -> Result<ClientDiagnosticReceipt, AppCommandError> {
    store_report(dir, report, MAX_REPORTS, MAX_TOTAL_BYTES)
}

fn store_report(
    dir: &Path,
    report: Value,
    max_reports: usize,
    max_total_bytes: u64,
) -> Result<ClientDiagnosticReceipt, AppCommandError> {
    let Value::Object(fields) = &report else {
        return Err(AppCommandError::invalid_input(
            "A crash report must be a JSON object",
        ));
    };
    let kind = fields
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty() && k.len() <= 64)
        .ok_or_else(|| AppCommandError::invalid_input("A crash report needs a kind"))?
        .to_string();
    let id = fields
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let received_at_ms = now_ms();
    let mut envelope = Map::new();
    envelope.insert("receivedAtMs".into(), Value::from(received_at_ms));
    envelope.insert("report".into(), report);
    let bytes = serde_json::to_vec_pretty(&Value::Object(envelope)).map_err(|e| {
        AppCommandError::invalid_input("The crash report isn't valid JSON")
            .with_detail(e.to_string())
    })?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "The crash report is larger than {} KiB",
            MAX_REPORT_BYTES / 1024
        )));
    }

    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    std::fs::create_dir_all(dir).map_err(|e| {
        AppCommandError::io_error("Failed to create the crash report directory")
            .with_detail(e.to_string())
    })?;
    if stored_files(dir)
        .iter()
        .any(|f| id_of(&f.1) == Some(id.as_str()))
    {
        return Ok(ClientDiagnosticReceipt { id, stored: true });
    }
    let path = dir.join(file_name(received_at_ms, &id));
    let tmp = dir.join(format!(".{}.tmp", file_name(received_at_ms, &id)));
    std::fs::write(&tmp, &bytes)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            AppCommandError::io_error("Failed to store the crash report").with_detail(e.to_string())
        })?;
    evict(dir, max_reports, max_total_bytes);
    // The kind and size only: a report's content never reaches the log.
    tracing::info!(kind = %kind, bytes = bytes.len(), "stored a crash report from the iPhone app");
    Ok(ClientDiagnosticReceipt { id, stored: true })
}

fn summarize(name: &str, size: u64, envelope: &Value) -> Option<ClientDiagnosticSummary> {
    let id = id_of(name)?.to_string();
    let report = envelope.get("report")?;
    let text = |path: &[&str], max: usize| str_at(report, path).map(|s| cut(s, max));
    let top_frames = report
        .pointer("/summary/topFrames")
        .and_then(Value::as_array)
        .map(|frames| {
            frames
                .iter()
                .filter_map(Value::as_str)
                .take(SUMMARY_FRAMES)
                .map(|f| cut(f, 160))
                .collect()
        })
        .unwrap_or_default();
    Some(ClientDiagnosticSummary {
        id,
        received_at_ms: envelope
            .get("receivedAtMs")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        kind: text(&["kind"], 64).unwrap_or_else(|| "unknown".into()),
        source: text(&["source"], 64),
        occurred_at: text(&["occurredAt"], 64),
        app_version: text(&["app", "version"], 32),
        app_build: text(&["app", "build"], 32),
        device_model: text(&["device", "model"], 64),
        os: text(&["device", "os"], 64),
        exception_type: text(&["summary", "exceptionType"], 64),
        signal: text(&["summary", "signal"], 32),
        exception_name: text(&["summary", "exceptionName"], 160),
        reason: text(&["summary", "reason"], 400),
        context: text(&["summary", "context"], 160),
        top_frames,
        breadcrumb_count: report
            .get("breadcrumbs")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        size_bytes: size,
    })
}

/// The stored reports, newest first, at most `limit` (default 100).
pub fn list_client_diagnostics_core(
    dir: &Path,
    limit: Option<usize>,
) -> Vec<ClientDiagnosticSummary> {
    let limit = limit.unwrap_or(100).clamp(1, MAX_REPORTS);
    stored_files(dir)
        .into_iter()
        .rev()
        .filter_map(|(path, name, size)| {
            let bytes = std::fs::read(&path).ok()?;
            let envelope: Value = serde_json::from_slice(&bytes).ok()?;
            summarize(&name, size, &envelope)
        })
        .take(limit)
        .collect()
}

/// One stored report as received: `{ receivedAtMs, report }`.
pub fn get_client_diagnostic_core(dir: &Path, id: &str) -> Result<Value, AppCommandError> {
    if !valid_id(id) {
        return Err(AppCommandError::invalid_input("Invalid crash report id"));
    }
    let (path, _, _) = stored_files(dir)
        .into_iter()
        .find(|f| id_of(&f.1) == Some(id))
        .ok_or_else(|| AppCommandError::not_found("No such crash report"))?;
    let bytes = std::fs::read(&path).map_err(|e| {
        AppCommandError::io_error("Failed to read the crash report").with_detail(e.to_string())
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        AppCommandError::io_error("The stored crash report is damaged").with_detail(e.to_string())
    })
}

// ---------------------------------------------------------------------------
// Tauri command wrappers (desktop only)
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn report_client_diagnostic(
    report: Value,
) -> Result<ClientDiagnosticReceipt, AppCommandError> {
    report_client_diagnostic_core(&crate::paths::codeg_client_diagnostics_root(), report)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_client_diagnostics(
    limit: Option<usize>,
) -> Result<Vec<ClientDiagnosticSummary>, AppCommandError> {
    Ok(list_client_diagnostics_core(
        &crate::paths::codeg_client_diagnostics_root(),
        limit,
    ))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_client_diagnostic(id: String) -> Result<Value, AppCommandError> {
    get_client_diagnostic_core(&crate::paths::codeg_client_diagnostics_root(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn crash(id: &str) -> Value {
        json!({
            "schema": 1,
            "id": id,
            "kind": "uncaught_exception",
            "source": "exception_handler",
            "occurredAt": "2026-10-19T13:15:06.033Z",
            "app": { "version": "1.3.17", "build": "105", "bundleId": "io.ashurov.codeg" },
            "device": { "model": "iPhone18,2", "os": "iOS 27.2 (24B5089g)" },
            "summary": {
                "exceptionType": "EXC_CRASH",
                "signal": "SIGABRT",
                "exceptionName": "com.apple.coreaudio.avfaudio",
                "reason": "required condition is false: format.sampleRate == hwFormat.sampleRate",
                "topFrames": ["AVFAudio +458544", "AVFAudio +934844", "Codeg +2437700"]
            },
            "breadcrumbs": [{ "t": 1, "event": "mic.start", "detail": "standby" }]
        })
    }

    #[test]
    fn stores_lists_and_gets_a_report() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = report_client_diagnostic_core(dir.path(), crash("A1B2")).unwrap();
        assert_eq!(
            receipt,
            ClientDiagnosticReceipt {
                id: "A1B2".into(),
                stored: true
            }
        );

        let list = list_client_diagnostics_core(dir.path(), None);
        assert_eq!(list.len(), 1);
        let row = &list[0];
        assert_eq!(row.id, "A1B2");
        assert_eq!(row.kind, "uncaught_exception");
        assert_eq!(row.app_version.as_deref(), Some("1.3.17"));
        assert_eq!(row.app_build.as_deref(), Some("105"));
        assert_eq!(
            row.exception_name.as_deref(),
            Some("com.apple.coreaudio.avfaudio")
        );
        assert_eq!(
            row.top_frames,
            vec!["AVFAudio +458544", "AVFAudio +934844", "Codeg +2437700"]
        );
        assert_eq!(row.breadcrumb_count, 1);
        assert!(row.received_at_ms > 0);

        let full = get_client_diagnostic_core(dir.path(), "A1B2").unwrap();
        assert_eq!(full["report"], crash("A1B2"));
        assert!(full["receivedAtMs"].as_u64().unwrap() > 0);
    }

    #[test]
    fn a_resend_is_stored_once() {
        let dir = tempfile::tempdir().unwrap();
        report_client_diagnostic_core(dir.path(), crash("same-id")).unwrap();
        let again = report_client_diagnostic_core(dir.path(), crash("same-id")).unwrap();
        assert!(again.stored);
        assert_eq!(list_client_diagnostics_core(dir.path(), None).len(), 1);
    }

    #[test]
    fn rejects_what_is_not_a_report() {
        let dir = tempfile::tempdir().unwrap();
        assert!(report_client_diagnostic_core(dir.path(), json!([1, 2])).is_err());
        assert!(report_client_diagnostic_core(dir.path(), json!({ "id": "x" })).is_err());
        let huge = json!({ "kind": "crash", "pad": "x".repeat(MAX_REPORT_BYTES) });
        assert!(report_client_diagnostic_core(dir.path(), huge).is_err());
        assert!(stored_files(dir.path()).is_empty());
    }

    #[test]
    fn an_unsafe_id_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = report_client_diagnostic_core(dir.path(), crash("../../etc/passwd")).unwrap();
        assert!(valid_id(&receipt.id));
        assert_ne!(receipt.id, "../../etc/passwd");
        assert!(get_client_diagnostic_core(dir.path(), "../x").is_err());
        assert!(get_client_diagnostic_core(dir.path(), "missing").is_err());
    }

    #[test]
    fn evicts_the_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            store_report(dir.path(), crash(&format!("r{i}")), 3, u64::MAX).unwrap();
            // Distinct, increasing receive times.
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let ids: Vec<String> = list_client_diagnostics_core(dir.path(), None)
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["r4", "r3", "r2"]);

        // The byte cap too: room for about two reports.
        let size = stored_files(dir.path())[0].2;
        store_report(dir.path(), crash("r5"), 100, size * 2 + size / 2).unwrap();
        let ids: Vec<String> = list_client_diagnostics_core(dir.path(), None)
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["r5", "r4"]);
    }

    #[test]
    fn list_respects_the_limit_and_skips_strays() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..3 {
            report_client_diagnostic_core(dir.path(), crash(&format!("l{i}"))).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        std::fs::write(dir.path().join("0000000000001-broken.json"), "{").unwrap();
        let list = list_client_diagnostics_core(dir.path(), Some(2));
        assert_eq!(
            list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["l2", "l1"]
        );
    }
}
