//! A sub-agent's thread: found from its Agent call (by the card's id or the
//! meta file), parsed into the same detail a session is, and read again
//! incrementally while it grows.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::json;

use super::{call_state, locate_in, still_running, CallState, SubagentMeta};
use crate::models::{ContentBlock, ConversationDetail, MessageTurn, TurnRole};
use crate::parsers::claude::transcript_cache::{refresh, Policy, Route};
use crate::parsers::claude::ClaudeParser;
use crate::parsers::detail_cache::{CachedValue, Limits};
use crate::parsers::{sanitize_detail, AgentParser};

const SESSION: &str = "5f0c2b1e-0000-4000-8000-00000000a6e1";
const AGENT: &str = "a1b2c3d4e5f60718";
const CALL: &str = "toolu_01AgentCall";

/// `<tmp>/projects/<project>/<SESSION>.jsonl` and its `subagents/` directory.
struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(root.path().join("projects/-tmp-proj")).unwrap();
        Self { root }
    }

    fn projects(&self) -> PathBuf {
        self.root.path().join("projects")
    }

    fn session_path(&self) -> PathBuf {
        self.projects().join(format!("-tmp-proj/{SESSION}.jsonl"))
    }

    fn subagents(&self) -> PathBuf {
        self.projects()
            .join(format!("-tmp-proj/{SESSION}/subagents"))
    }

    fn thread_path(&self, agent: &str) -> PathBuf {
        self.subagents().join(format!("agent-{agent}.jsonl"))
    }

    fn parser(&self) -> ClaudeParser {
        ClaudeParser::with_base_dir(self.projects())
    }

    fn write(&self, path: &Path, lines: &[serde_json::Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn append(&self, path: &Path, lines: &[serde_json::Value]) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn write_meta(&self, agent: &str, meta: serde_json::Value) {
        fs::create_dir_all(self.subagents()).unwrap();
        fs::write(
            self.subagents().join(format!("agent-{agent}.meta.json")),
            meta.to_string(),
        )
        .unwrap();
    }
}

fn at(second: u32) -> String {
    format!("2026-11-18T10:00:{second:02}.000Z")
}

fn user_text(uuid: &str, second: u32, text: &str) -> serde_json::Value {
    json!({
        "type": "user", "uuid": uuid, "timestamp": at(second), "sessionId": SESSION,
        "cwd": "/tmp/proj",
        "message": {"role": "user", "content": text}
    })
}

fn assistant(uuid: &str, second: u32, id: &str, block: serde_json::Value) -> serde_json::Value {
    json!({
        "type": "assistant", "uuid": uuid, "timestamp": at(second), "sessionId": SESSION,
        "cwd": "/tmp/proj",
        "message": {"id": id, "role": "assistant", "model": "claude-test", "content": [block],
            "usage": {"input_tokens": 10, "output_tokens": 5,
                "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
    })
}

fn tool_result(uuid: &str, second: u32, tool_use_id: &str, text: &str) -> serde_json::Value {
    json!({
        "type": "user", "uuid": uuid, "timestamp": at(second), "sessionId": SESSION,
        "cwd": "/tmp/proj",
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_use_id, "content": text}
        ]}
    })
}

/// The session: a prompt and the Agent call, and — when `settled` — the
/// call's report naming the sub-agent.
fn session_lines(settled: bool) -> Vec<serde_json::Value> {
    let mut lines = vec![
        user_text("p1", 0, "Find the bug"),
        assistant(
            "p2",
            1,
            "msg_p1",
            json!({"type": "tool_use", "id": CALL, "name": "Agent", "input": {
                "description": "Find the bug", "prompt": "Look in src/", "subagent_type": "Explore"
            }}),
        ),
    ];
    if settled {
        let mut result = tool_result(
            "p3",
            30,
            CALL,
            &format!("It is in main.rs.\nagentId: {AGENT}"),
        );
        result["toolUseResult"] = json!({
            "status": "completed", "agentType": "Explore", "agentId": AGENT,
            "totalDurationMs": 29000
        });
        lines.push(result);
    }
    lines
}

