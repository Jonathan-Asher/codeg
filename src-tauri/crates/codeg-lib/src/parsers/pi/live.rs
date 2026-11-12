//! The live half of the fold: pi-acp's structured cards (`_meta.piAcp.*`,
//! 0.0.34-steering.6 and later) reshaped into the cards the history pass
//! writes (`fold.rs`), so a call streaming in and the same call after a reload
//! render through one renderer and cannot drift apart.
//!
//! pi-acp already sends what the history pass reconstructs from notices: a
//! sub-agent run's status, rows, questions and answers (`subagentRun`), a
//! background job's state (`backgroundJob`), the start of a run Pi began by
//! itself (`agentTurn.trigger`) and the notices themselves (`customMessage`).
//! This module only renames and trims, with the history pass's own rules
//! (labels, caps, status vocabulary, what is stripped from results and
//! errors). Fields only a live card can know (a child's current tool, when a
//! run started) ride along under their own names; the history renderer reads
//! none of them, the live one shows them while a run is still going.

use serde_json::{Map, Value};

use crate::parsers::truncate_str;

use super::fold::{
    clean_error, clean_notice, first_line, format_duration, is_run_result, keyed, object,
    output_tail, strip_agent_label, AGENT_WAKE_META_KEY, BACKGROUND_JOB_META_KEY,
    DESCRIPTION_MAX_CHARS, NOTES_MAX, NOTE_MAX_CHARS, RESULT_MAX_CHARS, ROW_TEXT_MAX_CHARS,
    SUBAGENT_RUN_META_KEY,
};

/// Text a live System note keeps, as the history parser cuts a displayed
/// custom message.
const SYSTEM_NOTE_MAX_CHARS: usize = 4_000;

/// One raw notice kept on a card for its "What the model saw" toggle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveNote {
    pub(crate) kind: &'static str,
    pub(crate) text: String,
}

impl LiveNote {
    pub(crate) fn new(kind: &'static str, text: &str) -> Self {
        LiveNote {
            kind,
            text: truncate_str(text.trim(), NOTE_MAX_CHARS),
        }
    }
}

/// How many raw notices a card keeps.
pub(crate) const LIVE_NOTES_MAX: usize = NOTES_MAX;

/// The note kind a notice gets on the run card it names, as the history pass
/// files it (`fold_question`, `fold_child`, `fold_run`, `fold_attention`).
/// `None` for a background job's exit, which its job card carries itself.
pub(crate) fn note_kind(custom_type: &str) -> Option<&'static str> {
    match custom_type {
        "subagent_supervisor_request" => Some("question"),
        "subagent-incremental-child-notify" => Some("child"),
        "subagent-notify" => Some("result"),
        "bg-job-exit" | "injected-user" => None,
        other if other.starts_with("subagent") => Some("attention"),
        _ => Some("notice"),
    }
}

/// What woke Pi, in the history pass's words (`Notice::wake_kind`), for a
/// notice of `custom_type`. `legacy_job_report`: an older pi-bg-jobs exit
/// report, sent as a user message.
pub(crate) fn wake_kind(custom_type: &str, legacy_job_report: bool) -> &'static str {
    if legacy_job_report {
        return "jobExit";
    }
    match custom_type {
        "subagent_supervisor_request" => "subagentQuestion",
        "subagent-notify" | "subagent-incremental-child-notify" => "subagentSettled",
        "bg-job-exit" => "jobExit",
        other if other.starts_with("subagent") => "subagentAttention",
        _ => "extension",
    }
}

/// The wake kind of pi-acp's `agentTurn.trigger.kind`. `None` where the
/// history pass draws no marker: a run that began without a notice
/// (`unknown`), or with a user message an extension sent (`injectedUser`,
/// which the history shows as a user message; an older pi-bg-jobs exit report
/// is `jobExit`).
pub(crate) fn wake_kind_of_trigger(kind: &str) -> Option<&'static str> {
    match kind {
        "subagentSettled" => Some("subagentSettled"),
        "subagentQuestion" => Some("subagentQuestion"),
        "subagentAttention" => Some("subagentAttention"),
        "jobExit" => Some("jobExit"),
        "extension" => Some("extension"),
        _ => None,
    }
}

