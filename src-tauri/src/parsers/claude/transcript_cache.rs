//! Cached, incremental Claude Code detail parse (behind
//! [`AgentParser::get_conversation_shared`](crate::parsers::AgentParser)).
//!
//! A Claude Code session is one append-only JSONL file plus a
//! `<session>/subagents/` directory whose transcripts feed the Agent cards'
//! tool calls and the session's spend. The detail is a function of those files
//! alone, so it can be kept and reused for as long as they have not changed:
//!
//! * **Unchanged** (same size, mtime and inode; same sub-agent files): the
//!   cached detail is returned as is. Cost: a few `stat`s.
//! * **Only sub-agent files changed** (a background agent still running): the
//!   sub-agent spend is taken back out of the cached detail and redone,
//!   reading only the sub-agent files whose stamp moved. The transcript is not
//!   read.
//! * **The transcript grew** (same inode, not shorter than what was parsed,
//!   mtime not earlier, and the first 16 KB, eight 4 KB samples and the last
//!   64 KB before the old end still the same bytes): only the new bytes are
//!   read and fed into the kept parser state, and the detail is rebuilt from a
//!   copy of that state.
//! * **Anything else** — truncated, rewritten, replaced by another file (a
//!   fork's copy lives at another path, so it is parsed on its own), a
//!   sub-agent file an already-fed record read has changed, or no kept state:
//!   a full parse, exactly as before.
//!
//! ## What is kept, and how much of it
//!
//! The parser state needed to resume (the accumulator, which holds every
//! message) is about as large as the detail itself, so a transcript is never
//! kept twice unless both copies together are small (`Limits::pair_cap`, an
//! eighth of the budget):
//!
//! * **Dormant** (not written in the last 15 minutes): the finished detail.
//! * **Being written, small**: the detail and the parser state.
//! * **Being written, large**: the parser state, plus a *tail view* of the
//!   detail — its last 400 to 1000 turns whole, every earlier turn reduced to
//!   a stub (id, role, timestamp). The stubs are what a window needs to place
//!   itself (offset, alignment, prefix fingerprint, counts), so a windowed
//!   fetch of recent history is served from the view. A request that reads
//!   content further back (an older page, a full fetch) gets a whole detail
//!   rebuilt from the parser state, which is not kept.
//! * **Too large even once** (more than half the budget): not cached; logged.
//!
//! The kept parser state is always the state after the last COMPLETE line. A
//! trailing line without its newline — usually one the agent is still
//! writing, possibly cut mid-character — is fed into the copy the detail is
//! built from, never into the kept state, so it is read again (whole, next
//! time) once it ends. That is also exactly what a fresh parse does with it.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Utc};

use super::{
    assemble_detail, feed_transcript_bytes, finish_session_stats, fold_subagent_spend,
    list_subagent_transcripts, parse_subagent_tool_calls, Assembled, ClaudeRecordAccumulator,
};
use crate::models::{AgentToolCall, AgentType, ConversationDetail, MessageTurn, TurnUsage};
use crate::parsers::detail_cache::{self, CachedValue, DetailCache, FileStamp, Limits};
use crate::parsers::{sanitize_detail, CacheUse, Need, ParseError};

/// Bytes at the start of the transcript that must be unchanged for an append
/// to be parsed incrementally.
const HEAD_WITNESS: usize = 16 * 1024;
/// Bytes just before the previously parsed end that must be unchanged.
const TAIL_WITNESS: usize = 64 * 1024;
/// Samples between the two that must be unchanged too, and their length.
const SPOTS: usize = 8;
const SPOT_LEN: usize = 4 * 1024;
/// A transcript modified this recently is assumed to still be in use, and
/// keeps the state needed to parse its next append incrementally.
const HOT_WINDOW: Duration = Duration::from_secs(15 * 60);

/// How a tail view is cut: it keeps the content of at least `tail_min_turns`
/// trailing turns (a default `tailTurns` fetch is 120 turns, plus up to 200
/// for aligning to a user turn), and grows up to `tail_max_turns` while its
/// content stays under half of `pair_cap`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Policy {
    pub limits: Limits,
    pub tail_min_turns: usize,
    pub tail_max_turns: usize,
}

impl Policy {
    fn new(limits: Limits) -> Self {
        Self {
            limits,
            tail_min_turns: 400,
            tail_max_turns: 1000,
        }
    }
}

/// One sub-agent transcript, as the parent's detail uses it.
pub(crate) struct SubagentParse {
    pub(crate) calls: Vec<AgentToolCall>,
    pub(crate) usage: Option<TurnUsage>,
    pub(crate) started_at: Option<DateTime<Utc>>,
}

