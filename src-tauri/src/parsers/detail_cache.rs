//! Process-global cache of parsed conversation details.
//!
//! Opening a conversation used to re-parse the agent's whole transcript on
//! every request: a 120 MB Claude Code session took a third of a second of
//! JSON work per open, per refresh and per page of older history, although
//! the file had not changed (or had only grown by a few lines). This cache
//! keeps the finished detail per transcript file so a repeat request only
//! slices what it already has, and lets a parser keep whatever state it needs
//! to parse just the bytes appended since (see `claude::transcript_cache`).
//!
//! ## Shape
//!
//! One map entry per `(AgentType, path)`. Each entry is a *slot*: a mutex
//! around the cached value, held for the whole parse. That makes the cache
//! single-flight per file — a second request for the same transcript waits for
//! the first and then finds its result — while requests for different files
//! never wait on each other: the map lock is only held to look a slot up and
//! to settle the memory account afterwards, never across a parse.
//!
//! ## Memory bound
//!
//! Entries report their approximate heap size (`CachedDetail::bytes`), and the
//! map evicts least-recently-used entries until the total fits the budget
//! (256 MB by default, `CODEG_TRANSCRIPT_CACHE_MB` overrides, `0` disables the
//! cache). An entry larger than the whole budget is not kept at all. The size
//! is an estimate of the owned strings and vectors, which is what dominates a
//! transcript; it is not an allocator measurement.
//!
//! Lock order is slot → map, and nothing takes them the other way round:
//! eviction only drops the map's handle on a slot, it never locks one. A slot
//! evicted while a request still holds it simply becomes unreachable — that
//! request finishes, its result is returned, and the value is freed with the
//! last handle.

use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::SystemTime;

use crate::models::{
    AgentExecutionStats, AgentType, ContentBlock, ConversationDetail, ConversationSummary,
    ImageData, MessageTurn, UnifiedMessage,
};

/// Default budget when `CODEG_TRANSCRIPT_CACHE_MB` is unset.
const DEFAULT_BUDGET_MB: usize = 256;

/// What a file looked like when it was read: enough to tell, from a `stat`
/// alone, that it has not been written since.
///
/// `ino` (with the device) is what tells a file *replaced* by another of the
/// same size apart from the original — an agent that rewrites its log by
/// writing a sibling and renaming it over. `mtime` catches an in-place
/// rewrite whenever the clock advanced. Same size, same mtime and same inode
/// is treated as unchanged; that is the same residual blind spot the summary
/// cache accepts (a same-size rewrite within one mtime tick).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileStamp {
    pub len: u64,
    pub mtime: Option<SystemTime>,
    /// `(dev, ino)` where the platform reports one.
    pub ino: Option<(u64, u64)>,
}

impl FileStamp {
    pub fn of(path: &Path) -> Option<Self> {
        std::fs::metadata(path)
            .ok()
            .map(|m| Self::from_metadata(&m))
    }

    pub fn from_metadata(meta: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        let ino = {
            use std::os::unix::fs::MetadataExt;
            Some((meta.dev(), meta.ino()))
        };
        #[cfg(not(unix))]
        let ino = None;
        Self {
            len: meta.len(),
            mtime: meta.modified().ok(),
            ino,
        }
    }

    /// Unchanged as far as a `stat` can tell. A stamp without an mtime never
    /// counts as unchanged: the caller then revalidates the content instead.
    pub fn same_as(&self, other: &Self) -> bool {
        self.mtime.is_some() && self == other
    }
}

/// A cached parse: the finished detail, shared with every reader, plus the
/// parser's own bookkeeping (what it needs to validate the entry and to parse
/// only appended bytes next time).
pub(crate) struct CachedDetail {
    pub detail: Arc<ConversationDetail>,
    pub state: Box<dyn Any + Send>,
    /// Approximate heap size of `detail` plus `state`, in bytes.
    pub bytes: usize,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    agent: AgentType,
    path: PathBuf,
}

type Slot = Arc<Mutex<Option<CachedDetail>>>;

struct MapEntry {
    slot: Slot,
    last_used: u64,
    bytes: usize,
}

#[derive(Default)]
struct CacheMap {
    entries: HashMap<CacheKey, MapEntry>,
    tick: u64,
    total: usize,
}

pub(crate) struct DetailCache {
    map: Mutex<CacheMap>,
    budget: usize,
}

