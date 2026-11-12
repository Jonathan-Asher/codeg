//! Pi's live structured channel through the connection (`acp::pi_meta`),
//! driven by ACP traffic captured from pi-acp 0.0.34-steering.6 with Pi 1.5.2,
//! pi-subagents 0.88 and pi-bg-jobs (`tests/fixtures/pi_live/*.jsonl`, one
//! record per line: `prompt` / `promptEnd` / `cancel` mark what codeg did, and
//! `update` is a `session/update` as pi-acp sent it). The session files those
//! runs wrote are under `tests/fixtures/pi_live/sessions`: the history parser
//! reads them, so the live cards can be held against the history ones.

use super::*;
use crate::acp::pi_meta::PiLiveCaps;
use crate::models::{ContentBlock, ConversationDetail, TurnRole};
use crate::parsers::pi::PiParser;
use crate::parsers::AgentParser;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pi_live")
}

fn fixture(name: &str) -> Vec<Value> {
    std::fs::read_to_string(fixture_dir().join(name))
        .expect("fixture")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture line"))
        .collect()
}

fn all_caps() -> PiLiveCaps {
    PiLiveCaps {
        agent_turns: true,
        custom_messages: true,
        subagents: true,
        background_jobs: true,
        compaction: true,
        async_tasks: true,
    }
}

/// One connection, fed the way its loops feed it: a prompt turn opened and
/// closed like the prompt arm does, Stop like the idle arm, every update
/// through `emit_conversation_update` (AIR frames through their reader
/// first), and an agent turn's end settled like the idle loop settles it.
struct Harness {
    state: Arc<RwLock<SessionState>>,
    cache: ToolCallOutputCache,
    cb: CodeBuddyLiveState,
    perms: PendingPermissions,
    events: Vec<AcpEvent>,
    seq: u64,
    in_prompt: bool,
}

impl Harness {
    fn new() -> Self {
        let mut st = SessionState::new(
            "conn-pi-live".to_string(),
            AgentType::Pi,
            None,
            "win".to_string(),
            None,
        );
        st.pi_live = Some(all_caps());
        st.status = ConnectionStatus::Connected;
        st.external_id = Some("sess".to_string());
        st.conversation_id = Some(7);
        let mut cb = CodeBuddyLiveState::default();
        cb.pi.caps = Some(all_caps());
        Harness {
            state: Arc::new(RwLock::new(st)),
            cache: ToolCallOutputCache::default(),
            cb,
            perms: Arc::new(tokio::sync::Mutex::new(PermissionQueue::default())),
            events: Vec::new(),
            seq: 0,
            in_prompt: false,
        }
    }

    async fn drain(&mut self) -> Vec<AcpEvent> {
        let s = self.state.read().await;
        let fresh: Vec<AcpEvent> = s
            .recent_events_after(self.seq)
            .expect("no gap")
            .iter()
            .map(|e| e.payload.clone())
            .collect();
        self.seq = s.event_seq;
        drop(s);
        self.events.extend(fresh.iter().cloned());
        fresh
    }

    async fn emit(&mut self, event: AcpEvent) {
        emit_with_state(&self.state, &EventEmitter::Noop, event).await;
    }