impl SubagentParse {
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + detail_cache::vec_bytes(&self.calls)
            + self
                .calls
                .iter()
                .map(|c| {
                    detail_cache::string_bytes(&c.tool_name)
                        + detail_cache::opt_string_bytes(&c.input_preview)
                        + detail_cache::opt_string_bytes(&c.output_preview)
                })
                .sum::<usize>()
    }
}

/// Sub-agent transcripts already read, valid while the file's stamp holds.
/// Shared by the record feed (Agent card tool calls) and the spend
/// attribution, which used to read every sub-agent file twice per parse.
#[derive(Default)]
pub(crate) struct SubagentMemo {
    entries: Mutex<HashMap<PathBuf, (FileStamp, Arc<SubagentParse>)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl SubagentMemo {
    /// The file's stamp now (`None`: it does not exist) and its parse. Reads
    /// the file only when the remembered stamp no longer matches.
    pub(crate) fn read(&self, path: &Path) -> (Option<FileStamp>, Option<Arc<SubagentParse>>) {
        let Some(stamp) = FileStamp::of(path) else {
            lock(&self.entries).remove(path);
            return (None, None);
        };
        if let Some((known, parsed)) = lock(&self.entries).get(path) {
            if known.same_as(&stamp) {
                return (Some(stamp), Some(parsed.clone()));
            }
        }
        let (calls, usage, started_at) = parse_subagent_tool_calls(&path.to_path_buf());
        let parsed = Arc::new(SubagentParse {
            calls,
            usage,
            started_at,
        });
        // Remember only a read the file did not change under. Either way the
        // caller records the stamp from BEFORE the read, so a write that raced
        // it shows up as a changed stamp on the next request.
        if FileStamp::of(path).is_some_and(|after| after.same_as(&stamp)) {
            lock(&self.entries).insert(path.to_path_buf(), (stamp, parsed.clone()));
        }
        (Some(stamp), Some(parsed))
    }

    /// Forget files that are no longer referenced.
    fn retain(&self, keep: impl Fn(&Path) -> bool) {
        lock(&self.entries).retain(|p, _| keep(p));
    }

    fn bytes(&self) -> usize {
        lock(&self.entries)
            .iter()
            .map(|(p, (_, parsed))| p.as_os_str().len() + 64 + parsed.bytes())
            .sum()
    }
}

/// A file and its stamp when last looked at (`None`: it did not exist).
type Stamp = (PathBuf, Option<FileStamp>);

fn same_stamp(a: &Option<FileStamp>, b: &Option<FileStamp>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same_as(b),
        _ => false,
    }
}

fn same_listing(a: &[Stamp], b: &[Stamp]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|((pa, sa), (pb, sb))| pa == pb && same_stamp(sa, sb))
}

/// The sub-agent transcripts the spend attribution reads, with their stamps.
fn subagent_listing(session_path: &Path) -> Vec<Stamp> {
    list_subagent_transcripts(session_path)
        .into_iter()
        .map(|p| {
            let stamp = FileStamp::of(&p);
            (p, stamp)
        })
        .collect()
}

/// Whether every sub-agent file an already-fed record read is as it was.
/// Those reads are baked into the kept state, so a change means a full parse.
fn fed_reads_unchanged(reads: &[Stamp], listing_now: &[Stamp]) -> bool {
    if reads.is_empty() {
        return true;
    }
    let now: HashMap<&Path, &Option<FileStamp>> =
        listing_now.iter().map(|(p, s)| (p.as_path(), s)).collect();
    reads.iter().all(|(path, then)| {
        let current = match now.get(path.as_path()) {
            Some(s) => **s,
            // Not in the listing (not a `.jsonl` in `subagents/`, or gone).
            None => FileStamp::of(path),
        };
        same_stamp(then, &current)
    })
}

/// What it takes to parse only the bytes appended since.
struct Resume {
    /// The accumulator after the last complete line (`consumed` bytes).
    acc: ClaudeRecordAccumulator,
    /// Offset just past the last newline fed into `acc`.
    consumed: u64,
    /// `bytes[0 .. min(HEAD_WITNESS, consumed)]`.
    head: Vec<u8>,
    /// Samples of the bytes between the head and the tail: `(offset, bytes)`.
    spots: Vec<(u64, Vec<u8>)>,
    /// `bytes[consumed - min(TAIL_WITNESS, consumed) .. consumed]`.
    tail: Vec<u8>,
    /// The trailing unterminated line at the last read (often empty).
    partial: Vec<u8>,
    /// Bytes read at the last read: `consumed + partial.len()`.
    watermark: u64,
    /// When the transcript was last seen changing (or its mtime then).
    last_change: SystemTime,
    /// Heap size of `acc`, measured whenever `rebuild` keeps it.
    acc_bytes: usize,
}

