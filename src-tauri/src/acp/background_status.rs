//! What a live session is doing in the background, for every client's session
//! lists.
//!
//! A conversation's persisted `turn_state` only covers the turns codeg itself
//! sends. Three kinds of activity fall outside it, and a session list that
//! reads `turn_state` alone shows every one of them as "not running":
//!
//! * **Background tasks still running** — async sub-agents, background shells,
//!   monitors and workflows the agent launched. They keep running after the
//!   turn that started them ended, often for an hour or more.
//! * **Work out of turn** — a task notification (a sub-agent finishing, a
//!   monitor event) or a cron prompt wakes the agent, and it runs a whole turn
//!   of its own that codeg never sent. `turn_state` is null throughout.
//! * **A turn held open for background work** — claude-agent-acp keeps the
//!   prompt pending while the sub-agents it spawned run, so `turn_state` reads
//!   `running` although the agent answered long ago and is idle.
//!
//! The same value also lists the sub-agents working for the session right
//! now that are not background tasks: a sub-agent tool call the running turn
//! waits for (Claude's `Agent`, and the hosts the connection already titles
//! "agent"), and codeg's own delegations (`delegate_to_agent`), which outlive
//! the turn that started them. Every client's session list and the
//! conversation's own "running" panel read this one list, so they always
//! name the same items and the same count.
//!
//! The connection already tracks all three: the transcript watcher
//! (`acp::background_watch`) accounts launched tasks and sees out-of-turn
//! turns start and end, the adapter's async-task table (`AsyncTask` events)
//! names shells, monitors and workflows, and `awaiting_background` marks the
//! held turn. [`SessionState::background_status`] folds them into one
//! [`ConversationBackground`] value. It is served on the conversation list,
//! the attention snapshot and its own snapshot
//! (`list_conversation_background`), and every change to it is broadcast on
//! `conversation://background` (see `web::event_bridge`).
//!
//! Nothing here is persisted. A connection that closes clears its value
//! (`status` turns `Disconnected` first), and after a restart there is no
//! connection, so no value — a session can never be left reading "running"
//! by state that outlived the process doing the work.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::acp::session_state::{
    background_keepalive_max_age, SessionState, ToolCallState, ToolCallStatus,
};
use crate::acp::types::{async_task_state_is_terminal, AsyncTaskRecord, ConnectionStatus};
use crate::models::AgentType;

/// At most this many tasks are listed by name. `task_count` always carries
/// the full number; the list only feeds a tooltip.
pub const MAX_LISTED_TASKS: usize = 8;

/// Labels are cut to this many characters (a shell's description, a
/// sub-agent's task title). Enough for a tooltip line.
pub const MAX_TASK_LABEL_CHARS: usize = 120;

/// A sub-agent the running turn waits for (see the module docs).
pub const KIND_SUBAGENT: &str = "subagent";
/// A sub-agent codeg runs for the session through `delegate_to_agent`.
pub const KIND_DELEGATION: &str = "delegation";

/// One background task as the session lists name it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BackgroundTaskBrief {
    /// The agent's own task id (a background shell's `backgroundTaskId`, a
    /// monitor's `taskId`, a sub-agent's `agentId`). The adapter's async-task
    /// table uses the same ids, which is what lets the two sources merge
    /// without counting a shell twice.
    pub id: String,
    /// `agent` (async sub-agent), `shell`, `monitor`, `workflow`, or `task`
    /// for anything else. A plain string so a kind added later renders as
    /// itself instead of failing to decode.
    pub kind: String,
    /// What the agent called it — the `description` it gave the launching
    /// tool call. Empty when it gave none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// When this connection first listed it, so every client counts the
    /// same elapsed time. Absent until the status is first announced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    /// The tool call that started it, when known: where a client finds its
    /// card in the transcript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// A delegation's child agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    /// A delegation's child conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
}

impl BackgroundTaskBrief {
    pub fn new(id: impl Into<String>, kind: impl Into<String>, label: &str) -> Self {
        Self {
            id: id.into(),
            kind: kind.into(),
            label: clip_label(label),
            started_at: None,
            tool_call_id: None,
            agent_type: None,
            conversation_id: None,
        }
    }