/// Whether a notice is one the history pass skips entirely: what an extension
/// hides in its own chat stays hidden, except a run's result (pi-subagents
/// 0.80+ hides a clean completion that still wakes Pi).
pub(crate) fn is_skipped_hidden(custom_type: &str, hidden: bool) -> bool {
    hidden && !is_run_result(custom_type)
}

/// One trigger of a wake marker: its kind and what the model read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WakeTrigger {
    pub(crate) kind: &'static str,
    pub(crate) text: String,
}

/// The `_meta` of the marker opening a run Pi started by itself, the same
/// object `Wake::blocks` puts on the history's marker call.
pub(crate) fn wake_meta(triggers: &[WakeTrigger]) -> Value {
    let triggers: Vec<Value> = triggers
        .iter()
        .map(|trigger| {
            object([
                ("kind", Some(Value::from(trigger.kind))),
                (
                    "text",
                    Some(Value::from(truncate_str(
                        trigger.text.trim(),
                        NOTE_MAX_CHARS,
                    ))),
                ),
            ])
        })
        .collect();
    keyed(
        AGENT_WAKE_META_KEY,
        object([
            ("version", Some(Value::from(1))),
            ("triggers", Some(Value::Array(triggers))),
        ]),
    )
}

/// The `_meta` key of a live System note (a displayed notice no card claims),
/// drawn the way the history draws that notice: a System message.
pub(crate) const SYSTEM_NOTE_META_KEY: &str = "codeg.systemNote";

/// A displayed notice no card claims, as the history shows it: the text the
/// pi-subagents and bg-jobs notices carry without the lines addressed to the
/// model, any other extension's verbatim.
pub(crate) fn system_note_meta(custom_type: &str, text: &str) -> Value {
    let cleaned = if custom_type.starts_with("subagent") || custom_type == "bg-job-exit" {
        clean_notice(text)
    } else {
        text.trim().to_string()
    };
    keyed(
        SYSTEM_NOTE_META_KEY,
        object([
            ("version", Some(Value::from(1))),
            ("customType", Some(Value::from(custom_type))),
            (
                "text",
                Some(Value::from(truncate_str(&cleaned, SYSTEM_NOTE_MAX_CHARS))),
            ),
        ]),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent runs
// ─────────────────────────────────────────────────────────────────────────────

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|v| v.is_number()).cloned()
}

/// A live status on the history card's scale. The live channel adds no
/// status of its own; anything unrecognized reads like the history pass reads
/// it.
fn live_status(status: Option<&str>) -> Option<&'static str> {
    let status = status?;
    Some(match status {
        "pending" => "pending",
        "running" | "active" => "running",
        other => super::fold::normalize_status(other),
    })
}

fn is_terminal(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed" | "paused" | "stopped"))
}

/// What to call a run: its one agent, the agent all its children share, else
/// how it ran — `Launch::agent_label`.
pub(crate) fn run_agent_label(live: &Value, args: Option<&Value>) -> String {
    if let Some(agent) = args.and_then(|args| text(args, "agent")) {
        return agent;
    }
    let agents: Vec<String> = live
        .get("children")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(|row| text(row, "agent")).collect())
        .unwrap_or_default();
    match agents.first() {
        Some(first) if agents.iter().all(|agent| agent == first) => first.clone(),
        _ => text(live, "mode").unwrap_or_else(|| "single".to_string()),
    }
}

/// A row's label when pi-acp gave none: its workflow key, else its agent
/// (`ChildRow::label`).
fn row_label(key: &str, agent: Option<&str>) -> String {
    match key.strip_prefix('#') {
        Some(_) => agent.unwrap_or("sub-agent").to_string(),
        None => key.to_string(),
    }
}

