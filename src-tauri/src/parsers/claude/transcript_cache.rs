//! Cached, incremental Claude Code detail parse (behind
//! [`AgentParser::get_conversation_shared`]).
//!
//! A Claude Code session is one append-only JSONL file plus a
//! `<session>/subagents/` directory whose transcripts feed the Agent cards'
//! tool calls and the session's spend. The detail is a function of those files
//! alone, so it can be kept and reused for as long as they have not changed:
//!
//! * **Unchanged** (same size, mtime and inode; same sub-agent files): the
//!   cached detail is returned as is. Cost: a few `stat`s.
//! * **Only sub-agent files changed** (a background agent still running): the
//!   previous sub-agent attribution is taken back out and redone, reading only
//!   the sub-agent files whose stamp moved. The transcript is not read.
//! * **The transcript grew** (same inode, not shorter than what was parsed,
//!   and the first 16 KB and the last 64 KB before the old end are still the
//!   same bytes): only the new bytes are read and fed into the kept parser
//!   state, then the detail is rebuilt from a copy of that state.
//! * **Anything else** — truncated, rewritten, replaced by another file, a
//!   sub-agent file an already-fed record read has changed, or no kept state:
//!   a full parse, exactly as before.
//!
//! The parser state needed to resume (the accumulator, which holds every
//! message) is about as large as the detail itself, so it is only kept for
//! transcripts that are being written: ones modified in the last 15 minutes
//! when parsed, or seen changing since. A dormant conversation costs one
//! copy of its detail; the one being worked in costs two.
//!
//! The kept state is always the state after the last COMPLETE line. A trailing
//! line without its newline — usually one the agent is still writing, possibly
//! cut mid-character — is fed into the copy the detail is built from, never
//! into the kept state, so it is read again (whole, next time) once it ends.
//! That is also exactly what a fresh parse does with it.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};

use super::{
    assemble_detail, feed_transcript_bytes, finish_session_stats, fold_subagent_spend,
    list_subagent_transcripts, parse_subagent_tool_calls, Assembled, ClaudeRecordAccumulator,
};
use crate::models::{AgentToolCall, AgentType, ConversationDetail, TurnUsage};
use crate::parsers::detail_cache::{self, CachedDetail, DetailCache, FileStamp};
use crate::parsers::{sanitize_detail, ParseError};

/// Bytes at the start of the transcript that must be unchanged for an append
/// to be parsed incrementally.
const HEAD_WITNESS: usize = 16 * 1024;
/// Bytes just before the previously parsed end that must be unchanged.
const TAIL_WITNESS: usize = 64 * 1024;
/// A transcript modified this recently is assumed to still be in use, and
/// keeps the state needed to parse its next append incrementally.
const HOT_WINDOW: Duration = Duration::from_secs(15 * 60);

/// One sub-agent transcript, as the parent's detail uses it.
pub(crate) struct SubagentParse {
    pub(crate) calls: Vec<AgentToolCall>,
    pub(crate) usage: Option<TurnUsage>,
    pub(crate) started_at: Option<DateTime<Utc>>,
}