impl Resume {
    fn bytes(&self) -> usize {
        self.acc_bytes
            + self.head.capacity()
            + self.tail.capacity()
            + self.partial.capacity()
            + self
                .spots
                .iter()
                .map(|(_, s)| s.capacity() + 32)
                .sum::<usize>()
    }
}

/// The finished detail as cached: whole, or only its tail with every earlier
/// turn reduced to a stub (see the module docs).
struct View {
    detail: Arc<ConversationDetail>,
    /// Turns before this index are stubs.
    complete_from: usize,
    /// For each turn the sub-agent attribution changed: its usage before the
    /// change. Kept for whole views only.
    attribution_undo: Vec<(usize, Option<TurnUsage>)>,
    bytes: usize,
}

struct ClaudeCacheState {
    conversation_id: String,
    /// The transcript's stamp, taken BEFORE it was read. A write that raced
    /// the read therefore leaves a stamp that no longer matches the file, and
    /// the next request revalidates instead of trusting a stale hit.
    stamp: FileStamp,
    /// Sub-agent transcripts the spend attribution used, with their stamps.
    listing: Vec<Stamp>,
    /// Sub-agent transcripts the fed records read (Agent card tool calls).
    fed_reads: Vec<Stamp>,
    context_window_used_tokens: Option<u64>,
    context_window_max_tokens: Option<u64>,
    memo: Arc<SubagentMemo>,
    view: Option<View>,
    resume: Option<Resume>,
}

impl ClaudeCacheState {
    fn bytes(&self) -> usize {
        self.view.as_ref().map_or(0, |v| v.bytes)
            + self.resume.as_ref().map_or(0, Resume::bytes)
            + self.memo.bytes()
            + (self.listing.len() + self.fed_reads.len()) * 160
            + self.conversation_id.capacity()
    }
}

/// Heap size of an accumulator: its messages, and the maps that grow with the
/// transcript.
fn accumulator_bytes(acc: &ClaudeRecordAccumulator) -> usize {
    use detail_cache::{message_bytes, string_bytes, string_set_bytes, vec_bytes};
    let map_entry = std::mem::size_of::<String>() + std::mem::size_of::<usize>() + 1;
    vec_bytes(&acc.messages)
        + acc.messages.iter().map(message_bytes).sum::<usize>()
        + acc.usage_owner_by_message_id.capacity() * map_entry
        + acc
            .usage_owner_by_message_id
            .keys()
            .map(string_bytes)
            .sum::<usize>()
        + string_set_bytes(&acc.seen_compaction_uuids)
        + string_set_bytes(&acc.queued_prompt_ids)
        + (acc.background_acks.len() + acc.background_notifications.len()) * 160
        + acc.subagent_reads.len() * 160
        + acc
            .pending_command
            .as_ref()
            .map_or(0, |(m, _)| message_bytes(m))
}

fn is_hot(mtime: Option<SystemTime>, now: SystemTime) -> bool {
    match mtime.map(|m| now.duration_since(m)) {
        None => false,
        Some(Ok(age)) => age < HOT_WINDOW,
        // Modified "in the future" (clock skew): treat as just written.
        Some(Err(_)) => true,
    }
}

/// How a request was served.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Route {
    /// From the cached detail.
    Hit,
    /// Built from the kept parser state, the transcript unchanged (a tail
    /// view could not serve it, a sub-agent file moved, or it went dormant).
    Rebuild,
    /// The sub-agent spend redone on the cached detail.
    Reattribute,
    /// Only the appended bytes parsed.
    Append,
    /// The whole transcript parsed.
    Full,
    /// Parsed whole and not cached (cache off, or not filling it).
    Uncached,
}

pub(super) struct Served {
    pub detail: Arc<ConversationDetail>,
    pub route: Route,
}

/// The detail for the Claude transcript at `path`, from the process-wide
/// cache when it still describes the file.
pub(super) fn cached_detail(
    path: &Path,
    conversation_id: &str,
    need: Need<'_>,
) -> Result<Arc<ConversationDetail>, ParseError> {
    let started = Instant::now();
    let cache = DetailCache::global();
    if !cache.enabled() {
        return parse_uncached(path, conversation_id);
    }
    let policy = Policy::new(cache.limits());
    let now = SystemTime::now();
    let run = |slot: &mut Option<CachedValue>| {
        let served = refresh(slot, path, conversation_id, need.content_from, now, policy);
        served.map(|s| (s, slot.as_ref().map_or(0, |v| v.bytes)))
    };
    let (served, entry_bytes) = match need.cache {
        CacheUse::Fill => cache.with_slot(AgentType::ClaudeCode, path, run)?,
        CacheUse::IfPresent => match cache.with_slot_if_present(AgentType::ClaudeCode, path, run) {
            Some(served) => served?,
            None => (
                Served {
                    detail: parse_uncached(path, conversation_id)?,
                    route: Route::Uncached,
                },
                0,
            ),
        },
    };
    tracing::debug!(
        path = %path.display(),
        route = ?served.route,
        elapsed_ms = started.elapsed().as_millis() as u64,
        turns = served.detail.turns.len(),
        entry_kb = entry_bytes / 1024,
        cache_kb = cache.total_bytes() / 1024,
        "[transcript_cache] served"
    );
    Ok(served.detail)
}

