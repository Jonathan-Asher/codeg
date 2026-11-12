//! Pi's sub-agent runs (`pi-subagents`) and background jobs (`pi-bg-jobs`),
//! folded into the tool call that started each one.
//!
//! Both extensions report back by writing text into the parent's transcript:
//! notices (`custom_message` records, and from older pi-bg-jobs builds plain
//! `user` messages) that are addressed to the model, arrive seconds to minutes
//! after the call they belong to, and land between unrelated work. Rendered as
//! they are, a history reads as loose System bubbles full of run ids and tool
//! syntax, and as "You:" messages the user never typed.
//!
//! This pass reads the whole active branch first, then:
//!
//! - gives every `subagent` launch one card (`_meta["codeg.subagentRun"]` on
//!   the call, renamed `Agent` so the sub-agent capsule renders it): the run's
//!   status and result, and one row per child (workflow lane, parallel task,
//!   chain step) with its status, the questions it asked and the answers it
//!   got, and its own session. The notices that carried all of this are not
//!   rendered on their own; their text stays on the card (`notes`) for the
//!   "what the model saw" toggle, and the `subagent_supervisor` replies the
//!   card now shows are dropped from the transcript;
//! - gives every `bgj_run` its job's end (`_meta["codeg.backgroundJob"]`):
//!   state, exit code, duration and output tail, matched by the `bgj_run` tool
//!   call id where the notice carries one, and by job id for older ones;
//! - marks the runs Pi started by itself because a notice arrived after it had
//!   stopped (`_meta["codeg.agentWake"]`), so they do not read as answers to
//!   the user;
//! - strips the instructions meant for the model from the notices it cannot
//!   attribute, which still render as System notes.
//!
//! Children live in the parent's own folder (`<parent stem>/<id>/run-N/
//! session.jsonl`, or `<parent stem>/forks/` for a forked context) and are
//! named `subagent-<agent>-<run id>-<n>`; that name is how a row finds its
//! session when no notice names the file.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Map, Value};
use walkdir::WalkDir;

use crate::models::{AgentExecutionStats, ContentBlock};
use crate::parsers::detail_cache::FileStamp;
use crate::parsers::{is_safe_subagent_id, truncate_str};

use super::{
    fallback_id, record_iso_ts, string_field, tool_result_content_text, user_content_text,
};

/// `_meta` key of a sub-agent run's card, on the `Agent` call that started it.
pub(crate) const SUBAGENT_RUN_META_KEY: &str = "codeg.subagentRun";
/// `_meta` key of a background job's state, on the `bgj_run` call.
pub(crate) const BACKGROUND_JOB_META_KEY: &str = "codeg.backgroundJob";
/// `_meta` key of the marker opening a run the agent started by itself.
pub(crate) const AGENT_WAKE_META_KEY: &str = "codeg.agentWake";

/// One raw notice kept on a card.
const NOTE_MAX_CHARS: usize = 6_000;
/// Raw notices kept per card.
const NOTES_MAX: usize = 40;
/// A run's result (the cap the other parsers give a background result).
const RESULT_MAX_CHARS: usize = 16_000;
/// A child's task, result or error on its row.
const ROW_TEXT_MAX_CHARS: usize = 4_000;
/// A job's output tail.
const TAIL_MAX_CHARS: usize = 4_000;
/// The task shown as a card's description.
const DESCRIPTION_MAX_CHARS: usize = 80;
/// Session heads remembered across parses (see [`child_head`]).
const CHILD_MEMO_MAX: usize = 4_096;
/// Tool-argument previews, as `super::tool_arguments_preview` caps them.
const INPUT_MAX_CHARS: usize = 4_000;

// ─────────────────────────────────────────────────────────────────────────────
// What the replay consults
// ─────────────────────────────────────────────────────────────────────────────

/// The outcome of the pass, consulted while the branch is replayed.
#[derive(Default)]
pub(super) struct Fold {
    /// Entries folded into a card (their indices among the session's entries).
    hidden: HashSet<usize>,
    /// Tool calls whose call and result are folded into a card.
    hidden_calls: HashSet<String>,
    /// Card per `subagent` launch, by tool call id.
    runs: HashMap<String, RunCard>,
    /// Card per `bgj_run`, by tool call id.
    jobs: HashMap<String, JobCard>,
    /// Marker to open before the entry it is keyed by: the first message of a
    /// run the agent started on its own.
    wakes: HashMap<usize, Wake>,
    /// Notices left as System notes, with the instructions meant for the model
    /// taken out.
    notes: HashMap<usize, String>,
}

struct RunCard {
    input: Value,
    meta: Value,
    output: String,
    is_error: bool,
    stats: AgentExecutionStats,
}

struct JobCard {
    meta: Value,
    output: String,
}

/// The start of a run nobody asked for: Pi went idle, then a notice woke it.
pub(super) struct Wake {
    /// When the first notice that woke it arrived.
    pub(super) at: Option<DateTime<Utc>>,
    id: String,
    triggers: Vec<WakeTrigger>,
}

struct WakeTrigger {
    kind: &'static str,
    text: String,
}

impl Fold {
    /// Read `records` — the branch's entries in file order, with their indices —
    /// and work out what each card shows. `links` resolves children to their
    /// sessions; without it (the session list) rows carry no session ids.
    pub(super) fn scan<'a>(
        records: impl IntoIterator<Item = (usize, &'a Value)>,
        links: Option<&ChildLinks>,
    ) -> Self {
        let mut scan = Scan::default();
        for (index, value) in records {
            scan.feed(index, value);
        }
        scan.finish(links)
    }

    pub(super) fn hides(&self, index: usize) -> bool {
        self.hidden.contains(&index)
    }

    pub(super) fn hides_call(&self, id: Option<&str>) -> bool {
        id.is_some_and(|id| self.hidden_calls.contains(id))
    }

    pub(super) fn wake_before(&self, index: usize) -> Option<&Wake> {
        self.wakes.get(&index)
    }

    pub(super) fn note(&self, index: usize) -> Option<&str> {
        self.notes.get(&index).map(String::as_str)
    }

    /// Drop the calls this pass folded into a card, and give the ones that
    /// start a card their card's name, input and `_meta`.
    pub(super) fn decorate_calls(&self, blocks: &mut Vec<ContentBlock>) {
        blocks.retain(|block| match block {
            ContentBlock::ToolUse { tool_use_id, .. } => !self.hides_call(tool_use_id.as_deref()),
            _ => true,
        });
        for block in blocks.iter_mut() {
            let ContentBlock::ToolUse {
                tool_use_id: Some(id),
                tool_name,
                input_preview,
                meta,
                ..
            } = block
            else {
                continue;
            };
            if let Some(card) = self.runs.get(id.as_str()) {
                *tool_name = "Agent".to_string();
                *input_preview = Some(truncate_str(&card.input.to_string(), INPUT_MAX_CHARS));
                *meta = Some(card.meta.clone());
            } else if let Some(card) = self.jobs.get(id.as_str()) {
                // The live path already draws `bgj_run` as a command (its input
                // is `{command}`), so history says the same.
                *tool_name = "bash".to_string();
                *meta = Some(card.meta.clone());
            }
        }
    }

    /// Replace a card's result with what the card says.
    pub(super) fn decorate_result(&self, block: &mut ContentBlock) {
        let ContentBlock::ToolResult {
            tool_use_id: Some(id),
            output_preview,
            is_error,
            agent_stats,
            ..
        } = block
        else {
            return;
        };
        if let Some(card) = self.runs.get(id.as_str()) {
            *output_preview = Some(card.output.clone());
            *is_error = card.is_error;
            *agent_stats = Some(card.stats.clone());
        } else if let Some(card) = self.jobs.get(id.as_str()) {
            *output_preview = Some(card.output.clone());
        }
    }
}

impl Wake {
    /// The marker's blocks: a plain caption for clients that only read text
    /// (the phone shows System turns as a caption), and a settled marker call
    /// carrying `_meta["codeg.agentWake"]` that the desktop draws as a divider.
    pub(super) fn blocks(&self) -> Vec<ContentBlock> {
        let triggers: Vec<Value> = self
            .triggers
            .iter()
            .map(|trigger| {
                object([
                    ("kind", Some(Value::from(trigger.kind))),
                    ("text", Some(Value::from(trigger.text.as_str()))),
                ])
            })
            .collect();
        let marker = object([
            ("version", Some(Value::from(1))),
            ("triggers", Some(Value::Array(triggers))),
        ]);
        vec![
            ContentBlock::Text {
                text: self.caption(),
            },
            ContentBlock::ToolUse {
                tool_use_id: Some(self.id.clone()),
                tool_name: "agent_wake".to_string(),
                input_preview: None,
                status: None,
                meta: Some(keyed(AGENT_WAKE_META_KEY, marker)),
            },
            ContentBlock::ToolResult {
                tool_use_id: Some(self.id.clone()),
                output_preview: None,
                is_error: false,
                agent_stats: None,
                images: Vec::new(),
            },
        ]
    }

    fn caption(&self) -> String {
        let what = match self.triggers.first().map(|trigger| trigger.kind) {
            Some("subagentQuestion") => "a sub-agent's question",
            Some("subagentSettled") => "a sub-agent finishing",
            Some("subagentAttention") => "a sub-agent alert",
            Some("jobExit") => "a background job ending",
            _ => "an extension's message",
        };
        format!("Pi continued on its own, woken by {what}.")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The scan
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Scan {
    launches: Vec<Launch>,
    launch_by_call: HashMap<String, usize>,
    jobs: Vec<Job>,
    job_by_call: HashMap<String, usize>,
    notices: Vec<Notice>,
    /// `subagent_supervisor_reply` entries: request id → the answer.
    replies: HashMap<String, String>,
    /// `subagent_supervisor({action: "reply"})` calls.
    reply_calls: Vec<ReplyCall>,
    /// Job states read back by `bgj_status` / `bgj_wait` / `bgj_kill`, and the
    /// exits pi-bg-jobs records without telling the model, in order.
    job_states: Vec<JobExit>,
    /// Whether Pi is inside a run: a user message opens one, an assistant
    /// message that ends without calling a tool closes it.
    run_open: bool,
    /// Notices that arrived while no run was open (indices into `notices`).
    pending: Vec<usize>,
    wakes: Vec<PendingWake>,
}

struct ReplyCall {
    call_id: String,
    request_id: String,
    message: Option<String>,
}

struct PendingWake {
    /// The entry of the assistant message that opens the run.
    index: usize,
    at: Option<DateTime<Utc>>,
    id: String,
    notices: Vec<usize>,
}

impl Scan {
    fn feed(&mut self, index: usize, value: &Value) {
        let at = record_iso_ts(value);
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                let Some(message) = value.get("message") else {
                    return;
                };
                match message.get("role").and_then(Value::as_str).unwrap_or("") {
                    "assistant" => self.assistant(index, value, message, at),
                    "toolResult" => self.tool_result(message, at),
                    "user" => {
                        let text = user_content_text(message.get("content"));
                        match legacy_job_report(&text) {
                            Some(exit) => {
                                self.notice(index, at, text, NoticeKind::Job(Box::new(exit)), true)
                            }
                            None => {
                                self.run_open = true;
                                self.pending.clear();
                            }
                        }
                    }
                    _ => {}
                }
            }
            "custom_message" => self.custom_message(index, at, value),
            "custom" => self.custom_entry(value),
            _ => {}
        }
    }