impl SubagentParse {
    fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .calls
                .iter()
                .map(|c| {
                    std::mem::size_of::<AgentToolCall>()
                        + c.tool_name.len()
                        + c.input_preview.as_deref().map_or(0, str::len)
                        + c.output_preview.as_deref().map_or(0, str::len)
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
            .map(|(p, (_, parsed))| p.as_os_str().len() + parsed.bytes())
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
    /// `bytes[consumed - min(TAIL_WITNESS, consumed) .. consumed]`.
    tail: Vec<u8>,
    /// When the transcript was last seen changing (or its mtime then).
    last_change: SystemTime,
    /// Approximate heap size of `acc`.
    acc_bytes: usize,
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
    /// For each turn the attribution changed: its usage before the change.
    attribution_undo: Vec<(usize, Option<TurnUsage>)>,
    context_window_used_tokens: Option<u64>,
    context_window_max_tokens: Option<u64>,
    memo: Arc<SubagentMemo>,
    resume: Option<Resume>,
    detail_bytes: usize,
}

impl ClaudeCacheState {
    fn bytes(&self) -> usize {
        self.detail_bytes
            + self.memo.bytes()
            + self
                .resume
                .as_ref()
                .map_or(0, |r| r.acc_bytes + r.head.len() + r.tail.len())
            + (self.listing.len() + self.fed_reads.len()) * 128
    }
}

fn accumulator_bytes(acc: &ClaudeRecordAccumulator) -> usize {
    acc.messages
        .iter()
        .map(detail_cache::message_bytes)
        .sum::<usize>()
        + acc.subagent_reads.len() * 128
}

fn is_hot(mtime: Option<SystemTime>, now: SystemTime) -> bool {
    match mtime.map(|m| now.duration_since(m)) {
        None => false,
        Some(Ok(age)) => age < HOT_WINDOW,
        // Modified "in the future" (clock skew): treat as just written.
        Some(Err(_)) => true,
    }
}

/// The detail for the Claude transcript at `path`, from the process-wide
/// cache when it still describes the file.
pub(super) fn cached_detail(
    path: &Path,
    conversation_id: &str,
) -> Result<Arc<ConversationDetail>, ParseError> {
    let cache = DetailCache::global();
    if !cache.enabled() {
        let listing = subagent_listing(path);
        let (detail, _) = full_parse(path, conversation_id, &listing, Arc::default(), false, None)?;
        return Ok(detail);
    }
    cache.with_slot(AgentType::ClaudeCode, path, |slot| {
        refresh(slot, path, conversation_id, SystemTime::now())
    })
}

// Which way the last `refresh` on this thread went (tests only).
#[cfg(test)]
thread_local! {
    static LAST_ROUTE: std::cell::Cell<&'static str> = const { std::cell::Cell::new("") };
}

#[cfg(test)]
fn note(route: &'static str) {
    LAST_ROUTE.with(|r| r.set(route));
}

#[cfg(test)]
fn last_route() -> &'static str {
    LAST_ROUTE.with(|r| r.get())
}

/// How a cached entry can be brought up to date.
enum Plan {
    /// Nothing changed.
    Hit,
    /// Only sub-agent files changed.
    Reattribute,
    /// The transcript changed and there is state to resume from.
    Append,
    /// Parse the transcript whole.
    Full,
}

fn plan(
    slot: &Option<CachedDetail>,
    conversation_id: &str,
    stamp_now: &FileStamp,
    listing_now: &[Stamp],
) -> Plan {
    let Some(state) = slot
        .as_ref()
        .and_then(|c| c.state.downcast_ref::<ClaudeCacheState>())
    else {
        return Plan::Full;
    };
    let reusable = state.conversation_id == conversation_id
        && fed_reads_unchanged(&state.fed_reads, listing_now);
    if !reusable {
        Plan::Full
    } else if state.stamp.same_as(stamp_now) {
        if same_listing(&state.listing, listing_now) {
            Plan::Hit
        } else {
            Plan::Reattribute
        }
    } else if state.resume.is_some() {
        Plan::Append
    } else {
        Plan::Full
    }
}

/// Bring `slot` up to date with the files on disk and return its detail.
fn refresh(
    slot: &mut Option<CachedDetail>,
    path: &Path,
    conversation_id: &str,
    now: SystemTime,
) -> Result<Arc<ConversationDetail>, ParseError> {
    let stamp_now = match fs::metadata(path) {
        Ok(meta) => FileStamp::from_metadata(&meta),
        Err(e) => {
            *slot = None;
            return Err(e.into());
        }
    };
    let listing_now = subagent_listing(path);

    match (
        plan(slot, conversation_id, &stamp_now, &listing_now),
        slot.as_mut(),
    ) {
        (Plan::Hit, Some(cached)) => {
            if let Some(state) = cached.state.downcast_mut::<ClaudeCacheState>() {
                // Let a transcript nobody has written to for a while give up
                // the state it would need to resume.
                if state
                    .resume
                    .as_ref()
                    .is_some_and(|r| !is_hot(Some(r.last_change), now))
                {
                    state.resume = None;
                    cached.bytes = state.bytes();
                }
            }
            #[cfg(test)]
            note("hit");
            return Ok(cached.detail.clone());
        }
        (Plan::Reattribute, Some(cached)) => {
            reattribute(cached, listing_now);
            #[cfg(test)]
            note("reattribute");
            return Ok(cached.detail.clone());
        }
        (Plan::Append, Some(cached)) => {
            if let Some(state) = cached.state.downcast_mut::<ClaudeCacheState>() {
                if let Some(resume) = state.resume.take() {
                    let appended = append(
                        state,
                        resume,
                        path,
                        conversation_id,
                        &stamp_now,
                        &listing_now,
                        now,
                    )?;
                    if let Appended::Done(detail) = appended {
                        cached.bytes = state.bytes();
                        cached.detail = detail;
                        #[cfg(test)]
                        note("append");
                        return Ok(cached.detail.clone());
                    }
                }
            }
        }
        _ => {}
    }

    // Not reusable as it stands: parse it whole, keeping only the memo.
    let previous_state: Option<ClaudeCacheState> = slot
        .take()
        .and_then(|c| c.state.downcast::<ClaudeCacheState>().ok())
        .map(|state| *state);
    // A file seen changing since it was cached is in use, whatever its mtime.
    let changed_while_cached = previous_state.is_some();
    let memo = previous_state.map(|s| s.memo).unwrap_or_default();
    let keep_resume = changed_while_cached || is_hot(stamp_now.mtime, now);
    let (detail, state) = full_parse(
        path,
        conversation_id,
        &listing_now,
        memo,
        keep_resume,
        Some(now),
    )?;
    if let Some(state) = state {
        let bytes = state.bytes();
        *slot = Some(CachedDetail {
            detail: detail.clone(),
            state: Box::new(state),
            bytes,
        });
    }
    #[cfg(test)]
    note("full");
    Ok(detail)
}

/// Parse the whole transcript. Returns the detail and, unless `now` is `None`
/// (cache disabled), the state to cache with it.
fn full_parse(
    path: &Path,
    conversation_id: &str,
    listing: &[Stamp],
    memo: Arc<SubagentMemo>,
    keep_resume: bool,
    now: Option<SystemTime>,
) -> Result<(Arc<ConversationDetail>, Option<ClaudeCacheState>), ParseError> {
    // Stamp before reading, so a write racing the read can only make the
    // entry look stale, never fresh (see `ClaudeCacheState::stamp`).
    let stamp = FileStamp::of(path);
    let bytes = fs::read(path)?;
    let watermark = bytes.len() as u64;

    let mut acc = ClaudeRecordAccumulator::new(path.to_path_buf());
    acc.subagent_memo = Some(memo.clone());

    let (complete, partial) = split_at_last_newline(&bytes);
    feed_transcript_bytes(&mut acc, complete);

    let keep_resume = keep_resume && now.is_some();
    let (output_acc, resume) = if keep_resume {
        let consumed = complete.len();
        let head = complete[..consumed.min(HEAD_WITNESS)].to_vec();
        let tail = complete[consumed - consumed.min(TAIL_WITNESS)..].to_vec();
        let out = acc.clone();
        let acc_bytes = accumulator_bytes(&acc);
        let last_change = stamp
            .and_then(|s| s.mtime)
            .unwrap_or_else(|| now.unwrap_or_else(SystemTime::now));
        (
            out,
            Some(Resume {
                acc,
                consumed: consumed as u64,
                head,
                tail,
                last_change,
                acc_bytes,
            }),
        )
    } else {
        (acc, None)
    };

    let (detail, built) = build(
        output_acc,
        partial,
        conversation_id,
        watermark,
        listing,
        &memo,
    );
    let detail = Arc::new(detail);
    let Some(stamp) = stamp.filter(|_| now.is_some()) else {
        return Ok((detail, None));
    };
    memo.retain(|p| {
        listing.iter().any(|(q, _)| q == p) || built.fed_reads.iter().any(|(q, _)| q == p)
    });
    let state = ClaudeCacheState {
        conversation_id: conversation_id.to_string(),
        stamp,
        listing: listing.to_vec(),
        fed_reads: built.fed_reads,
        attribution_undo: built.attribution_undo,
        context_window_used_tokens: built.context_window_used_tokens,
        context_window_max_tokens: built.context_window_max_tokens,
        memo,
        resume,
        detail_bytes: detail_cache::detail_bytes(&detail),
    };
    Ok((detail, Some(state)))
}

enum Appended {
    Done(Arc<ConversationDetail>),
    /// The file is not the old one plus appended bytes: parse it whole.
    NotAnAppend,
}

/// Parse only the bytes appended since `resume` was taken, if the file is
/// provably the old one grown at its end.
fn append(
    state: &mut ClaudeCacheState,
    mut resume: Resume,
    path: &Path,
    conversation_id: &str,
    stamp_now: &FileStamp,
    listing_now: &[Stamp],
    now: SystemTime,
) -> Result<Appended, ParseError> {
    if stamp_now.len < resume.consumed {
        return Ok(Appended::NotAnAppend);
    }
    if let (Some(then), Some(now_ino)) = (state.stamp.ino, stamp_now.ino) {
        if then != now_ino {
            return Ok(Appended::NotAnAppend);
        }
    }

    let mut file = fs::File::open(path)?;
    // The head must still be the same bytes…
    let mut head = vec![0u8; resume.head.len()];
    if file.read_exact(&mut head).is_err() || head != resume.head {
        return Ok(Appended::NotAnAppend);
    }
    // …and so must the tail of what was parsed; everything after it is new.
    let tail_start = resume.consumed - resume.tail.len() as u64;
    file.seek(SeekFrom::Start(tail_start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    if buf.len() < resume.tail.len() || buf[..resume.tail.len()] != resume.tail[..] {
        return Ok(Appended::NotAnAppend);
    }
    let watermark = tail_start + buf.len() as u64;
    let new_bytes = &buf[resume.tail.len()..];
    let (complete, partial) = split_at_last_newline(new_bytes);

    if !complete.is_empty() {
        feed_transcript_bytes(&mut resume.acc, complete);
        let old_consumed = resume.consumed as usize;
        let consumed = old_consumed + complete.len();
        if resume.head.len() < HEAD_WITNESS {
            let want = consumed.min(HEAD_WITNESS) - resume.head.len();
            resume.head.extend_from_slice(&complete[..want]);
        }
        // `buf[..tail.len() + complete.len()]` is the file from the old tail's
        // start to the new consumed end, which always covers the new tail.
        let span = &buf[..resume.tail.len() + complete.len()];
        resume.tail = span[span.len() - consumed.min(TAIL_WITNESS)..].to_vec();
        resume.consumed = consumed as u64;
        resume.acc_bytes = accumulator_bytes(&resume.acc);
    }
    resume.last_change = now;

    let (detail, built) = build(
        resume.acc.clone(),
        partial,
        conversation_id,
        watermark,
        listing_now,
        &state.memo,
    );
    state.stamp = *stamp_now;
    state.listing = listing_now.to_vec();
    state.fed_reads = built.fed_reads;
    state.attribution_undo = built.attribution_undo;
    state.context_window_used_tokens = built.context_window_used_tokens;
    state.context_window_max_tokens = built.context_window_max_tokens;
    state.detail_bytes = detail_cache::detail_bytes(&detail);
    state.resume = Some(resume);
    Ok(Appended::Done(Arc::new(detail)))
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
    turns: &mut [crate::models::MessageTurn],
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

/// Only sub-agent files changed: take the old attribution out, put the new one
/// in, and recount the session totals. The transcript itself is not read.
fn reattribute(cached: &mut CachedDetail, listing_now: Vec<Stamp>) {
    let Some(state) = cached.state.downcast_mut::<ClaudeCacheState>() else {
        return;
    };
    // Copy-on-write: a reader still holding the previous detail keeps it.
    let detail = Arc::make_mut(&mut cached.detail);
    for (idx, previous) in state.attribution_undo.drain(..) {
        if let Some(turn) = detail.turns.get_mut(idx) {
            turn.usage = previous;
        }
    }
    state.attribution_undo = attribute(&mut detail.turns, &listing_now, &state.memo);
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
    cached.bytes = state.bytes();
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