/// A whole parse that keeps nothing.
fn parse_uncached(
    path: &Path,
    conversation_id: &str,
) -> Result<Arc<ConversationDetail>, ParseError> {
    let listing = subagent_listing(path);
    let parsed = read_whole(path, Arc::default(), false)?;
    let (detail, _) = build(
        parsed.acc,
        &parsed.partial,
        conversation_id,
        parsed.watermark,
        &listing,
        &parsed.memo,
    );
    Ok(Arc::new(detail))
}

/// Bring `slot` up to date with the files on disk and serve the request.
pub(super) fn refresh(
    slot: &mut Option<CachedValue>,
    path: &Path,
    conversation_id: &str,
    content_from: &dyn Fn(&[MessageTurn]) -> usize,
    now: SystemTime,
    policy: Policy,
) -> Result<Served, ParseError> {
    let stamp_now = match fs::metadata(path) {
        Ok(meta) => FileStamp::from_metadata(&meta),
        Err(e) => {
            *slot = None;
            return Err(e.into());
        }
    };
    let listing_now = subagent_listing(path);
    let previous = slot
        .take()
        .and_then(|c| c.value.downcast::<ClaudeCacheState>().ok())
        .map(|state| *state);
    let ctx = Ctx {
        path,
        conversation_id,
        content_from,
        now,
        policy,
    };
    let (served, state) = serve(previous, &ctx, stamp_now, listing_now)?;
    if let Some(state) = state.filter(|s| s.view.is_some() || s.resume.is_some()) {
        *slot = Some(CachedValue {
            bytes: state.bytes(),
            value: Box::new(state),
        });
    }
    Ok(served)
}

/// What every step of a refresh needs to know about the request.
struct Ctx<'a> {
    path: &'a Path,
    conversation_id: &'a str,
    content_from: &'a dyn Fn(&[MessageTurn]) -> usize,
    now: SystemTime,
    policy: Policy,
}

fn serve(
    previous: Option<ClaudeCacheState>,
    ctx: &Ctx<'_>,
    stamp_now: FileStamp,
    listing_now: Vec<Stamp>,
) -> Result<(Served, Option<ClaudeCacheState>), ParseError> {
    let Some(mut state) = previous else {
        return full(None, false, ctx, &listing_now);
    };
    let reusable = state.conversation_id == ctx.conversation_id
        && fed_reads_unchanged(&state.fed_reads, &listing_now);
    if !reusable {
        let changed = !state.stamp.same_as(&stamp_now);
        return full(Some(state), changed, ctx, &listing_now);
    }

    if state.stamp.same_as(&stamp_now) {
        let cold = state
            .resume
            .as_ref()
            .is_some_and(|r| !is_hot(Some(r.last_change), ctx.now));
        let listing_same = same_listing(&state.listing, &listing_now);
        if let Some(view) = state.view.as_ref() {
            let whole = view.complete_from == 0;
            if listing_same && (whole || !cold) {
                let detail = view.detail.clone();
                if (ctx.content_from)(&detail.turns) >= view.complete_from {
                    if cold {
                        // Nobody has written to it for a while: give up the
                        // state it would need to resume.
                        state.resume = None;
                    }
                    return Ok((
                        Served {
                            detail,
                            route: Route::Hit,
                        },
                        Some(state),
                    ));
                }
                // A tail view, and the caller reads further back: a whole
                // detail from the parser state, not kept.
                let resume = state
                    .resume
                    .as_ref()
                    .expect("a tail view always comes with its parser state");
                let (detail, _) = build(
                    resume.acc.clone(),
                    &resume.partial,
                    ctx.conversation_id,
                    resume.watermark,
                    &state.listing,
                    &state.memo,
                );
                return Ok((
                    Served {
                        detail: Arc::new(detail),
                        route: Route::Rebuild,
                    },
                    Some(state),
                ));
            }
            if whole && !listing_same {
                reattribute(&mut state, listing_now);
                if cold {
                    state.resume = None;
                }
                let detail = state.view.as_ref().expect("kept").detail.clone();
                return Ok((
                    Served {
                        detail,
                        route: Route::Reattribute,
                    },
                    Some(state),
                ));
            }
        }
        // A tail view whose sub-agents moved or that went dormant: rebuild
        // from the parser state (whole, and kept whole, once dormant).
        if let Some(resume) = state.resume.take() {
            state.view = None;
            let detail = rebuild(&mut state, resume, !cold, ctx, listing_now);
            return Ok((
                Served {
                    detail,
                    route: Route::Rebuild,
                },
                Some(state),
            ));
        }
        return full(Some(state), false, ctx, &listing_now);
    }

    // The transcript changed.
    if let Some(resume) = state.resume.take() {
        if let Some(resume) = append(&state, resume, ctx.path, &stamp_now, ctx.now)? {
            state.stamp = stamp_now;
            state.view = None;
            let detail = rebuild(&mut state, resume, true, ctx, listing_now);
            return Ok((
                Served {
                    detail,
                    route: Route::Append,
                },
                Some(state),
            ));
        }
    }
    full(Some(state), true, ctx, &listing_now)
}

