//! Process-global cache of parsed conversation details.
//!
//! Opening a conversation used to re-parse the agent's whole transcript on
//! every request: a 90 MB Claude Code session took a second of JSON work per
//! open, per refresh and per page of older history, although the file had not
//! changed (or had only grown by a few lines). This cache keeps the finished
//! detail per transcript file so a repeat request only slices what it already
//! has, and lets a parser keep whatever state it needs to parse just the bytes
//! appended since (see `claude::transcript_cache`).
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
//! Entries report their heap size (`CachedValue::bytes`, measured over the
//! strings and vectors they hold), and the map evicts least-recently-used
//! entries until the total fits the budget: 200 MB by default,
//! `CODEG_TRANSCRIPT_CACHE_MB` overrides it and `0` turns the cache off. No
//! single entry may take more than half the budget, and an entry nobody asked
//! for in [`IDLE_TTL`] is dropped whatever room is left.
//!
//! Lock order is slot → map, and nothing takes them the other way round:
//! eviction only drops the map's handle on a slot, it never locks one. A slot
//! evicted while a request still holds it simply becomes unreachable — that
//! request finishes, its result is returned, and the value is freed with the
//! last handle.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use crate::models::{
    AgentExecutionStats, AgentType, ContentBlock, ConversationDetail, ConversationSummary,
    ImageData, MessageTurn, UnifiedMessage,
};

/// Budget when `CODEG_TRANSCRIPT_CACHE_MB` is unset.
const DEFAULT_BUDGET_MB: usize = 200;
const BUDGET_ENV: &str = "CODEG_TRANSCRIPT_CACHE_MB";
/// An entry nobody asked for in this long is dropped.
pub(crate) const IDLE_TTL: Duration = Duration::from_secs(20 * 60);
/// How often the process-wide cache looks for idle entries.
const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// The total is reported at info level once it reaches half the budget, at
/// most this often.
const LARGE_REPORT_EVERY: Duration = Duration::from_secs(5 * 60);

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

/// A cached value and its measured heap size in bytes.
pub(crate) struct CachedValue {
    pub value: Box<dyn Any + Send>,
    pub bytes: usize,
}

/// The size limits a cached parse is held to.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// The most one entry may hold.
    pub entry_cap: usize,
    /// The most one entry may hold while it keeps two forms of the same
    /// transcript (a finished detail and the state to resume parsing it).
    /// Above this a transcript is kept once.
    pub pair_cap: usize,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    agent: AgentType,
    path: PathBuf,
}

type Slot = Arc<Mutex<Option<CachedValue>>>;

struct MapEntry {
    slot: Slot,
    /// LRU order.
    last_used: u64,
    used_at: Instant,
    bytes: usize,
}

#[derive(Default)]
struct CacheMap {
    entries: HashMap<CacheKey, MapEntry>,
    tick: u64,
    total: usize,
    last_large_report: Option<Instant>,
}

pub(crate) struct DetailCache {
    map: Mutex<CacheMap>,
    budget: usize,
    idle_ttl: Duration,
}

/// Lock a mutex, recovering from poisoning. A panic inside a parse could have
/// left a slot half-updated, so a poisoned SLOT is emptied (the next request
/// parses from scratch) — see `run`.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Why an entry left the cache, for the debug log.
#[derive(Clone, Copy, Debug)]
enum Gone {
    Lru,
    Idle,
    TooLarge,
    Forgotten,
}

impl DetailCache {
    pub fn with_budget(budget: usize) -> Self {
        Self {
            map: Mutex::new(CacheMap::default()),
            budget,
            idle_ttl: IDLE_TTL,
        }
    }