/// Lock a mutex, recovering from poisoning. A panic inside a parse could have
/// left a slot half-updated, so a poisoned SLOT is emptied (the next request
/// parses from scratch) — see `with_slot`.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl DetailCache {
    pub fn with_budget(budget: usize) -> Self {
        Self {
            map: Mutex::new(CacheMap::default()),
            budget,
        }
    }

    /// The process-wide cache, shared by the desktop app and codeg-server
    /// alike (both read transcripts through the same parsers).
    pub fn global() -> &'static DetailCache {
        static CACHE: OnceLock<DetailCache> = OnceLock::new();
        CACHE.get_or_init(|| {
            let mb = std::env::var("CODEG_TRANSCRIPT_CACHE_MB")
                .ok()
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(DEFAULT_BUDGET_MB);
            DetailCache::with_budget(mb.saturating_mul(1024 * 1024))
        })
    }

    pub fn enabled(&self) -> bool {
        self.budget > 0
    }

    /// Run `f` with exclusive access to the cached value for
    /// `(agent, path)`. `f` may read the value, replace it, or clear it; the
    /// memory account and eviction are settled after it returns.
    ///
    /// Concurrent calls for the same key run one after the other (the second
    /// sees what the first stored), which is what makes two simultaneous opens
    /// of one transcript parse it once.
    pub fn with_slot<R>(
        &self,
        agent: AgentType,
        path: &Path,
        f: impl FnOnce(&mut Option<CachedDetail>) -> R,
    ) -> R {
        let key = CacheKey {
            agent,
            path: path.to_path_buf(),
        };
        let slot = {
            let mut map = lock(&self.map);
            map.tick += 1;
            let tick = map.tick;
            let entry = map.entries.entry(key.clone()).or_insert_with(|| MapEntry {
                slot: Arc::new(Mutex::new(None)),
                last_used: tick,
                bytes: 0,
            });
            entry.last_used = tick;
            entry.slot.clone()
        };

        let mut guard = match slot.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                let mut g = poisoned.into_inner();
                *g = None;
                slot.clear_poison();
                g
            }
        };
        let out = f(&mut guard);
        let bytes = guard.as_ref().map_or(0, |v| v.bytes);

        // Settle the account while still holding the slot (slot → map order),
        // so two updates of the same key cannot interleave their accounting.
        let (evicted, keep) = {
            let mut map = lock(&self.map);
            self.settle(&mut map, &key, &slot, bytes)
        };
        if !keep {
            *guard = None;
        }
        drop(guard);
        // Free evicted values outside both locks.
        drop(evicted);
        out
    }

    /// Record `bytes` for `key` (if `slot` is still the one the map holds) and
    /// evict until the total fits. Returns the evicted slots, to be dropped by
    /// the caller after unlocking, and whether `key`'s own value may stay.
    fn settle(
        &self,
        map: &mut CacheMap,
        key: &CacheKey,
        slot: &Slot,
        bytes: usize,
    ) -> (Vec<Slot>, bool) {
        let mut evicted = Vec::new();
        let current = match map.entries.get_mut(key) {
            Some(e) if Arc::ptr_eq(&e.slot, slot) => e,
            // Evicted (or replaced) while we worked: our value lives in a slot
            // nobody can reach any more. Keeping it would hold memory the
            // account no longer sees.
            _ => return (evicted, false),
        };
        map.total = map.total - current.bytes + bytes;
        current.bytes = bytes;
        if bytes == 0 {
            // Nothing cached (a failed parse, or a value cleared by `f`): drop
            // the entry so the map only ever holds live values. A request
            // already waiting on this slot finds it empty and parses itself.
            if let Some(e) = map.entries.remove(key) {
                evicted.push(e.slot);
            }
            return (evicted, true);
        }
        if bytes > self.budget {
            if let Some(e) = map.entries.remove(key) {
                map.total -= e.bytes;
                evicted.push(e.slot);
            }
            return (evicted, false);
        }
        while map.total > self.budget {
            let victim = map
                .entries
                .iter()
                .filter(|(k, _)| *k != key)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone());
            let Some(victim) = victim else { break };
            if let Some(e) = map.entries.remove(&victim) {
                map.total -= e.bytes;
                evicted.push(e.slot);
            }
        }
        (evicted, true)
    }

    /// Total bytes currently accounted (tests and diagnostics).
    #[cfg(test)]
    pub fn total_bytes(&self) -> usize {
        lock(&self.map).total
    }

    #[cfg(test)]
    pub fn contains(&self, agent: AgentType, path: &Path) -> bool {
        lock(&self.map).entries.contains_key(&CacheKey {
            agent,
            path: path.to_path_buf(),
        })
    }
}

// ---------------------------------------------------------------------------
// Approximate heap sizes. Strings and vectors are what a transcript is made
// of; struct overhead is counted per element so a transcript of many tiny
// blocks is not under-counted to zero.

fn str_bytes(s: &str) -> usize {
    s.len()
}

fn opt_str_bytes(s: &Option<String>) -> usize {
    s.as_deref().map_or(0, str_bytes)
}

