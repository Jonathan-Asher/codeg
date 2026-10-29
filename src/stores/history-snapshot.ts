import { parseAskQuestionInput } from "@/lib/ask-question"
import { extendPrefixFingerprint, isWindowedDetail } from "@/lib/turn-window"
import type {
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
} from "@/lib/types"

/**
 * Shaping a server-served conversation detail for keeping it after its view
 * is gone: in memory (`leftDetailCache`) and on disk (`historyDiskCache`).
 *
 * A kept copy is only ever the newest part of the transcript: the default
 * tail window (`TAIL_TURNS_DEFAULT` turns, starting at a user turn the way the
 * server aligns its own windows), cut further when it is still too large.
 * Cutting moves the window start forward, so its coordinates are re-derived
 * exactly as the server would have served them (`turns_offset`, the prefix
 * fingerprint chain-extended over the dropped turns, and the rest): the
 * refresh that follows a reopen then verifies the kept window against the
 * transcript like any other.
 */

/** Turns kept per session: the default tail window (`TAIL_TURNS_DEFAULT`). */
export const KEPT_TAIL_TURNS = 120

/** Largest single kept detail, estimated from its JSON length. */
export const KEPT_DETAIL_MAX_BYTES = 16 * 1024 * 1024

/** How far a cut walks to land on a user turn (the server's own bound). */
const ROUND_ALIGN_STEPS = 64

/** A detail with its JSON form, which is also its size estimate. */
export interface KeptDetail {
  detail: DbConversationDetail
  json: string
}

function laterTimestamp(a: string | null, b: string): string | null {
  const bMs = Date.parse(b)
  if (!Number.isFinite(bMs)) return a
  if (a === null) return b
  const aMs = Date.parse(a)
  return Number.isFinite(aMs) && aMs >= bMs ? a : b
}

/**
 * `detail` without its first `drop` turns, its window moved forward to match.
 * Null when the prefix fingerprint cannot be extended (a timestamp that does
 * not parse): a window that cannot be verified is not worth keeping.
 */
export function dropLeadingTurns(
  detail: DbConversationDetail,
  drop: number
): DbConversationDetail | null {
  if (drop <= 0) return detail
  // A legacy full response (old server) has no window to move.
  if (!isWindowedDetail(detail)) return null
  if (drop >= detail.turns.length) return null
  const dropped = detail.turns.slice(0, drop)
  const prefixHash = extendPrefixFingerprint(detail.prefix_hash, dropped)
  if (prefixHash === null) return null
  let assistants = 0
  let maxTs = detail.uncovered_prefix_max_ts ?? null
  for (const turn of dropped) {
    if (turn.role === "assistant") assistants++
    maxTs = laterTimestamp(maxTs, turn.timestamp)
  }
  return {
    ...detail,
    turns: detail.turns.slice(drop),
    turns_offset: detail.turns_offset + drop,
    assistant_turns_before_offset:
      (detail.assistant_turns_before_offset ?? 0) + assistants,
    prefix_hash: prefixHash,
    uncovered_prefix_max_ts: maxTs,
  }
}

/** The first user turn at or before `index` (bounded walk), else `index`. */
function alignBackward(turns: MessageTurn[], index: number): number {
  for (let i = index, steps = 0; i > 0 && steps < ROUND_ALIGN_STEPS; i--) {
    if (turns[i].role === "user") return i
    steps++
  }
  return index
}

/** The first user turn at or after `index` (bounded walk), else `index`. */
function alignForward(turns: MessageTurn[], index: number): number {
  for (
    let i = index, steps = 0;
    i < turns.length && steps < ROUND_ALIGN_STEPS;
    i++
  ) {
    if (turns[i].role === "user") return i
    steps++
  }
  return index
}

/**
 * The newest `maxTurns` turns of `detail` (more when the cut walks back to a
 * user turn), as a window the server could have served. Returns `detail`
 * itself when it already fits.
 */