    /// The process-wide cache, shared by the desktop app and codeg-server
    /// alike (both read transcripts through the same parsers).
    pub fn global() -> &'static DetailCache {
        static CACHE: OnceLock<DetailCache> = OnceLock::new();
        CACHE.get_or_init(|| {
            let mb = std::env::var(BUDGET_ENV)
                .ok()
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(DEFAULT_BUDGET_MB);
            let cache = DetailCache::with_budget(mb.saturating_mul(1024 * 1024));
            if cache.enabled() {
                tracing::info!(budget_mb = mb, "[transcript_cache] enabled");
                // Frees idle entries even when nothing asks for a transcript.
                let _ = std::thread::Builder::new()
                    .name("transcript-cache-sweep".into())
                    .spawn(|| loop {
                        std::thread::sleep(SWEEP_EVERY);
                        DetailCache::global().sweep_idle();
                    });
            }
            cache
        })
    }

    pub fn enabled(&self) -> bool {
        self.budget > 0
    }

    pub fn limits(&self) -> Limits {
        Limits {
            entry_cap: self.budget / 2,
            pair_cap: self.budget / 8,
        }
    }

    /// Run `f` with exclusive access to the cached value for `(agent, path)`,
    /// creating an empty slot when there is none. `f` may read the value,
    /// replace it, or clear it; the memory account and eviction are settled
    /// after it returns.
    ///
    /// Concurrent calls for the same key run one after the other (the second
    /// sees what the first stored), which is what makes two simultaneous opens
    /// of one transcript parse it once.
    pub fn with_slot<R>(
        &self,
        agent: AgentType,
        path: &Path,
        f: impl FnOnce(&mut Option<CachedValue>) -> R,
    ) -> R {
        let key = CacheKey {
            agent,
            path: path.to_path_buf(),
        };
        let slot = self.touch(&key, true).expect("created on demand");
        self.run(key, slot, f)
    }

    /// [`Self::with_slot`] for a file that is already cached; `None` (and `f`
    /// not run) when it is not. For readers that should profit from the cache
    /// without filling it — a background pass over every conversation would
    /// otherwise push out the ones people have open.
    pub fn with_slot_if_present<R>(
        &self,
        agent: AgentType,
        path: &Path,
        f: impl FnOnce(&mut Option<CachedValue>) -> R,
    ) -> Option<R> {
        let key = CacheKey {
            agent,
            path: path.to_path_buf(),
        };
        let slot = self.touch(&key, false)?;
        Some(self.run(key, slot, f))
    }

    /// Mark `key` used and return its slot, creating it if `create`.
    fn touch(&self, key: &CacheKey, create: bool) -> Option<Slot> {
        let mut map = lock(&self.map);
        map.tick += 1;
        let tick = map.tick;
        let entry = if create {
            map.entries.entry(key.clone()).or_insert_with(|| MapEntry {
                slot: Arc::new(Mutex::new(None)),
                last_used: tick,
                used_at: Instant::now(),
                bytes: 0,
            })
        } else {
            map.entries.get_mut(key)?
        };
        entry.last_used = tick;
        entry.used_at = Instant::now();
        Some(entry.slot.clone())
    }

    fn run<R>(
        &self,
        key: CacheKey,
        slot: Slot,
        f: impl FnOnce(&mut Option<CachedValue>) -> R,
    ) -> R {
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
        let (gone, keep, total) = {
            let mut map = lock(&self.map);
            let (gone, keep) = self.settle(&mut map, &key, &slot, bytes);
            (gone, keep, map.total)
        };
        if !keep {
            *guard = None;
        }
        drop(guard);
        report(&gone, total);
        // Evicted values are freed here, outside both locks.
        drop(gone);
        out
    }

    /// Record `bytes` for `key` (if `slot` is still the one the map holds) and
    /// evict until the total fits. Returns the evicted entries, to be dropped
    /// by the caller after unlocking, and whether `key`'s own value may stay.
    fn settle(
        &self,
        map: &mut CacheMap,
        key: &CacheKey,
        slot: &Slot,
        bytes: usize,
    ) -> (Vec<(CacheKey, MapEntry, Gone)>, bool) {
        let mut gone = Vec::new();
        let current = match map.entries.get_mut(key) {
            Some(e) if Arc::ptr_eq(&e.slot, slot) => e,
            // Evicted (or replaced) while we worked: our value lives in a slot
            // nobody can reach any more. Keeping it would hold memory the
            // account no longer sees.
            _ => return (gone, false),
        };
        map.total = map.total - current.bytes + bytes;
        current.bytes = bytes;
        let mut keep = true;
        if bytes == 0 {
            // Nothing cached (a failed parse, or a value cleared by `f`): drop
            // the entry so the map only ever holds live values. A request
            // already waiting on this slot finds it empty and parses itself.
            if let Some(e) = map.entries.remove(key) {
                gone.push((key.clone(), e, Gone::Forgotten));
            }
        } else if bytes > self.limits().entry_cap {
            if let Some(e) = map.entries.remove(key) {
                map.total -= e.bytes;
                gone.push((key.clone(), e, Gone::TooLarge));
            }
            keep = false;
        }
        let now = Instant::now();
        let idle: Vec<CacheKey> = map
            .entries
            .iter()
            .filter(|(k, e)| *k != key && now.duration_since(e.used_at) >= self.idle_ttl)
            .map(|(k, _)| k.clone())
            .collect();
        for k in idle {
            if let Some(e) = map.entries.remove(&k) {
                map.total -= e.bytes;
                gone.push((k, e, Gone::Idle));
            }
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
                gone.push((victim, e, Gone::Lru));
            }
        }
        if map.total >= self.budget / 2
            && map
                .last_large_report
                .is_none_or(|at| now.duration_since(at) >= LARGE_REPORT_EVERY)
        {
            map.last_large_report = Some(now);
            tracing::info!(
                total_mb = map.total / (1024 * 1024),
                budget_mb = self.budget / (1024 * 1024),
                entries = map.entries.len(),
                "[transcript_cache] holding {} MB of parsed transcripts",
                map.total / (1024 * 1024)
            );
        }
        (gone, keep)
    }

    /// Drop every entry nobody asked for in [`IDLE_TTL`].
    pub fn sweep_idle(&self) {
        let (gone, total) = {
            let mut map = lock(&self.map);
            let now = Instant::now();
            let idle: Vec<CacheKey> = map
                .entries
                .iter()
                .filter(|(_, e)| now.duration_since(e.used_at) >= self.idle_ttl)
                .map(|(k, _)| k.clone())
                .collect();
            let mut gone = Vec::new();
            for k in idle {
                if let Some(e) = map.entries.remove(&k) {
                    map.total -= e.bytes;
                    gone.push((k, e, Gone::Idle));
                }
            }
            (gone, map.total)
        };
        report(&gone, total);
    }

    /// Drop every entry for a file at or under `prefix`, for any agent: for
    /// transcripts that are being deleted, whose content must not stay behind
    /// in memory. A request still holding one of the slots finishes with it,
    /// and its result is not kept.
    pub fn forget_under(&self, prefix: &Path) {
        let (gone, total) = {
            let mut guard = lock(&self.map);
            let map = &mut *guard;
            let doomed: Vec<CacheKey> = map
                .entries
                .keys()
                .filter(|k| k.path.starts_with(prefix))
                .cloned()
                .collect();
            let mut gone = Vec::new();
            for key in doomed {
                if let Some(e) = map.entries.remove(&key) {
                    map.total -= e.bytes;
                    gone.push((key, e, Gone::Forgotten));
                }
            }
            (gone, map.total)
        };
        report(&gone, total);
    }

    /// Total bytes currently accounted.
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

    #[cfg(test)]
    fn with_idle_ttl(mut self, idle_ttl: Duration) -> Self {
        self.idle_ttl = idle_ttl;
        self
    }
}