fn row(live: &Value) -> Option<Value> {
    let key = text(live, "key")?;
    let agent = text(live, "agent");
    let status = live_status(live.get("status").and_then(Value::as_str));
    let label = text(live, "label").unwrap_or_else(|| row_label(&key, agent.as_deref()));
    let capped =
        |key: &str| text(live, key).map(|v| Value::from(truncate_str(&v, ROW_TEXT_MAX_CHARS)));
    let exchanges: Vec<Value> = live
        .get("exchanges")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|exchange| {
                    let question = text(exchange, "question")?;
                    Some(object([
                        (
                            "question",
                            Some(Value::from(truncate_str(&question, ROW_TEXT_MAX_CHARS))),
                        ),
                        (
                            "answer",
                            text(exchange, "answer").map(|answer| {
                                Value::from(truncate_str(&answer, ROW_TEXT_MAX_CHARS))
                            }),
                        ),
                    ]))
                })
                .collect()
        })
        .unwrap_or_default();
    let attention: Vec<Value> = live
        .get("attention")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(|a| Value::from(truncate_str(a, ROW_TEXT_MAX_CHARS)))
                .collect()
        })
        .unwrap_or_default();
    // Only while the child still works: what it is doing right now.
    let activity = (!is_terminal(status))
        .then(|| live.get("activity").filter(|a| a.is_object()))
        .flatten()
        .map(|activity| {
            object([
                (
                    "currentTool",
                    text(activity, "currentTool").map(Value::from),
                ),
                ("toolCount", number(activity, "toolCount")),
            ])
        });
    Some(object([
        ("key", Some(Value::from(key.as_str()))),
        ("label", Some(Value::from(label))),
        ("agent", agent.map(Value::from)),
        ("status", status.map(Value::from)),
        ("runId", text(live, "runId").map(Value::from)),
        ("task", capped("task")),
        (
            "error",
            text(live, "error")
                .map(|e| Value::from(truncate_str(&clean_error(&e), ROW_TEXT_MAX_CHARS))),
        ),
        ("result", capped("result")),
        ("sessionId", text(live, "sessionId").map(Value::from)),
        ("model", text(live, "model").map(Value::from)),
        ("tokens", number(live, "tokens")),
        ("turns", number(live, "turns")),
        (
            "exchanges",
            (!exchanges.is_empty()).then_some(Value::Array(exchanges)),
        ),
        (
            "attention",
            (!attention.is_empty()).then_some(Value::Array(attention)),
        ),
        ("activity", activity),
        ("startedAt", number(live, "startedAt")),
        ("durationMs", number(live, "durationMs")),
    ]))
}

/// A run's own result and error, as the history card holds them: the result
/// without the leading `<agent>:` line single-run previews open with, and an
/// `Error: …` result of a failed run as its error.
fn outcome(live: &Value, status: Option<&str>, agent: &str) -> (Option<String>, Option<String>) {
    let error = text(live, "error")
        .map(|e| clean_error(&e))
        .filter(|e| !e.is_empty());
    let result = text(live, "result")
        .map(|raw| strip_agent_label(&raw, agent))
        .filter(|r| !r.is_empty() && r != "(no output)");
    match (result, error) {
        (Some(result), None) if status == Some("failed") => match result.strip_prefix("Error: ") {
            Some(rest) => (None, Some(clean_error(rest))),
            None => (Some(truncate_str(&result, RESULT_MAX_CHARS)), None),
        },
        (result, error) => (result.map(|r| truncate_str(&r, RESULT_MAX_CHARS)), error),
    }
}