export function trimToTail(
  detail: DbConversationDetail,
  maxTurns: number = KEPT_TAIL_TURNS
): DbConversationDetail | null {
  const excess = detail.turns.length - maxTurns
  // A legacy full response (old server) has no window to cut: kept whole
  // when it fits the byte budget, like before windows existed.
  if (excess <= 0 || !isWindowedDetail(detail)) return detail
  return dropLeadingTurns(detail, alignBackward(detail.turns, excess))
}

/**
 * `detail` cut down to its tail window and to `maxBytes`, with its JSON form.
 * Null when nothing worth keeping fits: a mid-turn snapshot (its in-flight
 * suppression would be stale by the time it came back), a legacy response too
 * large to keep whole, or a newest round larger than the budget on its own.
 */
export function shapeKeptDetail(
  detail: DbConversationDetail,
  options?: { maxTurns?: number; maxBytes?: number }
): KeptDetail | null {
  if (detail.in_flight_user_turn_id != null) return null
  const maxBytes = options?.maxBytes ?? KEPT_DETAIL_MAX_BYTES
  const tail = trimToTail(detail, options?.maxTurns ?? KEPT_TAIL_TURNS)
  if (!tail) return null
  let json: string
  try {
    json = JSON.stringify(tail)
  } catch {
    return null
  }
  if (json.length <= maxBytes) return { detail: tail, json }

  // Too large: keep the newest turns that fit, measured one by one.
  const sizes = tail.turns.map((turn) => JSON.stringify(turn).length)
  const overhead = json.length - sizes.reduce((sum, n) => sum + n, 0)
  let budget = maxBytes - overhead
  let keepFrom = tail.turns.length
  while (keepFrom > 0 && budget - sizes[keepFrom - 1] >= 0) {
    budget -= sizes[keepFrom - 1]
    keepFrom--
  }
  if (keepFrom >= tail.turns.length) return null
  const cut = dropLeadingTurns(tail, alignForward(tail.turns, keepFrom))
  if (!cut || cut.turns.length === 0) return null
  const cutJson = JSON.stringify(cut)
  return cutJson.length <= maxBytes ? { detail: cut, json: cutJson } : null
}

// ─── Secret answers ──────────────────────────────────────────────────────

function asksForSecret(block: ContentBlock): boolean {
  if (block.type !== "tool_use") return false
  const input = block.input_preview
  // Cheap gate before parsing: both spellings contain it.
  if (!input || !input.includes("ecret")) return false
  return parseAskQuestionInput(input).some((q) => q.isSecret)
}

/**
 * `detail` with every answer to a question marked secret taken out (the
 * result of the question's tool call; codex marks API keys and the like this
 * way). What is written to disk never holds them. The same object when there
 * is nothing to take out.
 */
export function withoutSecretAnswers(
  detail: DbConversationDetail
): DbConversationDetail {
  const secretIds = new Set<string>()
  let anyAnonymous = false
  for (const turn of detail.turns) {
    for (const block of turn.blocks) {
      if (block.type !== "tool_use" || !asksForSecret(block)) continue
      if (block.tool_use_id) secretIds.add(block.tool_use_id)
      else anyAnonymous = true
    }
  }
  if (secretIds.size === 0 && !anyAnonymous) return detail

  // A secret question asked by a call with no id: its answer is the next
  // result with no id.
  let anonymousPending = 0
  let changed = false
  const turns = detail.turns.map((turn) => {
    let turnChanged = false
    const blocks = turn.blocks.map((block) => {
      if (block.type === "tool_use") {
        if (!block.tool_use_id && anyAnonymous && asksForSecret(block)) {
          anonymousPending++
        }
        return block
      }
      if (block.type !== "tool_result") return block
      let secret = false
      if (block.tool_use_id != null) {
        secret = secretIds.has(block.tool_use_id)
      } else if (anonymousPending > 0) {
        secret = true
        anonymousPending--
      }
      if (!secret) return block
      turnChanged = true
      return { ...block, output_preview: null }
    })
    if (!turnChanged) return turn
    changed = true
    return { ...turn, blocks }
  })
  return changed ? { ...detail, turns } : detail
}