/// Debug-log what left the cache.
fn report(gone: &[(CacheKey, MapEntry, Gone)], total: usize) {
    for (key, entry, why) in gone {
        if entry.bytes == 0 {
            continue;
        }
        tracing::debug!(
            path = %key.path.display(),
            entry_kb = entry.bytes / 1024,
            reason = ?why,
            cache_kb = total / 1024,
            "[transcript_cache] evicted"
        );
    }
}

// ---------------------------------------------------------------------------
// Heap sizes. A transcript is made of strings and vectors, so those are what
// is measured: each allocation's capacity plus a malloc header, and the
// inline size of every element a vector holds.

/// Bookkeeping the allocator adds to every block (header and rounding).
const ALLOC_OVERHEAD: usize = 16;

fn heap(bytes: usize) -> usize {
    if bytes == 0 {
        0
    } else {
        bytes + ALLOC_OVERHEAD
    }
}

pub(crate) fn string_bytes(s: &String) -> usize {
    heap(s.capacity())
}

pub(crate) fn opt_string_bytes(s: &Option<String>) -> usize {
    s.as_ref().map_or(0, string_bytes)
}

/// The vector's own buffer (not what its elements own).
pub(crate) fn vec_bytes<T>(v: &Vec<T>) -> usize {
    heap(v.capacity() * std::mem::size_of::<T>())
}