    pub fn with_tool_call(mut self, tool_call_id: Option<&str>) -> Self {
        self.tool_call_id = tool_call_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        self
    }

    /// The key its first-seen time is kept under: ids come from different
    /// agents' namespaces, so the kind keeps them apart.
    fn seen_key(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}

/// Trim a label to one tooltip line.
pub fn clip_label(label: &str) -> String {
    let first_line = label.trim().lines().next().unwrap_or("").trim();
    if first_line.chars().count() <= MAX_TASK_LABEL_CHARS {
        return first_line.to_string();
    }
    let mut out: String = first_line.chars().take(MAX_TASK_LABEL_CHARS - 1).collect();
    out.push('…');
    out
}

/// A live session's background activity. Present only while there is some:
/// a session with none has no value at all (`null` / absent on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationBackground {
    /// Everything still running for the session: async sub-agents,
    /// background shells, monitors, workflows, codeg delegations and the
    /// sub-agents the running turn waits for. `0` while the turn is held open
    /// but no task is known by name.
    pub task_count: u32,
    /// The running tasks, at most [`MAX_LISTED_TASKS`] of them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<BackgroundTaskBrief>,
    /// The agent is working right now on a turn codeg did not send: woken by
    /// a task notification (a sub-agent finished, a monitor fired) or a cron
    /// prompt.
    #[serde(default)]
    pub out_of_turn: bool,
    /// The turn codeg sent is still open only because background work holds
    /// it; the agent itself answered and is idle.
    #[serde(default)]
    pub held_open: bool,
}

impl ConversationBackground {
    /// Combine the values of two connections bound to the same conversation
    /// (a pre-connect and the tab's own connection, for a moment). Tasks are
    /// joined by id, the flags are or-ed.
    pub fn merge(mut self, other: &ConversationBackground) -> ConversationBackground {
        let mut seen: HashSet<String> = self.tasks.iter().map(|t| t.id.clone()).collect();
        for task in &other.tasks {
            if seen.insert(task.id.clone()) && self.tasks.len() < MAX_LISTED_TASKS {
                self.tasks.push(task.clone());
            }
        }
        // Both connections run in the same agent session, so they usually
        // see the same tasks: never sum the counts. Tasks past the listing
        // cap can't be matched by id, so the larger count stands for them.
        self.task_count = self
            .task_count
            .max(other.task_count)
            .max(seen.len() as u32);
        self.out_of_turn |= other.out_of_turn;
        self.held_open |= other.held_open;
        self
    }
}

/// Fold per-connection values into one per conversation.
pub fn by_conversation(
    entries: impl IntoIterator<Item = (i32, ConversationBackground)>,
) -> HashMap<i32, ConversationBackground> {
    let mut map: HashMap<i32, ConversationBackground> = HashMap::new();
    for (id, value) in entries {
        let merged = match map.remove(&id) {
            Some(existing) => existing.merge(&value),
            None => value,
        };
        map.insert(id, merged);
    }
    map
}

/// The running background tasks a connection knows of: the adapter's
/// async-task table first (it names shells, monitors and workflows, and is
/// authoritative about whether they finished), then the watcher's accounting
/// for whatever the table doesn't cover — async sub-agents, which the adapter
/// never publishes there, and shells on an adapter without the table.
///
/// A watcher entry the table has seen finish is dropped: the table hears the
/// adapter's own terminal edge, while the watcher can only infer a shell's
/// end from the transcript (an inline `TaskOutput`, a notification that most
/// shells never write) and otherwise keeps it until its max-age valve.
pub fn merge_tasks(
    async_tasks: &BTreeMap<String, AsyncTaskRecord>,
    async_fresh: bool,
    watcher_tasks: &[BackgroundTaskBrief],
) -> Vec<BackgroundTaskBrief> {
    let mut out: Vec<BackgroundTaskBrief> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    if async_fresh {
        for task in async_tasks.values() {
            if async_task_state_is_terminal(&task.state) {
                continue;
            }
            seen.insert(task.task_id.as_str());
            let label = if task.name.trim().is_empty() {
                task.description.as_str()
            } else {
                task.name.as_str()
            };
            out.push(
                BackgroundTaskBrief::new(task.task_id.clone(), task.task_type.clone(), label)
                    .with_tool_call(task.tool_call_id.as_deref()),
            );
        }
    }
    for task in watcher_tasks {
        if seen.contains(task.id.as_str()) {
            continue;
        }
        if async_tasks
            .get(&task.id)
            .is_some_and(|t| async_task_state_is_terminal(&t.state))
        {
            continue;
        }
        let mut task = task.clone();
        // The table names a shell better than the transcript does (it has
        // the description even for a shell launched before this watch
        // armed), so borrow its label when the watcher has none.
        if task.label.is_empty() {
            if let Some(row) = async_tasks.get(&task.id) {
                let label = if row.name.trim().is_empty() {
                    row.description.as_str()
                } else {
                    row.name.as_str()
                };
                task.label = clip_label(label);
            }
        }
        out.push(task);
    }
    out
}

