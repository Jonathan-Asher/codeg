//! A Claude session's API calls one by one: the main thread and each
//! sub-agent, with the upstream message id and request id of every call.
//!
//! The conversation parser folds what a sub-agent spent into the turn that
//! launched it (`attribute_subagent_usage`), which is right for a session's
//! total and loses who spent it. The usage page also needs each call's
//! `message.id`: that is the key the account pool's request records are
//! joined on, to tell which account served the call. This reader walks the
//! same files with the same rules and keeps the calls apart:
//!
//! * one call per `message.id` in a file, the line with the most tokens
//!   winning (Claude Code writes one line per content block, each repeating
//!   the call's usage) — the parent transcript's own rule;
//! * a fork's transcript counts from its directive message on (see
//!   [`super::is_fork_directive_record`]); what it copied was counted where it
//!   was spent;
//! * a message id seen in an earlier file (the main thread first, then the
//!   sub-agents in name order) is not counted again.
//!
//! A sub-agent is labelled from its `agent-<id>.meta.json` (`description`,
//! `agentType`, `parentAgentId`), else from the `Task`/`Agent` call that
//! launched it (`description`, `subagent_type`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Utc};

use super::{is_fork_directive_record, parse_timestamp, subagent_dir_of};

/// The main thread's key; a sub-agent's is its agent id.
pub(crate) const MAIN_THREAD: &str = "";

/// Labels and types are short display strings; anything longer is cut.
const LABEL_MAX_CHARS: usize = 160;
const ID_MAX_CHARS: usize = 128;

/// One call's token counters, cache writes split by tier.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CallUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
}

impl CallUsage {
    pub fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write_5m)
            .saturating_add(self.cache_write_1h)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeCall {
    pub thread_key: String,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub model: Option<String>,
    pub usage: CallUsage,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeThread {
    pub key: String,
    /// The sub-agent's task description. `None` for the main thread.
    pub label: Option<String>,
    /// `general-purpose`, `Explore`, `fork`, a custom agent's name…
    pub agent_type: Option<String>,
    /// The sub-agent that launched this one, for nested sub-agents.
    pub parent_key: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ClaudeCalls {
    pub calls: Vec<ClaudeCall>,
    /// The main thread first, then every sub-agent that has a transcript.
    pub threads: Vec<ClaudeThread>,
}

/// What a transcript tree looked like on disk: changes whenever the main
/// transcript or any sub-agent file grows, appears or goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TreeStamp {
    pub fingerprint: String,
    /// The newest modification time in the tree.
    pub modified: Option<DateTime<Utc>>,
}

/// Every session transcript under `projects_dir`, by session id — one pass
/// over the project directories instead of one per conversation.
pub(crate) fn index_projects(projects_dir: &Path) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let Ok(dirs) = fs::read_dir(projects_dir) else {
        return out;
    };
    for dir in dirs.flatten() {
        let dir = dir.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.entry(stem.to_string()).or_insert(path);
            }
        }
    }
    out
}

/// FNV-1a: a hash whose value never changes between builds, so a stored
/// fingerprint stays comparable after an update.
fn fnv1a(bytes: &[u8], mut h: u64) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn stamp_of(path: &Path) -> Option<(u64, u128, Option<DateTime<Utc>>)> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok();
    let nanos = modified
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Some((meta.len(), nanos, modified.map(DateTime::<Utc>::from)))
}

/// The sub-agent transcripts of a session, in name order.
fn subagent_files(main: &Path) -> Vec<PathBuf> {
    let dir = subagent_dir_of(main);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("agent-") && n.ends_with(".jsonl"))
        })
        .collect();
    files.sort();
    files
}

/// The stamp of the main transcript and every sub-agent file beside it, or
/// `None` when the main transcript is gone.
pub(crate) fn tree_stamp(main: &Path) -> Option<TreeStamp> {
    let (len, nanos, modified) = stamp_of(main)?;
    let mut h = fnv1a(format!("{len}:{nanos}").as_bytes(), 0xcbf2_9ce4_8422_2325);
    let mut newest = modified;
    for f in subagent_files(main) {
        let Some((len, nanos, m)) = stamp_of(&f) else {
            continue;
        };
        let name = f.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        h = fnv1a(format!("|{name}:{len}:{nanos}").as_bytes(), h);
        if m > newest {
            newest = m;
        }
    }
    Some(TreeStamp {
        fingerprint: format!("{h:016x}"),
        modified: newest,
    })
}