/// The sub-agent's own thread: its prompt, a thought, a command and its
/// output, and its answer.
fn thread_lines() -> Vec<serde_json::Value> {
    vec![
        user_text("s1", 2, "Look in src/"),
        assistant(
            "s2",
            3,
            "msg_s1",
            json!({"type": "thinking", "thinking": "Start with the entry point", "signature": "x"}),
        ),
        assistant(
            "s3",
            4,
            "msg_s1",
            json!({"type": "tool_use", "id": "toolu_s1", "name": "Bash", "input": {"command": "ls src"}}),
        ),
        tool_result("s4", 5, "toolu_s1", "main.rs\nlib.rs"),
        assistant(
            "s5",
            6,
            "msg_s2",
            json!({"type": "text", "text": "It is in main.rs."}),
        ),
    ]
}

/// A fresh parse of `path`, the way the transcript cache serves it.
fn fresh(fx: &Fixture, path: &Path, id: &str) -> ConversationDetail {
    let mut detail = fx
        .parser()
        .parse_conversation_detail(&path.to_path_buf(), id)
        .expect("fresh parse");
    sanitize_detail(&mut detail);
    detail
}

fn texts(turn: &MessageTurn) -> Vec<String> {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn tool_names(detail: &ConversationDetail) -> Vec<String> {
    detail
        .turns
        .iter()
        .flat_map(|turn| &turn.blocks)
        .filter_map(|block| match block {
            ContentBlock::ToolUse { tool_name, .. } => Some(tool_name.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_sub_agents_file_parses_into_the_detail_a_session_has() {
    let fx = Fixture::new();
    fx.write(&fx.session_path(), &session_lines(true));
    fx.write(&fx.thread_path(AGENT), &thread_lines());

    let thread = fx
        .parser()
        .subagent_thread(SESSION, CALL, Some(AGENT))
        .expect("read")
        .expect("found");

    assert_eq!(thread.agent_id, AGENT);
    let detail = &thread.detail;
    assert!(matches!(
        detail.turns.first().map(|t| &t.role),
        Some(TurnRole::User)
    ));
    assert_eq!(texts(&detail.turns[0]), vec!["Look in src/".to_string()]);
    let blocks: Vec<&ContentBlock> = detail.turns.iter().flat_map(|t| &t.blocks).collect();
    assert!(
        blocks.iter().any(
            |b| matches!(b, ContentBlock::Thinking { text } if text == "Start with the entry point")
        ),
        "the thinking is kept"
    );
    assert!(
        blocks.iter().any(|b| matches!(
            b,
            ContentBlock::ToolResult { tool_use_id: Some(id), output_preview: Some(out), .. }
                if id == "toolu_s1" && out.contains("main.rs")
        )),
        "the command's output is paired with it"
    );
    assert_eq!(tool_names(detail), vec!["Bash".to_string()]);
    assert!(detail
        .turns
        .iter()
        .any(|t| texts(t).contains(&"It is in main.rs.".to_string())));
    // The same parse a session gets, byte for byte.
    let direct = fresh(&fx, &fx.thread_path(AGENT), AGENT);
    assert_eq!(
        serde_json::to_value(&direct.turns).unwrap(),
        serde_json::to_value(&detail.turns).unwrap()
    );
}

#[test]
fn the_session_card_names_the_sub_agent_only_while_its_file_is_there() {
    let fx = Fixture::new();
    fx.write(&fx.session_path(), &session_lines(true));
    let subagent_id = |parser: &ClaudeParser| {
        let detail = parser.get_conversation(SESSION).expect("session");
        detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    agent_stats: Some(stats),
                    ..
                } if id == CALL => Some(stats.subagent_id.clone()),
                _ => None,
            })
            .expect("the Agent call's result")
    };
    assert_eq!(subagent_id(&fx.parser()), None, "no file, no link");

    fx.write(&fx.thread_path(AGENT), &thread_lines());
    assert_eq!(subagent_id(&fx.parser()), Some(AGENT.to_string()));
}

#[test]
fn a_running_call_finds_its_file_through_the_meta_file() {
    let fx = Fixture::new();
    fx.write(&fx.session_path(), &session_lines(false));
    fx.write_meta(
        "aother000000000",
        json!({"agentType": "Plan", "description": "Other", "toolUseId": "toolu_other"}),
    );
    fx.write(&fx.thread_path("aother000000000"), &thread_lines());

    // Launched, but nothing written yet.
    assert_eq!(
        fx.parser()
            .subagent_thread(SESSION, CALL, None)
            .unwrap()
            .map(|t| t.agent_id),
        None
    );
    fx.write_meta(
        AGENT,
        json!({"agentType": "Explore", "description": "Find the bug", "toolUseId": CALL}),
    );
    assert!(
        locate_in(&fx.subagents(), CALL, None).is_none(),
        "a meta file without its transcript is not a thread yet"
    );

    fx.write(&fx.thread_path(AGENT), &thread_lines());
    let thread = fx
        .parser()
        .subagent_thread(SESSION, CALL, None)
        .unwrap()
        .expect("found by the call");
    assert_eq!(thread.agent_id, AGENT);
    let meta = thread.meta.expect("meta");
    assert_eq!(meta.agent_type.as_deref(), Some("Explore"));
    assert_eq!(meta.description.as_deref(), Some("Find the bug"));
    // Unanswered, and written just now: still at work.
    assert!(thread.running);
}

#[test]
fn an_unsafe_agent_id_never_reaches_the_file_system() {
    let fx = Fixture::new();
    fx.write(&fx.thread_path(AGENT), &thread_lines());
    assert!(locate_in(&fx.subagents(), "", Some("../agent-x")).is_none());
    assert!(locate_in(&fx.subagents(), "", Some("a/b")).is_none());
    assert_eq!(
        locate_in(&fx.subagents(), "", Some(AGENT)).map(|f| f.agent_id),
        Some(AGENT.to_string())
    );
}

#[test]
fn a_growing_thread_is_read_from_where_the_last_read_stopped() {
    let fx = Fixture::new();
    let path = fx.thread_path(AGENT);
    let lines = thread_lines();
    fx.write(&path, &lines[..3]);

    let policy = Policy {
        limits: Limits {
            entry_cap: 64 << 20,
            pair_cap: 64 << 20,
        },
        tail_min_turns: 400,
        tail_max_turns: 1000,
    };
    fn everything(_: &[MessageTurn]) -> usize {
        0
    }
    let mut slot: Option<CachedValue> = None;
    let read = |slot: &mut Option<CachedValue>| {
        refresh(slot, &path, AGENT, &everything, SystemTime::now(), policy).expect("refresh")
    };
    let first = read(&mut slot);
    assert_eq!(first.route, Route::Full);
    assert!(!tool_names(&first.detail).is_empty());

    fx.append(&path, &lines[3..]);
    let grown = read(&mut slot);
    assert_eq!(grown.route, Route::Append, "only the new lines are parsed");
    assert!(grown
        .detail
        .turns
        .iter()
        .any(|t| texts(t).contains(&"It is in main.rs.".to_string())));
    let fresh = fresh(&fx, &path, AGENT);
    assert_eq!(
        serde_json::to_value(&fresh.turns).unwrap(),
        serde_json::to_value(&grown.detail.turns).unwrap(),
        "the incremental read is the fresh parse"
    );
    assert_eq!(read(&mut slot).route, Route::Hit, "unchanged: served as is");
}

#[test]
fn a_fork_thread_opens_at_its_directive() {
    let fx = Fixture::new();
    let path = fx.thread_path(AGENT);
    fx.write(
        &path,
        &[
            json!({"type": "fork-context-ref", "agentId": AGENT, "parentSessionId": SESSION}),
            user_text("inherited-1", 0, "The parent's own prompt"),
            assistant(
                "inherited-2",
                1,
                "msg_parent",
                json!({"type": "tool_use", "id": "toolu_fork", "name": "Agent", "input": {"subagent_type": "fork"}}),
            ),
            json!({
                "type": "user", "uuid": "directive", "timestamp": at(2), "isSidechain": true,
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_fork",
                     "content": "Fork started — processing in background"},
                    {"type": "text", "text": "<fork-boilerplate>\nYou are a worker fork.\n</fork-boilerplate>\n\nYour directive: check the tests"}
                ]}
            }),
            assistant(
                "own-1",
                3,
                "msg_own",
                json!({"type": "text", "text": "Tests pass."}),
            ),
        ],
    );
    let detail = fresh(&fx, &path, AGENT);
    let all: Vec<String> = detail.turns.iter().flat_map(texts).collect();
    assert_eq!(
        all,
        vec!["check the tests".to_string(), "Tests pass.".to_string()]
    );
    assert!(tool_names(&detail).is_empty(), "the inherited call is gone");
}

