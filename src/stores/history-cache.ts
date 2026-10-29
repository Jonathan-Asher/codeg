import type { DbConversationDetail } from "@/lib/types"
import {
  getHistoryDiskCache,
  historyServerKey,
  remoteServerKey,
} from "@/stores/history-disk-cache"
import { isKeepableDetail, leftDetailCache } from "@/stores/left-detail-cache"
import { shapeKeptDetail, type KeptDetail } from "@/stores/history-snapshot"

/**
 * The client's history cache, in two layers behind one set of calls:
 *
 * - memory (`leftDetailCache`): the windows of sessions whose view went away
 *   (a tab closed or replaced), served synchronously on reopen;
 * - disk (`history-disk-cache`): the same windows, plus those of the sessions
 *   still open, written when the browser is idle, so the sessions of the
 *   restored tabs (and any other recently viewed one) paint at once after a
 *   restart.
 *
 * Either way what is shown first is a copy, and the runtime store refreshes it
 * from the server straight away (stale-while-revalidate).
 */

/** Quiet time after a session's detail changed before it is written. */
const DISK_SAVE_DELAY_MS = 1500

/** Whether this window reads and writes sessions on disk. */
export function historyDiskEnabled(): boolean {
  return historyServerKey() !== null && getHistoryDiskCache() !== null
}

// ─── Reading ─────────────────────────────────────────────────────────────

// Disk reads on their way, by DB id: a view that opens meanwhile waits for
// the same read instead of starting a second.
const diskReads = new Map<number, Promise<DbConversationDetail | null>>()

/**
 * Bring a session's kept window from disk into memory (`leftDetailCache`),
 * where a view opening it finds it synchronously. Resolves to the detail
 * (also when memory already had it), or null.
 *
 * `stillWanted` is asked once the read is back: a session a view already
 * holds, or one deleted meanwhile, must not be put back.
 */
export function warmFromDisk(
  conversationId: number,
  stillWanted: () => boolean = () => true
): Promise<DbConversationDetail | null> {
  if (conversationId <= 0) return Promise.resolve(null)
  const pending = diskReads.get(conversationId)
  if (pending) return pending
  if (leftDetailCache.has(conversationId) || !historyDiskEnabled()) {
    return Promise.resolve(null)
  }
  const server = historyServerKey()
  const disk = getHistoryDiskCache()
  if (server === null || !disk) return Promise.resolve(null)
  const read = disk.load(server, conversationId).then((detail) => {
    if (diskReads.get(conversationId) === read) {
      diskReads.delete(conversationId)
    }
    // Asked to forget this server or session while the read was out.
    if (!detail || historyServerKey() !== server || forgotten.has(read)) {
      return null
    }
    // It is what the disk holds: shown and refreshed, never written back.
    written.add(detail)
    if (stillWanted() && !leftDetailCache.has(conversationId)) {
      leftDetailCache.put(conversationId, detail)
    }
    return detail
  })
  diskReads.set(conversationId, read)
  return read
}

/** A disk read for `conversationId` still on its way, if any. */
export function pendingDiskRead(
  conversationId: number
): Promise<DbConversationDetail | null> | null {
  return diskReads.get(conversationId) ?? null
}

/** Warm several sessions, in order (the active tab first). */
export function prewarmFromDisk(
  conversationIds: readonly number[],
  stillWanted: (conversationId: number) => boolean = () => true
): void {
  if (!historyDiskEnabled()) return
  for (const id of conversationIds) {
    void warmFromDisk(id, () => stillWanted(id))
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────

const pendingSaves = new Map<
  number,
  {
    timer: ReturnType<typeof setTimeout>
    value: DbConversationDetail | KeptDetail
  }
>()
// Details already written (or found not worth keeping): a refresh that came
// back with the same object is not written again.
let written = new WeakSet<object>()

function writeNow(
  conversationId: number,
  value: DbConversationDetail | KeptDetail
): void {
  const server = historyServerKey()
  if (server === null) return
  const source = "json" in value ? value.detail : value
  if (written.has(source)) return
  written.add(source)
  if (!("json" in value) && !isKeepableDetail(value)) return
  const kept = "json" in value ? value : shapeKeptDetail(value)
  if (!kept) return
  void getHistoryDiskCache()?.save(server, conversationId, kept)
}

/**
 * Write a session's served detail to disk once it has been quiet for a moment
 * (the newest one wins), when the browser has time. A mid-turn detail is
 * skipped: the window written before the turn stays until the turn's own
 * refresh lands.
 */
export function scheduleDiskSave(
  conversationId: number,
  value: DbConversationDetail | KeptDetail
): void {
  if (conversationId <= 0 || !historyDiskEnabled()) return
  const pending = pendingSaves.get(conversationId)
  if (pending) clearTimeout(pending.timer)
  const timer = setTimeout(() => {
    const entry = pendingSaves.get(conversationId)
    if (!entry || entry.timer !== timer) return
    pendingSaves.delete(conversationId)
    whenIdle(() => writeNow(conversationId, entry.value))
  }, DISK_SAVE_DELAY_MS)
  pendingSaves.set(conversationId, { timer, value })
}

function whenIdle(run: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    }
  ).requestIdleCallback
  if (idle) idle(run, { timeout: 5000 })
  else setTimeout(run, 0)
}