/// `_meta` of a live run card: `{"codeg.subagentRun": …}` in the history
/// card's shape (`Launch::card`), notes included. `args` are the launch's
/// arguments, when known.
pub(crate) fn run_meta(live: &Value, args: Option<&Value>, notes: &[LiveNote]) -> Value {
    let status = live_status(live.get("status").and_then(Value::as_str)).unwrap_or("pending");
    let agent = run_agent_label(live, args);
    let (result, error) = outcome(live, Some(status), &agent);
    let task = args
        .and_then(|args| text(args, "task"))
        .or_else(|| text(live, "task"));
    let children: Vec<Value> = live
        .get("children")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(row).collect())
        .unwrap_or_default();
    let notes: Vec<Value> = notes
        .iter()
        .map(|note| {
            object([
                ("kind", Some(Value::from(note.kind))),
                ("text", Some(Value::from(note.text.as_str()))),
            ])
        })
        .collect();
    let activity = (!is_terminal(Some(status)))
        .then(|| live.get("activity").filter(|a| a.is_object()).cloned())
        .flatten();
    keyed(
        SUBAGENT_RUN_META_KEY,
        object([
            ("version", Some(Value::from(1))),
            (
                "mode",
                Some(Value::from(
                    text(live, "mode").unwrap_or_else(|| "single".to_string()),
                )),
            ),
            (
                "async",
                Some(Value::Bool(
                    live.get("async").and_then(Value::as_bool) == Some(true),
                )),
            ),
            ("status", Some(Value::from(status))),
            ("agent", Some(Value::from(agent.as_str()))),
            (
                "task",
                task.map(|task| Value::from(truncate_str(&task, ROW_TEXT_MAX_CHARS))),
            ),
            ("runId", text(live, "runId").map(Value::from)),
            ("durationMs", number(live, "durationMs")),
            ("tokens", number(live, "tokens")),
            ("result", result.map(Value::from)),
            ("error", error.map(Value::from)),
            ("children", Some(Value::Array(children))),
            ("notes", Some(Value::Array(notes))),
            // Live only.
            ("startedAt", number(live, "startedAt")),
            ("toolCount", number(live, "toolCount")),
            ("turnCount", number(live, "turnCount")),
            ("activity", activity),
        ]),
    )
}