    fn assistant(
        &mut self,
        index: usize,
        value: &Value,
        message: &Value,
        at: Option<DateTime<Utc>>,
    ) {
        if !self.run_open && !self.pending.is_empty() {
            let notices = std::mem::take(&mut self.pending);
            let first_at = notices.first().and_then(|&n| self.notices[n].at);
            let id = match value.get("id").and_then(Value::as_str) {
                Some(entry) if !entry.is_empty() => format!("pi-wake-{entry}"),
                _ => format!("pi-wake-{index}"),
            };
            self.wakes.push(PendingWake {
                index,
                at: first_at.or(at),
                id,
                notices,
            });
        }
        self.pending.clear();

        let items = message.get("content").and_then(Value::as_array);
        let calls_a_tool = items.is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("toolCall"))
        });
        // `toolUse` goes on to the tools; `error` is retried by Pi within the
        // same run. Anything else (`stop`, `length`, `aborted`) ends the run.
        self.run_open = match message.get("stopReason").and_then(Value::as_str) {
            Some("toolUse") | Some("error") => true,
            Some(_) => false,
            None => calls_a_tool,
        };

        for item in items.into_iter().flatten() {
            if item.get("type").and_then(Value::as_str) != Some("toolCall") {
                continue;
            }
            let Some(id) = string_field(item, "id") else {
                continue;
            };
            let args = match item.get("arguments") {
                Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or(Value::Null),
                Some(args) => args.clone(),
                None => Value::Null,
            };
            match item.get("name").and_then(Value::as_str).unwrap_or("") {
                "subagent" if is_launch(&args) => {
                    self.launch_by_call.insert(id.clone(), self.launches.len());
                    self.launches.push(Launch::new(id, args, at));
                }
                "subagent_supervisor" => {
                    if args.get("action").and_then(Value::as_str) == Some("reply") {
                        if let Some(request_id) = string_field(&args, "replyTo") {
                            self.reply_calls.push(ReplyCall {
                                call_id: id,
                                request_id,
                                message: string_field(&args, "message"),
                            });
                        }
                    }
                }
                "bgj_run" => {
                    self.job_by_call.insert(id.clone(), self.jobs.len());
                    self.jobs.push(Job::new(id));
                }
                _ => {}
            }
        }
    }

    fn tool_result(&mut self, message: &Value, at: Option<DateTime<Utc>>) {
        let Some(call_id) = string_field(message, "toolCallId") else {
            return;
        };
        let text = message
            .get("content")
            .and_then(tool_result_content_text)
            .unwrap_or_default();
        let details = message.get("details").cloned().unwrap_or(Value::Null);
        let is_error = message
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(&launch) = self.launch_by_call.get(&call_id) {
            self.launches[launch].result = Some(LaunchResult {
                details,
                text,
                is_error,
                at,
            });
            return;
        }
        if let Some(&job) = self.job_by_call.get(&call_id) {
            self.jobs[job].launched(&details, text, is_error);
            return;
        }
        if matches!(
            message.get("toolName").and_then(Value::as_str),
            Some("bgj_status" | "bgj_wait" | "bgj_kill")
        ) {
            if let Some(exit) = details.get("job").and_then(JobExit::from_job) {
                self.job_states.push(exit);
            }
        }
    }

    fn custom_message(&mut self, index: usize, at: Option<DateTime<Utc>>, value: &Value) {
        let custom_type = value
            .get("customType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let displayed = value
            .get("display")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // What an extension hides in its own UI stays out of codeg's too, and
        // does not count as waking the agent. Except a run's results: since
        // 0.80, pi-subagents hides a run that completed without trouble (and a
        // workflow child that did) because its own run widget shows it there,
        // yet the notice still wakes Pi, and here the run's card is that widget.
        if !displayed && !is_run_result(custom_type) {
            return;
        }
        let text = user_content_text(value.get("content"));
        if text.trim().is_empty() {
            return;
        }
        let details = value.get("details").filter(|details| details.is_object());
        let kind = match custom_type {
            "subagent_supervisor_request" => {
                NoticeKind::Question(Box::new(Question::parse(details, &text)))
            }
            "subagent-incremental-child-notify" => match ChildNotice::parse(details, &text) {
                Some(child) => NoticeKind::Child(Box::new(child)),
                None => NoticeKind::Subagent,
            },
            "subagent-notify" => match RunNotice::parse(&text) {
                Some(run) => NoticeKind::Run(Box::new(run)),
                None => NoticeKind::Subagent,
            },
            "bg-job-exit" => match details.and_then(JobExit::from_job) {
                Some(mut exit) => {
                    exit.tail = output_tail(&text);
                    NoticeKind::Job(Box::new(exit))
                }
                None => NoticeKind::Other,
            },
            other if other.starts_with("subagent") => {
                NoticeKind::Attention(Box::new(Attention::parse(details, &text)))
            }
            _ => NoticeKind::Other,
        };
        self.notice(index, at, text, kind, displayed);
    }

    fn custom_entry(&mut self, value: &Value) {
        let data = value.get("data").filter(|data| data.is_object());
        match value
            .get("customType")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "subagent_supervisor_reply" => {
                let field = |key: &str| data.and_then(|data| string_field(data, key));
                if let (Some(request_id), Some(message)) = (field("requestId"), field("message")) {
                    self.replies.insert(request_id, message);
                }
            }
            // An exit pi-bg-jobs recorded without telling the model (the model
            // had already read it): it only flips the job's card.
            "bg-job-exit" => {
                if let Some(exit) = data.and_then(JobExit::from_job) {
                    self.job_states.push(exit);
                }
            }
            _ => {}
        }
    }

    fn notice(
        &mut self,
        index: usize,
        at: Option<DateTime<Utc>>,
        text: String,
        kind: NoticeKind,
        displayed: bool,
    ) {
        let n = self.notices.len();
        self.notices.push(Notice {
            index,
            at,
            text,
            kind,
            displayed,
        });
        if !self.run_open {
            self.pending.push(n);
        }
    }

    fn finish(self, links: Option<&ChildLinks>) -> Fold {
        let Scan {
            mut launches,
            jobs: mut job_list,
            notices,
            replies,
            reply_calls,
            job_states,
            wakes,
            ..
        } = self;
        let mut fold = Fold::default();

        for launch in &mut launches {
            launch.seed_rows();
        }
        attribute(&mut launches, &mut job_list, &notices, &mut fold);
        answer(&mut launches, &replies, &reply_calls, &mut fold);

        for launch in &mut launches {
            if let Some(links) = links {
                for row in &mut launch.rows {
                    row.link(links);
                }
            }
            fold.runs.insert(launch.call_id.clone(), launch.card());
        }
        for job in &job_list {
            fold.jobs.insert(job.call_id.clone(), job.card(&job_states));
        }
        for wake in wakes {
            let triggers = wake
                .notices
                .iter()
                .map(|&n| WakeTrigger {
                    kind: notices[n].wake_kind(),
                    text: truncate_str(notices[n].text.trim(), NOTE_MAX_CHARS),
                })
                .collect();
            fold.wakes.insert(
                wake.index,
                Wake {
                    at: wake.at,
                    id: wake.id,
                    triggers,
                },
            );
        }
        fold
    }
}

/// The pi-subagents notices that carry a run's (or a workflow child's) result.
/// pi-subagents 0.80 and later write them hidden (`display: false`) when the
/// run completed without trouble, and still wake Pi with them.
fn is_run_result(custom_type: &str) -> bool {
    matches!(
        custom_type,
        "subagent-notify" | "subagent-incremental-child-notify"
    )
}

