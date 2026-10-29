import type { DbConversationDetail } from "@/lib/types"
import {
  getServerBaseUrl,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"
import {
  shapeKeptDetail,
  withoutSecretAnswers,
  type KeptDetail,
} from "@/stores/history-snapshot"

/**
 * The last viewed window of recently viewed sessions, on disk (IndexedDB in
 * both the desktop webview and the browser), so a session paints at once
 * after a restart too, before the server has read its transcript again.
 *
 * Entries are keyed by the server they came from and the session's id there,
 * so two servers (the local app and a remote workspace share one webview
 * origin) never see each other's sessions. Only what the server served is
 * written, cut to its tail window (`shapeKeptDetail`), never a mid-turn
 * snapshot and never the answer to a question marked secret. The budget is
 * shared by every server and evicts the least recently used session first.
 */

/** Budget across every entry, estimated from their JSON length. */
export const HISTORY_DISK_MAX_BYTES = 100 * 1024 * 1024
/** Sessions kept. */
export const HISTORY_DISK_MAX_ENTRIES = 64
/**
 * Largest single entry. Smaller than what memory keeps: a restart reads the
 * restored tabs back while the app is still starting, and in a webview the
 * read crosses into the storage process, so its cost grows with the entry
 * (~400 ms for 7 MB on the M1 box, mid-startup). The newest turns paint the
 * view, the refresh brings whatever came after them, and older history pages
 * in as the reader scrolls up.
 */
export const HISTORY_DISK_ENTRY_MAX_BYTES = 2 * 1024 * 1024
/** Bumped when the stored shape changes: older entries are then ignored. */
const ENTRY_FORMAT = 1

export interface DiskEntryMeta {
  key: string
  server: string
  conversationId: number
  bytes: number
  savedAt: number
  usedAt: number
  format: number
}

/** Storage under the cache: IndexedDB in the app, a map in tests. */
export interface DiskBackend {
  read(key: string): Promise<{ meta: DiskEntryMeta; json: string } | null>
  write(meta: DiskEntryMeta, json: string): Promise<void>
  touch(key: string, usedAt: number): Promise<void>
  remove(keys: string[]): Promise<void>
  list(): Promise<DiskEntryMeta[]>
  clear(): Promise<void>
}

export interface HistoryDiskCache {
  /**
   * The kept detail with the JSON it was read from (its size, for the memory
   * budget, without serializing it again), or null: none, unreadable, or
   * written by an older format.
   */
  load(server: string, conversationId: number): Promise<KeptDetail | null>
  /** Write `detail` (shaped and stripped of secrets here). False when not kept. */
  save(
    server: string,
    conversationId: number,
    detail: DbConversationDetail | KeptDetail
  ): Promise<boolean>
  remove(server: string, conversationId: number): Promise<void>
  /** Forget every session of one server. */
  clearServer(server: string): Promise<void>
  /** Forget everything (sign-out). */
  clear(): Promise<void>
}

export function historyEntryKey(
  server: string,
  conversationId: number
): string {
  return `${server}#${conversationId}`
}

function isKept(value: DbConversationDetail | KeptDetail): value is KeptDetail {
  return typeof (value as KeptDetail).json === "string"
}

function looksLikeDetail(
  value: unknown,
  conversationId: number
): value is DbConversationDetail {
  if (!value || typeof value !== "object") return false
  const detail = value as Partial<DbConversationDetail>
  return (
    Array.isArray(detail.turns) &&
    detail.summary != null &&
    detail.summary.id === conversationId
  )
}

export function createHistoryDiskCache(
  backend: DiskBackend,
  options?: {
    maxBytes?: number
    maxEntries?: number
    maxEntryBytes?: number
    now?: () => number
  }
): HistoryDiskCache {
  const maxBytes = options?.maxBytes ?? HISTORY_DISK_MAX_BYTES
  const maxEntryBytes = Math.min(
    options?.maxEntryBytes ?? HISTORY_DISK_ENTRY_MAX_BYTES,
    maxBytes
  )
  const maxEntries = options?.maxEntries ?? HISTORY_DISK_MAX_ENTRIES
  const now = options?.now ?? Date.now
  // One operation at a time in this window, in call order: a removal asked
  // for after a write must not be overtaken by it.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(op: () => Promise<T>, fallback: T): Promise<T> => {
    const run = queue.then(op, op).catch(() => fallback)
    queue = run
    return run
  }

  const evict = async (keep: string) => {
    const metas = await backend.list()
    let total = metas.reduce((sum, meta) => sum + meta.bytes, 0)
    let count = metas.length
    if (total <= maxBytes && count <= maxEntries) return
    const victims: string[] = []
    for (const meta of [...metas].sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= maxBytes && count <= maxEntries) break
      if (meta.key === keep) continue
      victims.push(meta.key)
      total -= meta.bytes
      count--
    }
    if (victims.length > 0) await backend.remove(victims)
  }

  return {
    load(server, conversationId) {
      const key = historyEntryKey(server, conversationId)
      return serial(async () => {
        const entry = await backend.read(key)
        if (!entry) return null
        if (entry.meta.format !== ENTRY_FORMAT) {
          await backend.remove([key])
          return null
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(entry.json)
        } catch {
          parsed = null
        }
        if (!looksLikeDetail(parsed, conversationId)) {
          await backend.remove([key])
          return null
        }
        // Recency is noted after the answer is out: the open waits on it.
        void serial(() => backend.touch(key, now()), undefined)
        return { detail: parsed, json: entry.json }
      }, null)
    },

    save(server, conversationId, value) {
      const key = historyEntryKey(server, conversationId)
      return serial(async () => {
        // Taken out first, so what is measured is what is written.
        const detail = withoutSecretAnswers(
          isKept(value) ? value.detail : value
        )
        const shaped =
          isKept(value) &&
          detail === value.detail &&
          value.json.length <= maxEntryBytes
            ? value
            : shapeKeptDetail(detail, { maxBytes: maxEntryBytes })
        if (!shaped) {
          await backend.remove([key])
          return false
        }
        const json = shaped.json
        if (json.length > maxEntryBytes) {
          await backend.remove([key])
          return false
        }
        const at = now()
        await backend.write(
          {
            key,
            server,
            conversationId,
            bytes: json.length,
            savedAt: at,
            usedAt: at,
            format: ENTRY_FORMAT,
          },
          json
        )
        await evict(key)
        return true
      }, false)
    },

    remove(server, conversationId) {
      const key = historyEntryKey(server, conversationId)
      return serial(() => backend.remove([key]), undefined)
    },

    clearServer(server) {
      return serial(async () => {
        const metas = await backend.list()
        const keys = metas.filter((m) => m.server === server).map((m) => m.key)
        if (keys.length > 0) await backend.remove(keys)
      }, undefined)
    },

    clear() {
      return serial(() => backend.clear(), undefined)
    },
  }
}