pub(crate) fn json_value_bytes(v: &serde_json::Value) -> usize {
    use serde_json::Value;
    std::mem::size_of::<Value>()
        + match v {
            Value::String(s) => s.len(),
            Value::Array(a) => a.iter().map(json_value_bytes).sum(),
            Value::Object(o) => o.iter().map(|(k, v)| k.len() + json_value_bytes(v)).sum(),
            _ => 0,
        }
}

fn image_bytes(i: &ImageData) -> usize {
    std::mem::size_of::<ImageData>() + i.data.len() + i.mime_type.len() + opt_str_bytes(&i.uri)
}

fn agent_stats_bytes(s: &AgentExecutionStats) -> usize {
    std::mem::size_of::<AgentExecutionStats>()
        + opt_str_bytes(&s.agent_type)
        + opt_str_bytes(&s.status)
        + opt_str_bytes(&s.child_session_id)
        + s.tool_calls
            .iter()
            .map(|c| {
                std::mem::size_of_val(c)
                    + c.tool_name.len()
                    + opt_str_bytes(&c.input_preview)
                    + opt_str_bytes(&c.output_preview)
            })
            .sum::<usize>()
}

pub(crate) fn block_bytes(b: &ContentBlock) -> usize {
    std::mem::size_of::<ContentBlock>()
        + match b {
            ContentBlock::Text { text } | ContentBlock::Thinking { text } => str_bytes(text),
            ContentBlock::Image {
                data,
                mime_type,
                uri,
            } => data.len() + mime_type.len() + opt_str_bytes(uri),
            ContentBlock::ImageGeneration {
                revised_prompt,
                image,
            } => opt_str_bytes(revised_prompt) + image.as_ref().map_or(0, image_bytes),
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                status,
                meta,
            } => {
                opt_str_bytes(tool_use_id)
                    + tool_name.len()
                    + opt_str_bytes(input_preview)
                    + opt_str_bytes(status)
                    + meta.as_ref().map_or(0, json_value_bytes)
            }
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                agent_stats,
                images,
                ..
            } => {
                opt_str_bytes(tool_use_id)
                    + opt_str_bytes(output_preview)
                    + agent_stats.as_ref().map_or(0, agent_stats_bytes)
                    + images.iter().map(image_bytes).sum::<usize>()
            }
        }
}

pub(crate) fn turn_bytes(t: &MessageTurn) -> usize {
    std::mem::size_of::<MessageTurn>()
        + t.id.len()
        + opt_str_bytes(&t.model)
        + opt_str_bytes(&t.agent_message_id)
        + t.blocks.iter().map(block_bytes).sum::<usize>()
}

pub(crate) fn message_bytes(m: &UnifiedMessage) -> usize {
    std::mem::size_of::<UnifiedMessage>()
        + m.id.len()
        + opt_str_bytes(&m.model)
        + opt_str_bytes(&m.agent_message_id)
        + m.content.iter().map(block_bytes).sum::<usize>()
}

fn summary_bytes(s: &ConversationSummary) -> usize {
    std::mem::size_of::<ConversationSummary>()
        + s.id.len()
        + opt_str_bytes(&s.folder_path)
        + opt_str_bytes(&s.folder_name)
        + opt_str_bytes(&s.title)
        + opt_str_bytes(&s.model)
        + opt_str_bytes(&s.git_branch)
        + opt_str_bytes(&s.parent_id)
        + opt_str_bytes(&s.parent_tool_use_id)
        + opt_str_bytes(&s.delegation_call_id)
}