#[test]
fn a_nested_agent_card_reads_its_sibling_file() {
    let fx = Fixture::new();
    let nested = "a9999999999999999";
    let mut outer = thread_lines();
    outer.push(assistant(
        "s6",
        7,
        "msg_s3",
        json!({"type": "tool_use", "id": "toolu_nested", "name": "Agent", "input": {"subagent_type": "Explore"}}),
    ));
    let mut result = tool_result("s7", 9, "toolu_nested", "done");
    result["toolUseResult"] =
        json!({"status": "completed", "agentType": "Explore", "agentId": nested});
    outer.push(result);
    fx.write(&fx.thread_path(AGENT), &outer);
    fx.write(&fx.thread_path(nested), &thread_lines());

    let detail = fresh(&fx, &fx.thread_path(AGENT), AGENT);
    let stats = detail
        .turns
        .iter()
        .flat_map(|t| &t.blocks)
        .find_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                agent_stats: Some(stats),
                ..
            } if id == "toolu_nested" => Some(stats.clone()),
            _ => None,
        })
        .expect("nested card");
    assert_eq!(stats.subagent_id.as_deref(), Some(nested));
    assert_eq!(stats.tool_calls.len(), 1, "its steps come from the sibling");
}

fn turn_with(blocks: Vec<ContentBlock>) -> MessageTurn {
    MessageTurn {
        id: "t".into(),
        role: TurnRole::Assistant,
        blocks,
        timestamp: chrono::Utc::now(),
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: None,
        agent_message_id: None,
        spoken: false,
    }
}