// ─── Backends ────────────────────────────────────────────────────────────

/** A backend that keeps nothing (no IndexedDB here). */
export const nullDiskBackend: DiskBackend = {
  read: async () => null,
  write: async () => {},
  touch: async () => {},
  remove: async () => {},
  list: async () => [],
  clear: async () => {},
}

/** An in-memory backend that outlives the caches built on it (tests). */
export function createMemoryDiskBackend(): DiskBackend & {
  readonly entries: Map<string, { meta: DiskEntryMeta; json: string }>
} {
  const entries = new Map<string, { meta: DiskEntryMeta; json: string }>()
  return {
    entries,
    read: async (key) => {
      const entry = entries.get(key)
      return entry ? { meta: { ...entry.meta }, json: entry.json } : null
    },
    write: async (meta, json) => {
      entries.set(meta.key, { meta: { ...meta }, json })
    },
    touch: async (key, usedAt) => {
      const entry = entries.get(key)
      if (entry) entry.meta = { ...entry.meta, usedAt }
    },
    remove: async (keys) => {
      for (const key of keys) entries.delete(key)
    },
    list: async () => [...entries.values()].map((e) => ({ ...e.meta })),
    clear: async () => {
      entries.clear()
    },
  }
}

const DB_NAME = "codeg-history"
const DB_VERSION = 1
const META = "meta"
const DATA = "data"

