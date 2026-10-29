/**
 * Reopening a session paints it from the history cache at once (memory, or
 * disk after a restart) and brings it up to date in the background: a merge
 * that keeps every unchanged row, never a spinner, never a blank, and a clean
 * replacement when the transcript was rewritten. The server is the only
 * stand-in (`getFolderConversation`); the disk is an in-memory store that
 * outlives the module state a restart drops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import type {
  DbConversationDetail,
  DbConversationSummary,
  MessageTurn,
} from "@/lib/types"
import {
  prewarmConversationsFromDisk,
  releaseRuntimeSession,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  warmConversationFromDisk,
} from "./conversation-runtime-store"
import { useAppWorkspaceStore } from "./app-workspace-store"
import {
  clearHistoryCache,
  flushDiskSaves,
  resetHistoryCacheForTests,
} from "./history-cache"
import {
  createMemoryDiskBackend,
  getHistoryDiskCache,
  historyEntryKey,
  historyServerKey,
  setHistoryDiskBackendForTests,
} from "./history-disk-cache"
import { leftDetailCache } from "./left-detail-cache"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const server = vi.mocked(getFolderConversation)

const at = (i: number) => new Date(Date.UTC(2026, 9, 29, 8, 0, i)).toISOString()

function turnAt(i: number, text = `t${i}`): MessageTurn {
  return {
    id: `turn-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    blocks: [{ type: "text", text }],
    timestamp: at(i),
  }
}

function summary(id: number, externalId = `session-${id}`) {
  return {
    id,
    folder_id: 1,
    agent_type: "claude_code",
    title: "t",
    title_locked: false,
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: externalId,
    message_count: 0,
    child_count: 0,
    created_at: at(0),
    updated_at: at(0),
    pinned_at: null,
  } as unknown as DbConversationSummary
}

/** Turns `from..to` of a transcript, served as a window. */
function served(
  id: number,
  from: number,
  to: number,
  extra: Partial<DbConversationDetail> = {}
): DbConversationDetail {
  const prefix = Array.from({ length: from }, (_, i) => turnAt(i))
  return {
    summary: summary(id),
    turns: Array.from({ length: to - from }, (_, i) => turnAt(from + i)),
    session_stats: null,
    turns_offset: from,
    turns_total: to,
    assistant_turns_before_offset: prefix.filter((t) => t.role === "assistant")
      .length,
    prefix_hash: extendPrefixFingerprint(FNV_SEED_HEX, prefix)!,
    uncovered_prefix_max_ts: from > 0 ? at(from - 1) : null,
    ...extra,
  } as DbConversationDetail
}

const state = () => useConversationRuntimeStore.getState()
const session = (id: number) => state().byConversationId.get(id)
const flush = () => new Promise((r) => setTimeout(r, 0))
let disk: ReturnType<typeof createMemoryDiskBackend>

/** What a restart drops: everything but the disk. */
function restart() {
  resetConversationRuntimeStore()
  resetHistoryCacheForTests()
  setHistoryDiskBackendForTests(disk)
}

async function onDisk(id: number, detail: DbConversationDetail) {
  await getHistoryDiskCache()!.save(historyServerKey()!, id, detail)
}

beforeEach(() => {
  disk = createMemoryDiskBackend()
  setHistoryDiskBackendForTests(disk)
})

afterEach(() => {
  resetConversationRuntimeStore()
  resetHistoryCacheForTests()
  setHistoryDiskBackendForTests(undefined)
  useAppWorkspaceStore.setState({ conversations: [] })
  server.mockReset()
})