/// Parse the transcript whole, keeping the sub-agent memo of `previous`. A
/// transcript seen changing while it was cached is in use, whatever its mtime
/// says.
fn full(
    previous: Option<ClaudeCacheState>,
    changed_while_cached: bool,
    ctx: &Ctx<'_>,
    listing: &[Stamp],
) -> Result<(Served, Option<ClaudeCacheState>), ParseError> {
    let memo = previous.map(|s| s.memo).unwrap_or_default();
    let parsed = read_whole(ctx.path, memo, true)?;
    let hot = changed_while_cached || parsed.stamp.is_some_and(|s| is_hot(s.mtime, ctx.now));
    let Some(stamp) = parsed.stamp else {
        // Gone while it was read: nothing to validate a cached copy against.
        let (detail, _) = build(
            parsed.acc,
            &parsed.partial,
            ctx.conversation_id,
            parsed.watermark,
            listing,
            &parsed.memo,
        );
        return Ok((
            Served {
                detail: Arc::new(detail),
                route: Route::Full,
            },
            None,
        ));
    };
    let mut state = ClaudeCacheState {
        conversation_id: ctx.conversation_id.to_string(),
        stamp,
        listing: Vec::new(),
        fed_reads: Vec::new(),
        context_window_used_tokens: None,
        context_window_max_tokens: None,
        memo: parsed.memo,
        view: None,
        resume: None,
    };
    let consumed = parsed.consumed;
    let resume = Resume {
        // Measured once it is known to be kept (`rebuild`).
        acc_bytes: 0,
        acc: parsed.acc,
        consumed,
        head: parsed.head,
        spots: parsed.spots,
        tail: parsed.tail,
        partial: parsed.partial,
        watermark: parsed.watermark,
        last_change: stamp.mtime.unwrap_or(ctx.now),
    };
    let detail = rebuild(&mut state, resume, hot, ctx, listing.to_vec());
    Ok((
        Served {
            detail,
            route: Route::Full,
        },
        Some(state),
    ))
}

/// A whole read of the transcript, fed up to its last complete line.
struct Whole {
    /// Taken before reading (see `ClaudeCacheState::stamp`); `None` if the
    /// file was gone by then.
    stamp: Option<FileStamp>,
    acc: ClaudeRecordAccumulator,
    memo: Arc<SubagentMemo>,
    consumed: u64,
    head: Vec<u8>,
    spots: Vec<(u64, Vec<u8>)>,
    tail: Vec<u8>,
    partial: Vec<u8>,
    watermark: u64,
}

fn read_whole(path: &Path, memo: Arc<SubagentMemo>, witnesses: bool) -> Result<Whole, ParseError> {
    // Stamp before reading, so a write racing the read can only make the
    // entry look stale, never fresh.
    let stamp = FileStamp::of(path);
    // Read whole: `transcript_watermark` must be exactly the bytes this parse
    // consumed (see `ClaudeParser::parse_conversation_detail`).
    let bytes = fs::read(path)?;
    let mut acc = ClaudeRecordAccumulator::new(path.to_path_buf());
    acc.subagent_memo = Some(memo.clone());
    let (complete, partial) = split_at_last_newline(&bytes);
    feed_transcript_bytes(&mut acc, complete);
    let consumed = complete.len();
    let (head, spots, tail) = if witnesses {
        (
            complete[..consumed.min(HEAD_WITNESS)].to_vec(),
            spot_offsets(consumed as u64)
                .map(|at| {
                    let at = at as usize;
                    (at as u64, complete[at..at + SPOT_LEN].to_vec())
                })
                .collect(),
            complete[consumed - consumed.min(TAIL_WITNESS)..].to_vec(),
        )
    } else {
        Default::default()
    };
    Ok(Whole {
        stamp,
        acc,
        memo,
        consumed: consumed as u64,
        head,
        spots,
        tail,
        partial: partial.to_vec(),
        watermark: bytes.len() as u64,
    })
}

