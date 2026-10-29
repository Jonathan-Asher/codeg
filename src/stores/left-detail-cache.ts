import type { DbConversationDetail } from "@/lib/types"
import { shapeKeptDetail, type KeptDetail } from "@/stores/history-snapshot"

/**
 * Details of sessions the user recently left (L0 of the offline plan): going
 * back to one paints it at once, and a background refresh brings it up to
 * date — instead of a spinner while 120 turns download and parse again.
 *
 * Only what the server served is kept (`detail`: its turns, window
 * coordinates, summary and stats), never optimistic or local turns, and never
 * a detail fetched mid-turn (`in_flight_user_turn_id`): its in-flight
 * suppression would be stale by the time it came back. A kept detail is cut
 * to its tail window (`shapeKeptDetail`): history paged in above it is read
 * again when the user scrolls back up. The disk layer behind it
 * (`history-disk-cache`) keeps the same windows across restarts.
 */
export interface DetailCache {
  /**
   * Keep `detail` for `conversationId` (a DB id), newest last. Returns what
   * was kept, with its JSON form (which a disk write reuses), or null.
   */
  put(
    conversationId: number,
    detail: DbConversationDetail | KeptDetail
  ): KeptDetail | null
  /** Hand the kept detail back and forget it (it is live again). */
  take(conversationId: number): DbConversationDetail | null
  /** Whether a detail is kept for `conversationId` (without taking it). */
  has(conversationId: number): boolean
  delete(conversationId: number): void
  clear(): void
  readonly size: number
}

/** Sessions kept. */
export const LEFT_DETAIL_MAX_ENTRIES = 12
/** Budget across them, estimated from their JSON length. */
export const LEFT_DETAIL_MAX_BYTES = 50 * 1024 * 1024

export function isKeepableDetail(detail: DbConversationDetail): boolean {
  return detail.in_flight_user_turn_id == null
}

function isKept(value: DbConversationDetail | KeptDetail): value is KeptDetail {
  return typeof (value as KeptDetail).json === "string"
}

export function createMemoryDetailCache(options?: {
  maxEntries?: number
  maxBytes?: number
}): DetailCache {
  const maxEntries = options?.maxEntries ?? LEFT_DETAIL_MAX_ENTRIES
  const maxBytes = options?.maxBytes ?? LEFT_DETAIL_MAX_BYTES
  // Map iteration order is insertion order: the first entry is the oldest.
  const entries = new Map<
    number,
    { detail: DbConversationDetail; bytes: number }
  >()
  let total = 0

  const remove = (conversationId: number) => {
    const entry = entries.get(conversationId)
    if (!entry) return null
    entries.delete(conversationId)
    total -= entry.bytes
    return entry
  }

  return {
    put(conversationId, value) {
      remove(conversationId)
      const kept = isKept(value)
        ? value
        : isKeepableDetail(value)
          ? shapeKeptDetail(value, { maxBytes })
          : null
      if (!kept || kept.json.length > maxBytes) return null
      entries.set(conversationId, {
        detail: kept.detail,
        bytes: kept.json.length,
      })
      total += kept.json.length
      while (entries.size > maxEntries || total > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
      return kept
    },
    take(conversationId) {
      return remove(conversationId)?.detail ?? null
    },
    has(conversationId) {
      return entries.has(conversationId)
    },
    delete(conversationId) {
      remove(conversationId)
    },
    clear() {
      entries.clear()
      total = 0
    },
    get size() {
      return entries.size
    },
  }
}

/** The window's L0 cache. */
export const leftDetailCache: DetailCache = createMemoryDetailCache()
