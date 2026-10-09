//! The cached and incremental parses must be indistinguishable from a fresh
//! one. Every test here builds a synthetic transcript (seeded, so a failure
//! reproduces), grows or rewrites it the way an agent would, and after each
//! step compares what the cache serves with what a fresh parse of the same
//! bytes produces — serialized, because that is what every client sees.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, TimeZone, Utc};
use serde_json::json;

use super::{refresh, CachedDetail, ClaudeCacheState};
use crate::acp::agent_mentions::append_agent_routes;
use crate::acp::types::PromptInputBlock;
use crate::parsers::claude::ClaudeParser;
use crate::parsers::{sanitize_detail, AgentParser};

const SESSION: &str = "cache-sess";

// ---------------------------------------------------------------------------
// A tiny deterministic generator (xorshift64*), so no test depends on `rand`'s
// algorithm staying the same across versions.

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

/// Synthesizes Claude Code session records, covering the shapes whose
/// handling reaches backwards (usage demotion within one API response,
/// background-task acks rewritten by a later notification, `/compact` prompts
/// inserted at an earlier divider, goal cards held until the next reply,
/// buffered slash commands) as well as the plain ones.
struct Gen {
    rng: Rng,
    clock: DateTime<Utc>,
    counter: usize,
    cwd: String,
    /// Background launches whose notification has not been written yet.
    open_tasks: Vec<String>,
    /// Sub-agent ids a sync Agent result referenced (files to write).
    pub subagents: Vec<String>,
}

impl Gen {
    fn new(seed: u64) -> Self {
        Self {
            rng: Rng::new(seed),
            clock: Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap(),
            counter: 0,
            cwd: "/Users/test/proj".to_string(),
            open_tasks: Vec::new(),
            subagents: Vec::new(),
        }
    }

    fn ts(&mut self) -> String {
        self.clock += chrono::Duration::milliseconds(200 + self.rng.below(20_000) as i64);
        self.clock
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{:05}", self.counter)
    }

    fn user_text(&mut self) -> String {
        let words = [
            "fix the build",
            "שלום, תבדוק את הקובץ",
            "why does this fail? 🤔",
            "add a test for the parser",
            "continue",
            "run the benchmarks",
        ];
        let mut text = self.rng.pick(&words).to_string();
        if self.rng.chance(20) {
            text.push_str(&"\nmore detail ".repeat(1 + self.rng.below(40) as usize));
        }
        text
    }