/// A string set's buffer and keys.
pub(crate) fn string_set_bytes(s: &HashSet<String>) -> usize {
    heap(s.capacity() * (std::mem::size_of::<String>() + 1))
        + s.iter().map(string_bytes).sum::<usize>()
}

/// What a JSON value owns on the heap.
pub(crate) fn json_value_bytes(v: &serde_json::Value) -> usize {
    use serde_json::Value;
    match v {
        Value::String(s) => string_bytes(s),
        Value::Array(a) => vec_bytes(a) + a.iter().map(json_value_bytes).sum::<usize>(),
        Value::Object(o) => o
            .iter()
            .map(|(k, v)| {
                // One map node per entry, holding the key and the value.
                heap(std::mem::size_of::<String>() + std::mem::size_of::<Value>())
                    + string_bytes(k)
                    + json_value_bytes(v)
            })
            .sum(),
        _ => 0,
    }
}

fn image_bytes(i: &ImageData) -> usize {
    string_bytes(&i.data) + string_bytes(&i.mime_type) + opt_string_bytes(&i.uri)
}

fn agent_stats_bytes(s: &AgentExecutionStats) -> usize {
    opt_string_bytes(&s.agent_type)
        + opt_string_bytes(&s.status)
        + opt_string_bytes(&s.child_session_id)
        + vec_bytes(&s.tool_calls)
        + s.tool_calls
            .iter()
            .map(|c| {
                string_bytes(&c.tool_name)
                    + opt_string_bytes(&c.input_preview)
                    + opt_string_bytes(&c.output_preview)
            })
            .sum::<usize>()
}

/// What one content block owns on the heap (its inline size is counted by the
/// vector holding it).
pub(crate) fn block_bytes(b: &ContentBlock) -> usize {
    match b {
        ContentBlock::Text { text } | ContentBlock::Thinking { text } => string_bytes(text),
        ContentBlock::Image {
            data,
            mime_type,
            uri,
        } => string_bytes(data) + string_bytes(mime_type) + opt_string_bytes(uri),
        ContentBlock::ImageGeneration {
            revised_prompt,
            image,
        } => {
            opt_string_bytes(revised_prompt)
                + image.as_ref().map_or(0, |i| {
                    heap(std::mem::size_of::<ImageData>()) + image_bytes(i)
                })
        }
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            status,
            meta,
        } => {
            opt_string_bytes(tool_use_id)
                + string_bytes(tool_name)
                + opt_string_bytes(input_preview)
                + opt_string_bytes(status)
                + meta.as_ref().map_or(0, json_value_bytes)
        }
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            agent_stats,
            images,
            ..
        } => {
            opt_string_bytes(tool_use_id)
                + opt_string_bytes(output_preview)
                + agent_stats.as_ref().map_or(0, |s| {
                    heap(std::mem::size_of::<AgentExecutionStats>()) + agent_stats_bytes(s)
                })
                + vec_bytes(images)
                + images.iter().map(image_bytes).sum::<usize>()
        }
    }
}

fn blocks_bytes(blocks: &Vec<ContentBlock>) -> usize {
    vec_bytes(blocks) + blocks.iter().map(block_bytes).sum::<usize>()
}

/// What one turn owns on the heap.
pub(crate) fn turn_bytes(t: &MessageTurn) -> usize {
    string_bytes(&t.id)
        + opt_string_bytes(&t.model)
        + opt_string_bytes(&t.agent_message_id)
        + blocks_bytes(&t.blocks)
}

/// What one message owns on the heap.
pub(crate) fn message_bytes(m: &UnifiedMessage) -> usize {
    string_bytes(&m.id)
        + opt_string_bytes(&m.model)
        + opt_string_bytes(&m.agent_message_id)
        + blocks_bytes(&m.content)
}

fn summary_bytes(s: &ConversationSummary) -> usize {
    string_bytes(&s.id)
        + opt_string_bytes(&s.folder_path)
        + opt_string_bytes(&s.folder_name)
        + opt_string_bytes(&s.title)
        + opt_string_bytes(&s.model)
        + opt_string_bytes(&s.git_branch)
        + opt_string_bytes(&s.parent_id)
        + opt_string_bytes(&s.parent_tool_use_id)
        + opt_string_bytes(&s.delegation_call_id)
}

