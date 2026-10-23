import type { DbConversationDetail } from "@/lib/types"

/**
 * Details of sessions the user recently left (L0 of the offline plan): going
 * back to one paints it at once, and a background refresh brings it up to
 * date — instead of a spinner while 120 turns download and parse again.
 *
 * Only what the server served is kept (`detail`: its turns, window
 * coordinates, summary and stats), never optimistic or local turns, and never
 * a detail fetched mid-turn (`in_flight_user_turn_id`): its in-flight
 * suppression would be stale by the time it came back. Phase 3 puts a disk
 * layer behind the same interface.
 */
export interface DetailCache {
  /** Keep `detail` for `conversationId` (a DB id), newest last. */
  put(conversationId: number, detail: DbConversationDetail): void
  /** Hand the kept detail back and forget it (it is live again). */
  take(conversationId: number): DbConversationDetail | null
  delete(conversationId: number): void
  clear(): void
  readonly size: number
}

/** Sessions kept. */
export const LEFT_DETAIL_MAX_ENTRIES = 8
/** Budget across them, estimated from their JSON length. */
export const LEFT_DETAIL_MAX_BYTES = 150 * 1024 * 1024

function estimateBytes(detail: DbConversationDetail): number {
  try {
    return JSON.stringify(detail).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function isKeepableDetail(detail: DbConversationDetail): boolean {
  return detail.in_flight_user_turn_id == null
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
    put(conversationId, detail) {
      remove(conversationId)
      if (!isKeepableDetail(detail)) return
      const bytes = estimateBytes(detail)
      if (bytes > maxBytes) return
      entries.set(conversationId, { detail, bytes })
      total += bytes
      while (entries.size > maxEntries || total > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
    },
    take(conversationId) {
      return remove(conversationId)?.detail ?? null
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