    /// Feed one fixture record; returns the events it produced.
    async fn feed(&mut self, record: &Value) -> Vec<AcpEvent> {
        if record.get("prompt").is_some() {
            self.cb.pi.prompt_started();
            self.state.write().await.turn_in_flight = true;
            self.emit(AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            })
            .await;
            self.in_prompt = true;
        } else if let Some(stop) = record.get("promptEnd").and_then(Value::as_str) {
            self.emit(AcpEvent::TurnComplete {
                session_id: "sess".into(),
                stop_reason: stop.into(),
                agent_type: "pi".into(),
            })
            .await;
            self.emit(AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            })
            .await;
            self.in_prompt = false;
        } else if record.get("cancel").is_some() {
            assert!(!self.in_prompt, "fixtures only stop runs Pi started");
            if self.cb.pi.cancel_turn() {
                settle_pi_agent_turn(
                    &self.perms,
                    &self.state,
                    &EventEmitter::Noop,
                    AgentType::Pi,
                    "sess",
                    crate::acp::pi_meta::TurnClose {
                        stop_reason: "cancelled",
                        error: None,
                    },
                )
                .await;
            }
        } else if let Some(update) = record.get("update") {
            let dispatch = Dispatch::Notification(
                UntypedMessage::new(
                    "session/update",
                    json!({"sessionId": "sess", "update": update}),
                )
                .unwrap(),
            );
            if let Some(delta) = air_async_task_delta(&dispatch) {
                self.emit(AcpEvent::AsyncTask { delta }).await;
            } else {
                let update: SessionUpdate =
                    serde_json::from_value(update.clone()).expect("a typed update");
                emit_conversation_update(
                    &self.state,
                    &EventEmitter::Noop,
                    AgentType::Pi,
                    update,
                    None,
                    &mut self.cache,
                    &mut self.cb,
                )
                .await;
                if let Some(close) = self.cb.pi.take_close() {
                    assert!(!self.in_prompt, "no agent turn under a prompt turn");
                    settle_pi_agent_turn(
                        &self.perms,
                        &self.state,
                        &EventEmitter::Noop,
                        AgentType::Pi,
                        "sess",
                        close,
                    )
                    .await;
                }
            }
        }
        self.drain().await
    }

    async fn run(fixture_name: &str) -> Harness {
        let mut harness = Harness::new();
        for record in fixture(fixture_name) {
            harness.feed(&record).await;
        }
        harness
    }

    /// The last card published for `id`.
    fn last_card(&self, id: &str) -> Option<&Value> {
        self.events.iter().rev().find_map(|event| match event {
            AcpEvent::ToolCard { tool_call_id, meta } if tool_call_id == id => Some(meta),
            _ => None,
        })
    }

    fn turn_completes(&self) -> Vec<&str> {
        self.events
            .iter()
            .filter_map(|event| match event {
                AcpEvent::TurnComplete { stop_reason, .. } => Some(stop_reason.as_str()),
                _ => None,
            })
            .collect()
    }
}

fn find_launch(events: &[AcpEvent], title: &str) -> Option<(String, Option<String>, Value)> {
    events.iter().find_map(|event| match event {
        AcpEvent::ToolCall {
            tool_call_id,
            title: t,
            raw_input,
            meta: Some(meta),
            ..
        } if t == title => Some((tool_call_id.clone(), raw_input.clone(), meta.clone())),
        _ => None,
    })
}

/// The history parser's reading of a fixture session, copied to a fresh dir.
fn history(session_id: &str) -> ConversationDetail {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = fixture_dir().join("sessions");
    for entry in walkdir::WalkDir::new(&src) {
        let entry = entry.expect("walk");
        let to = dir.path().join(entry.path().strip_prefix(&src).unwrap());
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&to).unwrap();
        } else {
            std::fs::copy(entry.path(), &to).unwrap();
        }
    }
    let detail = PiParser::with_base_dir(dir.path().to_path_buf())
        .get_conversation(session_id)
        .expect("the fixture parses");
    drop(dir);
    detail
}