/// A detail's heap size, its own struct included.
pub(crate) fn detail_bytes(d: &ConversationDetail) -> usize {
    heap(std::mem::size_of::<ConversationDetail>())
        + summary_bytes(&d.summary)
        + vec_bytes(&d.turns)
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

    fn value(bytes: usize) -> CachedValue {
        CachedValue {
            value: Box::new(()),
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
    fn an_entry_larger_than_half_the_budget_is_not_kept() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/small", 100);
        put(&cache, "/huge", 501);
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/huge")));
        assert!(cache.contains(AgentType::ClaudeCode, Path::new("/small")));
        assert_eq!(cache.total_bytes(), 100);
        // The oversized value was cleared, not left in an unreachable slot.
        assert!(!has(&cache, "/huge"));
        put(&cache, "/half", 500);
        assert!(cache.contains(AgentType::ClaudeCode, Path::new("/half")));
    }

    #[test]
    fn growing_an_entry_reaccounts_and_evicts_others() {
        let cache = DetailCache::with_budget(1000);
        put(&cache, "/a", 300);
        put(&cache, "/b", 300);
        put(&cache, "/c", 300);
        put(&cache, "/a", 500);
        assert_eq!(cache.total_bytes(), 800);
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/b")));
        put(&cache, "/a", 100);
        assert_eq!(cache.total_bytes(), 400);
    }

    #[test]
    fn idle_entries_are_dropped() {
        let cache = DetailCache::with_budget(10_000).with_idle_ttl(Duration::from_millis(30));
        put(&cache, "/old", 100);
        std::thread::sleep(Duration::from_millis(60));
        put(&cache, "/new", 100);
        // Settling /new swept /old.
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/old")));
        assert_eq!(cache.total_bytes(), 100);
        std::thread::sleep(Duration::from_millis(60));
        cache.sweep_idle();
        assert_eq!(cache.total_bytes(), 0);
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/new")));
    }

    #[test]
    fn if_present_neither_creates_nor_runs_for_an_unknown_file() {
        let cache = DetailCache::with_budget(1000);
        let ran = cache.with_slot_if_present(AgentType::ClaudeCode, Path::new("/a"), |slot| {
            *slot = Some(value(10));
        });
        assert!(ran.is_none());
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/a")));
        put(&cache, "/a", 10);
        let seen = cache.with_slot_if_present(AgentType::ClaudeCode, Path::new("/a"), |slot| {
            slot.is_some()
        });
        assert_eq!(seen, Some(true));
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
    fn forgetting_a_directory_drops_every_entry_under_it() {
        let cache = DetailCache::with_budget(10_000);
        put(&cache, "/p/a/one.jsonl", 100);
        put(&cache, "/p/a/two.jsonl", 100);
        put(&cache, "/p/ab/three.jsonl", 100);
        cache.forget_under(Path::new("/p/a"));
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/p/a/one.jsonl")));
        assert!(!cache.contains(AgentType::ClaudeCode, Path::new("/p/a/two.jsonl")));
        // Path-component prefix, not string prefix.
        assert!(cache.contains(AgentType::ClaudeCode, Path::new("/p/ab/three.jsonl")));
        assert_eq!(cache.total_bytes(), 100);
        cache.forget_under(Path::new("/p/ab/three.jsonl"));
        assert_eq!(cache.total_bytes(), 0);
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
                            std::thread::sleep(Duration::from_millis(30));
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
                rx.recv_timeout(Duration::from_secs(10))
                    .expect("the /fast request must not block on /slow");
                *slot = Some(value(1));
            });
        });
        std::thread::sleep(Duration::from_millis(20));
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
                *slot = Some(value(400));
            });
        });
        started_rx.recv().unwrap();
        // /victim is the least recently used entry (bytes 0 so far); fill the
        // budget so it is evicted while its parse is still running.
        put(&cache, "/a", 400);
        put(&cache, "/b", 400);
        put(&cache, "/c", 400);
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
    fn detail_size_tracks_content() {
        let small = detail_bytes(&detail_of(1));
        let large = detail_bytes(&detail_of(100));
        assert!(large >= 100 * 1000);
        assert!(large > small * 50);
    }
}