describe("after a restart", () => {
  it("pre-warms the restored tabs, paints at once, then merges the fresh tail", async () => {
    await onDisk(21, served(21, 10, 14))
    restart()

    prewarmConversationsFromDisk([21])
    await flush()
    expect(leftDetailCache.has(21)).toBe(true)

    let answer!: (d: DbConversationDetail) => void
    server.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    state().actions.fetchDetail(21)
    const shown = session(21)!
    // On screen with no loading state, refreshing in the background.
    expect(shown.detailLoading).toBe(false)
    expect(shown.detail?.turns.map((t) => t.id)).toEqual([
      "turn-10",
      "turn-11",
      "turn-12",
      "turn-13",
    ])
    expect(shown.detailRevalidating).toBe(true)
    // The refresh asks for the kept window and everything after it.
    expect(server).toHaveBeenLastCalledWith(21, { fromIndex: 10 })

    answer(served(21, 10, 16))
    await flush()
    const after = session(21)!
    expect(after.detail?.turns.map((t) => t.id)).toEqual([
      "turn-10",
      "turn-11",
      "turn-12",
      "turn-13",
      "turn-14",
      "turn-15",
    ])
    // A merge: the rows that did not change keep their objects, the window
    // keeps its place (nothing shifts the reader), no turn twice.
    shown.detail!.turns.forEach((turn, i) =>
      expect(after.detail!.turns[i]).toBe(turn)
    )
    expect(after.detail?.turns_offset).toBe(10)
    expect(after.olderTurnsPrependEpoch).toBe(shown.olderTurnsPrependEpoch)
    expect(after.detailRevalidating).toBe(false)
  })

  it("reads a session that was not pre-warmed from disk before asking the server", async () => {
    await onDisk(22, served(22, 0, 2))
    restart()
    server.mockImplementation(() => new Promise(() => {}))

    state().actions.fetchDetail(22)
    // Waiting on the disk: no loading state yet, no server request.
    expect(session(22)?.detailLoading ?? false).toBe(false)
    expect(server).not.toHaveBeenCalled()

    await flush()
    expect(session(22)?.detail?.turns).toHaveLength(2)
    expect(session(22)?.detailLoading).toBe(false)
    expect(server).toHaveBeenCalledTimes(1)
    expect(server).toHaveBeenLastCalledWith(22, { fromIndex: 0 })
  })

  it("asks the server when the disk has nothing", async () => {
    server.mockImplementation(() => new Promise(() => {}))
    state().actions.fetchDetail(23)
    await flush()
    expect(server).toHaveBeenLastCalledWith(23, { tailTurns: 120 })
    expect(session(23)?.detailLoading).toBe(true)
  })

  it("does not read another server's sessions", async () => {
    await getHistoryDiskCache()!.save(
      "remote:https://other",
      24,
      served(24, 0, 2)
    )
    server.mockImplementation(() => new Promise(() => {}))
    state().actions.fetchDetail(24)
    await flush()
    expect(session(24)?.detail ?? null).toBeNull()
    expect(server).toHaveBeenLastCalledWith(24, { tailTurns: 120 })
  })
})