fn history_meta(detail: &ConversationDetail, call_id: &str) -> Value {
    detail
        .turns
        .iter()
        .flat_map(|turn| &turn.blocks)
        .find_map(|block| match block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                meta: Some(meta),
                ..
            } if id == call_id => Some(meta.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no card for {call_id} in history"))
}

fn history_wake_kinds(detail: &ConversationDetail) -> Vec<String> {
    detail
        .turns
        .iter()
        .filter(|turn| matches!(turn.role, TurnRole::System))
        .flat_map(|turn| &turn.blocks)
        .filter_map(|block| match block {
            ContentBlock::ToolUse {
                meta: Some(meta), ..
            } => meta.get("codeg.agentWake").map(|wake| {
                wake["triggers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["kind"].as_str().unwrap().to_string())
                    .collect::<Vec<_>>()
                    .join("+")
            }),
            _ => None,
        })
        .collect()
}

fn live_wake_kinds(events: &[AcpEvent]) -> Vec<String> {
    // The marker's last state per id, in order of first appearance.
    let mut order: Vec<String> = Vec::new();
    let mut last: HashMap<String, Value> = HashMap::new();
    for event in events {
        let (id, meta) = match event {
            AcpEvent::ToolCall {
                tool_call_id,
                meta: Some(meta),
                ..
            }
            | AcpEvent::ToolCallUpdate {
                tool_call_id,
                meta: Some(meta),
                ..
            } => (tool_call_id, meta),
            _ => continue,
        };
        if meta.get("codeg.agentWake").is_none() {
            continue;
        }
        if !order.contains(id) {
            order.push(id.clone());
        }
        last.insert(id.clone(), meta.clone());
    }
    order
        .iter()
        .map(|id| {
            last[id]["codeg.agentWake"]["triggers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["kind"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
                .join("+")
        })
        .collect()
}

/// The fields of a run card both views know, for comparing them.
fn run_digest(meta: &Value) -> Value {
    let run = &meta["codeg.subagentRun"];
    let rows: Vec<Value> = run["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            json!({
                "key": row["key"], "label": row["label"], "agent": row["agent"],
                "status": row["status"], "sessionId": row["sessionId"],
            })
        })
        .collect();
    let mut note_kinds: Vec<String> = run["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["kind"].as_str().unwrap().to_string())
        .collect();
    note_kinds.dedup();
    json!({
        "status": run["status"], "mode": run["mode"], "async": run["async"],
        "agent": run["agent"], "error": run["error"], "children": rows,
        "notes": note_kinds,
    })
}

const ASYNC_LAUNCH: &str = "chatcmpl-tool-20bf71a84c294eeb8f5eaeafcf2d0946";
const JOB_LAUNCH: &str = "chatcmpl-tool-98a8944ceb08426cb832b7b6c1b6e120";
const WORKFLOW_LAUNCH: &str = "chatcmpl-tool-00f26fec2c6d4169be85630ef46c60ad";

#[tokio::test]
async fn an_async_run_streams_its_card_and_the_run_it_wakes_is_a_turn() {
    let mut h = Harness::new();
    let records = fixture("async_run.jsonl");
    let mut opened_at = None;
    let mut ended_at = None;
    for (i, record) in records.iter().enumerate() {
        let events = h.feed(record).await;
        if events
            .iter()
            .any(|e| matches!(e, AcpEvent::ToolCall { title, .. } if title == "agent_wake"))
        {
            opened_at = Some(i);
            // The run is a turn: prompting, the gate held, a start time known.
            let s = h.state.read().await;
            assert_eq!(s.status, ConnectionStatus::Prompting);
            assert!(s.turn_in_flight);
            assert!(s.pi_agent_turn_started_at.is_some());
        }
        if opened_at.is_some()
            && ended_at.is_none()
            && events
                .iter()
                .any(|e| matches!(e, AcpEvent::TurnComplete { .. }))
        {
            ended_at = Some(i);
        }
    }
    let (opened, ended) = (opened_at.expect("a woken turn"), ended_at.expect("it ends"));
    assert!(opened < ended);

    // The launch is an Agent card from its first frame, in the history's shape.
    let (id, input, meta) = find_launch(&h.events, "agent").expect("the launch is titled agent");
    assert_eq!(id, ASYNC_LAUNCH);
    let input: Value = serde_json::from_str(input.as_deref().unwrap()).unwrap();
    assert_eq!(input["subagent_type"], "scout");
    assert!(input["description"].as_str().unwrap().starts_with("Run ls"));
    assert_eq!(meta["codeg.subagentRun"]["status"], "pending");

    // It finished after its turn: the card, by id, says so.
    let card = h.last_card(ASYNC_LAUNCH).expect("a card");
    let run = &card["codeg.subagentRun"];
    assert_eq!(run["status"], "completed", "{run}");
    assert_eq!(
        run["children"][0]["sessionId"],
        "01a1d126-b3e8-72d9-971f-2d966f66b9d6"
    );
    assert!(run["result"]
        .as_str()
        .unwrap()
        .ends_with("**Number of entries: 0**"));
    let notes: Vec<&str> = run["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["kind"].as_str().unwrap())
        .collect();
    assert_eq!(notes.first(), Some(&"launch"));
    assert!(notes.contains(&"result"), "{notes:?}");
    assert_eq!(
        h.state.read().await.tool_cards.get(ASYNC_LAUNCH),
        Some(card)
    );

    // Woken by the run's (hidden) completion, which is the marker's text.
    assert_eq!(live_wake_kinds(&h.events), ["subagentSettled"]);
    let filled = h.events.iter().any(|e| matches!(e,
        AcpEvent::ToolCallUpdate { meta: Some(meta), .. }
            if meta["codeg.agentWake"]["triggers"][0]["text"].as_str().is_some_and(|t| t.starts_with("Background task completed"))));
    assert!(filled, "the notice is what the model saw");

    // Its reply streamed inside the turn, which ended like a prompt turn.
    assert_eq!(h.turn_completes(), ["end_turn", "end_turn"]);
    let s = h.state.read().await;
    assert_eq!(s.status, ConnectionStatus::Connected);
    assert!(!s.turn_in_flight);
    assert!(s.pi_agent_turn_started_at.is_none());
    assert!(s
        .last_assistant_text
        .as_deref()
        .is_some_and(|t| t.contains("0 entries")));
}

#[tokio::test]
async fn a_job_runs_then_exits_and_its_exit_wakes_a_turn() {
    let h = Harness::run("job.jsonl").await;
    let (id, _, meta) = h
        .events
        .iter()
        .find_map(|event| match event {
            AcpEvent::ToolCall {
                tool_call_id,
                meta: Some(meta),
                raw_input,
                ..
            } if meta.get("codeg.backgroundJob").is_some() => {
                Some((tool_call_id.clone(), raw_input.clone(), meta.clone()))
            }
            _ => None,
        })
        .expect("the bgj_run call carries its job");
    assert_eq!(id, JOB_LAUNCH);
    assert_eq!(meta["codeg.backgroundJob"]["state"], "running");
    let running_card = h.events.iter().any(|e| {
        matches!(e,
        AcpEvent::ToolCard { tool_call_id, meta } if tool_call_id == JOB_LAUNCH
            && meta["codeg.backgroundJob"]["id"] == "jb-mwdx4odn-5ox8"
            && meta["codeg.backgroundJob"]["state"] == "running")
    });
    assert!(running_card);
    let job = &h.last_card(JOB_LAUNCH).expect("a card")["codeg.backgroundJob"];
    assert_eq!(job["state"], "completed");
    assert_eq!(job["exitCode"], 0);
    assert_eq!(job["duration"], "6s");
    assert_eq!(job["tail"], "bg-done");
    assert_eq!(live_wake_kinds(&h.events), ["jobExit"]);
    assert_eq!(h.turn_completes(), ["end_turn", "end_turn"]);
}

#[tokio::test]
async fn stop_ends_a_woken_run_at_once_and_the_next_prompt_works() {
    let h = Harness::run("stop.jsonl").await;
    // The prompt turn, the woken run stopped by codeg (once: pi's own
    // `ended cancelled` that follows is not a second end), the next prompt.
    assert_eq!(h.turn_completes(), ["end_turn", "cancelled", "end_turn"]);
    let s = h.state.read().await;
    assert_eq!(s.status, ConnectionStatus::Connected);
    assert!(!s.turn_in_flight);
}

#[tokio::test]
async fn a_workflows_rows_update_in_place_and_its_child_launches_fold_into_the_card() {
    let mut h = Harness::new();
    let mut saw_turn_task = false;
    for record in fixture("workflow_air.jsonl") {
        h.feed(&record).await;
        let s = h.state.read().await;
        if s.async_tasks
            .values()
            .any(|t| t.task_type == "turn" && t.state == "running")
        {
            saw_turn_task = true;
            // The woken run is drawn as a turn, not listed as background work.
            if let Some(background) = s.background_status(chrono::Utc::now()) {
                assert!(background.tasks.iter().all(|t| t.kind != "turn"));
            }
        }
    }
    assert!(
        saw_turn_task,
        "pi-acp published the woken run as an AIR task"
    );
    assert!(
        !h.events.iter().any(|e| matches!(e,
            AcpEvent::ToolCall { tool_call_id, .. } | AcpEvent::ToolCallUpdate { tool_call_id, .. }
                if tool_call_id.contains('/'))),
        "the workflow's child launches are its rows, not calls"
    );
    // Rows changed in place on the same card: pending, running, completed.
    let row_states: Vec<String> = h
        .events
        .iter()
        .filter_map(|e| match e {
            AcpEvent::ToolCard { tool_call_id, meta } if tool_call_id == WORKFLOW_LAUNCH => Some(
                meta["codeg.subagentRun"]["children"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        format!(
                            "{}:{}",
                            r["key"].as_str().unwrap(),
                            r["status"].as_str().unwrap_or("?")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            _ => None,
        })
        .collect();
    assert!(
        row_states.iter().any(|r| r.contains("task-1:running")),
        "{row_states:?}"
    );
    assert_eq!(
        row_states.last().map(String::as_str),
        Some("task-1:completed,task-2:completed")
    );
    let run = &h.last_card(WORKFLOW_LAUNCH).unwrap()["codeg.subagentRun"];
    assert_eq!(run["status"], "completed");
    assert_eq!(run["agent"], "scout", "the agent both lanes share");
    let task = h.state.read().await.async_tasks["5f686226-fbe1-44ed-8980-b859a172d226"].clone();
    assert_eq!(task.task_type, "workflow");
    assert_eq!(task.state, "completed");
}

#[tokio::test]
async fn compaction_draws_the_shared_card_without_blanking_the_reply() {
    let mut h = Harness::new();
    h.state.write().await.talk_rules_key = Some("rules".into());
    for record in fixture("compaction.jsonl") {
        h.feed(&record).await;
    }
    let cards: Vec<(&str, &str)> = h
        .events
        .iter()
        .filter_map(|e| match e {
            AcpEvent::ToolCall {
                tool_call_id,
                status,
                meta: Some(meta),
                ..
            } if meta.get("contextCompaction").is_some() => {
                Some((tool_call_id.as_str(), status.as_str()))
            }
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                status: Some(status),
                meta: Some(meta),
                ..
            } if meta.get("contextCompaction").is_some() => {
                Some((tool_call_id.as_str(), status.as_str()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        cards.len(),
        4,
        "two compactions, each opened and settled: {cards:?}"
    );
    assert_eq!(cards[0].1, "in_progress");
    assert_eq!(cards[1].1, "completed");
    let settled = h
        .events
        .iter()
        .find_map(|e| match e {
            AcpEvent::ToolCallUpdate {
                status: Some(s),
                meta: Some(meta),
                ..
            } if s == "completed" => meta.get("contextCompaction").cloned(),
            _ => None,
        })
        .unwrap();
    assert_eq!(settled["trigger"], "automatic");
    assert_eq!(settled["preTokens"], 10047);
    let s = h.state.read().await;
    assert_eq!(
        s.talk_rules_key, None,
        "the summarized context lost the talk rules"
    );
    assert_eq!(
        s.last_assistant_text.as_deref(),
        Some("DONE"),
        "the compaction after the reply is not the turn's last work"
    );
}

#[tokio::test]
async fn an_extension_commands_reply_ends_its_turn_as_prose() {
    let h = Harness::run("jobs_command.jsonl").await;
    let reply: String = h
        .events
        .iter()
        .filter_map(|e| match e {
            AcpEvent::ContentDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(reply.contains("[jb-"), "{reply}");
    assert_eq!(h.turn_completes(), ["end_turn"]);
}

/// The live card a run ends with and the card the history pass folds from the
/// same session agree on everything both can know.
#[tokio::test]
async fn live_and_history_draw_the_same_cards() {
    // An async single run, woken on completion.
    let live = Harness::run("async_run.jsonl").await;
    let detail = history("01a1d126-9ac9-7728-9fa5-401873fae038");
    let history_card = history_meta(&detail, ASYNC_LAUNCH);
    let live_card = live.last_card(ASYNC_LAUNCH).unwrap();
    assert_eq!(run_digest(live_card), run_digest(&history_card));
    assert_eq!(
        live_card["codeg.subagentRun"]["result"],
        history_card["codeg.subagentRun"]["result"]
    );
    assert_eq!(live_wake_kinds(&live.events), history_wake_kinds(&detail));

    // A two-lane workflow.
    let live = Harness::run("workflow_air.jsonl").await;
    let detail = history("01a1d12b-1b05-769f-b592-48fbdf920a53");
    let history_card = history_meta(&detail, WORKFLOW_LAUNCH);
    assert_eq!(
        run_digest(live.last_card(WORKFLOW_LAUNCH).unwrap()),
        run_digest(&history_card)
    );
    assert_eq!(live_wake_kinds(&live.events), history_wake_kinds(&detail));

    // A background job, woken by its exit.
    let live = Harness::run("job.jsonl").await;
    let detail = history("01a1d126-d580-70f4-bfff-dcf3ac55f192");
    let history_job = &history_meta(&detail, JOB_LAUNCH)["codeg.backgroundJob"];
    let live_job = &live.last_card(JOB_LAUNCH).unwrap()["codeg.backgroundJob"];
    for key in ["id", "state", "exitCode", "duration", "tail", "logFile"] {
        assert_eq!(live_job[key], history_job[key], "{key}");
    }
    assert_eq!(live_wake_kinds(&live.events), history_wake_kinds(&detail));
}

#[test]
fn the_detail_names_a_woken_runs_divider_as_its_in_flight_turn() {
    use crate::commands::conversations::pi_agent_turn_anchor;
    let detail = history("01a1d126-9ac9-7728-9fa5-401873fae038");
    let wake = detail
        .turns
        .iter()
        .find(|t| matches!(t.role, TurnRole::System))
        .expect("the history's divider");
    // The run began as the notice that woke it was written.
    let since = wake.timestamp;
    assert_eq!(pi_agent_turn_anchor(&detail.turns, since), wake.id);
    // A divider from long before belongs to an earlier run.
    let later = since + chrono::Duration::minutes(5);
    assert_eq!(
        pi_agent_turn_anchor(&detail.turns, later),
        format!("pi-agent-turn-{}", later.timestamp_millis())
    );
}