impl SessionState {
    /// This connection's background activity right now, or `None` when there
    /// is none — see the module docs. `now` gates the async-task table the
    /// same way the idle sweep's keep-alive does
    /// ([`SessionState::has_live_async_task`]): rows the adapter has gone
    /// quiet about for longer than the keep-alive window stop counting,
    /// exactly when they stop keeping the connection alive.
    pub fn background_status(&self, now: DateTime<Utc>) -> Option<ConversationBackground> {
        // A connection on its way out (or already gone) runs nothing: the
        // agent CLI and every background task it held die with it. The
        // lifecycle's cleanup emits `StatusChanged { Disconnected }` before
        // the state is dropped, which is what turns into the clearing
        // broadcast.
        if matches!(
            self.status,
            ConnectionStatus::Disconnected | ConnectionStatus::Error
        ) {
            return None;
        }
        let mut tasks = self.background_items(now);
        // An emitter that only counts (Grok's background sub-agents) names
        // none of its tasks; they still count.
        let unnamed = self
            .background_outstanding
            .saturating_sub(self.background_tasks.len() as u32);
        let task_count = tasks.len() as u32 + unnamed;
        let held_open = self.status == ConnectionStatus::Prompting && self.awaiting_background;
        let out_of_turn = self.background_out_of_turn;
        if task_count == 0 && !held_open && !out_of_turn {
            return None;
        }
        for task in &mut tasks {
            task.started_at = self.background_seen_at.get(&task.seen_key()).copied();
        }
        // Oldest first, so the listed few are the longest-running; an item
        // not stamped yet goes last. Stable, so equal stamps keep the order
        // the sources were merged in.
        tasks.sort_by_key(|t| (t.started_at.is_none(), t.started_at));
        tasks.truncate(MAX_LISTED_TASKS);
        Some(ConversationBackground {
            task_count,
            tasks,
            out_of_turn,
            held_open,
        })
    }

    /// The `conversation://background` broadcasts owed since the last one this
    /// connection made, and records them as made. Empty when nothing a
    /// session list shows has changed.
    ///
    /// Compares against what was last ANNOUNCED rather than sampling around
    /// one event, so a change with no event of its own — an async-task row
    /// aging out of the keep-alive window — is still caught by the next
    /// re-check ([`crate::web::event_bridge::refresh_background_broadcast`]),
    /// and a broadcast that never went out is retried rather than lost.
    ///
    /// Rebinding counts: a session linked to its row while already busy
    /// announces itself under the new id, and the old row (if it was told
    /// anything) is cleared.
    pub fn take_background_changes(&mut self, now: DateTime<Utc>) -> Vec<ConversationBackgroundChange> {
        self.stamp_background_seen(now);
        let current = (self.conversation_id, self.background_status(now));
        if current == self.background_announced {
            return Vec::new();
        }
        let (old_id, old_value) =
            std::mem::replace(&mut self.background_announced, current.clone());
        let (new_id, new_value) = current;
        let mut out = Vec::new();
        if let Some(old_id) = old_id {
            if old_value.is_some() && Some(old_id) != new_id {
                out.push(ConversationBackgroundChange {
                    id: old_id,
                    background: None,
                });
            }
        }
        if let Some(new_id) = new_id {
            let rebound = old_id != Some(new_id);
            if new_value != old_value || (rebound && new_value.is_some()) {
                // An unbound session that went quiet has nothing to clear.
                if new_value.is_some() || !rebound {
                    out.push(ConversationBackgroundChange {
                        id: new_id,
                        background: new_value,
                    });
                }
            }
        }
        out
    }