/** Write every pending save now (the page is going away, or a test). */
export function flushDiskSaves(): void {
  for (const [conversationId, entry] of [...pendingSaves]) {
    clearTimeout(entry.timer)
    pendingSaves.delete(conversationId)
    writeNow(conversationId, entry.value)
  }
}

// A window hidden or closing (an update installs and restarts the app) still
// writes what changed in its last moments.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDiskSaves)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDiskSaves()
  })
}

/**
 * Keep the detail of a session whose view went away: in memory at once (a
 * reopen paints from it), and on disk.
 */
export function keepLeftDetail(
  conversationId: number,
  detail: DbConversationDetail
): void {
  if (conversationId <= 0) return
  const kept = leftDetailCache.put(conversationId, detail)
  if (kept) scheduleDiskSave(conversationId, kept)
}

// ─── Forgetting ──────────────────────────────────────────────────────────

// Reads that were out when their session or server was forgotten.
const forgotten = new WeakSet<Promise<unknown>>()

/** Forget a session everywhere (it was deleted). */
export function forgetConversationHistory(conversationId: number): void {
  leftDetailCache.delete(conversationId)
  const pending = pendingSaves.get(conversationId)
  if (pending) clearTimeout(pending.timer)
  pendingSaves.delete(conversationId)
  const read = diskReads.get(conversationId)
  if (read) forgotten.add(read)
  diskReads.delete(conversationId)
  const server = historyServerKey()
  if (server !== null)
    void getHistoryDiskCache()?.remove(server, conversationId)
}

/**
 * Forget every kept session: this server's (`server`, e.g. its address
 * changed) or every server's (`all`, sign-out).
 */
export function clearHistoryCache(
  scope: "all" | { server: string }
): Promise<void> {
  // This window's memory holds its own server's sessions only.
  if (scope === "all" || scope.server === historyServerKey()) {
    leftDetailCache.clear()
    for (const entry of pendingSaves.values()) clearTimeout(entry.timer)
    pendingSaves.clear()
    for (const read of diskReads.values()) forgotten.add(read)
    diskReads.clear()
    written = new WeakSet()
  }
  const disk = getHistoryDiskCache()
  if (!disk) return Promise.resolve()
  return scope === "all" ? disk.clear() : disk.clearServer(scope.server)
}

const REMOTE_SERVER_KEY_PREFIX = "codeg:history-server:"

/**
 * A remote workspace window bound connection `connectionId` to `baseUrl`. When
 * the connection pointed somewhere else last time (its address was edited),
 * that server's kept sessions are forgotten.
 */
export function noteRemoteServer(connectionId: number, baseUrl: string): void {
  try {
    const key = `${REMOTE_SERVER_KEY_PREFIX}${connectionId}`
    const current = remoteServerKey(baseUrl)
    const previous = localStorage.getItem(key)
    if (previous !== null && previous !== current) {
      void clearHistoryCache({ server: previous })
    }
    if (previous !== current) localStorage.setItem(key, current)
  } catch {
    // No storage: nothing was kept either.
  }
}

/** A remote connection was removed: forget what its server's sessions left. */
export function forgetRemoteServer(
  connectionId: number,
  baseUrl: string | null | undefined
): void {
  try {
    localStorage.removeItem(`${REMOTE_SERVER_KEY_PREFIX}${connectionId}`)
  } catch {
    // Nothing recorded.
  }
  if (baseUrl) void clearHistoryCache({ server: remoteServerKey(baseUrl) })
}

/** Test seam: drop the module state (not what is on disk). */
export function resetHistoryCacheForTests(): void {
  for (const entry of pendingSaves.values()) clearTimeout(entry.timer)
  pendingSaves.clear()
  diskReads.clear()
  written = new WeakSet()
}
