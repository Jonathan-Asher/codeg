//! The Codex parser against real rollouts written through codex-acp 2.6.0
//! (`@openai/codex` 0.166.0), sanitized: the scratch working directory is
//! `/work/demo`, account ids, instruction text and local configuration are
//! stripped, and long strings are cut.
//!
//! 0.166.0 rollouts carry records the 0.156 ones did not (`retained_context`
//! / `verified_answer`, `response_item.additional_tools`) and new
//! `session_meta` fields (`thread_source`, `parent_thread_id`,
//! `agent_nickname`), and drop `turn_context.current_date` / `timezone` /
//! `workspace_roots`. The sessions:
//!
//! * `01a1e0a3-02d0…` — code-mode `exec` calls that add and patch a file and
//!   run commands, a network command, a Plan-mode `request_user_input` answered
//!   with an option, and a `/goal` the model completes.
//! * `01a1e0a5-d66c…` — an edit approved in the `read-only` preset, then a
//!   sub-agent spawned and awaited (multi-agent v1, through code mode);
//!   `01a1e0a6-0cf3…` is that sub-agent's own rollout.
//! * `01a1e0a9-5beb…` — one `apply_patch` touching three files (two hunks in
//!   one, an add, a delete), then a one-line edit.
//!
//! Set `CODEG_FIXTURE_DUMP=1` to print each parsed detail.

use std::fs;
use std::path::{Path, PathBuf};

use codeg_lib::parsers::codex::CodexParser;
use codeg_lib::parsers::AgentParser;

const MAIN: &str = "01a1e0a3-02d0-7752-8b73-8894880ea5c3";
const PARENT: &str = "01a1e0a5-d66c-7161-a1df-98cedf30d702";
const CHILD: &str = "01a1e0a6-0cf3-7593-b332-8ce36121fd7e";
const PATCH: &str = "01a1e0a9-5beb-7fb3-a6c5-a5d4895e713a";

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex/acp-2.6.0")
}

/// Copy the fixtures into a codex `sessions` layout under a temp dir.
fn sessions() -> (tempfile::TempDir, CodexParser) {
    let temp = tempfile::tempdir().expect("tempdir");
    let day = temp.path().join("2026").join("11").join("15");
    fs::create_dir_all(&day).expect("day dir");
    for entry in fs::read_dir(fixture_dir()).expect("fixture dir") {
        let path = entry.expect("entry").path();
        fs::copy(&path, day.join(path.file_name().unwrap())).expect("copy fixture");
    }
    let parser = CodexParser::with_base_dir(temp.path().to_path_buf());
    (temp, parser)
}

fn detail_json(parser: &CodexParser, id: &str) -> serde_json::Value {
    let detail = parser
        .get_conversation(id)
        .unwrap_or_else(|e| panic!("{id} parses: {e:?}"));
    let value = serde_json::to_value(&detail).expect("detail serializes");
    if std::env::var_os("CODEG_FIXTURE_DUMP").is_some() {
        println!("===== {id}\n{}", serde_json::to_string_pretty(&value).unwrap());
    }
    value
}

/// Every string anywhere in `value`, for content checks that do not depend on
/// which block or field a fact lands in.
fn strings(value: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![value];
    while let Some(v) = stack.pop() {
        match v {
            serde_json::Value::String(s) => out.push(s.clone()),
            serde_json::Value::Array(items) => stack.extend(items),
            serde_json::Value::Object(map) => stack.extend(map.values()),
            _ => {}
        }
    }
    out
}

fn mentions(value: &serde_json::Value, needle: &str) -> bool {
    strings(value).iter().any(|s| s.contains(needle))
}

fn turns_of<'a>(value: &'a serde_json::Value, role: &str) -> Vec<&'a serde_json::Value> {
    value["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .filter(|t| t["role"] == role)
        .collect()
}

#[test]
fn codex_acp_2_6_rollouts_list_with_lineage() {
    let (_temp, parser) = sessions();
    let summaries = parser.list_conversations().expect("list");
    let by_id = |id: &str| summaries.iter().find(|s| s.id == id);

    for id in [MAIN, PARENT, PATCH] {
        let summary = by_id(id).unwrap_or_else(|| panic!("{id} listed"));
        assert_eq!(summary.folder_path.as_deref(), Some("/work/demo"), "{id}");
        assert!(summary.message_count > 0, "{id} has messages");
        assert!(summary.parent_id.is_none(), "{id} is a root session");
    }
    // The sub-agent's rollout names its parent through the flat
    // `parent_thread_id` 0.166.0 writes (and the nested `source` it keeps).
    if let Some(child) = by_id(CHILD) {
        assert_eq!(child.parent_id.as_deref(), Some(PARENT));
    }
    let main = by_id(MAIN).unwrap();
    assert!(
        main.title
            .as_deref()
            .is_some_and(|t| t.contains("hello.txt")),
        "titled from the first prompt: {:?}",
        main.title
    );
}