    fn prompt(&mut self) -> String {
        let ts = self.ts();
        let uuid = self.id("u");
        let mut content = vec![json!({"type": "text", "text": self.user_text()})];
        if self.rng.chance(10) {
            content.push(json!({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}
            }));
        }
        if self.rng.chance(10) {
            // The internal `@agent` routing frame, as codeg appends it.
            let mut blocks = vec![PromptInputBlock::Text {
                text: "ask [@A](codeg://agent/codex) to help".into(),
            }];
            append_agent_routes(&mut blocks, true);
            if let Some(PromptInputBlock::Text { text }) = blocks.get(1) {
                content.push(json!({"type": "text", "text": text}));
            }
        }
        json!({
            "type": "user", "timestamp": ts, "uuid": uuid, "cwd": self.cwd,
            "sessionId": SESSION, "gitBranch": "main", "promptId": format!("p{uuid}"),
            "message": {"role": "user", "content": content}
        })
        .to_string()
    }

    fn usage(&mut self) -> serde_json::Value {
        json!({
            "input_tokens": self.rng.below(5000),
            "output_tokens": self.rng.below(2000),
            "cache_creation_input_tokens": self.rng.below(10_000),
            "cache_read_input_tokens": self.rng.below(100_000),
        })
    }

    fn assistant_line(
        &mut self,
        message_id: &str,
        block: serde_json::Value,
        usage: &serde_json::Value,
    ) -> String {
        let ts = self.ts();
        let uuid = self.id("a");
        json!({
            "type": "assistant", "timestamp": ts, "uuid": uuid, "cwd": self.cwd,
            "message": {
                "id": message_id, "role": "assistant", "model": "claude-opus-4-5",
                "content": [block], "usage": usage
            }
        })
        .to_string()
    }

    fn tool_result(
        &mut self,
        tool_use_id: &str,
        text: &str,
        extra: Option<serde_json::Value>,
    ) -> String {
        let ts = self.ts();
        let uuid = self.id("r");
        let mut record = json!({
            "type": "user", "timestamp": ts, "uuid": uuid,
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tool_use_id, "content": text}
            ]}
        });
        if let Some(extra) = extra {
            record["toolUseResult"] = extra;
        }
        record.to_string()
    }

    /// One API response: thinking fragments, text, tool calls (one line per
    /// block, all repeating the call's usage), then the tool results.
    fn response(&mut self, out: &mut Vec<String>) {
        let message_id = self.id("msg_");
        let usage = self.usage();
        let zero = json!({"input_tokens": 0, "output_tokens": 0});
        for _ in 0..self.rng.below(3) {
            let block = json!({"type": "thinking", "thinking": "considering… ", "signature": "s"});
            out.push(self.assistant_line(&message_id, block, &usage));
        }
        if self.rng.chance(80) {
            let block =
                json!({"type": "text", "text": format!("Working on it ({}).", self.counter)});
            let u = if self.rng.chance(15) {
                zero.clone()
            } else {
                usage.clone()
            };
            out.push(self.assistant_line(&message_id, block, &u));
        }
        let mut results = Vec::new();
        for _ in 0..self.rng.below(3) {
            let tool_id = self.id("toolu_");
            match self.rng.below(5) {
                0 => {
                    let block = json!({"type": "tool_use", "id": tool_id, "name": "Read",
                        "input": {"file_path": "/Users/test/proj/src/lib.rs"}});
                    out.push(self.assistant_line(&message_id, block, &usage));
                    results.push(self.tool_result(
                        &tool_id,
                        "     1→fn main() {\n     2→}\n",
                        None,
                    ));
                }
                1 => {
                    let block = json!({"type": "tool_use", "id": tool_id, "name": "Edit",
                        "input": {"file_path": "/Users/test/proj/src/lib.rs", "old_string": "a", "new_string": "b"}});
                    out.push(self.assistant_line(&message_id, block, &usage));
                    let patch = json!({"filePath": "/Users/test/proj/src/lib.rs", "structuredPatch": [
                        {"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"]}
                    ]});
                    results.push(self.tool_result(&tool_id, "The file was updated.", Some(patch)));
                }
                2 => {
                    // Background agent: the ack now, the notification later.
                    let block = json!({"type": "tool_use", "id": tool_id, "name": "Agent",
                        "input": {"description": "run the build", "run_in_background": true}});
                    out.push(self.assistant_line(&message_id, block, &usage));
                    let task = self.id("task");
                    let ack = json!({"isAsync": true, "status": "async_launched", "agentId": task,
                        "description": "run the build"});
                    results.push(self.tool_result(
                        &tool_id,
                        &format!("Async agent launched successfully. agentId: {task}"),
                        Some(ack),
                    ));
                    self.open_tasks.push(task);
                }
                3 => {
                    // A finished sub-agent whose own transcript feeds the card.
                    let block = json!({"type": "tool_use", "id": tool_id, "name": "Task",
                        "input": {"description": "look around"}});
                    out.push(self.assistant_line(&message_id, block, &usage));
                    let agent = self.id("sub");
                    self.subagents.push(agent.clone());
                    let stats = json!({"agentType": "general-purpose", "agentId": agent,
                        "status": "completed", "totalTokens": 1200, "totalDurationMs": 5000,
                        "totalToolUseCount": 2});
                    results.push(self.tool_result(
                        &tool_id,
                        "Found three call sites.",
                        Some(stats),
                    ));
                }
                _ => {
                    let block = json!({"type": "tool_use", "id": tool_id, "name": "Bash",
                        "input": {"command": "cargo check"}});
                    out.push(self.assistant_line(&message_id, block, &usage));
                    let is_error = self.rng.chance(20);
                    let ts = self.ts();
                    let uuid = self.id("r");
                    results.push(
                        json!({"type": "user", "timestamp": ts, "uuid": uuid,
                        "message": {"role": "user", "content": [
                            {"type": "tool_result", "tool_use_id": tool_id,
                             "content": [{"type": "text", "text": "ok"}], "is_error": is_error}
                        ]}})
                        .to_string(),
                    );
                }
            }
        }
        out.extend(results);
    }

    fn records(&mut self, rounds: usize) -> Vec<String> {
        let mut out = Vec::new();
        // Every session opens with a timestamped prompt: a detail with no
        // timestamped record at all is stamped with the parse instant, which
        // no two parses share.
        out.push(self.prompt());
        for _ in 0..rounds {
            match self.rng.below(14) {
                0 => {
                    // A client slash command, refuted by the next prompt.
                    let ts = self.ts();
                    let uuid = self.id("c");
                    out.push(json!({"type": "user", "timestamp": ts, "uuid": uuid, "promptId": "pc",
                        "message": {"role": "user", "content":
                            "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"}})
                        .to_string());
                }
                1 => {
                    let ts = self.ts();
                    let id = self.id("cb");
                    out.push(json!({"type": "system", "subtype": "compact_boundary", "timestamp": ts,
                        "uuid": id, "compactMetadata": {"trigger": "manual", "preTokens": 190_000, "postTokens": 9000}})
                        .to_string());
                    let ts = self.ts();
                    let id = self.id("cs");
                    out.push(json!({"type": "user", "timestamp": ts, "uuid": id, "isCompactSummary": true,
                        "message": {"role": "user", "content": "This session is being continued from a previous conversation…"}})
                        .to_string());
                    let ts = self.ts();
                    let id = self.id("cc");
                    out.push(json!({"type": "user", "timestamp": ts, "uuid": id, "promptId": "p9",
                        "message": {"role": "user", "content":
                            "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"}})
                        .to_string());
                }
                2 => {
                    let title = self.user_text();
                    if self.rng.chance(50) {
                        out.push(
                            json!({"type": "ai-title", "aiTitle": title, "sessionId": SESSION})
                                .to_string(),
                        );
                    } else {
                        out.push(json!({"type": "custom-title", "customTitle": title, "sessionId": SESSION}).to_string());
                    }
                }
                3 => {
                    let ts = self.ts();
                    let id = self.id("g");
                    let attachment = if self.rng.chance(50) {
                        json!({"type": "goal_status", "met": false, "sentinel": true, "condition": "ship it"})
                    } else {
                        json!({"type": "goal_status", "met": true, "condition": "ship it", "reason": "done",
                            "iterations": 2, "durationMs": 4000, "tokens": 900})
                    };
                    out.push(json!({"type": "attachment", "timestamp": ts, "uuid": id, "attachment": attachment}).to_string());
                }
                4 if !self.open_tasks.is_empty() => {
                    let task = self.open_tasks.remove(0);
                    let ts = self.ts();
                    let uuid = self.id("n");
                    out.push(json!({"type": "user", "timestamp": ts, "uuid": uuid,
                        "message": {"role": "user", "content": format!(
                            "<task-notification>\n<task-id>{task}</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>Build OK</result>\n</task-notification>")}})
                        .to_string());
                }
                5 => {
                    let ts = self.ts();
                    let uuid = self.id("h");
                    out.push(json!({"type": "user", "timestamp": ts, "uuid": uuid, "isMeta": true,
                        "message": {"role": "user", "content": "Stop hook feedback:\nthe tests still fail"}})
                        .to_string());
                    self.response(&mut out);
                }
                6 => {
                    let ts = self.ts();
                    let uuid = self.id("i");
                    out.push(json!({"type": "user", "timestamp": ts, "uuid": uuid,
                        "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}})
                        .to_string());
                }
                7 => {
                    let ts = self.ts();
                    out.push(
                        json!({"type": "system", "subtype": "turn_duration", "timestamp": ts,
                        "durationMs": 1000 + self.rng.below(100_000)})
                        .to_string(),
                    );
                }
                8 => {
                    out.push(
                        json!({"type": "file-history-snapshot", "snapshot": {"files": {}}})
                            .to_string(),
                    );
                    out.push(json!({"type": "progress", "data": {"step": 1}}).to_string());
                }
                9 if self.rng.chance(30) => {
                    // Junk an agent can leave behind: a blank line, a line that
                    // is not JSON.
                    out.push(String::new());
                    out.push("{\"type\": \"user\", \"broken".to_string());
                }
                _ => {
                    out.push(self.prompt());
                    for _ in 0..1 + self.rng.below(3) {
                        self.response(&mut out);
                    }
                }
            }
        }
        out
    }
}

/// A sub-agent transcript: one call, one result, some spend.
fn subagent_transcript(seed: u64, calls: usize) -> String {
    let mut lines = Vec::new();
    for i in 0..calls {
        lines.push(
            json!({"type": "assistant", "timestamp": format!("2026-09-01T08:{:02}:{:02}.000Z", (seed % 50) + 1, i % 60),
                "uuid": format!("sa{seed}-{i}"),
                "message": {"id": format!("msg_sub{seed}_{i}"), "role": "assistant",
                    "content": [{"type": "tool_use", "id": format!("st{seed}-{i}"), "name": "Grep", "input": {"pattern": "x"}}],
                    "usage": {"input_tokens": 10 + i as u64, "output_tokens": 5, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 100}}})
            .to_string(),
        );
        lines.push(
            json!({"type": "user", "timestamp": format!("2026-09-01T08:{:02}:{:02}.500Z", (seed % 50) + 1, i % 60),
                "uuid": format!("sr{seed}-{i}"),
                "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("st{seed}-{i}"), "content": "3 matches"}]}})
            .to_string(),
        );
    }
    lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Harness

struct Session {
    _dir: tempfile::TempDir,
    base: PathBuf,
    path: PathBuf,
    slot: Option<CachedDetail>,
    now: SystemTime,
}

impl Session {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let proj = base.join("-Users-test-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join(format!("{SESSION}.jsonl"));
        Self {
            _dir: dir,
            base,
            path,
            slot: None,
            now: SystemTime::now(),
        }
    }

    fn subagent_dir(&self) -> PathBuf {
        self.path.with_extension("").join("subagents")
    }

    fn write(&self, bytes: &[u8]) {
        std::fs::write(&self.path, bytes).unwrap();
        self.bump_mtime();
    }

    fn append(&self, bytes: &[u8]) {
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .unwrap();
        f.write_all(bytes).unwrap();
        drop(f);
        self.bump_mtime();
    }

    /// Filesystems with a coarse mtime would otherwise let two writes in one
    /// tick look identical; every write here moves the mtime forward a second.
    fn bump_mtime(&self) {
        bump(&self.path);
    }

    fn fresh(&self) -> serde_json::Value {
        let mut detail = ClaudeParser::with_base_dir(self.base.clone())
            .get_conversation(SESSION)
            .expect("fresh parse");
        sanitize_detail(&mut detail);
        serde_json::to_value(&detail).unwrap()
    }

    fn cached(&mut self) -> serde_json::Value {
        let detail = refresh(&mut self.slot, &self.path, SESSION, self.now).expect("cached parse");
        serde_json::to_value(&*detail).unwrap()
    }

    fn state(&self) -> &ClaudeCacheState {
        self.slot
            .as_ref()
            .and_then(|c| c.state.downcast_ref::<ClaudeCacheState>())
            .expect("cached state")
    }

    /// The cached parse equals a fresh one; returns which way it was served
    /// (`hit` / `reattribute` / `append` / `full`).
    fn check(&mut self, what: &str) -> &'static str {
        let cached = self.cached();
        let route = super::last_route();
        let fresh = self.fresh();
        if cached != fresh {
            let c = serde_json::to_string_pretty(&cached).unwrap();
            let f = serde_json::to_string_pretty(&fresh).unwrap();
            let line = c
                .lines()
                .zip(f.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(0);
            panic!(
                "{what}: cached detail differs from a fresh parse near line {line}:\n  cached: {}\n  fresh:  {}",
                c.lines().nth(line).unwrap_or(""),
                f.lines().nth(line).unwrap_or("")
            );
        }
        route
    }
}

fn bump(path: &Path) {
    let meta = std::fs::metadata(path).unwrap();
    let next = meta.modified().unwrap() + Duration::from_secs(1);
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(next.max(SystemTime::now())).unwrap();
}

fn joined(lines: &[String]) -> Vec<u8> {
    (lines.join("\n") + "\n").into_bytes()
}

/// Byte offsets to grow the file through, anywhere after the first record:
/// line boundaries and points inside lines (including inside multi-byte
/// characters).
fn cut_points(rng: &mut Rng, bytes: &[u8], steps: usize) -> Vec<usize> {
    let len = bytes.len();
    let first = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    let mut cuts: Vec<usize> = (0..steps)
        .map(|_| first + rng.below((len - first) as u64) as usize)
        .collect();
    cuts.push(len);
    cuts.sort_unstable();
    cuts.dedup();
    cuts
}

fn write_subagents(session: &Session, ids: &[String], seed: u64) {
    let dir = session.subagent_dir();
    std::fs::create_dir_all(&dir).unwrap();
    for (i, id) in ids.iter().enumerate() {
        // Some referenced sub-agents never got a transcript.
        if (seed + i as u64) % 4 == 3 {
            continue;
        }
        let p = dir.join(format!("agent-{id}.jsonl"));
        std::fs::write(&p, subagent_transcript(seed + i as u64, 1 + i % 3)).unwrap();
        bump(&p);
    }
}

// ---------------------------------------------------------------------------
// Appends

#[test]
fn growing_transcript_matches_fresh_parse_at_every_step() {
    for seed in 1..=24u64 {
        let mut gen = Gen::new(seed);
        let lines = gen.records(40);
        let bytes = joined(&lines);
        let mut session = Session::new();
        write_subagents(&session, &gen.subagents, seed);
        let mut rng = Rng::new(seed ^ 0xABCD);
        let cuts = cut_points(&mut rng, &bytes, 12);

        session.write(&bytes[..cuts[0]]);
        assert_eq!(session.check(&format!("seed {seed} first")), "full");
        let mut prev = cuts[0];
        for &cut in &cuts[1..] {
            session.append(&bytes[prev..cut]);
            let route = session.check(&format!("seed {seed} grown to {cut}"));
            assert_eq!(
                route, "append",
                "seed {seed}: an append must not reparse the file"
            );
            prev = cut;
            // Asking again without a change is a pure hit.
            assert_eq!(
                session.check(&format!("seed {seed} unchanged at {cut}")),
                "hit"
            );
        }
        assert!(session.state().resume.is_some());
    }
}

#[test]
fn a_line_split_inside_a_multibyte_character_is_parsed_once_complete() {
    let mut session = Session::new();
    let mut gen = Gen::new(99);
    let mut lines = gen.records(6);
    lines.push(
        json!({"type": "user", "timestamp": "2026-09-02T10:00:00.000Z", "uuid": "heb",
            "message": {"role": "user", "content": [{"type": "text", "text": "שלום עולם 🌍"}]}})
        .to_string(),
    );
    let bytes = joined(&lines);
    let last_line_start = bytes[..bytes.len() - 1]
        .iter()
        .rposition(|b| *b == b'\n')
        .unwrap()
        + 1;
    // Find a cut that lands inside a multi-byte character of the last line.
    let cut = (last_line_start..bytes.len())
        .find(|&i| bytes[i] & 0b1100_0000 == 0b1000_0000)
        .expect("a continuation byte");
    session.write(&bytes[..cut]);
    session.check("half a character");
    session.append(&bytes[cut..bytes.len() - 1]);
    assert_eq!(session.check("complete line without its newline"), "append");
    session.append(&bytes[bytes.len() - 1..]);
    assert_eq!(session.check("newline arrives"), "append");
}

#[test]
fn a_file_without_trailing_newline_feeds_its_last_record() {
    let mut session = Session::new();
    let lines = Gen::new(7).records(10);
    let bytes = joined(&lines);
    session.write(&bytes[..bytes.len() - 1]);
    session.check("no trailing newline");
    let more = joined(&Gen::new(8).records(3));
    let mut tail = b"\n".to_vec();
    tail.extend_from_slice(&more);
    session.append(&tail);
    assert_eq!(session.check("then more"), "append");
}

// ---------------------------------------------------------------------------
// Rewrites

#[test]
fn rewritten_truncated_or_replaced_transcripts_are_parsed_whole() {
    for seed in 30..40u64 {
        let mut gen = Gen::new(seed);
        let bytes = joined(&gen.records(30));
        let mut session = Session::new();
        session.write(&bytes);
        session.check("initial");

        // Truncated (e.g. a rewrite that dropped the tail).
        let half = bytes.len() / 2;
        session.write(&bytes[..half]);
        assert_eq!(session.check(&format!("seed {seed} truncated")), "full");

        // Grown again, but a byte before the old end changed.
        let consumed = session.state().resume.as_ref().unwrap().consumed as usize;
        let mut altered = bytes;
        let flip = (consumed.saturating_sub(40)..consumed)
            .find(|&i| altered[i].is_ascii_alphanumeric())
            .expect("an ASCII byte to flip");
        altered[flip] = if altered[flip] == b'x' { b'y' } else { b'x' };
        session.write(&altered);
        assert_eq!(
            session.check(&format!("seed {seed} tail rewritten")),
            "full"
        );

        // Head changed, same length.
        let mut head_changed = altered;
        let other = Gen::new(seed + 1000).records(30);
        let other_first = other.into_iter().next().unwrap();
        let n = other_first.len().min(head_changed.len());
        head_changed[..n].copy_from_slice(&other_first.as_bytes()[..n]);
        session.write(&head_changed);
        assert_eq!(
            session.check(&format!("seed {seed} head rewritten")),
            "full"
        );

        // Replaced by a different file renamed over it, holding the very same
        // bytes plus an append: only the inode tells.
        let replacement = session.path.with_extension("tmp");
        let mut grown = head_changed;
        grown.extend_from_slice(&joined(&Gen::new(seed + 2000).records(3)));
        std::fs::write(&replacement, grown).unwrap();
        bump(&replacement);
        bump(&replacement);
        std::fs::rename(replacement, &session.path).unwrap();
        let route = session.check(&format!("seed {seed} replaced"));
        if cfg!(unix) {
            assert_eq!(route, "full");
        }
    }
}

#[test]
fn a_cold_transcript_does_not_keep_resume_state_but_stays_correct() {
    let mut gen = Gen::new(55);
    let bytes = joined(&gen.records(20));
    let mut session = Session::new();
    session.write(&bytes);
    // Pretend the file was last written long ago.
    session.now = SystemTime::now() + Duration::from_secs(24 * 3600);
    session.check("cold open");
    assert!(
        session.state().resume.is_none(),
        "a dormant transcript keeps one copy"
    );
    let cold_bytes = session.slot.as_ref().unwrap().bytes;

    // It changes after all: parsed whole once, then kept for appends.
    session.append(&joined(&gen.records(3)));
    assert_eq!(session.check("first change"), "full");
    assert!(session.state().resume.is_some());
    assert!(session.slot.as_ref().unwrap().bytes > cold_bytes);
    session.append(&joined(&gen.records(3)));
    assert_ne!(session.check("second change"), "full");

    // Untouched for longer than the hot window: the resume state goes.
    session.now += Duration::from_secs(3600);
    assert_eq!(session.check("idle"), "hit");
    assert!(session.state().resume.is_none());
}

// ---------------------------------------------------------------------------
// Sub-agents

#[test]
fn subagent_changes_redo_only_the_attribution() {
    let mut gen = Gen::new(77);
    let bytes = joined(&gen.records(30));
    let mut session = Session::new();
    session.write(&bytes);
    let dir = session.subagent_dir();
    std::fs::create_dir_all(&dir).unwrap();
    // Background agents not referenced by any fed record.
    for i in 0..3u64 {
        let p = dir.join(format!("agent-bg{i}.jsonl"));
        std::fs::write(&p, subagent_transcript(100 + i, 2)).unwrap();
        bump(&p);
    }
    assert_eq!(session.check("with sub-agents"), "full");
    let with_spend = session.slot.as_ref().unwrap().detail.session_stats.clone();
    assert!(with_spend.is_some());

    // One keeps running.
    let running = dir.join("agent-bg1.jsonl");
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&running)
        .unwrap();
    f.write_all(subagent_transcript(200, 4).as_bytes()).unwrap();
    drop(f);
    bump(&running);
    // A reader holding the previous detail keeps it unchanged.
    let held = session.slot.as_ref().unwrap().detail.clone();
    let held_json = serde_json::to_value(&*held).unwrap();
    assert_eq!(session.check("a sub-agent grew"), "reattribute");
    assert_eq!(serde_json::to_value(&*held).unwrap(), held_json);
    drop(held);

    // A new one starts, an old one is removed.
    let p = dir.join("agent-bg9.jsonl");
    std::fs::write(&p, subagent_transcript(300, 1)).unwrap();
    bump(&p);
    assert_eq!(session.check("a sub-agent appeared"), "reattribute");
    std::fs::remove_file(dir.join("agent-bg0.jsonl")).unwrap();
    assert_eq!(session.check("a sub-agent vanished"), "reattribute");

    // And the transcript grows at the same time.
    session.append(&joined(&gen.records(5)));
    assert_eq!(
        session.check("transcript and sub-agents together"),
        "append"
    );
    let gone = dir.join("agent-bg9.jsonl");
    std::fs::remove_file(gone).unwrap();
    session.append(&joined(&gen.records(5)));
    assert_eq!(session.check("both again"), "append");
}

#[test]
fn a_changed_subagent_an_agent_card_already_read_forces_a_full_parse() {
    // Find a seed whose records reference a sub-agent through an Agent result.
    let (mut gen, lines) = (1..200u64)
        .map(|s| {
            let mut g = Gen::new(s);
            let l = g.records(30);
            (g, l)
        })
        .find(|(g, _)| !g.subagents.is_empty())
        .expect("a seed with a sub-agent card");
    let mut session = Session::new();
    let dir = session.subagent_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let id = gen.subagents[0].clone();
    let card_file = dir.join(format!("agent-{id}.jsonl"));
    std::fs::write(&card_file, subagent_transcript(1, 1)).unwrap();
    bump(&card_file);
    session.write(&joined(&lines));
    session.check("card read");
    assert!(!session.state().fed_reads.is_empty());

    // The sub-agent was resumed: its transcript grew after its card was fed.
    std::fs::write(&card_file, subagent_transcript(1, 3)).unwrap();
    bump(&card_file);
    assert_eq!(session.check("card's transcript changed"), "full");

    // A sub-agent card whose file did not exist when fed, appearing later.
    std::fs::remove_file(&card_file).unwrap();
    session.check("card's transcript removed");
    std::fs::write(&card_file, subagent_transcript(1, 2)).unwrap();
    bump(&card_file);
    assert_eq!(session.check("card's transcript reappeared"), "full");

    session.append(&joined(&gen.records(4)));
    session.check("then appended");
}

// ---------------------------------------------------------------------------
// Cache plumbing

#[test]
fn concurrent_requests_through_the_global_cache_agree() {
    let mut gen = Gen::new(123);
    let bytes = joined(&gen.records(60));
    let session = Session::new();
    session.write(&bytes);
    let path = session.path.clone();
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || super::cached_detail(&path, SESSION).unwrap())
        })
        .collect();
    let details: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    // One parse, shared: every caller holds the same allocation.
    for d in &details[1..] {
        assert!(std::sync::Arc::ptr_eq(&details[0], d));
    }
    assert_eq!(serde_json::to_value(&*details[0]).unwrap(), session.fresh());
}