/// Whether a `subagent` call runs something (rather than managing runs).
/// pi-subagents: "`action`: management/control only; omit for execution", and
/// an execution names what to run.
fn is_launch(args: &Value) -> bool {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .is_some_and(|action| !action.trim().is_empty());
    !action
        && [
            "agent",
            "task",
            "tasks",
            "chain",
            "workflowScript",
            "workflowScriptPath",
            "workflow",
        ]
        .iter()
        .any(|key| args.get(*key).is_some_and(|value| !value.is_null()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Notices
// ─────────────────────────────────────────────────────────────────────────────

/// A notice an extension wrote for the model: a displayed one, or a run's
/// result the extension hides (see [`is_run_result`]).
struct Notice {
    /// Its index among the session's entries.
    index: usize,
    at: Option<DateTime<Utc>>,
    /// What the model read, verbatim.
    text: String,
    kind: NoticeKind,
    /// Whether the extension shows it in Pi's own chat. A hidden one that no
    /// card claims stays hidden instead of becoming a System note.
    displayed: bool,
}

enum NoticeKind {
    /// A child asked for a decision (`contact_supervisor`).
    Question(Box<Question>),
    /// A workflow child settled.
    Child(Box<ChildNotice>),
    /// A whole run settled.
    Run(Box<RunNotice>),
    /// Any other pi-subagents notice (watchdog, control): an alert on a run.
    Attention(Box<Attention>),
    /// A pi-subagents notice in a shape this pass does not read.
    Subagent,
    /// A background job ended.
    Job(Box<JobExit>),
    /// Another extension's message.
    Other,
}

impl Notice {
    fn wake_kind(&self) -> &'static str {
        match self.kind {
            NoticeKind::Question(_) => "subagentQuestion",
            NoticeKind::Child(_) | NoticeKind::Run(_) | NoticeKind::Subagent => "subagentSettled",
            NoticeKind::Attention(_) => "subagentAttention",
            NoticeKind::Job(_) => "jobExit",
            NoticeKind::Other => "extension",
        }
    }
}

/// `subagent_supervisor_request`: a child's `contact_supervisor`.
struct Question {
    request_id: Option<String>,
    /// The asking child's run id.
    run_id: Option<String>,
    agent: Option<String>,
    /// The question, in the child's words.
    body: String,
}

impl Question {
    fn parse(details: Option<&Value>, text: &str) -> Self {
        let field = |key: &str| details.and_then(|details| string_field(details, key));
        Question {
            request_id: field("requestId").or_else(|| field("id")),
            run_id: field("runId").or_else(|| labeled(text, "Run:").map(first_word)),
            agent: field("agent").or_else(|| labeled(text, "Agent:")),
            body: field("requestBody").unwrap_or_else(|| question_body(text)),
        }
    }
}

/// The question out of a supervisor request's text: the blocks between the
/// header ("Subagent needs a supervisor decision." + run, agent, child index)
/// and the reply instructions.
fn question_body(text: &str) -> String {
    text.split("\n\n")
        .skip(1)
        .filter(|block| !is_model_directive(block))
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

/// `subagent-incremental-child-notify`: one workflow child settled.
///
/// ```text
/// Workflow child failed: **uma**
/// Workflow run: <run id>
/// Child run: <child run id>
/// Output: <path>
/// Error: <one or more lines>
/// Status: workflow still running
/// ```
struct ChildNotice {
    key: String,
    status: String,
    workflow_run: Option<String>,
    child_run: Option<String>,
    error: Option<String>,
}

impl ChildNotice {
    fn parse(details: Option<&Value>, text: &str) -> Option<Self> {
        static HEAD: OnceLock<Regex> = OnceLock::new();
        let head = regex(
            &HEAD,
            r"^Workflow child (completed|failed|paused|stopped)(?: \([^)]*\))?: \*\*(.+?)\*\*\s*$",
        );
        let field = |key: &str| details.and_then(|details| string_field(details, key));
        let mut lines = text.lines();
        let captures = lines.next().and_then(|line| head.captures(line));
        let key = field("childKey").or_else(|| captures.as_ref().map(|c| c[2].to_string()))?;
        let status = field("outcome")
            .or_else(|| captures.as_ref().map(|c| c[1].to_string()))
            .unwrap_or_else(|| "completed".to_string());

        let mut workflow_run = field("workflowRunId");
        let mut child_run = field("childRunId");
        let mut error_lines: Vec<&str> = Vec::new();
        let mut in_error = false;
        for line in lines {
            if let Some(value) = line.strip_prefix("Workflow run: ") {
                workflow_run.get_or_insert_with(|| value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Child run: ") {
                child_run.get_or_insert_with(|| value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Error: ") {
                error_lines.push(value);
                in_error = true;
                continue;
            } else if in_error && !line.starts_with("Output: ") && !line.starts_with("Status: ") {
                error_lines.push(line);
                continue;
            }
            in_error = false;
        }
        let error = field("error")
            .or_else(|| (!error_lines.is_empty()).then(|| error_lines.join("\n")))
            .map(|error| clean_error(&error))
            .filter(|error| !error.is_empty());
        Some(ChildNotice {
            key,
            status,
            workflow_run,
            child_run,
            error,
        })
    }
}

/// `subagent-notify`: a run settled. The inverse of pi-subagents'
/// `formatSingleCompletion`, as its own `parseSubagentNotifyContent` reads it,
/// plus the child outputs block and the async directory line.
struct RunNotice {
    status: String,
    agent: String,
    async_dir: Option<String>,
    workflow_run: Option<String>,
    /// `Child runs: key=<id> (status), …`
    children: Vec<ChildRun>,
    /// `Child outputs:` — each child's preview.
    outputs: Vec<ChildOutput>,
    /// The result preview, without the blocks above.
    result: String,
    session_file: Option<String>,
}

struct ChildRun {
    key: Option<String>,
    run_id: String,
    status: Option<String>,
}

struct ChildOutput {
    key: Option<String>,
    run_id: Option<String>,
    status: Option<String>,
    preview: String,
}

impl RunNotice {
    fn parse(text: &str) -> Option<Self> {
        static HEAD: OnceLock<Regex> = OnceLock::new();
        let head = regex(
            &HEAD,
            r"^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*(?:\s+\([^)]*\))?\s*$",
        );
        let lines: Vec<&str> = text.lines().collect();
        let captures = head.captures(lines.first()?)?;
        let mut notice = RunNotice {
            status: captures[1].to_string(),
            agent: captures[2].to_string(),
            async_dir: None,
            workflow_run: None,
            children: Vec::new(),
            outputs: Vec::new(),
            result: String::new(),
            session_file: None,
        };
        let mut result: Vec<&str> = Vec::new();
        let mut in_outputs = false;
        for &line in &lines[1..] {
            if let Some(value) = line.strip_prefix("Retention-managed async directory: ") {
                notice.async_dir = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Workflow run: ") {
                notice.workflow_run = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Child runs: ") {
                notice.children = parse_child_runs(value);
            } else if let Some(value) = line.strip_prefix("Session file: ") {
                notice.session_file = Some(value.trim().to_string());
            } else if [
                "Workflow receipt: ",
                "Reconciled detached child: ",
                "Parallel handoff: ",
                "Session: ",
                "Session share error: ",
                "Scheduled run from ",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
            {
                // Bookkeeping for the model.
            } else if line == "Child outputs:" {
                in_outputs = true;
            } else if in_outputs {
                if let Some(head) = line.strip_prefix("- key=") {
                    notice.outputs.push(parse_output_head(head));
                } else if let Some(preview) = line
                    .strip_prefix("    | ")
                    .or_else(|| (line == "    |").then_some(""))
                {
                    if let Some(output) = notice.outputs.last_mut() {
                        output.preview.push_str(preview);
                        output.preview.push('\n');
                    }
                } else if line.trim().is_empty() {
                    in_outputs = false;
                } else if !line.starts_with("  ") && !line.starts_with("- ") {
                    in_outputs = false;
                    result.push(line);
                }
            } else {
                result.push(line);
            }
        }
        notice.result = result.join("\n").trim().to_string();
        Some(notice)
    }
}

/// `mina=<id> (failed), uma=<id> (failed)` — the child run list.
fn parse_child_runs(value: &str) -> Vec<ChildRun> {
    value
        .split(", ")
        .filter_map(|part| {
            let part = part.trim();
            let (raw, status) = match part.strip_suffix(')').and_then(|p| p.rsplit_once(" (")) {
                Some((raw, status)) => (raw, Some(status.to_string())),
                None => (part, None),
            };
            let (key, run_id) = match raw.split_once('=') {
                Some((key, run_id)) => (Some(key.to_string()), run_id.to_string()),
                None => (None, raw.to_string()),
            };
            (!run_id.is_empty()).then_some(ChildRun {
                key,
                run_id,
                status,
            })
        })
        .collect()
}

/// `mina run=<id> status=failed` — one child output's head (after `- key=`).
fn parse_output_head(head: &str) -> ChildOutput {
    let known =
        |value: &str| (value != "unavailable" && !value.is_empty()).then(|| value.to_string());
    let (key, rest) = head.split_once(" run=").unwrap_or((head, ""));
    let (run_id, status) = rest.split_once(" status=").unwrap_or((rest, ""));
    ChildOutput {
        key: known(key.trim()),
        run_id: known(run_id.trim()),
        status: known(status.trim()),
        preview: String::new(),
    }
}

/// Any other pi-subagents notice: an alert about a run (`subagent_control_notice`
/// "needs attention", watchdog clarifications).
struct Attention {
    run_id: Option<String>,
    message: String,
}

impl Attention {
    fn parse(details: Option<&Value>, text: &str) -> Self {
        let event = details
            .and_then(|details| details.get("event"))
            .filter(|event| event.is_object())
            .or(details);
        let field = |key: &str| event.and_then(|event| string_field(event, key));
        Attention {
            run_id: field("runId").or_else(|| labeled(text, "Run:").map(first_word)),
            message: field("message")
                .or_else(|| labeled(text, "Signal:"))
                .unwrap_or_else(|| first_line(text)),
        }
    }
}

/// How a background job ended.
struct JobExit {
    job_id: Option<String>,
    /// The `bgj_run` call that started it (current pi-bg-jobs only).
    tool_call_id: Option<String>,
    /// `completed` / `failed` / `killed` / `unknown`.
    state: String,
    exit_code: Option<i64>,
    killed_by: Option<String>,
    duration_ms: Option<u64>,
    /// The duration as an older report spelled it ("3m 52s").
    duration: Option<String>,
    tail: Option<String>,
}

impl JobExit {
    /// A job record (`details.job` of a status / wait / kill, or the details of
    /// a `bg-job-exit` notice) — `None` while it is still running.
    fn from_job(job: &Value) -> Option<Self> {
        let state = string_field(job, "state")?;
        if state == "running" {
            return None;
        }
        let ms = |key: &str| job.get(key).and_then(Value::as_u64);
        let duration_ms = ms("durationMs").or_else(|| {
            ms("exitedAtMs")
                .zip(ms("startedAtMs"))
                .map(|(end, start)| end.saturating_sub(start))
        });
        Some(JobExit {
            job_id: string_field(job, "id"),
            tool_call_id: string_field(job, "toolCallId"),
            state,
            exit_code: job.get("exitCode").and_then(Value::as_i64),
            killed_by: string_field(job, "killedBy"),
            duration_ms,
            duration: None,
            tail: None,
        })
    }
}

/// An exit report an older pi-bg-jobs sent as a user message:
///
/// ```text
/// ✅ Background job finished (exit 0, ran 3m 52s)
/// [jb-mwc8zz2b-8l1v] completed exit 0 · 3m 52s · <command>
/// cwd: …
/// log: …
///
/// --- last output ---
/// …
/// ```
///
/// (`🛑 Background job killed (bgj_kill, ran 13m 34s)`, `❌ Background job
/// FAILED (exit 1, ran 5s)`.) Kept narrow: the header and the job line must both
/// be there, so nothing the user typed can match.
fn legacy_job_report(text: &str) -> Option<JobExit> {
    static REPORT: OnceLock<Regex> = OnceLock::new();
    let report = regex(
        &REPORT,
        r"^\s*(?:✅|🛑|❌)\s*Background job (finished|killed|FAILED) \(([^)]*)\)\s*\n\[([A-Za-z0-9_.-]+)\] ",
    );
    let captures = report.captures(text)?;
    let (head, ran) = match captures[2].split_once(", ran ") {
        Some((head, ran)) => (head.trim(), Some(ran.trim().to_string())),
        None => (captures[2].trim(), None),
    };
    let exit_code = head
        .strip_prefix("exit ")
        .and_then(|code| code.trim().parse::<i64>().ok());
    let (state, killed_by) = match &captures[1] {
        "finished" => ("completed", None),
        "killed" => ("killed", Some(head.to_string())),
        _ => ("failed", None),
    };
    Some(JobExit {
        job_id: Some(captures[3].to_string()),
        tool_call_id: None,
        state: state.to_string(),
        exit_code,
        killed_by,
        duration_ms: None,
        duration: ran,
        tail: output_tail(text),
    })
}

/// What follows a report's `--- last output ---` line.
fn output_tail(text: &str) -> Option<String> {
    let (_, tail) = text.split_once("--- last output ---\n")?;
    let tail = tail.trim_end();
    (!tail.trim().is_empty()).then(|| tail_of(tail, TAIL_MAX_CHARS))
}

/// The last `max` characters of `text`, so a cut keeps the end of a log.
fn tail_of(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let kept: String = text.chars().skip(count - max).collect();
    format!("…{kept}")
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent runs
// ─────────────────────────────────────────────────────────────────────────────

struct Launch {
    call_id: String,
    args: Value,
    called_at: Option<DateTime<Utc>>,
    result: Option<LaunchResult>,
    rows: Vec<ChildRow>,
    /// The raw text the model was given about this run, oldest first.
    notes: Vec<RawNote>,
    settled: Option<Settled>,
    /// The children's order as the final notice lists them (the workflow's own).
    settled_order: Option<Vec<String>>,
}

struct LaunchResult {
    details: Value,
    text: String,
    is_error: bool,
    at: Option<DateTime<Utc>>,
}

/// What the run's final notice said.
struct Settled {
    status: String,
    result: String,
    at: Option<DateTime<Utc>>,
}

struct RawNote {
    kind: &'static str,
    text: String,
}

#[derive(Clone, Default)]
struct ChildRow {
    /// The row's identity within its run: the workflow key, or `#<index>`.
    key: String,
    agent: Option<String>,
    status: Option<String>,
    run_id: Option<String>,
    task: Option<String>,
    error: Option<String>,
    result: Option<String>,
    session_file: Option<String>,
    session_id: Option<String>,
    model: Option<String>,
    tokens: Option<u64>,
    turns: Option<u64>,
    exchanges: Vec<Exchange>,
    attention: Vec<String>,
}

#[derive(Clone)]
struct Exchange {
    request_id: Option<String>,
    question: String,
    answer: Option<String>,
}

impl Launch {
    fn new(call_id: String, args: Value, called_at: Option<DateTime<Utc>>) -> Self {
        Launch {
            call_id,
            args,
            called_at,
            result: None,
            rows: Vec::new(),
            notes: Vec::new(),
            settled: None,
            settled_order: None,
        }
    }

    fn details(&self) -> Option<&Value> {
        self.result.as_ref().map(|result| &result.details)
    }

    fn mode(&self) -> &'static str {
        match self
            .details()
            .and_then(|d| d.get("mode"))
            .and_then(Value::as_str)
        {
            Some("single") => return "single",
            Some("parallel") => return "parallel",
            Some("chain") => return "chain",
            Some("workflow") => return "workflow",
            _ => {}
        }
        let has = |key: &str| self.args.get(key).is_some_and(|value| !value.is_null());
        if has("workflowScript") || has("workflowScriptPath") || has("workflow") {
            "workflow"
        } else if has("tasks") {
            "parallel"
        } else if has("chain") {
            "chain"
        } else {
            "single"
        }
    }

    fn is_async(&self) -> bool {
        self.details()
            .is_some_and(|d| d.get("asyncId").is_some() || d.get("asyncDir").is_some())
    }

    /// Every id a notice can name this run by.
    fn run_ids(&self) -> Vec<String> {
        let Some(details) = self.details() else {
            return Vec::new();
        };
        let mut ids: Vec<String> = ["runId", "asyncId"]
            .iter()
            .filter_map(|key| string_field(details, key))
            .collect();
        if let Some(dir) = string_field(details, "asyncDir") {
            if let Some(name) = Path::new(&dir).file_name() {
                ids.push(name.to_string_lossy().into_owned());
            }
        }
        if let Some(id) = details
            .pointer("/workflowChildren/workflowRunId")
            .and_then(Value::as_str)
        {
            ids.push(id.to_string());
        }
        ids
    }

    fn row_mut(&mut self, key: &str) -> &mut ChildRow {
        let index = match self.rows.iter().position(|row| row.key == key) {
            Some(index) => index,
            None => {
                self.rows.push(ChildRow {
                    key: key.to_string(),
                    ..ChildRow::default()
                });
                self.rows.len() - 1
            }
        };
        &mut self.rows[index]
    }

    /// The key of a single-child run's one row.
    fn sole_key(&self) -> Option<String> {
        (self.mode() == "single").then(|| "#0".to_string())
    }

    fn note(&mut self, kind: &'static str, text: &str) {
        if self.notes.len() < NOTES_MAX {
            self.notes.push(RawNote {
                kind,
                text: truncate_str(text.trim(), NOTE_MAX_CHARS),
            });
        }
    }

    /// Rows the launch itself describes: a foreground run's results, the
    /// workflow's lanes, the tasks it was given.
    fn seed_rows(&mut self) {
        let mode = self.mode();
        let mut seeds: Vec<ChildRow> = Vec::new();
        let tasks_key = match mode {
            "parallel" => Some("tasks"),
            "chain" => Some("chain"),
            _ => None,
        };
        if mode == "single" {
            seeds.push(ChildRow {
                key: "#0".to_string(),
                agent: string_field(&self.args, "agent"),
                task: string_field(&self.args, "task")
                    .map(|task| truncate_str(&task, ROW_TEXT_MAX_CHARS)),
                run_id: self.details().and_then(|d| string_field(d, "runId")),
                ..ChildRow::default()
            });
        } else if let Some(items) = tasks_key
            .and_then(|key| self.args.get(key))
            .and_then(Value::as_array)
        {
            for (index, item) in items.iter().enumerate() {
                seeds.push(ChildRow {
                    key: format!("#{index}"),
                    agent: string_field(item, "agent"),
                    task: string_field(item, "task")
                        .map(|task| truncate_str(&task, ROW_TEXT_MAX_CHARS)),
                    ..ChildRow::default()
                });
            }
        }
        if let Some(details) = self.details() {
            if let Some(children) = details
                .pointer("/workflowChildren/children")
                .and_then(Value::as_array)
            {
                for child in children {
                    if let Some(key) = string_field(child, "childId") {
                        seeds.push(ChildRow {
                            key,
                            agent: string_field(child, "agent"),
                            status: string_field(child, "state"),
                            run_id: string_field(child, "runId"),
                            model: string_field(child, "model"),
                            ..ChildRow::default()
                        });
                    }
                }
            }
            if let Some(results) = details.get("results").and_then(Value::as_array) {
                for (position, result) in results.iter().enumerate() {
                    let index = result
                        .get("index")
                        .and_then(Value::as_u64)
                        .map_or(position, |index| index as usize);
                    let key =
                        string_field(result, "workflowKey").unwrap_or_else(|| format!("#{index}"));
                    let usage = result.get("usage");
                    seeds.push(ChildRow {
                        key,
                        agent: string_field(result, "agent"),
                        status: result.get("exitCode").and_then(Value::as_i64).map(|code| {
                            (if code == 0 { "completed" } else { "failed" }).to_string()
                        }),
                        task: string_field(result, "task")
                            .map(|task| truncate_str(&task, ROW_TEXT_MAX_CHARS)),
                        error: string_field(result, "error").map(|error| clean_error(&error)),
                        result: string_field(result, "finalOutput")
                            .map(|output| truncate_str(&output, ROW_TEXT_MAX_CHARS)),
                        session_file: string_field(result, "sessionFile"),
                        model: string_field(result, "model"),
                        tokens: usage.and_then(usage_tokens),
                        turns: usage
                            .and_then(|usage| usage.get("turns"))
                            .and_then(Value::as_u64),
                        ..ChildRow::default()
                    });
                }
            }
        }
        for seed in seeds {
            let row = self.row_mut(&seed.key);
            row.merge(seed);
        }
    }

    fn status(&self) -> &'static str {
        if let Some(settled) = &self.settled {
            return normalize_status(&settled.status);
        }
        let Some(result) = &self.result else {
            return "pending";
        };
        if result.is_error {
            return "failed";
        }
        let settled_rows = !self.rows.is_empty()
            && self
                .rows
                .iter()
                .all(|row| row.status.as_deref().is_some_and(is_terminal));
        let all_failed = !self.rows.is_empty()
            && self
                .rows
                .iter()
                .all(|row| row.status.as_deref() == Some("failed"));
        if self.is_async() {
            // The final notice can be lost (a reconnected Pi no longer sees the
            // run); children that all settled still say how it went.
            if !settled_rows {
                return "pending";
            }
            return if self
                .rows
                .iter()
                .any(|row| row.status.as_deref() == Some("failed"))
            {
                "failed"
            } else {
                "completed"
            };
        }
        if all_failed
            || result
                .details
                .pointer("/workflowChildren/workflowState")
                .and_then(Value::as_str)
                == Some("failed")
        {
            "failed"
        } else {
            "completed"
        }
    }

    /// The run's own result and error: the final notice's preview for a
    /// background run, the tool's result for a foreground one.
    fn outcome(&self, status: &str) -> (Option<String>, Option<String>) {
        let raw = match (&self.settled, &self.result) {
            (Some(settled), _) => settled.result.clone(),
            (None, Some(result)) if !self.is_async() => foreground_result(result),
            _ => return (None, None),
        };
        let raw = strip_agent_label(&raw, self.agent_label().as_str());
        if raw.is_empty() || raw == "(no output)" {
            return (None, None);
        }
        let failed = status == "failed" || self.result.as_ref().is_some_and(|r| r.is_error);
        match raw.strip_prefix("Error: ") {
            Some(error) if failed => (None, Some(clean_error(error))),
            _ if failed && self.result.as_ref().is_some_and(|r| r.is_error) => {
                (None, Some(clean_error(&raw)))
            }
            _ => (Some(truncate_str(&raw, RESULT_MAX_CHARS)), None),
        }
    }

    /// What to call the run: its one agent, the agent all its children share,
    /// else how it ran.
    fn agent_label(&self) -> String {
        if let Some(agent) = string_field(&self.args, "agent") {
            return agent;
        }
        let agents: Vec<&str> = self
            .rows
            .iter()
            .filter_map(|row| row.agent.as_deref())
            .collect();
        match agents.first() {
            Some(first) if agents.iter().all(|agent| agent == first) => first.to_string(),
            _ => self.mode().to_string(),
        }
    }

    fn duration_ms(&self) -> Option<u64> {
        let result = self.result.as_ref()?;
        let (start, end) = match &self.settled {
            Some(settled) => (result.at, settled.at),
            None if !self.is_async() => (self.called_at, result.at),
            None => return None,
        };
        let ms = (end? - start?).num_milliseconds();
        (ms > 0).then_some(ms as u64)
    }

    fn tokens(&self) -> Option<u64> {
        if let Some(total) = self
            .details()
            .and_then(|d| d.get("totalChildUsage"))
            .and_then(usage_tokens)
        {
            return Some(total);
        }
        let known: Vec<u64> = self.rows.iter().filter_map(|row| row.tokens).collect();
        (!known.is_empty()).then(|| known.iter().sum())
    }

    fn card(&mut self) -> RunCard {
        if let Some(result) = &self.result {
            self.notes.insert(
                0,
                RawNote {
                    kind: "launch",
                    text: truncate_str(result.text.trim(), NOTE_MAX_CHARS),
                },
            );
        }
        let status = self.status();
        let (result, error) = self.outcome(status);
        let agent = self.agent_label();
        let mode = self.mode();
        let duration_ms = self.duration_ms();
        let tokens = self.tokens();
        let task = string_field(&self.args, "task");
        let sole = self.rows.len() == 1;

        let children: Vec<Value> = self.rows.iter().map(ChildRow::to_json).collect();
        let notes: Vec<Value> = self
            .notes
            .iter()
            .map(|note| {
                object([
                    ("kind", Some(Value::from(note.kind))),
                    ("text", Some(Value::from(note.text.as_str()))),
                ])
            })
            .collect();
        let run = object([
            ("version", Some(Value::from(1))),
            ("mode", Some(Value::from(mode))),
            ("async", Some(Value::Bool(self.is_async()))),
            ("status", Some(Value::from(status))),
            ("agent", Some(Value::from(agent.as_str()))),
            (
                "task",
                task.as_deref()
                    .map(|task| Value::from(truncate_str(task, ROW_TEXT_MAX_CHARS))),
            ),
            (
                "runId",
                self.details()
                    .and_then(|d| string_field(d, "runId"))
                    .map(Value::from),
            ),
            ("durationMs", duration_ms.map(Value::from)),
            ("tokens", tokens.map(Value::from)),
            ("result", result.as_deref().map(Value::from)),
            ("error", error.as_deref().map(Value::from)),
            ("children", Some(Value::Array(children))),
            ("notes", Some(Value::Array(notes))),
        ]);

        // The input, with the fields the Agent card (and the phone's task card)
        // title themselves by put first, so a long workflow script cut at the
        // preview limit cannot take them with it.
        let mut input = Map::new();
        input.insert("subagent_type".to_string(), Value::from(agent.as_str()));
        if let Some(task) = task.as_deref() {
            input.insert(
                "description".to_string(),
                Value::from(truncate_str(&first_line(task), DESCRIPTION_MAX_CHARS)),
            );
        }
        if let Value::Object(args) = &self.args {
            for (key, value) in args {
                input.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }

        let is_error = status == "failed";
        RunCard {
            input: Value::Object(input),
            meta: keyed(SUBAGENT_RUN_META_KEY, run),
            output: plain_run_report(&self.rows, status, result.as_deref(), error.as_deref()),
            is_error,
            stats: AgentExecutionStats {
                agent_type: Some(agent),
                status: Some(status.to_string()),
                total_duration_ms: duration_ms,
                total_tokens: tokens,
                total_tool_use_count: None,
                read_count: None,
                search_count: None,
                bash_count: None,
                edit_file_count: None,
                lines_added: None,
                lines_removed: None,
                other_tool_count: None,
                tool_calls: Vec::new(),
                child_session_id: if sole {
                    self.rows[0].session_id.clone()
                } else {
                    None
                },
            },
        }
    }
}

/// A foreground run's result: the workflow's return value or the single
/// child's final output, else the tool's text without the lines addressed to
/// the model.
fn foreground_result(result: &LaunchResult) -> String {
    if let Some(value) = result
        .details
        .pointer("/workflow/value")
        .and_then(Value::as_str)
    {
        return value.to_string();
    }
    if let Some(results) = result.details.get("results").and_then(Value::as_array) {
        if let [only] = results.as_slice() {
            if let Some(output) = string_field(only, "finalOutput") {
                return output;
            }
        }
    }
    strip_run_bookkeeping(&result.text)
}

/// The tool text without pi-subagents' budget, mission and call-trace lines.
fn strip_run_bookkeeping(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut in_trace = false;
    for line in text.lines() {
        if is_fanout_line(line) || line.starts_with("Mission: ") {
            continue;
        }
        if line == "Call trace:" {
            in_trace = true;
            continue;
        }
        if in_trace && line.starts_with("- ") {
            continue;
        }
        in_trace = false;
        out.push(line);
    }
    let text = out.join("\n");
    let text = text.trim();
    match text.split_once("\n\nReturn:\n") {
        Some((_, value)) => value.trim().to_string(),
        None => text.to_string(),
    }
}

/// Drop a leading `<agent>:` line — single-run previews open with the agent's
/// name, which the card already shows.
fn strip_agent_label(text: &str, agent: &str) -> String {
    let text = text.trim();
    match text.split_once('\n') {
        Some((first, rest)) if first.trim() == format!("{agent}:") => rest.trim().to_string(),
        _ => text.to_string(),
    }
}

fn normalize_status(status: &str) -> &'static str {
    match status {
        "completed" | "complete" | "done" | "success" => "completed",
        "failed" | "error" => "failed",
        "paused" => "paused",
        "stopped" | "interrupted" | "cancelled" | "canceled" => "stopped",
        "running" | "active" => "running",
        _ => "completed",
    }
}

fn is_terminal(status: &str) -> bool {
    matches!(
        normalize_status(status),
        "completed" | "failed" | "paused" | "stopped"
    )
}

/// Pi's own total: input + output + cache read + cache write.
fn usage_tokens(usage: &Value) -> Option<u64> {
    let field = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let total = field("input") + field("output") + field("cacheRead") + field("cacheWrite");
    (total > 0).then_some(total)
}

impl ChildRow {
    /// Take what `other` knows that this row does not.
    fn merge(&mut self, other: ChildRow) {
        fn keep(slot: &mut Option<String>, value: Option<String>) {
            if slot.is_none() {
                *slot = value;
            }
        }
        keep(&mut self.agent, other.agent);
        keep(&mut self.status, other.status);
        keep(&mut self.run_id, other.run_id);
        keep(&mut self.task, other.task);
        keep(&mut self.error, other.error);
        keep(&mut self.result, other.result);
        keep(&mut self.session_file, other.session_file);
        keep(&mut self.model, other.model);
        self.tokens = self.tokens.or(other.tokens);
        self.turns = self.turns.or(other.turns);
    }

    /// Find the child's session, and what its run recorded about it.
    fn link(&mut self, links: &ChildLinks) {
        if self.session_id.is_none() {
            self.session_id = self
                .session_file
                .as_deref()
                .and_then(|file| links.session_for_file(file))
                .or_else(|| {
                    self.run_id
                        .as_deref()
                        .and_then(|run| links.session_for_run(run))
                });
        }
        if self.agent.is_none() {
            self.agent = self
                .run_id
                .as_deref()
                .and_then(|run| links.agent_for_run(run));
        }
        let (Some(run_id), Some(agent)) = (self.run_id.as_deref(), self.agent.as_deref()) else {
            return;
        };
        if self.tokens.is_some() && self.turns.is_some() && self.model.is_some() {
            return;
        }
        let Some(meta) = links.artifact(run_id, agent) else {
            return;
        };
        let usage = meta.get("usage");
        self.tokens = self.tokens.or_else(|| usage.and_then(usage_tokens));
        self.turns = self.turns.or_else(|| {
            usage
                .and_then(|usage| usage.get("turns"))
                .and_then(Value::as_u64)
        });
        if self.model.is_none() {
            self.model = string_field(&meta, "model");
        }
        if self.error.is_none() && self.status.as_deref() == Some("failed") {
            self.error = string_field(&meta, "error").map(|error| clean_error(&error));
        }
    }

    fn label(&self) -> &str {
        match self.key.strip_prefix('#') {
            Some(_) => self.agent.as_deref().unwrap_or("sub-agent"),
            None => &self.key,
        }
    }

    fn to_json(&self) -> Value {
        let exchanges: Vec<Value> = self
            .exchanges
            .iter()
            .map(|exchange| {
                object([
                    ("question", Some(Value::from(exchange.question.as_str()))),
                    ("answer", exchange.answer.as_deref().map(Value::from)),
                ])
            })
            .collect();
        let text = |value: &Option<String>| {
            value
                .as_deref()
                .map(|value| Value::from(truncate_str(value, ROW_TEXT_MAX_CHARS)))
        };
        object([
            ("key", Some(Value::from(self.key.as_str()))),
            ("label", Some(Value::from(self.label()))),
            ("agent", self.agent.as_deref().map(Value::from)),
            (
                "status",
                self.status
                    .as_deref()
                    .map(|status| Value::from(normalize_status(status))),
            ),
            ("runId", self.run_id.as_deref().map(Value::from)),
            ("task", text(&self.task)),
            ("error", text(&self.error)),
            ("result", text(&self.result)),
            ("sessionId", self.session_id.as_deref().map(Value::from)),
            ("model", self.model.as_deref().map(Value::from)),
            ("tokens", self.tokens.map(Value::from)),
            ("turns", self.turns.map(Value::from)),
            (
                "exchanges",
                (!exchanges.is_empty()).then_some(Value::Array(exchanges)),
            ),
            (
                "attention",
                (!self.attention.is_empty()).then(|| {
                    Value::Array(
                        self.attention
                            .iter()
                            .map(|a| Value::from(a.as_str()))
                            .collect(),
                    )
                }),
            ),
        ])
    }
}

/// The result text for clients that show a card's result as it is (the phone,
/// exports): one line per child when there are several, then the run's own
/// result or error.
fn plain_run_report(
    rows: &[ChildRow],
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> String {
    let mut out = String::new();
    if rows.len() > 1 {
        for row in rows {
            let state = row.status.as_deref().map_or("pending", normalize_status);
            let agent = match (&row.agent, row.key.starts_with('#')) {
                (Some(agent), false) => format!(" ({agent})"),
                _ => String::new(),
            };
            let detail = row
                .error
                .as_deref()
                .or(row.result.as_deref())
                .map(|text| format!(": {}", truncate_str(&first_line(text), 160)))
                .unwrap_or_default();
            out.push_str(&format!("- **{}**{agent} — {state}{detail}\n", row.label()));
        }
        out.push('\n');
    }
    match (error, result) {
        (Some(error), _) => out.push_str(&format!("Error: {error}")),
        (None, Some(result)) => out.push_str(result),
        (None, None) if status == "pending" => {
            out.push_str("Running in the background; its result is not in this transcript.")
        }
        (None, None) => {}
    }
    out.trim().to_string()
}

/// Notices → the runs and jobs they belong to.
fn attribute(launches: &mut [Launch], jobs: &mut [Job], notices: &[Notice], fold: &mut Fold) {
    // Which launch a run id names.
    let mut owner: HashMap<String, usize> = HashMap::new();
    for (index, launch) in launches.iter().enumerate() {
        for id in launch.run_ids() {
            owner.entry(id).or_insert(index);
        }
    }
    // Which row a child run id names. Read off every notice first: a child's
    // question routinely arrives before the notice that names its lane.
    let mut child_of: HashMap<String, (usize, String)> = HashMap::new();
    for (index, launch) in launches.iter().enumerate() {
        for row in &launch.rows {
            if let Some(run_id) = &row.run_id {
                child_of.insert(run_id.clone(), (index, row.key.clone()));
            }
        }
    }
    for notice in notices {
        match &notice.kind {
            NoticeKind::Child(child) => {
                let launch = child.workflow_run.as_ref().and_then(|run| owner.get(run));
                if let (Some(&launch), Some(child_run)) = (launch, &child.child_run) {
                    child_of.insert(child_run.clone(), (launch, child.key.clone()));
                }
            }
            NoticeKind::Run(run) => {
                if let Some(&launch) = run.workflow_run.as_ref().and_then(|id| owner.get(id)) {
                    for child in &run.children {
                        let key = child.key.clone().unwrap_or_else(|| child.run_id.clone());
                        child_of.insert(child.run_id.clone(), (launch, key));
                    }
                }
            }
            _ => {}
        }
    }

    for notice in notices {
        let attributed = match &notice.kind {
            NoticeKind::Question(question) => {
                fold_question(launches, question, notice, &owner, &child_of)
            }
            NoticeKind::Child(child) => fold_child(launches, child, notice, &owner, &child_of),
            NoticeKind::Run(run) => fold_run(launches, run, notice, &owner),
            NoticeKind::Attention(attention) => {
                fold_attention(launches, attention, notice, &owner, &child_of)
            }
            NoticeKind::Job(exit) => fold_job(jobs, exit, notice),
            NoticeKind::Subagent | NoticeKind::Other => false,
        };
        if attributed {
            fold.hidden.insert(notice.index);
        } else if notice.displayed && !matches!(notice.kind, NoticeKind::Other) {
            fold.notes.insert(notice.index, clean_notice(&notice.text));
        }
    }

    // Children in the order the final notice lists them — the workflow's own.
    for launch in launches.iter_mut() {
        let order: Vec<String> = launch.settled_order.take().unwrap_or_default();
        if order.is_empty() {
            continue;
        }
        launch.rows.sort_by_key(|row| {
            order
                .iter()
                .position(|key| key == &row.key)
                .unwrap_or(usize::MAX)
        });
    }
}

/// The background run open at `at`: the latest launch before it that has not
/// settled yet. The last resort for a notice that names no run codeg knows.
fn open_launch(launches: &[Launch], at: Option<DateTime<Utc>>) -> Option<usize> {
    launches
        .iter()
        .enumerate()
        .rev()
        .find(|(_, launch)| {
            launch.is_async()
                && launch.settled.is_none()
                && match (launch.called_at, at) {
                    (Some(called), Some(at)) => called <= at,
                    _ => true,
                }
        })
        .map(|(index, _)| index)
}

fn fold_question(
    launches: &mut [Launch],
    question: &Question,
    notice: &Notice,
    owner: &HashMap<String, usize>,
    child_of: &HashMap<String, (usize, String)>,
) -> bool {
    let named = question.run_id.as_deref().and_then(|run| {
        child_of.get(run).cloned().or_else(|| {
            owner
                .get(run)
                .and_then(|&launch| launches[launch].sole_key().map(|key| (launch, key)))
        })
    });
    let target = named.or_else(|| {
        open_launch(launches, notice.at).map(|launch| {
            let key = launches[launch]
                .sole_key()
                .or_else(|| question.run_id.clone())
                .unwrap_or_else(|| "#0".to_string());
            (launch, key)
        })
    });
    let Some((launch, key)) = target else {
        return false;
    };
    let launch = &mut launches[launch];
    let row = launch.row_mut(&key);
    if row.run_id.is_none() {
        row.run_id = question.run_id.clone();
    }
    if row.agent.is_none() {
        row.agent = question.agent.clone();
    }
    row.exchanges.push(Exchange {
        request_id: question.request_id.clone(),
        question: truncate_str(question.body.trim(), ROW_TEXT_MAX_CHARS),
        answer: None,
    });
    launch.note("question", &notice.text);
    true
}

fn fold_child(
    launches: &mut [Launch],
    child: &ChildNotice,
    notice: &Notice,
    owner: &HashMap<String, usize>,
    child_of: &HashMap<String, (usize, String)>,
) -> bool {
    let launch = child
        .workflow_run
        .as_ref()
        .and_then(|run| owner.get(run).copied())
        .or_else(|| {
            child
                .child_run
                .as_ref()
                .and_then(|run| child_of.get(run))
                .map(|(launch, _)| *launch)
        })
        .or_else(|| open_launch(launches, notice.at));
    let Some(launch) = launch else {
        return false;
    };
    let launch = &mut launches[launch];
    let row = launch.row_mut(&child.key);
    row.status = Some(child.status.clone());
    if child.error.is_some() {
        row.error = child.error.clone();
    }
    if row.run_id.is_none() {
        row.run_id = child.child_run.clone();
    }
    launch.note("child", &notice.text);
    true
}

fn fold_run(
    launches: &mut [Launch],
    run: &RunNotice,
    notice: &Notice,
    owner: &HashMap<String, usize>,
) -> bool {
    let by_id = run
        .workflow_run
        .as_ref()
        .and_then(|id| owner.get(id))
        .or_else(|| {
            run.async_dir
                .as_ref()
                .and_then(|dir| Path::new(dir).file_name())
                .and_then(|name| owner.get(&*name.to_string_lossy()))
        })
        .copied();
    let launch = by_id.or_else(|| {
        // No id this pass knows: the open run of the same agent (a workflow
        // reports itself as `**workflow**`).
        open_launch(launches, notice.at).filter(|&launch| {
            let launch = &launches[launch];
            launch.agent_label() == run.agent || launch.mode() == run.agent
        })
    });
    let Some(index) = launch else {
        return false;
    };
    let launch = &mut launches[index];
    for child in &run.children {
        let key = child.key.clone().unwrap_or_else(|| child.run_id.clone());
        let row = launch.row_mut(&key);
        if row.run_id.is_none() {
            row.run_id = Some(child.run_id.clone());
        }
        if let Some(status) = &child.status {
            row.status = Some(status.clone());
        }
    }
    for output in &run.outputs {
        let Some(key) = output.key.clone().or_else(|| output.run_id.clone()) else {
            continue;
        };
        let row = launch.row_mut(&key);
        if row.run_id.is_none() {
            row.run_id = output.run_id.clone();
        }
        if row.status.is_none() {
            row.status = output.status.clone();
        }
        let preview = output.preview.trim();
        if row.result.is_none() && !preview.is_empty() {
            row.result = Some(truncate_str(preview, ROW_TEXT_MAX_CHARS));
        }
    }
    if launch.mode() == "single" {
        let row = launch.row_mut("#0");
        if row.status.is_none() {
            row.status = Some(run.status.clone());
        }
        if row.session_file.is_none() {
            row.session_file = run.session_file.clone();
        }
    }
    let order: Vec<String> = run
        .children
        .iter()
        .map(|child| child.key.clone().unwrap_or_else(|| child.run_id.clone()))
        .collect();
    launch.settled_order = Some(order);
    launch.settled = Some(Settled {
        status: run.status.clone(),
        result: run.result.clone(),
        at: notice.at,
    });
    launch.note("result", &notice.text);
    true
}

fn fold_attention(
    launches: &mut [Launch],
    attention: &Attention,
    notice: &Notice,
    owner: &HashMap<String, usize>,
    child_of: &HashMap<String, (usize, String)>,
) -> bool {
    let named = attention.run_id.as_deref().and_then(|run| {
        child_of.get(run).cloned().or_else(|| {
            owner.get(run).map(|&launch| {
                let key = launches[launch]
                    .sole_key()
                    .unwrap_or_else(|| "#0".to_string());
                (launch, key)
            })
        })
    });
    let target = named.or_else(|| {
        open_launch(launches, notice.at).map(|launch| {
            let key = launches[launch]
                .sole_key()
                .or_else(|| attention.run_id.clone())
                .unwrap_or_else(|| "#0".to_string());
            (launch, key)
        })
    });
    let Some((launch, key)) = target else {
        return false;
    };
    let launch = &mut launches[launch];
    launch
        .row_mut(&key)
        .attention
        .push(truncate_str(attention.message.trim(), ROW_TEXT_MAX_CHARS));
    launch.note("attention", &notice.text);
    true
}

fn fold_job(jobs: &mut [Job], exit: &JobExit, notice: &Notice) -> bool {
    let by_call = exit
        .tool_call_id
        .as_ref()
        .and_then(|call| jobs.iter().position(|job| &job.call_id == call));
    let by_id = || {
        exit.job_id
            .as_ref()
            .and_then(|id| jobs.iter().position(|job| job.id.as_ref() == Some(id)))
    };
    let Some(index) = by_call.or_else(by_id) else {
        return false;
    };
    let job = &mut jobs[index];
    job.exit = Some(JobExit {
        job_id: exit.job_id.clone(),
        tool_call_id: exit.tool_call_id.clone(),
        state: exit.state.clone(),
        exit_code: exit.exit_code,
        killed_by: exit.killed_by.clone(),
        duration_ms: exit.duration_ms,
        duration: exit.duration.clone(),
        tail: exit.tail.clone(),
    });
    job.notice = Some(truncate_str(notice.text.trim(), NOTE_MAX_CHARS));
    true
}

/// Pi's answers to its children's questions, on the rows that asked; the
/// `subagent_supervisor` calls that carried them then have nothing left to show.
fn answer(
    launches: &mut [Launch],
    replies: &HashMap<String, String>,
    calls: &[ReplyCall],
    fold: &mut Fold,
) {
    let from_calls: HashMap<&str, &str> = calls
        .iter()
        .filter_map(|call| {
            call.message
                .as_deref()
                .map(|message| (call.request_id.as_str(), message))
        })
        .collect();
    let mut asked: HashSet<String> = HashSet::new();
    for launch in launches.iter_mut() {
        for row in &mut launch.rows {
            for exchange in &mut row.exchanges {
                let Some(id) = exchange.request_id.as_deref() else {
                    continue;
                };
                exchange.answer = replies
                    .get(id)
                    .cloned()
                    .or_else(|| from_calls.get(id).map(|message| message.to_string()))
                    .map(|answer| truncate_str(answer.trim(), ROW_TEXT_MAX_CHARS));
                asked.insert(id.to_string());
            }
        }
    }
    for call in calls {
        if asked.contains(&call.request_id) {
            fold.hidden_calls.insert(call.call_id.clone());
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Background jobs
// ─────────────────────────────────────────────────────────────────────────────

struct Job {
    call_id: String,
    id: Option<String>,
    log_file: Option<String>,
    /// The launch receipt's lines worth keeping (the id and the log file).
    receipt: Option<String>,
    launch_failed: bool,
    exit: Option<JobExit>,
    /// The exit notice, verbatim.
    notice: Option<String>,
}

impl Job {
    fn new(call_id: String) -> Self {
        Job {
            call_id,
            id: None,
            log_file: None,
            receipt: None,
            launch_failed: false,
            exit: None,
            notice: None,
        }
    }

    fn launched(&mut self, details: &Value, text: String, is_error: bool) {
        static LAUNCH: OnceLock<Regex> = OnceLock::new();
        let launch = regex(
            &LAUNCH,
            r"Command running in background with ID:\s*([A-Za-z0-9_.-]+)",
        );
        self.launch_failed = is_error;
        self.id = string_field(details, "id").or_else(|| {
            launch
                .captures(&text)
                .map(|captures| captures[1].to_string())
        });
        self.log_file = string_field(details, "logFile");
        if !is_error {
            let kept: Vec<&str> = text
                .lines()
                .filter(|line| {
                    line.starts_with("Command running in background")
                        || line.starts_with("Output file:")
                })
                .collect();
            self.receipt = (!kept.is_empty()).then(|| kept.join("\n"));
        }
        if self.receipt.is_none() {
            self.receipt = Some(text);
        }
    }

    fn card(&self, states: &[JobExit]) -> JobCard {
        // The exit notice is authoritative; failing that, the last state a
        // status / wait / kill read back.
        let polled = self.id.as_deref().and_then(|id| {
            states.iter().rev().find(|state| {
                state.job_id.as_deref() == Some(id)
                    || state.tool_call_id.as_deref() == Some(self.call_id.as_str())
            })
        });
        let exit = self.exit.as_ref().or(polled);
        let state = match exit {
            Some(exit) => match exit.state.as_str() {
                "completed" | "failed" | "killed" => exit.state.as_str(),
                _ => "unknown",
            },
            None => "pending",
        };
        let duration = exit.and_then(|exit| {
            exit.duration
                .clone()
                .or_else(|| exit.duration_ms.map(format_duration))
        });
        let tail = exit.and_then(|exit| exit.tail.clone());
        let job = object([
            ("version", Some(Value::from(1))),
            ("tool", Some(Value::from("bgj_run"))),
            ("id", self.id.as_deref().map(Value::from)),
            ("state", Some(Value::from(state))),
            (
                "exitCode",
                exit.and_then(|exit| exit.exit_code).map(Value::from),
            ),
            (
                "killedBy",
                exit.and_then(|exit| exit.killed_by.as_deref())
                    .map(Value::from),
            ),
            (
                "durationMs",
                exit.and_then(|exit| exit.duration_ms).map(Value::from),
            ),
            ("duration", duration.as_deref().map(Value::from)),
            ("logFile", self.log_file.as_deref().map(Value::from)),
            ("tail", tail.as_deref().map(Value::from)),
            ("notice", self.notice.as_deref().map(Value::from)),
        ]);

        let mut output = self.receipt.clone().unwrap_or_default();
        if !self.launch_failed {
            let outcome = match (state, exit) {
                ("pending", _) | (_, None) => {
                    "No exit was recorded in this transcript.".to_string()
                }
                (state, Some(exit)) => {
                    let after = duration
                        .as_deref()
                        .map(|d| format!(" after {d}"))
                        .unwrap_or_default();
                    match state {
                        "completed" => {
                            format!("Completed (exit {}){after}.", exit.exit_code.unwrap_or(0))
                        }
                        "failed" => match exit.exit_code {
                            Some(code) => format!("Failed (exit {code}){after}."),
                            None => format!("Failed{after}."),
                        },
                        "killed" => match exit.killed_by.as_deref() {
                            Some(by) => format!("Killed ({by}){after}."),
                            None => format!("Killed{after}."),
                        },
                        _ => format!("Ended (exit code unknown){after}."),
                    }
                }
            };
            output = format!("{}\n\n{outcome}", output.trim_end());
            if let Some(tail) = &tail {
                output.push_str(&format!("\n\n--- last output ---\n{tail}"));
            }
        }
        JobCard {
            meta: keyed(BACKGROUND_JOB_META_KEY, job),
            output: output.trim().to_string(),
        }
    }
}

/// pi-bg-jobs' own duration spelling: `58s`, `3m 52s`, `1h12m`.
fn format_duration(ms: u64) -> String {
    let seconds = (ms + 500) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return match seconds % 60 {
            0 => format!("{minutes}m"),
            rest => format!("{minutes}m {rest}s"),
        };
    }
    format!("{}h{}m", minutes / 60, minutes % 60)
}

// ─────────────────────────────────────────────────────────────────────────────
// Children on disk
// ─────────────────────────────────────────────────────────────────────────────

/// Where a run's children are: the sessions nested in the parent's own folder,
/// and the per-run records pi-subagents keeps next to it.
pub(super) struct ChildLinks {
    /// The sessions directory. A session file a transcript names is only opened
    /// when it lies inside it.
    root: PathBuf,
    /// Sub-agent run id → the header id of the session it ran in, and the agent
    /// its name says ran there.
    by_run: HashMap<String, (String, String)>,
    /// `<bucket>/subagent-artifacts`.
    artifacts: Option<PathBuf>,
}

impl ChildLinks {
    /// The children of the session stored at `path`, under `root`.
    pub(super) fn for_session(path: &Path, root: &Path) -> Self {
        let mut by_run: HashMap<String, (String, String)> = HashMap::new();
        let nested = path.with_extension("");
        if nested.is_dir() {
            let mut heads: Vec<(u64, String, String, String)> = Vec::new();
            for entry in WalkDir::new(&nested)
                .max_depth(3)
                .into_iter()
                .filter_map(Result::ok)
            {
                let file = entry.path();
                if file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Some(ChildHead {
                    id: Some(id),
                    name: Some(name),
                }) = child_head(file)
                {
                    heads.push((name.attempt, name.run_id, id, name.agent));
                }
            }
            // A run's first session is its child; later ones are retries.
            heads.sort();
            for (_, run_id, id, agent) in heads {
                by_run.entry(run_id).or_insert((id, agent));
            }
        }
        ChildLinks {
            root: root.to_path_buf(),
            by_run,
            artifacts: path.parent().map(|dir| dir.join("subagent-artifacts")),
        }
    }

    fn session_for_run(&self, run_id: &str) -> Option<String> {
        self.by_run.get(run_id).map(|(id, _)| id.clone())
    }

    fn agent_for_run(&self, run_id: &str) -> Option<String> {
        self.by_run.get(run_id).map(|(_, agent)| agent.clone())
    }

    /// The header id of a session file a transcript names.
    fn session_for_file(&self, file: &str) -> Option<String> {
        let path = Path::new(file);
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl")
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return None;
        }
        if path.starts_with(&self.root) {
            return child_head(path).and_then(|head| head.id);
        }
        // Moved since it ran: pi names a session's file after its id
        // (`<time>_<id>.jsonl`), so the name alone still says which one it is.
        let name = path.file_stem()?.to_string_lossy();
        name.contains('_').then(|| fallback_id(path))
    }

    /// pi-subagents' record of a finished child: `<run>_<agent>_meta.json`.
    fn artifact(&self, run_id: &str, agent: &str) -> Option<Value> {
        if !is_safe_subagent_id(run_id) || !is_safe_subagent_id(agent) {
            return None;
        }
        let path = self
            .artifacts
            .as_ref()?
            .join(format!("{run_id}_{agent}_meta.json"));
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }
}

#[derive(Clone, Default)]
struct ChildHead {
    id: Option<String>,
    name: Option<SubagentName>,
}

/// What a child session's name, `subagent-<agent>-<run id>-<n>`, says.
#[derive(Clone)]
struct SubagentName {
    agent: String,
    run_id: String,
    attempt: u64,
}

type ChildMemo = Mutex<HashMap<PathBuf, (Option<FileStamp>, ChildHead)>>;

/// A session's header id and sub-agent name, remembered per file.
///
/// The name of a forked child sits after the copy of its parent's history it
/// starts with — most of a multi-megabyte file — so it is read once: a session
/// writes its header and name when it starts, and a file that keeps growing
/// cannot change either.
fn child_head(path: &Path) -> Option<ChildHead> {
    static MEMO: OnceLock<ChildMemo> = OnceLock::new();
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    let stamp = FileStamp::of(path);
    if let Ok(map) = memo.lock() {
        if let Some((seen, head)) = map.get(path) {
            let unchanged = matches!((seen, stamp), (Some(seen), Some(now)) if seen.same_as(&now));
            if head.name.is_some() || unchanged {
                return Some(head.clone());
            }
        }
    }
    let head = read_child_head(path)?;
    if let Ok(mut map) = memo.lock() {
        if map.len() >= CHILD_MEMO_MAX {
            map.clear();
        }
        map.insert(path.to_path_buf(), (stamp, head.clone()));
    }
    Some(head)
}

fn read_child_head(path: &Path) -> Option<ChildHead> {
    let file = fs::File::open(path).ok()?;
    let mut head = ChildHead::default();
    let mut seen_header = false;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if !seen_header {
            seen_header = true;
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("type").and_then(Value::as_str) == Some("session") {
                    head.id = string_field(&value, "id");
                }
            }
            continue;
        }
        if !line.contains("\"session_info\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_info") {
            continue;
        }
        if let Some(name) = string_field(&value, "name")
            .as_deref()
            .and_then(subagent_name)
        {
            head.name = Some(name);
        }
    }
    Some(head)
}

/// `subagent-<agent>-<run id>-<n>`: the name pi-subagents gives every child
/// session.
fn subagent_name(name: &str) -> Option<SubagentName> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    let pattern = regex(
        &NAME,
        r"^subagent-(.+)-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-(\d+)$",
    );
    let captures = pattern.captures(name.trim())?;
    Some(SubagentName {
        agent: captures[1].to_string(),
        run_id: captures[2].to_string(),
        attempt: captures[3].parse().unwrap_or(0),
    })
}

/// Whether `name` is the name pi-subagents gives a child session.
pub(super) fn is_subagent_session_name(name: &str) -> bool {
    subagent_name(name).is_some()
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

fn keyed(key: &str, value: Value) -> Value {
    let mut map = Map::new();
    map.insert(key.to_string(), value);
    Value::Object(map)
}

/// A JSON object of the fields that have a value, in order.
fn object<const N: usize>(fields: [(&str, Option<Value>); N]) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

/// The value of the first `<label> …` line.
fn labeled(text: &str, label: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix(label))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn first_word(text: String) -> String {
    text.split_whitespace().next().unwrap_or("").to_string()
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// `Run fan-out: 4/64 used, 60 remaining` — the budget line pi-subagents puts
/// in front of results and errors alike.
fn is_fanout_line(line: &str) -> bool {
    static FANOUT: OnceLock<Regex> = OnceLock::new();
    regex(&FANOUT, r"^\s*Run fan-out: \d+/\d+ used, \d+ remaining\s*$").is_match(line)
}

/// An error as the reader needs it: without the fan-out budget glued in front
/// and without the script's stack frames.
fn clean_error(error: &str) -> String {
    error
        .lines()
        .filter(|line| !is_fanout_line(line) && !is_stack_frame(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// `    at f (file:1:2)` — a JavaScript stack frame (always indented).
fn is_stack_frame(line: &str) -> bool {
    line.starts_with(char::is_whitespace) && line.trim_start().starts_with("at ")
}

/// A line (or block) written for the model to act on: how to reply, steer,
/// inspect or interrupt, in tool-call syntax.
fn is_model_directive(text: &str) -> bool {
    let line = text.trim_start();
    [
        "Reply with:",
        "Live guidance:",
        "Hint:",
        "Top-level live async nudge:",
        "Routed live nested nudge:",
        "Direct intercom target:",
        "Status: subagent(",
        "Interrupt: subagent(",
        "Parent action:",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

/// A notice left as a System note, without the instructions meant for the model.
fn clean_notice(text: &str) -> String {
    text.lines()
        .filter(|line| !is_model_directive(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_notice_reads_lane_runs_and_a_multi_line_error() {
        let text = "Workflow child failed: **uma**\nWorkflow run: wf-1\nChild run: c-1\nOutput: /tmp/x\nError: Run fan-out: 4/64 used, 60 remaining\nAgent 'researcher' requested unavailable child tools: web_search.\nThe `tools` field is a strict allowlist.\nStatus: workflow still running";
        let child = ChildNotice::parse(None, text).expect("parsed");
        assert_eq!(child.key, "uma");
        assert_eq!(child.status, "failed");
        assert_eq!(child.workflow_run.as_deref(), Some("wf-1"));
        assert_eq!(child.child_run.as_deref(), Some("c-1"));
        assert_eq!(
            child.error.as_deref(),
            Some("Agent 'researcher' requested unavailable child tools: web_search.\nThe `tools` field is a strict allowlist.")
        );
    }

    #[test]
    fn run_notice_splits_the_result_from_child_outputs_and_bookkeeping() {
        let text = "Background task failed: **workflow**\nWorkflow receipt: /tmp/r.json\n\nError: Cannot read runs.all result property 'mina'.\n    at runsAllKeyAccessError ([worker eval]:275:10)\n\nChild outputs:\n- key=mina run=c-1 status=failed\n  Saved output: unavailable\n  Preview:\n    | Task closed.\n    | \n    | **Outcome:** none.\n- key=uma run=c-2 status=failed\n  Saved output: unavailable\n  Preview: unavailable (no safe inline output)\n\nRetention-managed async directory: /tmp/runs/wf-1\nWorkflow run: wf-1\nChild runs: mina=c-1 (failed), uma=c-2 (failed)";
        let run = RunNotice::parse(text).expect("parsed");
        assert_eq!(run.status, "failed");
        assert_eq!(run.agent, "workflow");
        assert_eq!(run.workflow_run.as_deref(), Some("wf-1"));
        assert_eq!(run.async_dir.as_deref(), Some("/tmp/runs/wf-1"));
        assert_eq!(
            run.result,
            "Error: Cannot read runs.all result property 'mina'.\n    at runsAllKeyAccessError ([worker eval]:275:10)"
        );
        assert_eq!(run.children.len(), 2);
        assert_eq!(run.children[1].key.as_deref(), Some("uma"));
        assert_eq!(run.children[1].run_id, "c-2");
        assert_eq!(run.children[1].status.as_deref(), Some("failed"));
        assert_eq!(run.outputs.len(), 2);
        assert_eq!(
            run.outputs[0].preview,
            "Task closed.\n\n**Outcome:** none.\n"
        );
        assert_eq!(run.outputs[1].preview, "");
    }

    #[test]
    fn a_single_run_notice_keeps_its_report_and_session_file() {
        let text = "Background task completed: **worker**\n\nworker:\nDone.\n\nRetention-managed async directory: /tmp/runs/r-9\n\nSession file: /s/a/b.jsonl";
        let run = RunNotice::parse(text).expect("parsed");
        assert_eq!(run.result, "worker:\nDone.");
        assert_eq!(run.session_file.as_deref(), Some("/s/a/b.jsonl"));
        assert_eq!(strip_agent_label(&run.result, "worker"), "Done.");
    }

    #[test]
    fn legacy_job_reports_are_read_and_nothing_else_is() {
        let report = "🛑 Background job killed (timeout, ran 15m)\n[jb-x1] killed killed (timeout) · 15m · cmd\ncwd: /w\nlog: /l\n\n--- last output ---\nlast line";
        let exit = legacy_job_report(report).expect("a report");
        assert_eq!(exit.job_id.as_deref(), Some("jb-x1"));
        assert_eq!(exit.state, "killed");
        assert_eq!(exit.killed_by.as_deref(), Some("timeout"));
        assert_eq!(exit.duration.as_deref(), Some("15m"));
        assert_eq!(exit.tail.as_deref(), Some("last line"));

        let done = legacy_job_report(
            "✅ Background job finished (exit 0, ran 58s)\n[jb-y] completed exit 0 · 58s · c",
        )
        .expect("a report");
        assert_eq!(
            (done.state.as_str(), done.exit_code),
            ("completed", Some(0))
        );
        let failed = legacy_job_report(
            "❌ Background job FAILED (exit 2, ran 5s)\n[jb-z] failed exit 2 · 5s · c",
        )
        .expect("a report");
        assert_eq!(
            (failed.state.as_str(), failed.exit_code),
            ("failed", Some(2))
        );

        assert!(legacy_job_report("✅ Background job finished (exit 0, ran 58s)").is_none());
        assert!(legacy_job_report("please check the background job").is_none());
    }

    #[test]
    fn errors_lose_the_fanout_budget_and_stack_frames() {
        assert_eq!(
            clean_error("Run fan-out: 4/64 used, 60 remaining\nboom\n    at f (x:1:2)"),
            "boom"
        );
    }

    #[test]
    fn supervisor_requests_lose_their_reply_instructions() {
        let text = "Subagent needs a supervisor decision.\nRun: r-1\nAgent: researcher\nChild index: 0\n\nNo web tools. Options?\n\nReply with: subagent_supervisor({ action: \"reply\" })\n\nLive guidance: subagent({ action: \"steer\" })";
        assert_eq!(question_body(text), "No web tools. Options?");
        assert_eq!(
            clean_notice(text),
            "Subagent needs a supervisor decision.\nRun: r-1\nAgent: researcher\nChild index: 0\n\nNo web tools. Options?"
        );
    }

    #[test]
    fn sub_agent_session_names_carry_the_agent_and_run_id() {
        let name =
            subagent_name("subagent-evidence-auditor-42960108-49ef-4be8-8f62-5cd19733a13e-2")
                .expect("a sub-agent name");
        assert_eq!(name.agent, "evidence-auditor");
        assert_eq!(name.run_id, "42960108-49ef-4be8-8f62-5cd19733a13e");
        assert_eq!(name.attempt, 2);
        assert!(!is_subagent_session_name("Build the app"));
    }

    #[test]
    fn durations_read_like_pi_bg_jobs_writes_them() {
        assert_eq!(format_duration(58_000), "58s");
        assert_eq!(format_duration(232_000), "3m 52s");
        assert_eq!(format_duration(900_000), "15m");
        assert_eq!(format_duration(4_320_000), "1h12m");
    }
}