pub(crate) fn detail_bytes(d: &ConversationDetail) -> usize {
    std::mem::size_of::<ConversationDetail>()
        + summary_bytes(&d.summary)
        + d.turns.iter().map(turn_bytes).sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    fn detail_of(n: usize) -> ConversationDetail {
        ConversationDetail {
            summary: ConversationSummary {
                id: "s".into(),
                agent_type: AgentType::ClaudeCode,
                folder_path: None,
                folder_name: None,
                title: None,
                started_at: chrono::Utc::now(),
                ended_at: None,
                message_count: 0,
                model: None,
                git_branch: None,
                parent_id: None,
                parent_tool_use_id: None,
                delegation_call_id: None,
            },
            turns: (0..n)
                .map(|i| MessageTurn {
                    id: format!("turn-{i}"),
                    role: crate::models::TurnRole::User,
                    blocks: vec![ContentBlock::Text {
                        text: "x".repeat(1000),
                    }],
                    timestamp: chrono::Utc::now(),
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: None,
                    agent_message_id: None,
                })
                .collect(),
            session_stats: None,
            transcript_watermark: None,
        }
    }

    fn value(bytes: usize) -> CachedDetail {
        CachedDetail {
            detail: Arc::new(detail_of(0)),
            state: Box::new(()),
            bytes,
        }
    }

    fn put(cache: &DetailCache, path: &str, bytes: usize) {
        cache.with_slot(AgentType::ClaudeCode, Path::new(path), |slot| {
            *slot = Some(value(bytes));
        });
    }

    fn has(cache: &DetailCache, path: &str) -> bool {
        cache.with_slot(AgentType::ClaudeCode, Path::new(path), |slot| {
            slot.is_some()
        })
    }

    #[test]
    fn evicts_least_recently_used_to_stay_within_budget() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/a", 400);
        put(&cache, "/b", 400);
        // Touch /a so /b becomes the least recently used.
        assert!(has(&cache, "/a"));
        put(&cache, "/c", 400);
        assert!(cache.total_bytes() <= 1000);
        assert!(cache.contains(AgentType::ClaudeCode, Path::new("/a")));
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/b")));
        assert!(cache.contains(AgentType::ClaudeCode, Path::new("/c")));
        assert_eq!(cache.total_bytes(), 800);
    }

    #[test]
    fn an_entry_larger_than_the_budget_is_not_kept() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/small", 100);
        put(&cache, "/huge", 5000);
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/huge")));
        assert!(cache.contains(AgentType::ClaudeCode, Path::new("/small")));
        assert_eq!(cache.total_bytes(), 100);
        // The oversized value was cleared, not left in an unreachable slot.
        assert!(!has(&cache, "/huge"));
    }

    #[test]
    fn growing_an_entry_reaccounts_and_evicts_others() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/a", 300);
        put(&cache, "/b", 300);
        put(&cache, "/a", 900);
        assert_eq!(cache.total_bytes(), 900);
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/b")));
        put(&cache, "/a", 100);
        assert_eq!(cache.total_bytes(), 100);
    }

    #[test]
    fn clearing_a_value_drops_its_entry_and_bytes() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/a", 300);
        cache.with_slot(AgentType::ClaudeCode, Path::new("/a"), |slot| *slot = None);
        assert_eq!(cache.total_bytes(), 0);
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/a")));
    }

    #[test]
    fn keys_are_namespaced_by_agent() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/same", 100);
        let other = cache.with_slot(AgentType::Codex, Path::new("/same"), |slot| slot.is_some());
        assert!(!other);
    }

    #[test]
    fn concurrent_requests_for_one_file_parse_once() {
        let cache = Arc::new(DetailCache::with_budget(1 << 20));
        let parses = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let parses = parses.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    cache.with_slot(AgentType::ClaudeCode, Path::new("/shared"), |slot| {
                        if slot.is_none() {
                            parses.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(30));
                            *slot = Some(value(10));
                        }
                    })
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(parses.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn different_files_do_not_wait_on_each_other() {
        let cache = Arc::new(DetailCache::with_budget(1 << 20));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let c2 = cache.clone();
        // Hold /slow's slot until the other thread has finished with /fast.
        let slow = std::thread::spawn(move || {
            c2.with_slot(AgentType::ClaudeCode, Path::new("/slow"), |slot| {
                rx.recv_timeout(std::time::Duration::from_secs(10))
                    .expect("the /fast request must not block on /slow");
                *slot = Some(value(1));
            });
        });
        std::thread::sleep(std::time::Duration::from_millis(20));
        put(&cache, "/fast", 1);
        tx.send(()).unwrap();
        slow.join().unwrap();
    }

    #[test]
    fn a_slot_evicted_mid_parse_does_not_leak_into_the_account() {
        let cache = Arc::new(DetailCache::with_budget(1000));
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let c2 = cache.clone();
        let parsing = std::thread::spawn(move || {
            c2.with_slot(AgentType::ClaudeCode, Path::new("/victim"), |slot| {
                started_tx.send(()).unwrap();
                go_rx.recv().unwrap();
                *slot = Some(value(600));
            });
        });
        started_rx.recv().unwrap();
        // /victim is the least recently used entry (bytes 0 so far); fill the
        // budget so it is evicted while its parse is still running.
        put(&cache, "/a", 500);
        put(&cache, "/b", 500);
        put(&cache, "/c", 500);
        go_tx.send(()).unwrap();
        parsing.join().unwrap();
        assert!(cache.total_bytes() <= 1000);
    }

    #[test]
    fn a_panicking_parse_empties_its_slot() {
        let cache = Arc::new(DetailCache::with_budget(1000));
        put(&cache, "/p", 100);
        let c2 = cache.clone();
        let _ = std::thread::spawn(move || {
            c2.with_slot(AgentType::ClaudeCode, Path::new("/p"), |_slot| {
                panic!("parse blew up");
            });
        })
        .join();
        assert!(!has(&cache, "/p"));
        put(&cache, "/p", 100);
        assert!(has(&cache, "/p"));
    }

    #[test]
    fn detail_size_estimate_tracks_content() {
        let small = detail_bytes(&detail_of(1));
        let large = detail_bytes(&detail_of(100));
        assert!(large >= 100 * 1000);
        assert!(large > small * 50);
    }
}