#[test]
fn shared_and_owned_parser_paths_agree() {
    let mut gen = Gen::new(321);
    let bytes = joined(&gen.records(25));
    let session = Session::new();
    session.write(&bytes);
    let parser =
        crate::parsers::RouteSanitized(Box::new(ClaudeParser::with_base_dir(session.base.clone())));
    let shared = parser.get_conversation_shared(SESSION).unwrap();
    let owned = parser.get_conversation(SESSION).unwrap();
    assert_eq!(
        serde_json::to_value(&*shared).unwrap(),
        serde_json::to_value(&owned).unwrap()
    );
}

#[test]
fn memory_estimate_counts_the_detail_and_the_resume_state() {
    let mut gen = Gen::new(9);
    let bytes = joined(&gen.records(80));
    let mut session = Session::new();
    session.write(&bytes);
    session.check("hot");
    let state = session.state();
    let detail_bytes = state.detail_bytes;
    let resume_bytes = state.resume.as_ref().unwrap().acc_bytes;
    assert!(detail_bytes > 0 && resume_bytes > 0);
    assert_eq!(session.slot.as_ref().unwrap().bytes, state.bytes());
    // The kept accumulator holds the same messages the detail was built from.
    let ratio = resume_bytes as f64 / detail_bytes as f64;
    assert!((0.5..2.0).contains(&ratio), "ratio {ratio}");
}