fn clean(raw: Option<&str>, max: usize) -> Option<String> {
    let s: String = raw?
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect();
    (!s.is_empty()).then_some(s)
}

fn count(v: Option<&serde_json::Value>) -> u64 {
    v.and_then(|v| v.as_u64()).unwrap_or(0)
}

/// A call's usage, the 1-hour cache tier split out when the transcript
/// records the split (every write is a 5-minute write otherwise).
fn call_usage(usage: &serde_json::Value) -> CallUsage {
    let created = count(usage.get("cache_creation_input_tokens"));
    let split = usage.get("cache_creation");
    let w1h = count(split.and_then(|s| s.get("ephemeral_1h_input_tokens")));
    let w5m = count(split.and_then(|s| s.get("ephemeral_5m_input_tokens")));
    CallUsage {
        input: count(usage.get("input_tokens")),
        output: count(usage.get("output_tokens")),
        cache_read: count(usage.get("cache_read_input_tokens")),
        cache_write_5m: w5m.max(created.saturating_sub(w1h)),
        cache_write_1h: w1h,
    }
}

/// What a `Task`/`Agent` call said about the sub-agent it launched.
#[derive(Debug, Clone, Default)]
struct Launch {
    description: Option<String>,
    agent_type: Option<String>,
}

/// One file's calls (deduped by message id, fork prefix dropped) and the
/// sub-agents it launched, by tool-use id.
fn read_file(path: &Path, thread_key: &str) -> (Vec<ClaudeCall>, HashMap<String, Launch>) {
    let mut calls: Vec<ClaudeCall> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut launches: HashMap<String, Launch> = HashMap::new();
    let Ok(file) = fs::File::open(path) else {
        return (calls, launches);
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let assistant = line.contains("\"assistant\"");
        let fork = line.contains("<fork-boilerplate>");
        if !assistant && !fork {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind == "user" && is_fork_directive_record(&value) {
            calls.clear();
            by_id.clear();
            launches.clear();
            continue;
        }
        if kind != "assistant" {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        if let Some(blocks) = message.get("content").and_then(|c| c.as_array()) {
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                    continue;
                }
                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name != "Task" && name != "Agent" {
                    continue;
                }
                let Some(id) = block.get("id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let input = block.get("input");
                launches.insert(
                    id.to_string(),
                    Launch {
                        description: clean(
                            input
                                .and_then(|i| i.get("description"))
                                .and_then(|d| d.as_str()),
                            LABEL_MAX_CHARS,
                        ),
                        agent_type: clean(
                            input
                                .and_then(|i| i.get("subagent_type"))
                                .and_then(|d| d.as_str()),
                            LABEL_MAX_CHARS,
                        ),
                    },
                );
            }
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let usage = call_usage(usage);
        if usage.total() == 0 {
            continue;
        }
        let Some(occurred_at) = parse_timestamp(&value) else {
            continue;
        };
        let message_id = clean(message.get("id").and_then(|i| i.as_str()), ID_MAX_CHARS);
        let call = ClaudeCall {
            thread_key: thread_key.to_string(),
            message_id: message_id.clone(),
            request_id: clean(
                value.get("requestId").and_then(|i| i.as_str()),
                ID_MAX_CHARS,
            ),
            occurred_at,
            model: clean(
                message.get("model").and_then(|m| m.as_str()),
                LABEL_MAX_CHARS,
            )
            .filter(|m| m != "<synthetic>"),
            usage,
        };
        match message_id.and_then(|id| by_id.get(&id).copied().map(|at| (id, at))) {
            Some((_, at)) => {
                if call.usage.total() > calls[at].usage.total() {
                    let first_seen = calls[at].occurred_at;
                    calls[at] = ClaudeCall {
                        occurred_at: first_seen.min(call.occurred_at),
                        ..call
                    };
                }
            }
            None => {
                if let Some(id) = call.message_id.clone() {
                    by_id.insert(id, calls.len());
                }
                calls.push(call);
            }
        }
    }
    (calls, launches)
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AgentMeta {
    description: Option<String>,
    agent_type: Option<String>,
    tool_use_id: Option<String>,
    parent_agent_id: Option<String>,
}

fn read_meta(transcript: &Path) -> AgentMeta {
    let meta = transcript.with_extension("meta.json");
    fs::read(&meta)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Every call of the session whose main transcript is `main`.
pub(crate) fn read_calls(main: &Path) -> ClaudeCalls {
    let mut out = ClaudeCalls::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut launches: HashMap<String, Launch> = HashMap::new();

    let mut take = |calls: Vec<ClaudeCall>, out: &mut ClaudeCalls| {
        for call in calls {
            if let Some(id) = &call.message_id {
                if !seen.insert(id.clone()) {
                    continue;
                }
            }
            out.calls.push(call);
        }
    };

    let (main_calls, main_launches) = read_file(main, MAIN_THREAD);
    take(main_calls, &mut out);
    launches.extend(main_launches);
    out.threads.push(ClaudeThread {
        key: MAIN_THREAD.to_string(),
        label: None,
        agent_type: None,
        parent_key: None,
    });

    let mut metas: Vec<(String, AgentMeta)> = Vec::new();
    for file in subagent_files(main) {
        let Some(agent_id) = file
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("agent-"))
            .and_then(|n| n.strip_suffix(".jsonl"))
            .filter(|id| !id.is_empty() && id.len() <= ID_MAX_CHARS)
            .map(str::to_string)
        else {
            continue;
        };
        let (calls, nested) = read_file(&file, &agent_id);
        take(calls, &mut out);
        launches.extend(nested);
        metas.push((agent_id, read_meta(&file)));
    }
    for (agent_id, meta) in metas {
        let launch = meta
            .tool_use_id
            .as_deref()
            .and_then(|id| launches.get(id))
            .cloned()
            .unwrap_or_default();
        out.threads.push(ClaudeThread {
            label: clean(meta.description.as_deref(), LABEL_MAX_CHARS).or(launch.description),
            agent_type: clean(meta.agent_type.as_deref(), LABEL_MAX_CHARS).or(launch.agent_type),
            parent_key: clean(meta.parent_agent_id.as_deref(), ID_MAX_CHARS),
            key: agent_id,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn assistant(
        id: &str,
        req: &str,
        at: &str,
        usage: serde_json::Value,
        content: serde_json::Value,
    ) -> String {
        json!({
            "type": "assistant",
            "requestId": req,
            "timestamp": at,
            "message": {"id": id, "model": "claude-opus-5-5", "role": "assistant", "content": content, "usage": usage}
        })
        .to_string()
    }

    fn usage(input: u64, output: u64, read: u64, w5m: u64, w1h: u64) -> serde_json::Value {
        json!({
            "input_tokens": input, "output_tokens": output, "cache_read_input_tokens": read,
            "cache_creation_input_tokens": w5m + w1h,
            "cache_creation": {"ephemeral_5m_input_tokens": w5m, "ephemeral_1h_input_tokens": w1h}
        })
    }

    fn write(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn session(dir: &Path) -> PathBuf {
        let main = dir.join("proj").join("sess-1.jsonl");
        write(
            &main,
            &[
                json!({"type": "user", "timestamp": "2026-11-23T10:00:00Z", "message": {"role": "user", "content": "hi"}}).to_string(),
                // One call written as two lines (thinking, then tool use), the
                // second carrying the final usage.
                assistant("msg_A", "req_A", "2026-11-23T10:00:01Z", usage(3, 10, 1000, 0, 200), json!([{"type": "thinking", "thinking": ""}])),
                assistant("msg_A", "req_A", "2026-11-23T10:00:02Z", usage(3, 40, 1000, 0, 200), json!([
                    {"type": "tool_use", "id": "toolu_1", "name": "Agent", "input": {"description": "Review the diff", "subagent_type": "general-purpose", "prompt": "secret prompt"}}
                ])),
                assistant("msg_B", "req_B", "2026-11-23T10:05:00Z", usage(1, 5, 2000, 50, 0), json!([{"type": "text", "text": "done"}])),
            ],
        );
        let sub = main.with_extension("").join("subagents");
        write(
            &sub.join("agent-aaa.jsonl"),
            &[
                assistant(
                    "msg_C",
                    "req_C",
                    "2026-11-23T10:01:00Z",
                    usage(2, 100, 5000, 300, 0),
                    json!([]),
                ),
                assistant(
                    "msg_D",
                    "req_D",
                    "2026-11-23T10:02:00Z",
                    usage(2, 7, 6000, 0, 0),
                    json!([]),
                ),
            ],
        );
        fs::write(
            sub.join("agent-aaa.meta.json"),
            r#"{"agentType":"general-purpose","toolUseId":"toolu_1"}"#,
        )
        .unwrap();
        // A fork: copies the parent's launching record (msg_A) before its
        // directive; only what follows the directive is its own.
        write(
            &sub.join("agent-fff.jsonl"),
            &[
                assistant("msg_A", "req_A", "2026-11-23T10:00:02Z", usage(3, 40, 1000, 0, 200), json!([])),
                json!({"type": "user", "timestamp": "2026-11-23T10:03:00Z", "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_x", "content": "Fork started"},
                    {"type": "text", "text": "<fork-boilerplate>you are a fork</fork-boilerplate>Your directive: check"}
                ]}}).to_string(),
                assistant("msg_E", "req_E", "2026-11-23T10:03:30Z", usage(1, 9, 900, 0, 0), json!([])),
            ],
        );
        fs::write(
            sub.join("agent-fff.meta.json"),
            r#"{"agentType":"fork","description":"Check the build"}"#,
        )
        .unwrap();
        main
    }

    #[test]
    fn splits_main_thread_and_sub_agents_with_their_message_ids() {
        let dir = tempfile::tempdir().unwrap();
        let main = session(dir.path());
        let got = read_calls(&main);
        let ids: Vec<(&str, &str)> = got
            .calls
            .iter()
            .map(|c| (c.thread_key.as_str(), c.message_id.as_deref().unwrap()))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("", "msg_A"),
                ("", "msg_B"),
                ("aaa", "msg_C"),
                ("aaa", "msg_D"),
                ("fff", "msg_E")
            ]
        );
        // The line with the most tokens wins; the first timestamp stays.
        let a = &got.calls[0];
        assert_eq!(
            a.usage,
            CallUsage {
                input: 3,
                output: 40,
                cache_read: 1000,
                cache_write_5m: 0,
                cache_write_1h: 200
            }
        );
        assert_eq!(a.request_id.as_deref(), Some("req_A"));
        assert_eq!(a.occurred_at.to_rfc3339(), "2026-11-23T10:00:01+00:00");
        assert_eq!(got.calls[2].usage.cache_write_5m, 300);
    }

    #[test]
    fn labels_sub_agents_from_meta_then_from_the_launching_call() {
        let dir = tempfile::tempdir().unwrap();
        let main = session(dir.path());
        let got = read_calls(&main);
        assert_eq!(got.threads.len(), 3);
        assert_eq!(got.threads[0].key, "");
        let aaa = got.threads.iter().find(|t| t.key == "aaa").unwrap();
        assert_eq!(
            aaa.label.as_deref(),
            Some("Review the diff"),
            "meta has no description: the Agent call's"
        );
        assert_eq!(aaa.agent_type.as_deref(), Some("general-purpose"));
        let fff = got.threads.iter().find(|t| t.key == "fff").unwrap();
        assert_eq!(fff.label.as_deref(), Some("Check the build"));
        assert_eq!(fff.agent_type.as_deref(), Some("fork"));
    }

    #[test]
    fn never_reads_prompt_text_into_labels_beyond_the_description() {
        let dir = tempfile::tempdir().unwrap();
        let main = session(dir.path());
        let got = read_calls(&main);
        let all = format!("{got:?}");
        assert!(!all.contains("secret prompt"));
        assert!(!all.contains("you are a fork"));
    }

    #[test]
    fn a_call_without_a_split_counts_its_writes_as_5_minute_ones() {
        let u = call_usage(
            &json!({"input_tokens": 1, "output_tokens": 2, "cache_creation_input_tokens": 70}),
        );
        assert_eq!(u.cache_write_5m, 70);
        assert_eq!(u.cache_write_1h, 0);
    }

    #[test]
    fn the_stamp_moves_when_a_sub_agent_file_grows() {
        let dir = tempfile::tempdir().unwrap();
        let main = session(dir.path());
        let before = tree_stamp(&main).unwrap();
        assert_eq!(
            tree_stamp(&main).unwrap(),
            before,
            "stable when nothing changed"
        );
        let sub = main
            .with_extension("")
            .join("subagents")
            .join("agent-aaa.jsonl");
        let mut f = fs::OpenOptions::new().append(true).open(&sub).unwrap();
        writeln!(
            f,
            "{}",
            assistant(
                "msg_Z",
                "req_Z",
                "2026-11-23T11:00:00Z",
                usage(1, 1, 1, 0, 0),
                json!([])
            )
        )
        .unwrap();
        drop(f);
        assert_ne!(tree_stamp(&main).unwrap().fingerprint, before.fingerprint);
        assert!(tree_stamp(&dir.path().join("gone.jsonl")).is_none());
    }

    #[test]
    fn indexes_session_files_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let main = session(dir.path());
        let index = index_projects(dir.path());
        assert_eq!(index.get("sess-1"), Some(&main));
        assert_eq!(index.len(), 1, "sub-agent files are not sessions");
    }
}