/** IndexedDB, opened on first use; null where there is none. */
export function createIndexedDbBackend(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined"
    ? undefined
    : indexedDB
): DiskBackend | null {
  if (!factory) return null
  let opening: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => {
    if (opening) return opening
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: "key" })
        }
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA)
      }
      request.onsuccess = () => {
        const db = request.result
        // Another window upgrading the schema, or the store going away:
        // let go, and open again on the next use.
        db.onversionchange = () => {
          db.close()
          opening = null
        }
        db.onclose = () => {
          opening = null
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error("history cache blocked"))
    })
    opening.catch(() => {
      opening = null
    })
    return opening
  }

  const transact = async <T>(
    mode: IDBTransactionMode,
    body: (meta: IDBObjectStore, data: IDBObjectStore) => () => T
  ): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([META, DATA], mode)
      const result = body(tx.objectStore(META), tx.objectStore(DATA))
      tx.oncomplete = () => resolve(result())
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error("aborted"))
    })
  }

  return {
    read: (key) =>
      transact("readonly", (meta, data) => {
        const metaReq = meta.get(key)
        const dataReq = data.get(key)
        return () => {
          const m = metaReq.result as DiskEntryMeta | undefined
          const json = dataReq.result as unknown
          return m && typeof json === "string" ? { meta: m, json } : null
        }
      }),
    write: (entry, json) =>
      transact("readwrite", (meta, data) => {
        meta.put(entry)
        data.put(json, entry.key)
        return () => undefined
      }),
    touch: (key, usedAt) =>
      transact("readwrite", (meta) => {
        const req = meta.get(key)
        req.onsuccess = () => {
          const m = req.result as DiskEntryMeta | undefined
          if (m) meta.put({ ...m, usedAt })
        }
        return () => undefined
      }),
    remove: (keys) =>
      transact("readwrite", (meta, data) => {
        for (const key of keys) {
          meta.delete(key)
          data.delete(key)
        }
        return () => undefined
      }),
    list: () =>
      transact("readonly", (meta) => {
        const req = meta.getAll()
        return () => (req.result as DiskEntryMeta[]) ?? []
      }),
    clear: () =>
      transact("readwrite", (meta, data) => {
        meta.clear()
        data.clear()
        return () => undefined
      }),
  }
}

// ─── Where the history comes from ────────────────────────────────────────

/** The cache key prefix of a remote server, by its address. */
export function remoteServerKey(baseUrl: string): string {
  return `remote:${baseUrl.trim().replace(/\/+$/, "")}`
}

/**
 * Which server this window's sessions belong to, as a cache key prefix: the
 * remote host for a remote-workspace window, this page's origin for the web
 * client, `local` for the desktop app's own backend. Null while a remote
 * window has not bound its server yet, when nothing may be read or written.
 */
export function historyServerKey(): string | null {
  if (typeof window === "undefined") return null
  if (isRemoteDesktopMode()) return remoteServerKey(getServerBaseUrl())
  if (isDesktop()) {
    const params = new URLSearchParams(window.location.search)
    return params.has("remoteConnectionId") ? null : "local"
  }
  return `web:${window.location.origin}`
}

// Undefined until first asked for; null where there is no IndexedDB.
let diskCache: HistoryDiskCache | null | undefined

/** The window's disk cache, or null where there is no IndexedDB. */
export function getHistoryDiskCache(): HistoryDiskCache | null {
  if (diskCache === undefined) {
    const backend = createIndexedDbBackend()
    diskCache = backend ? createHistoryDiskCache(backend) : null
  }
  return diskCache
}

/**
 * Test seam: run the window's disk cache on `backend` (null: no disk at all;
 * undefined: back to the default).
 */
export function setHistoryDiskBackendForTests(
  backend: DiskBackend | null | undefined
): void {
  diskCache =
    backend === undefined
      ? undefined
      : backend
        ? createHistoryDiskCache(backend)
        : null
}