/// Where the samples between the head and the tail witnesses sit, for a file
/// whose complete lines end at `consumed`. None when the two meet.
fn spot_offsets(consumed: u64) -> impl Iterator<Item = u64> {
    let start = HEAD_WITNESS as u64;
    let end = consumed.saturating_sub(TAIL_WITNESS as u64);
    let span = end.saturating_sub(start);
    let n: u64 = if span >= (SPOTS * SPOT_LEN) as u64 {
        SPOTS as u64
    } else {
        0
    };
    // Evenly spread, the first at `start`, the last ending at `end`.
    let step = span.saturating_sub(SPOT_LEN as u64) / (SPOTS as u64 - 1);
    (0..n).map(move |i| start + step * i)
}

/// Parse only the bytes appended since `resume` was taken, if the file is
/// provably the old one grown at its end. `None`: it is not, parse it whole.
fn append(
    state: &ClaudeCacheState,
    mut resume: Resume,
    path: &Path,
    stamp_now: &FileStamp,
    now: SystemTime,
) -> Result<Option<Resume>, ParseError> {
    if stamp_now.len < resume.consumed {
        return Ok(None);
    }
    if let (Some(then), Some(ino_now)) = (state.stamp.ino, stamp_now.ino) {
        if then != ino_now {
            return Ok(None);
        }
    }
    if let (Some(then), Some(mtime_now)) = (state.stamp.mtime, stamp_now.mtime) {
        if mtime_now < then {
            return Ok(None);
        }
    }

    let mut file = fs::File::open(path)?;
    // The head must still be the same bytes…
    let mut head = vec![0u8; resume.head.len()];
    if file.read_exact(&mut head).is_err() || head != resume.head {
        return Ok(None);
    }
    // …and the samples in between…
    let mut spot = vec![0u8; SPOT_LEN];
    for (at, bytes) in &resume.spots {
        file.seek(SeekFrom::Start(*at))?;
        if file.read_exact(&mut spot).is_err() || spot != *bytes {
            return Ok(None);
        }
    }
    // …and so must the tail of what was parsed; everything after it is new.
    let tail_start = resume.consumed - resume.tail.len() as u64;
    file.seek(SeekFrom::Start(tail_start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if buf.len() < resume.tail.len() || buf[..resume.tail.len()] != resume.tail[..] {
        return Ok(None);
    }
    let new_bytes = &buf[resume.tail.len()..];
    let (complete, partial) = split_at_last_newline(new_bytes);

    if !complete.is_empty() {
        feed_transcript_bytes(&mut resume.acc, complete);
        let consumed = resume.consumed as usize + complete.len();
        if resume.head.len() < HEAD_WITNESS {
            let want = consumed.min(HEAD_WITNESS) - resume.head.len();
            resume.head.extend_from_slice(&complete[..want]);
        }
        // `buf[..tail.len() + complete.len()]` is the file from the old tail's
        // start to the new consumed end, which always covers the new tail.
        let span = &buf[..resume.tail.len() + complete.len()];
        resume.tail = span[span.len() - consumed.min(TAIL_WITNESS)..].to_vec();
        resume.consumed = consumed as u64;
    }
    resume.partial = partial.to_vec();
    resume.watermark = tail_start + buf.len() as u64;
    resume.last_change = now;
    Ok(Some(resume))
}

/// Build the detail from `resume` (from a copy of it when `keep_resume`),
/// cache what the size policy allows, and return the detail for the caller.
fn rebuild(
    state: &mut ClaudeCacheState,
    resume: Resume,
    keep_resume: bool,
    ctx: &Ctx<'_>,
    listing: Vec<Stamp>,
) -> Arc<ConversationDetail> {
    let (detail, built, resume) = if keep_resume {
        // Keep the copy and build from the original: a copy's strings are
        // allocated to size, the parser's grew as they were filled, so the
        // state that stays in memory is the smaller of the two.
        let mut resume = resume;
        let copy = resume.acc.clone();
        let fed = std::mem::replace(&mut resume.acc, copy);
        resume.acc_bytes = accumulator_bytes(&resume.acc);
        let (detail, built) = build(
            fed,
            &resume.partial,
            ctx.conversation_id,
            resume.watermark,
            &listing,
            &state.memo,
        );
        (detail, built, Some(resume))
    } else {
        let Resume {
            acc,
            partial,
            watermark,
            ..
        } = resume;
        let (detail, built) = build(
            acc,
            &partial,
            ctx.conversation_id,
            watermark,
            &listing,
            &state.memo,
        );
        (detail, built, None)
    };
    state.listing = listing;
    keep(state, detail, built, resume, ctx)
}

/// Decide what to keep of a freshly built detail (see the module docs) and
/// return what the caller reads.
fn keep(
    state: &mut ClaudeCacheState,
    detail: ConversationDetail,
    built: Built,
    resume: Option<Resume>,
    ctx: &Ctx<'_>,
) -> Arc<ConversationDetail> {
    state.fed_reads = built.fed_reads;
    state.context_window_used_tokens = built.context_window_used_tokens;
    state.context_window_max_tokens = built.context_window_max_tokens;
    let (listing, fed_reads) = (&state.listing, &state.fed_reads);
    state
        .memo
        .retain(|p| listing.iter().any(|(q, _)| q == p) || fed_reads.iter().any(|(q, _)| q == p));
    let limits = ctx.policy.limits;
    let detail_bytes = detail_cache::detail_bytes(&detail);

    if let Some(resume) = resume {
        let resume_bytes = resume.bytes();
        if detail_bytes + resume_bytes <= limits.pair_cap.min(limits.entry_cap) {
            let detail = Arc::new(detail);
            state.view = Some(View {
                detail: detail.clone(),
                complete_from: 0,
                attribution_undo: built.attribution_undo,
                bytes: detail_bytes,
            });
            state.resume = Some(resume);
            return detail;
        }
        let from = tail_view_start(&detail.turns, &ctx.policy);
        let view_bytes = tail_view_bytes(&detail, from);
        if from > 0 && view_bytes + resume_bytes <= limits.entry_cap {
            let (view, out) = if (ctx.content_from)(&detail.turns) >= from {
                // The caller reads only the tail: stub the rest in place and
                // share the one result.
                let mut detail = detail;
                stub_before(&mut detail.turns, from);
                let detail = Arc::new(detail);
                (detail.clone(), detail)
            } else {
                (Arc::new(tail_copy(&detail, from)), Arc::new(detail))
            };
            state.view = Some(View {
                bytes: detail_cache::detail_bytes(&view),
                detail: view,
                complete_from: from,
                attribution_undo: Vec::new(),
            });
            state.resume = Some(resume);
            return out;
        }
        tracing::info!(
            path = %ctx.path.display(),
            detail_mb = detail_bytes / (1024 * 1024),
            state_mb = resume_bytes / (1024 * 1024),
            "[transcript_cache] too large to keep its parser state; appends will be parsed whole"
        );
    }

    state.resume = None;
    let detail = Arc::new(detail);
    if detail_bytes <= limits.entry_cap {
        state.view = Some(View {
            detail: detail.clone(),
            complete_from: 0,
            attribution_undo: built.attribution_undo,
            bytes: detail_bytes,
        });
    } else {
        state.view = None;
        tracing::info!(
            path = %ctx.path.display(),
            detail_mb = detail_bytes / (1024 * 1024),
            cap_mb = limits.entry_cap / (1024 * 1024),
            "[transcript_cache] too large to cache; parsed whole on every request"
        );
    }
    detail
}

/// Where a tail view of `turns` starts (0: it would hold them all).
fn tail_view_start(turns: &[MessageTurn], policy: &Policy) -> usize {
    let byte_cap = policy.limits.pair_cap / 2;
    let n = turns.len();
    let mut from = n;
    let mut bytes = 0usize;
    while from > 0 {
        let kept = n - from;
        if kept >= policy.tail_max_turns || (kept >= policy.tail_min_turns && bytes >= byte_cap) {
            break;
        }
        from -= 1;
        bytes += detail_cache::turn_bytes(&turns[from]);
    }
    if from > 0 || n < 2 {
        return from;
    }
    // Fewer turns than the minimum, each of them large: keep what the byte
    // cap allows, at least the last turn and never all of them.
    let mut from = n - 1;
    let mut bytes = detail_cache::turn_bytes(&turns[from]);
    while from > 1 {
        let more = detail_cache::turn_bytes(&turns[from - 1]);
        if bytes + more > byte_cap {
            break;
        }
        bytes += more;
        from -= 1;
    }
    from
}

/// The heap size `detail` will have once the turns before `from` are stubs.
fn tail_view_bytes(detail: &ConversationDetail, from: usize) -> usize {
    let whole = detail_cache::detail_bytes(detail);
    let dropped: usize = detail.turns[..from]
        .iter()
        .map(|t| detail_cache::turn_bytes(t) - detail_cache::string_bytes(&t.id))
        .sum();
    whole - dropped
}

/// Reduce the turns before `from` to stubs: id, role and timestamp (and the
/// other inline fields), no content.
fn stub_before(turns: &mut [MessageTurn], from: usize) {
    for turn in &mut turns[..from] {
        turn.blocks = Vec::new();
        turn.model = None;
        turn.agent_message_id = None;
    }
}

/// A copy of `detail` with the turns before `from` as stubs.
fn tail_copy(detail: &ConversationDetail, from: usize) -> ConversationDetail {
    let turns = detail
        .turns
        .iter()
        .enumerate()
        .map(|(i, t)| {
            if i >= from {
                t.clone()
            } else {
                MessageTurn {
                    id: t.id.clone(),
                    role: t.role.clone(),
                    blocks: Vec::new(),
                    timestamp: t.timestamp,
                    usage: t.usage.clone(),
                    duration_ms: t.duration_ms,
                    model: None,
                    completed_at: t.completed_at,
                    agent_message_id: None,
                    spoken: false,
                }
            }
        })
        .collect();
    ConversationDetail {
        summary: detail.summary.clone(),
        turns,
        session_stats: detail.session_stats.clone(),
        transcript_watermark: detail.transcript_watermark,
    }
}

/// What [`build`] learned besides the detail.
struct Built {
    fed_reads: Vec<Stamp>,
    attribution_undo: Vec<(usize, Option<TurnUsage>)>,
    context_window_used_tokens: Option<u64>,
    context_window_max_tokens: Option<u64>,
}

/// Stage B on a fed accumulator (a copy when the original is kept): the
/// trailing unterminated line, the detail, the route-frame pass, the sub-agent
/// attribution and the session totals.
///
/// The route-frame pass runs BEFORE the attribution here (a fresh parse runs
/// it after, in `RouteSanitized`) so the recorded attribution indices stay
/// valid. The result is the same: the pass only removes user turns, which never
/// carry usage or a duration, and the attribution only picks among assistant
/// turns, whose order and timestamps the pass does not touch.
fn build(
    mut acc: ClaudeRecordAccumulator,
    partial: &[u8],
    conversation_id: &str,
    watermark: u64,
    listing: &[Stamp],
    memo: &SubagentMemo,
) -> (ConversationDetail, Built) {
    if !partial.is_empty() {
        feed_transcript_bytes(&mut acc, partial);
    }
    let fed_reads = std::mem::take(&mut acc.subagent_reads);
    let Assembled {
        mut detail,
        context_window_used_tokens,
        context_window_max_tokens,
    } = assemble_detail(acc, conversation_id, watermark);
    sanitize_detail(&mut detail);
    let attribution_undo = attribute(&mut detail.turns, listing, memo);
    finish_session_stats(
        &mut detail,
        context_window_used_tokens,
        context_window_max_tokens,
    );
    (
        detail,
        Built {
            fed_reads,
            attribution_undo,
            context_window_used_tokens,
            context_window_max_tokens,
        },
    )
}

/// Fold every listed sub-agent transcript's spend into `turns`, the same way
/// `attribute_subagent_usage` does, recording what each changed turn held
/// before its first change.
fn attribute(
    turns: &mut [MessageTurn],
    listing: &[Stamp],
    memo: &SubagentMemo,
) -> Vec<(usize, Option<TurnUsage>)> {
    let mut undo: Vec<(usize, Option<TurnUsage>)> = Vec::new();
    for (path, _) in listing {
        let (_, parsed) = memo.read(path);
        let Some(parsed) = parsed else { continue };
        if let Some((idx, previous)) =
            fold_subagent_spend(turns, parsed.usage.clone(), parsed.started_at)
        {
            if !undo.iter().any(|(i, _)| *i == idx) {
                undo.push((idx, previous));
            }
        }
    }
    undo
}

/// Only sub-agent files changed: take the old attribution out of the whole
/// cached detail, put the new one in, and recount the session totals. The
/// transcript itself is not read.
fn reattribute(state: &mut ClaudeCacheState, listing_now: Vec<Stamp>) {
    let Some(view) = state.view.as_mut() else {
        return;
    };
    // Copy-on-write: a reader still holding the previous detail keeps it.
    let detail = Arc::make_mut(&mut view.detail);
    for (idx, previous) in view.attribution_undo.drain(..) {
        if let Some(turn) = detail.turns.get_mut(idx) {
            turn.usage = previous;
        }
    }
    view.attribution_undo = attribute(&mut detail.turns, &listing_now, &state.memo);
    finish_session_stats(
        detail,
        state.context_window_used_tokens,
        state.context_window_max_tokens,
    );
    let fed_reads = &state.fed_reads;
    state.memo.retain(|p| {
        listing_now.iter().any(|(q, _)| q == p) || fed_reads.iter().any(|(q, _)| q == p)
    });
    state.listing = listing_now;
}

/// `(complete lines, trailing unterminated line)`. The split is at the last
/// `\n`; either side may be empty.
fn split_at_last_newline(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().rposition(|b| *b == b'\n') {
        Some(i) => bytes.split_at(i + 1),
        None => (&[], bytes),
    }
}

#[cfg(test)]
mod tests;