/// The launch's input as the history card shows it: the fields the Agent card
/// titles itself by first (`subagent_type`, `description`), then the
/// arguments as Pi got them (`Launch::card`).
pub(crate) fn run_input(live: &Value, args: Option<&Value>) -> Value {
    let mut input = Map::new();
    input.insert(
        "subagent_type".to_string(),
        Value::from(run_agent_label(live, args)),
    );
    if let Some(task) = args.and_then(|args| text(args, "task")) {
        input.insert(
            "description".to_string(),
            Value::from(truncate_str(&first_line(&task), DESCRIPTION_MAX_CHARS)),
        );
    }
    if let Some(Value::Object(args)) = args {
        for (key, value) in args {
            input.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    Value::Object(input)
}

// ─────────────────────────────────────────────────────────────────────────────
// Background jobs
// ─────────────────────────────────────────────────────────────────────────────

/// `_meta` of a live job card: `{"codeg.backgroundJob": …}` in the history
/// card's shape (`Job::card`). A job still going is `running` (the history
/// card's `pending` means "no exit recorded", which live it never is).
pub(crate) fn job_meta(live: &Value) -> Value {
    let state = match live.get("state").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("killed") => "killed",
        Some("unknown") => "unknown",
        _ => "running",
    };
    let ended = state != "running";
    let duration_ms = live.get("durationMs").and_then(Value::as_u64);
    let notice = text(live, "notice");
    keyed(
        BACKGROUND_JOB_META_KEY,
        object([
            ("version", Some(Value::from(1))),
            ("tool", Some(Value::from("bgj_run"))),
            ("id", text(live, "id").map(Value::from)),
            ("state", Some(Value::from(state))),
            (
                "exitCode",
                ended
                    .then(|| live.get("exitCode").and_then(Value::as_i64))
                    .flatten()
                    .map(Value::from),
            ),
            ("killedBy", text(live, "killedBy").map(Value::from)),
            (
                "durationMs",
                ended.then_some(duration_ms).flatten().map(Value::from),
            ),
            (
                "duration",
                ended
                    .then(|| duration_ms.map(format_duration))
                    .flatten()
                    .map(Value::from),
            ),
            ("logFile", text(live, "logFile").map(Value::from)),
            (
                "tail",
                notice.as_deref().and_then(output_tail).map(Value::from),
            ),
            (
                "notice",
                notice.map(|n| Value::from(truncate_str(&n, NOTE_MAX_CHARS))),
            ),
            // Live only.
            ("startedAt", number(live, "startedAt")),
        ]),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

/// One `_meta.piAcp.compaction` record as the call the history draws for a
/// compaction (`parse_compaction`: `_meta.contextCompaction`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiveCompaction {
    pub(crate) id: String,
    /// The call's status: `in_progress`, `completed` or `failed`.
    pub(crate) status: &'static str,
    pub(crate) meta: Value,
}

pub(crate) fn compaction(live: &Value) -> Option<LiveCompaction> {
    let id = text(live, "id")?;
    let status = match live.get("status").and_then(Value::as_str) {
        Some("in_progress") => "in_progress",
        Some("completed") => "completed",
        Some("failed") | Some("cancelled") => "failed",
        _ => return None,
    };
    let trigger = match live.get("reason").and_then(Value::as_str) {
        Some("manual") => "manual",
        _ => "automatic",
    };
    let error = match live.get("status").and_then(Value::as_str) {
        Some("failed") => Some(text(live, "errorMessage").unwrap_or_else(|| "failed".to_string())),
        Some("cancelled") => Some("cancelled".to_string()),
        _ => None,
    };
    let marker = object([
        ("version", Some(Value::from(1))),
        ("trigger", Some(Value::from(trigger))),
        ("preTokens", number(live, "tokensBefore")),
        ("durationMs", number(live, "durationMs")),
        ("error", error.map(Value::from)),
    ]);
    Some(LiveCompaction {
        id,
        status,
        meta: keyed("contextCompaction", marker),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_live_single_run_reads_like_the_history_card() {
        let live = json!({
            "version": 1, "toolCallId": "call-1", "runId": "r-1", "mode": "single", "async": true,
            "status": "completed", "agent": "scout", "task": "Run ls and count.",
            "startedAt": 1, "endedAt": 2, "durationMs": 2780, "tokens": 4547,
            "toolCount": 2, "turnCount": 4,
            "result": "scout:\n# Task\n\n0 entries.",
            "children": [{"key": "#0", "label": "scout", "agent": "scout", "status": "completed",
                "task": "Run ls and count.", "model": "baseten/zai-org/GLM-5.3-Fast", "tokens": 4547,
                "turns": 4, "sessionId": "child-1", "sessionFile": "/x/run-0/session.jsonl",
                "activity": {"currentTool": "bash", "toolCount": 2}}]
        });
        let args = json!({"agent": "scout", "async": true, "task": "Run ls and count."});
        let meta = run_meta(
            &live,
            Some(&args),
            &[LiveNote::new("result", "Background task completed")],
        );
        let run = &meta[SUBAGENT_RUN_META_KEY];
        assert_eq!(run["status"], "completed");
        assert_eq!(run["agent"], "scout");
        assert_eq!(run["mode"], "single");
        assert_eq!(run["async"], true);
        assert_eq!(
            run["result"], "# Task\n\n0 entries.",
            "the agent line is the card's own"
        );
        assert_eq!(run["children"][0]["label"], "scout");
        assert_eq!(run["children"][0]["sessionId"], "child-1");
        assert!(
            run["children"][0].get("activity").is_none(),
            "a finished child shows no activity"
        );
        assert_eq!(run["notes"][0]["kind"], "result");

        let input = run_input(&live, Some(&args));
        assert_eq!(input["subagent_type"], "scout");
        assert_eq!(input["description"], "Run ls and count.");
        assert_eq!(input["async"], true);
    }

    #[test]
    fn a_running_row_keeps_its_live_status_and_activity() {
        let live = json!({"mode": "workflow", "status": "running", "async": true,
            "children": [
                {"key": "task-1", "agent": "scout", "status": "running",
                 "activity": {"currentTool": "bash", "toolCount": 1, "lastActivityAt": 5}},
                {"key": "task-2", "agent": "scout", "status": "pending"}]});
        let meta = run_meta(&live, Some(&json!({"workflow": "parallel"})), &[]);
        let run = &meta[SUBAGENT_RUN_META_KEY];
        assert_eq!(run["status"], "running");
        assert_eq!(run["agent"], "scout", "the agent both children share");
        assert_eq!(run["children"][0]["status"], "running");
        assert_eq!(run["children"][0]["label"], "task-1");
        assert_eq!(run["children"][0]["activity"]["currentTool"], "bash");
        assert_eq!(
            run["children"][1]["status"], "pending",
            "not read as completed"
        );
    }

    #[test]
    fn a_failed_run_result_becomes_its_error() {
        let live = json!({"mode": "single", "status": "failed",
            "result": "Error: Run fan-out: 1/64 used, 63 remaining\nboom\n    at f (x:1:2)"});
        let meta = run_meta(&live, Some(&json!({"agent": "worker", "task": "t"})), &[]);
        let run = &meta[SUBAGENT_RUN_META_KEY];
        assert_eq!(run["error"], "boom");
        assert!(run.get("result").is_none());
    }

    #[test]
    fn a_job_reads_like_the_history_chip() {
        let running = job_meta(&json!({"id": "jb-1", "state": "pending", "toolCallId": "c"}));
        assert_eq!(running[BACKGROUND_JOB_META_KEY]["state"], "running");
        let done = job_meta(&json!({"id": "jb-1", "state": "completed", "exitCode": 0,
            "durationMs": 8014, "logFile": "/l",
            "notice": "[bg-jobs] Background job jb-1 completed (exit 0) after 8s.\n\n--- last output ---\nbg-done"}));
        let job = &done[BACKGROUND_JOB_META_KEY];
        assert_eq!(job["state"], "completed");
        assert_eq!(job["exitCode"], 0);
        assert_eq!(job["duration"], "8s");
        assert_eq!(job["tail"], "bg-done");
    }

    #[test]
    fn compaction_records_become_the_shared_card() {
        let start = compaction(
            &json!({"id": "pi-compaction-1", "status": "in_progress", "reason": "threshold"}),
        )
        .expect("start");
        assert_eq!(start.status, "in_progress");
        assert_eq!(start.meta["contextCompaction"]["trigger"], "automatic");
        let end = compaction(
            &json!({"id": "pi-compaction-1", "status": "completed", "reason": "threshold",
            "tokensBefore": 10047, "estimatedTokensAfter": 12000, "durationMs": 990}),
        )
        .expect("end");
        assert_eq!(end.status, "completed");
        assert_eq!(end.meta["contextCompaction"]["preTokens"], 10047);
        assert!(
            end.meta["contextCompaction"].get("postTokens").is_none(),
            "pi's estimate is not a count; the history card has none either"
        );
        let failed =
            compaction(&json!({"id": "c", "status": "failed", "errorMessage": "no model"}))
                .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.meta["contextCompaction"]["error"], "no model");
    }

    #[test]
    fn wake_kinds_follow_the_history_vocabulary() {
        assert_eq!(wake_kind("subagent-notify", false), "subagentSettled");
        assert_eq!(
            wake_kind("subagent_supervisor_request", false),
            "subagentQuestion"
        );
        assert_eq!(
            wake_kind("subagent_watchdog_clarification", false),
            "subagentAttention"
        );
        assert_eq!(wake_kind("bg-job-exit", false), "jobExit");
        assert_eq!(wake_kind("injected-user", true), "jobExit");
        assert_eq!(wake_kind("my-extension", false), "extension");
        assert_eq!(wake_kind_of_trigger("injectedUser"), None);
        assert_eq!(wake_kind_of_trigger("extension"), Some("extension"));
        assert_eq!(wake_kind_of_trigger("unknown"), None);
        assert!(is_skipped_hidden("subagent_watchdog", true));
        assert!(!is_skipped_hidden("subagent-notify", true));
        let meta = wake_meta(&[WakeTrigger {
            kind: "jobExit",
            text: " done ".into(),
        }]);
        assert_eq!(meta[AGENT_WAKE_META_KEY]["triggers"][0]["text"], "done");
    }

    #[test]
    fn a_system_note_drops_the_lines_for_the_model() {
        let meta = system_note_meta(
            "subagent_control_notice",
            "Run r-1 needs attention\nReply with: subagent_supervisor({...})",
        );
        assert_eq!(
            meta[SYSTEM_NOTE_META_KEY]["text"],
            "Run r-1 needs attention"
        );
        let other = system_note_meta("my-ext", "Reply with: keep me");
        assert_eq!(other[SYSTEM_NOTE_META_KEY]["text"], "Reply with: keep me");
    }
}