fn call_block() -> ContentBlock {
    ContentBlock::ToolUse {
        tool_use_id: Some(CALL.into()),
        tool_name: "Agent".into(),
        input_preview: None,
        status: None,
        meta: None,
    }
}

fn result_block(output: &str) -> ContentBlock {
    ContentBlock::ToolResult {
        tool_use_id: Some(CALL.into()),
        output_preview: Some(output.into()),
        is_error: false,
        agent_stats: None,
        images: Vec::new(),
        exit_code: None,
    }
}

#[test]
fn the_call_state_reads_the_result_and_the_background_marker() {
    assert_eq!(call_state(&[], CALL), CallState::Unknown);
    assert_eq!(
        call_state(&[turn_with(vec![call_block()])], CALL),
        CallState::Unsettled
    );
    assert_eq!(
        call_state(&[turn_with(vec![call_block(), result_block("done")])], CALL),
        CallState::Settled
    );
    let marker = |status: serde_json::Value| {
        format!(
            "{}{}",
            super::BACKGROUND_TASK_MARKER,
            json!({"task_id": AGENT, "status": status, "summary": null, "result": null})
        )
    };
    assert_eq!(
        call_state(
            &[
                turn_with(vec![call_block()]),
                turn_with(vec![result_block(&marker(json!(null)))])
            ],
            CALL
        ),
        CallState::Unsettled,
        "a background launch still out"
    );
    assert_eq!(
        call_state(
            &[turn_with(vec![
                call_block(),
                result_block(&marker(json!("completed")))
            ])],
            CALL
        ),
        CallState::Settled
    );
}

#[test]
fn running_follows_the_meta_flag_the_call_and_the_files() {
    let now = SystemTime::now();
    let ago = |secs: u64| Some(now - Duration::from_secs(secs));
    let finished = SubagentMeta {
        finished: Some(true),
        ..Default::default()
    };
    // Done, and quiet since.
    assert!(!still_running(
        Some(&finished),
        CallState::Unsettled,
        ago(60),
        ago(1),
        now
    ));
    // Done, and written to again: resumed.
    assert!(still_running(
        Some(&finished),
        CallState::Settled,
        ago(1),
        ago(1),
        now
    ));
    // Answered and quiet.
    assert!(!still_running(
        None,
        CallState::Settled,
        ago(120),
        ago(1),
        now
    ));
    // Unanswered: at work while either file moved lately…
    assert!(still_running(
        None,
        CallState::Unsettled,
        ago(600),
        ago(5),
        now
    ));
    // …and cut off once both have been quiet for long.
    assert!(!still_running(
        None,
        CallState::Unsettled,
        ago(3600),
        ago(3600),
        now
    ));
    // Not found in the session: only a growing file says it runs.
    assert!(still_running(None, CallState::Unknown, ago(2), None, now));
    assert!(!still_running(
        None,
        CallState::Unknown,
        ago(120),
        ago(1),
        now
    ));
}