describe("revalidating a kept copy", () => {
  it("replaces it cleanly when the transcript was rewritten", async () => {
    await onDisk(31, served(31, 10, 14))
    restart()
    // Compaction: the prefix the kept window stands on is gone. The window
    // check fails, and the fresh tail replaces the copy.
    const rewritten = served(31, 0, 3, { prefix_hash: FNV_SEED_HEX })
    server
      .mockResolvedValueOnce(
        served(31, 10, 14, { prefix_hash: "0123456789abcdef" })
      )
      .mockResolvedValueOnce(rewritten)
    state().actions.fetchDetail(31)
    await flush()
    await flush()
    const after = session(31)!
    expect(server).toHaveBeenLastCalledWith(31, { tailTurns: 120 })
    expect(after.detail).toBe(rewritten)
    expect(after.detail?.turns.map((t) => t.id)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ])
    expect(after.detailRevalidating).toBe(false)
  })

  it("drops a copy of a session a fork re-pointed the row away from", async () => {
    await onDisk(32, served(32, 0, 2))
    restart()
    useAppWorkspaceStore.setState({
      conversations: [summary(32, "session-after-fork")],
    })
    server.mockImplementation(() => new Promise(() => {}))
    state().actions.fetchDetail(32)
    await flush()
    expect(session(32)?.detail ?? null).toBeNull()
    expect(session(32)?.detailLoading).toBe(true)
    expect(server).toHaveBeenLastCalledWith(32, { tailTurns: 120 })
  })

  it("holds the connect until the server confirms a copy the sidebar does not know", async () => {
    await onDisk(33, served(33, 0, 2))
    restart()
    let answer!: (d: DbConversationDetail) => void
    server.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    state().actions.fetchDetail(33)
    await flush()
    expect(session(33)?.detailUnverified).toBe(true)
    answer(served(33, 0, 2))
    await flush()
    expect(session(33)?.detailUnverified).toBe(false)

    // A row the sidebar holds, with the same session: trusted at once.
    await onDisk(34, served(34, 0, 2))
    useAppWorkspaceStore.setState({ conversations: [summary(34)] })
    server.mockImplementation(() => new Promise(() => {}))
    state().actions.fetchDetail(34)
    await flush()
    expect(session(34)?.detail).not.toBeNull()
    expect(session(34)?.detailUnverified).toBe(false)
  })
})

describe("resync and reconnect", () => {
  it("re-read the open transcript in place: never blank, failure keeps it", async () => {
    server.mockResolvedValueOnce(served(41, 0, 2))
    state().actions.fetchDetail(41)
    await flush()
    const before = session(41)!.detail!

    let fail!: (e: Error) => void
    server.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject))
    )
    const done = state().actions.refetchDetail(41, { revalidate: true })
    expect(session(41)?.detail).toBe(before)
    expect(session(41)?.detailLoading).toBe(false)
    expect(session(41)?.detailRevalidating).toBe(true)

    fail(new Error("offline"))
    expect(await done).toBe(false)
    expect(session(41)?.detail).toBe(before)
    expect(session(41)?.detailError).toBeNull()
    expect(session(41)?.detailRevalidating).toBe(false)
  })
})

describe("writing to disk", () => {
  it("keeps an open session's window, and a released one's, but never a mid-turn one", async () => {
    server.mockResolvedValueOnce(served(51, 0, 2))
    state().actions.fetchDetail(51)
    await flush()
    flushDiskSaves()
    await flush()
    const key = historyEntryKey(historyServerKey()!, 51)
    expect(disk.entries.has(key)).toBe(true)

    // Mid-turn: the window written before the turn stays as it was.
    const before = disk.entries.get(key)!.json
    server.mockResolvedValueOnce(
      served(51, 0, 3, { in_flight_user_turn_id: "turn-2" })
    )
    await state().actions.refetchDetail(51, { quiet: true })
    flushDiskSaves()
    await flush()
    expect(disk.entries.get(key)!.json).toBe(before)

    // Released (the tab closed): kept in memory and on disk.
    server.mockResolvedValueOnce(served(52, 0, 4))
    state().actions.fetchDetail(52)
    await flush()
    releaseRuntimeSession(52)
    await flush()
    expect(leftDetailCache.has(52)).toBe(true)
    flushDiskSaves()
    await flush()
    expect(disk.entries.has(historyEntryKey(historyServerKey()!, 52))).toBe(
      true
    )
  })

  it("forgets a deleted session, and everything on sign-out", async () => {
    await onDisk(61, served(61, 0, 2))
    await onDisk(62, served(62, 0, 2))
    warmConversationFromDisk(61)
    await flush()
    expect(leftDetailCache.has(61)).toBe(true)

    useAppWorkspaceStore.getState().applyConversationRemove(61)
    await flush()
    expect(leftDetailCache.has(61)).toBe(false)
    expect(disk.entries.has(historyEntryKey(historyServerKey()!, 61))).toBe(
      false
    )

    await clearHistoryCache("all")
    expect(disk.entries.size).toBe(0)
  })
})