    /// Every item running for this connection, unsorted and uncapped, without
    /// first-seen times: background tasks, then delegations, then the
    /// sub-agents the running turn waits for.
    fn background_items(&self, now: DateTime<Utc>) -> Vec<BackgroundTaskBrief> {
        let async_fresh = self
            .async_task_activity_at
            .is_some_and(|at| now.signed_duration_since(at) < background_keepalive_max_age());
        let mut items = merge_tasks(&self.async_tasks, async_fresh, &self.background_tasks);
        for delegation in self.active_delegations.values() {
            let id = if delegation.task_id.is_empty() {
                &delegation.parent_tool_use_id
            } else {
                &delegation.task_id
            };
            let mut brief =
                BackgroundTaskBrief::new(id.clone(), KIND_DELEGATION, &delegation.task_preview)
                    .with_tool_call(Some(&delegation.parent_tool_use_id));
            brief.agent_type = Some(delegation.agent_type);
            brief.conversation_id = Some(delegation.child_conversation_id);
            items.push(brief);
        }
        for call in self.active_tool_calls.values() {
            if !matches!(
                call.status,
                ToolCallStatus::Pending | ToolCallStatus::InProgress
            ) || self.active_delegations.contains_key(&call.id)
            {
                continue;
            }
            if let Some(label) = foreground_subagent_label(call) {
                items.push(
                    BackgroundTaskBrief::new(call.id.clone(), KIND_SUBAGENT, &label)
                        .with_tool_call(Some(&call.id)),
                );
            }
        }
        items
    }

    /// Record when each item was first listed and forget the ones that are
    /// gone. Runs after every event (see `take_background_changes`), so an
    /// item is stamped the moment the event that started it lands.
    fn stamp_background_seen(&mut self, now: DateTime<Utc>) {
        let live: HashSet<String> = if matches!(
            self.status,
            ConnectionStatus::Disconnected | ConnectionStatus::Error
        ) {
            HashSet::new()
        } else {
            self.background_items(now)
                .iter()
                .map(BackgroundTaskBrief::seen_key)
                .collect()
        };
        self.background_seen_at.retain(|key, _| live.contains(key));
        for key in live {
            self.background_seen_at.entry(key).or_insert(now);
        }
    }

    /// Whether [`Self::take_background_changes`] would announce anything —
    /// the cheap read-lock check a periodic re-check runs first.
    pub fn background_change_pending(&self, now: DateTime<Utc>) -> bool {
        (self.conversation_id, self.background_status(now)) != self.background_announced
    }
}