/// One line per turn — its role, then each block as `type:name|text` cut
/// short — for failure messages that show what the parser made of a rollout.
fn turn_summary(value: &serde_json::Value) -> String {
    let mut out = String::new();
    for turn in value["turns"].as_array().into_iter().flatten() {
        let blocks: Vec<String> = turn["blocks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|b| {
                let kind = b["type"].as_str().unwrap_or("?");
                let label = b["tool_name"]
                    .as_str()
                    .or_else(|| b["text"].as_str())
                    .unwrap_or("");
                let label: String = label.chars().take(48).collect();
                format!("{kind}:{label}")
            })
            .collect();
        out.push_str(&format!("{}: {}\n", turn["role"], blocks.join(" | ")));
    }
    out
}

/// The text a user turn opens with.
fn user_prompts(value: &serde_json::Value) -> Vec<String> {
    turns_of(value, "user")
        .iter()
        .map(|t| {
            t["blocks"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|b| b["text"].as_str())
                .unwrap_or("")
                .chars()
                .take(40)
                .collect()
        })
        .collect()
}

/// The same scenario recorded through codex-acp 1.13.1 (`@openai/codex`
/// 0.156.1), the parity baseline for the main rollout.
fn baseline_1_13_1() -> serde_json::Value {
    let temp = tempfile::tempdir().expect("tempdir");
    let day = temp.path().join("2026").join("11").join("15");
    fs::create_dir_all(&day).expect("day dir");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex/acp-1.13.1");
    for entry in fs::read_dir(src).expect("baseline dir") {
        let path = entry.expect("entry").path();
        fs::copy(&path, day.join(path.file_name().unwrap())).expect("copy baseline");
    }
    let parser = CodexParser::with_base_dir(temp.path().to_path_buf());
    detail_json(&parser, "01a1e0a3-0612-73f1-820d-561e0f15f29e")
}

#[test]
fn codex_acp_2_6_main_rollout_keeps_every_turn() {
    let (_temp, parser) = sessions();
    let detail = detail_json(&parser, MAIN);
    let summary = turn_summary(&detail);

    // The same prompts reach the transcript as from a 0.156.1 rollout of the
    // same scenario (edit, network command, plan question, goal).
    let baseline = baseline_1_13_1();
    assert_eq!(
        user_prompts(&detail),
        user_prompts(&baseline),
        "2.6.0:\n{summary}\n1.13.1:\n{}",
        turn_summary(&baseline)
    );
    assert!(mentions(&detail, "create hello.txt with three lines"), "{summary}");
    assert!(mentions(&detail, "curl -sI https://example.com"), "{summary}");
    assert!(
        mentions(&detail, "ask me exactly one multiple-choice question"),
        "{summary}"
    );

    // The code-mode tool calls reach the transcript with their effects.
    assert!(mentions(&detail, "BETA"), "the patch\n{summary}");
    assert!(mentions(&detail, "./hello.txt:2:BETA"), "the command output\n{summary}");

    // The Plan-mode question and the option that answered it. 0.166.0 also
    // writes a `retained_context` record for the answer.
    assert!(
        mentions(&detail, "Which language should the tiny greeting script use?"),
        "{summary}"
    );
    assert!(mentions(&detail, "Python (Recommended)"), "{summary}");

    // The final answers.
    let assistant_text: Vec<String> = turns_of(&detail, "assistant")
        .iter()
        .flat_map(|t| strings(t))
        .collect();
    assert!(assistant_text.iter().any(|s| s == "done"), "{summary}");
    assert!(assistant_text.iter().any(|s| s.contains("Hi.")), "{summary}");

    // Nothing of the stripped tool catalog leaks in as a message.
    assert!(!mentions(&detail, "Run JavaScript code to orchestrate"));
}

#[test]
fn codex_acp_2_6_multi_file_patch_is_one_call_with_every_file() {
    let (_temp, parser) = sessions();
    let detail = detail_json(&parser, PATCH);
    for needle in ["LINE THREE", "LINE THIRTY", "new.txt", "gone.txt", "LINE TEN"] {
        assert!(mentions(&detail, needle), "{needle}");
    }
    assert_eq!(turns_of(&detail, "user").len(), 2);
}

#[test]
fn codex_acp_2_6_subagent_parent_and_child_parse() {
    let (_temp, parser) = sessions();
    let parent = detail_json(&parser, PARENT);
    assert!(mentions(&parent, "perm.txt"));
    assert!(mentions(&parent, "Run `echo from-sub` and report the output."));
    assert!(mentions(&parent, "from-sub"), "the wait result reaches the parent");

    let child = detail_json(&parser, CHILD);
    assert!(mentions(&child, "echo from-sub"));
    let child_assistant: Vec<String> = turns_of(&child, "assistant")
        .iter()
        .flat_map(|t| strings(t))
        .collect();
    assert!(child_assistant.iter().any(|s| s.contains("from-sub")));
}