/// What a sub-agent tool call is called, when `call` launches a sub-agent the
/// turn waits for; `None` for any other call. Recognized the way the
/// transcript's Agent card is: claude-agent-acp's `claudeCode.subagent` mark,
/// the "agent" title the connection gives OpenCode / CodeBuddy / Grok
/// launches, or the `subagent_type` input shape (Claude's `Task`, Cursor's
/// task). A launch into the background is left out: it returns at once, and
/// the transcript watcher lists the sub-agent as an `agent` task from then on.
/// So is a codeg delegation, which is listed as one.
pub(crate) fn foreground_subagent_label(call: &ToolCallState) -> Option<String> {
    let field = |key: &str| call.input.as_ref().and_then(|v| v.get(key));
    let text = |key: &str| {
        field(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let meta = |key: &str| call.meta.as_ref().and_then(|m| m.get(key));
    let marked = meta("claudeCode")
        .and_then(|c| c.get("subagent"))
        .and_then(|v| v.as_bool())
        == Some(true);
    let titled = call.label.trim().eq_ignore_ascii_case("agent");
    let shaped = text("subagent_type").is_some()
        || field("subagentType").is_some_and(|v| !v.is_null())
        || text("_toolName") == Some("task");
    if !(marked || titled || shaped)
        || meta("codeg.delegation").is_some()
        || field("run_in_background").and_then(|v| v.as_bool()) == Some(true)
    {
        return None;
    }
    let description = text("description");
    Some(match (text("subagent_type"), description) {
        (Some(kind), Some(description)) => format!("{kind}: {description}"),
        (Some(kind), None) => kind.to_string(),
        (None, Some(description)) => description.to_string(),
        (None, None) if titled => String::new(),
        (None, None) => call.label.trim().to_string(),
    })
}

/// Payload of the `conversation://background` side-channel: a session's
/// background activity changed. `id` is the conversation its connection is
/// bound to; `background: null` means none is left.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationBackgroundChange {
    pub id: i32,
    pub background: Option<ConversationBackground>,
}

/// One row of the `list_conversation_background` snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationBackgroundEntry {
    pub conversation_id: i32,
    pub background: ConversationBackground,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{AcpEvent, AsyncTaskDelta};
    use crate::models::AgentType;

    fn state() -> SessionState {
        let mut s = SessionState::new(
            "conn".into(),
            AgentType::ClaudeCode,
            None,
            "win".into(),
            None,
        );
        s.status = ConnectionStatus::Connected;
        s.conversation_id = Some(144);
        s
    }

    fn watcher_event(tasks: Vec<BackgroundTaskBrief>, out_of_turn: bool) -> AcpEvent {
        AcpEvent::BackgroundActivity {
            session_id: "sess".into(),
            turns: Vec::new(),
            outstanding: tasks.len() as u32,
            settled: Vec::new(),
            watermark: 0,
            tasks,
            out_of_turn,
            activity_at: None,
        }
    }

    fn spawned(id: &str, kind: &str, name: &str) -> AcpEvent {
        AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                task_id: id.into(),
                spawned: true,
                name: Some(name.into()),
                task_type: Some(kind.into()),
                description: Some(name.into()),
                show_in_transcript: None,
                can_stop: Some(true),
                state: Some("running".into()),
                summary: None,
                last_tool_name: None,
                usage: None,
                output_file_path: None,
                tool_call_id: None,
            },
        }
    }

    fn state_update(id: &str, state: &str) -> AcpEvent {
        AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                task_id: id.into(),
                spawned: false,
                name: None,
                task_type: None,
                description: None,
                show_in_transcript: None,
                can_stop: None,
                state: Some(state.into()),
                summary: None,
                last_tool_name: None,
                usage: None,
                output_file_path: None,
                tool_call_id: None,
            },
        }
    }

    fn tool_call(
        id: &str,
        title: &str,
        status: &str,
        input: &str,
        meta: Option<serde_json::Value>,
    ) -> AcpEvent {
        AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: title.into(),
            kind: "think".into(),
            status: status.into(),
            content: None,
            raw_input: Some(input.into()),
            raw_output: None,
            locations: None,
            meta,
            images: None,
        }
    }

    fn delegation_started(parent_tool_use_id: &str) -> AcpEvent {
        AcpEvent::DelegationStarted {
            parent_connection_id: "conn".into(),
            parent_tool_use_id: parent_tool_use_id.into(),
            child_connection_id: "child-conn".into(),
            child_conversation_id: 77,
            agent_type: AgentType::Codex,
            task_preview: "run the tests".into(),
            task_id: "task-1".into(),
        }
    }

    #[test]
    fn sub_agents_the_turn_waits_for_are_listed() {
        let mut s = state();
        s.status = ConnectionStatus::Prompting;
        let marked =
            Some(serde_json::json!({"claudeCode": {"toolName": "Agent", "subagent": true}}));
        s.apply_event(&tool_call(
            "toolu_fg",
            "Find the bug",
            "in_progress",
            r#"{"subagent_type":"Explore","description":"Find the bug","prompt":"x"}"#,
            marked.clone(),
        ));
        // Launched into the background: the watcher lists it once acked.
        s.apply_event(&tool_call(
            "toolu_bg",
            "Review",
            "in_progress",
            r#"{"subagent_type":"general-purpose","description":"Review","run_in_background":true}"#,
            marked,
        ));
        s.apply_event(&tool_call(
            "toolu_sh",
            "ls",
            "in_progress",
            r#"{"command":"ls"}"#,
            None,
        ));
        // The connection's sentinel title for OpenCode / CodeBuddy / Grok.
        s.apply_event(&tool_call(
            "toolu_oc",
            "agent",
            "pending",
            r#"{"prompt":"x"}"#,
            None,
        ));

        let bg = s.background_status(Utc::now()).expect("listed");
        assert_eq!(bg.task_count, 2);
        let fg = bg.tasks.iter().find(|t| t.id == "toolu_fg").unwrap();
        assert_eq!(fg.kind, KIND_SUBAGENT);
        assert_eq!(fg.label, "Explore: Find the bug");
        assert_eq!(fg.tool_call_id.as_deref(), Some("toolu_fg"));
        assert!(bg
            .tasks
            .iter()
            .any(|t| t.id == "toolu_oc" && t.label.is_empty()));
        assert!(!bg.out_of_turn && !bg.held_open);

        s.apply_event(&tool_call(
            "toolu_fg",
            "Find the bug",
            "completed",
            "{}",
            None,
        ));
        let bg = s.background_status(Utc::now()).expect("one left");
        assert_eq!(
            bg.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["toolu_oc"]
        );
    }

    #[test]
    fn delegations_are_listed_until_they_complete() {
        let mut s = state();
        s.apply_event(&delegation_started("toolu_deleg"));
        let bg = s.background_status(Utc::now()).expect("listed");
        assert_eq!(bg.task_count, 1);
        let item = &bg.tasks[0];
        assert_eq!(item.kind, KIND_DELEGATION);
        assert_eq!(item.id, "task-1");
        assert_eq!(item.label, "run the tests");
        assert_eq!(item.tool_call_id.as_deref(), Some("toolu_deleg"));
        assert_eq!(item.agent_type, Some(AgentType::Codex));
        assert_eq!(item.conversation_id, Some(77));

        s.apply_event(&AcpEvent::DelegationCompleted {
            parent_connection_id: "conn".into(),
            parent_tool_use_id: "toolu_deleg".into(),
            child_connection_id: "child-conn".into(),
            child_conversation_id: 77,
            agent_type: AgentType::Codex,
            result: crate::acp::types::DelegationResultSummary::Ok {
                duration_ms: 1,
                text_preview: None,
            },
        });
        assert_eq!(s.background_status(Utc::now()), None);
    }

    #[test]
    fn items_keep_the_time_they_were_first_listed() {
        let mut s = state();
        let t0 = Utc::now();
        s.apply_event(&delegation_started("toolu_deleg"));
        let first = s.take_background_changes(t0);
        let started = first[0].background.as_ref().unwrap().tasks[0].started_at;
        assert_eq!(started, Some(t0));

        // A later change re-announces the list; the first item keeps its time.
        let t1 = t0 + chrono::Duration::seconds(30);
        s.apply_event(&watcher_event(
            vec![BackgroundTaskBrief::new("x", "shell", "build")],
            false,
        ));
        let next = s.take_background_changes(t1);
        let tasks = &next[0].background.as_ref().unwrap().tasks;
        assert_eq!(tasks[0].id, "task-1", "oldest first");
        assert_eq!(tasks[0].started_at, Some(t0));
        assert_eq!(tasks[1].started_at, Some(t1));

        // Gone items are forgotten, so one coming back starts afresh.
        s.apply_event(&watcher_event(Vec::new(), false));
        let _ = s.take_background_changes(t1);
        assert_eq!(s.background_seen_at.len(), 1);
    }

    #[test]
    fn idle_session_has_no_background() {
        let s = state();
        assert_eq!(s.background_status(Utc::now()), None);
    }

    #[test]
    fn a_task_starting_and_settling_moves_the_count() {
        let mut s = state();
        let shell = BackgroundTaskBrief::new("bm227ltpx", "shell", "Wait for runs");
        s.apply_event(&watcher_event(vec![shell.clone()], false));
        let bg = s.background_status(Utc::now()).expect("a task runs");
        assert_eq!(bg.task_count, 1);
        assert_eq!(bg.tasks, vec![shell]);
        assert!(!bg.out_of_turn && !bg.held_open);

        s.apply_event(&watcher_event(Vec::new(), false));
        assert_eq!(s.background_status(Utc::now()), None);
    }

    #[test]
    fn async_table_and_watcher_merge_by_id() {
        let mut s = state();
        // The adapter announces the shell and a monitor; the watcher knows
        // the same shell (no label) and a sub-agent.
        s.apply_event(&spawned("bm227ltpx", "shell", "Wait for runs, then judge"));
        s.apply_event(&spawned("bq4s928n8", "monitor", "main run: errors"));
        s.apply_event(&watcher_event(
            vec![
                BackgroundTaskBrief::new("bm227ltpx", "shell", ""),
                BackgroundTaskBrief::new("a4dc31", "agent", "Plant defects"),
            ],
            false,
        ));
        let bg = s.background_status(Utc::now()).unwrap();
        assert_eq!(bg.task_count, 3, "the shell must not count twice");
        let kinds: Vec<_> = bg.tasks.iter().map(|t| t.kind.as_str()).collect();
        assert_eq!(kinds, vec!["shell", "monitor", "agent"]);
        assert_eq!(bg.tasks[0].label, "Wait for runs, then judge");

        // The adapter says the shell finished; the watcher (which cannot see
        // a shell end that wrote no notification) still lists it. The table
        // wins.
        s.apply_event(&state_update("bm227ltpx", "completed"));
        let bg = s.background_status(Utc::now()).unwrap();
        assert_eq!(bg.task_count, 2);
        assert!(bg.tasks.iter().all(|t| t.id != "bm227ltpx"));
    }

    #[test]
    fn async_rows_age_out_with_the_keep_alive() {
        let mut s = state();
        s.apply_event(&spawned("bq4s928n8", "monitor", "main run"));
        assert!(s.background_status(Utc::now()).is_some());
        let later = Utc::now() + background_keepalive_max_age() + chrono::Duration::seconds(1);
        assert_eq!(s.background_status(later), None);
    }

    #[test]
    fn out_of_turn_work_starts_and_ends() {
        let mut s = state();
        s.apply_event(&watcher_event(Vec::new(), true));
        let bg = s.background_status(Utc::now()).unwrap();
        assert!(bg.out_of_turn);
        assert_eq!(bg.task_count, 0);
        s.apply_event(&watcher_event(Vec::new(), false));
        assert_eq!(s.background_status(Utc::now()), None);
    }

    #[test]
    fn held_open_only_while_prompting() {
        let mut s = state();
        s.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });
        assert_eq!(s.background_status(Utc::now()), None, "a normal turn");
        s.apply_event(&AcpEvent::AwaitingBackground {
            awaiting: true,
            native_steering: true,
        });
        let bg = s.background_status(Utc::now()).unwrap();
        assert!(bg.held_open);
        assert_eq!(bg.task_count, 0);
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "sess".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        assert_eq!(s.background_status(Utc::now()), None);
    }

    #[test]
    fn disconnect_clears_everything() {
        let mut s = state();
        s.apply_event(&watcher_event(
            vec![BackgroundTaskBrief::new("x", "shell", "build")],
            true,
        ));
        assert!(s.background_status(Utc::now()).is_some());
        s.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected,
        });
        assert_eq!(s.background_status(Utc::now()), None);
    }

    #[test]
    fn a_fresh_state_after_restart_has_nothing() {
        // Nothing is persisted: the state a restarted codeg builds for a
        // resumed session starts empty, whatever the old process last said.
        let s = SessionState::new(
            "conn-2".into(),
            AgentType::ClaudeCode,
            None,
            "win".into(),
            None,
        );
        assert_eq!(s.background_status(Utc::now()), None);
        assert_eq!(s.background_announced, (None, None));
    }

    #[test]
    fn changes_are_announced_once_and_cleared() {
        let mut s = state();
        let now = Utc::now();
        assert!(s.take_background_changes(now).is_empty());

        s.apply_event(&watcher_event(
            vec![BackgroundTaskBrief::new("x", "shell", "build")],
            false,
        ));
        let changes = s.take_background_changes(now);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].id, 144);
        assert_eq!(changes[0].background.as_ref().unwrap().task_count, 1);
        assert!(s.take_background_changes(now).is_empty(), "announced once");
        assert!(!s.background_change_pending(now));

        s.apply_event(&watcher_event(Vec::new(), false));
        assert!(s.background_change_pending(now));
        assert_eq!(
            s.take_background_changes(now),
            vec![ConversationBackgroundChange {
                id: 144,
                background: None
            }]
        );
    }

    #[test]
    fn rebinding_moves_the_announcement() {
        let mut s = state();
        s.conversation_id = None;
        let now = Utc::now();
        s.apply_event(&watcher_event(Vec::new(), true));
        assert!(
            s.take_background_changes(now).is_empty(),
            "an unbound session has no row to tell"
        );
        s.conversation_id = Some(7);
        let changes = s.take_background_changes(now);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].id, 7);
        // Moved to another row while busy: the old row is cleared.
        s.conversation_id = Some(9);
        let changes = s.take_background_changes(now);
        assert_eq!(
            changes,
            vec![
                ConversationBackgroundChange {
                    id: 7,
                    background: None
                },
                ConversationBackgroundChange {
                    id: 9,
                    background: s.background_status(now)
                },
            ]
        );
        // Linked while idle: nothing to say.
        let mut idle = state();
        idle.conversation_id = None;
        assert!(idle.take_background_changes(now).is_empty());
        idle.conversation_id = Some(3);
        assert!(idle.take_background_changes(now).is_empty());
    }

    #[test]
    fn merge_joins_tasks_and_flags() {
        let a = ConversationBackground {
            task_count: 1,
            tasks: vec![BackgroundTaskBrief::new("x", "shell", "build")],
            out_of_turn: false,
            held_open: true,
        };
        let b = ConversationBackground {
            task_count: 2,
            tasks: vec![
                BackgroundTaskBrief::new("x", "shell", "build"),
                BackgroundTaskBrief::new("y", "agent", "review"),
            ],
            out_of_turn: true,
            held_open: false,
        };
        let m = a.merge(&b);
        assert_eq!(m.task_count, 2);
        assert_eq!(m.tasks.len(), 2);
        assert!(m.out_of_turn && m.held_open);

        let folded = by_conversation(vec![
            (1, m.clone()),
            (
                2,
                ConversationBackground {
                    task_count: 0,
                    tasks: vec![],
                    out_of_turn: true,
                    held_open: false,
                },
            ),
        ]);
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[&1], m);
    }

    #[test]
    fn count_only_emitters_still_count() {
        // Grok's background sub-agents arrive as a bare `outstanding`.
        let mut s = state();
        s.apply_event(&AcpEvent::BackgroundActivity {
            session_id: "sess".into(),
            turns: Vec::new(),
            outstanding: 2,
            settled: Vec::new(),
            watermark: 0,
            tasks: Vec::new(),
            out_of_turn: false,
            activity_at: None,
        });
        let bg = s.background_status(Utc::now()).unwrap();
        assert_eq!(bg.task_count, 2);
        assert!(bg.tasks.is_empty());
    }

    #[test]
    fn listing_is_capped_but_counting_is_not() {
        let mut s = state();
        let tasks: Vec<_> = (0..12)
            .map(|i| BackgroundTaskBrief::new(format!("t{i}"), "agent", "x"))
            .collect();
        s.apply_event(&watcher_event(tasks, false));
        let bg = s.background_status(Utc::now()).unwrap();
        assert_eq!(bg.task_count, 12);
        assert_eq!(bg.tasks.len(), MAX_LISTED_TASKS);
    }

    #[test]
    fn labels_are_one_clipped_line() {
        assert_eq!(clip_label("  Build the app\nwith more  "), "Build the app");
        let long = "x".repeat(300);
        let clipped = clip_label(&long);
        assert_eq!(clipped.chars().count(), MAX_TASK_LABEL_CHARS);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn wire_shape() {
        let bg = ConversationBackground {
            task_count: 1,
            tasks: vec![BackgroundTaskBrief::new("x", "shell", "")],
            out_of_turn: false,
            held_open: false,
        };
        let v = serde_json::to_value(&bg).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "task_count": 1,
                "tasks": [{"id": "x", "kind": "shell"}],
                "out_of_turn": false,
                "held_open": false,
            })
        );
        let change = ConversationBackgroundChange {
            id: 4,
            background: None,
        };
        assert_eq!(
            serde_json::to_value(&change).unwrap(),
            serde_json::json!({"id": 4, "background": null})
        );
    }
}
