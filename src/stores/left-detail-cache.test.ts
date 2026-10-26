/**
 * L0: sessions the user left come back at once, then refresh in the
 * background without a spinner and without disturbing rows that did not
 * change. The transcript read (`getFolderConversation`) is the only stand-in.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  claimRuntimeSession,
  keepUnchangedTurns,
  prefetchConversationDetail,
  releaseRuntimeSession,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "./conversation-runtime-store"
import { createMemoryDetailCache, leftDetailCache } from "./left-detail-cache"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

function turn(id: string, text: string): MessageTurn {
  return {
    id,
    role: id.endsWith("u") ? "user" : "assistant",
    blocks: [{ type: "text", text }],
    timestamp: "2026-10-22T10:00:00.000Z",
  }
}

function detail(
  id: number,
  turns: MessageTurn[],
  extra: Partial<DbConversationDetail> = {}
): DbConversationDetail {
  return {
    summary: {
      id,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: `session-${id}`,
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-10-22T10:00:00.000Z",
      updated_at: "2026-10-22T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
    turns_offset: 0,
    turns_total: turns.length,
    prefix_hash: "0000000000000000",
    ...extra,
  } as DbConversationDetail
}

const state = () => useConversationRuntimeStore.getState()
const actions = () => state().actions
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

describe("createMemoryDetailCache", () => {
  it("keeps the newest sessions within the entry and size budgets", () => {
    const cache = createMemoryDetailCache({ maxEntries: 2, maxBytes: 10_000 })
    cache.put(1, detail(1, [turn("1u", "a")]))
    cache.put(2, detail(2, [turn("1u", "b")]))
    cache.put(3, detail(3, [turn("1u", "c")]))
    expect(cache.size).toBe(2)
    expect(cache.take(1)).toBeNull()
    expect(cache.take(3)?.summary.id).toBe(3)
    expect(cache.size).toBe(1)

    // Larger than the whole budget: not kept.
    cache.put(4, detail(4, [turn("1u", "x".repeat(20_000))]))
    expect(cache.take(4)).toBeNull()
  })

  it("never keeps a detail fetched mid-turn", () => {
    const cache = createMemoryDetailCache()
    cache.put(1, detail(1, [turn("1u", "a")], { in_flight_user_turn_id: "1u" }))
    expect(cache.size).toBe(0)
  })
})

describe("leaving and coming back to a session", () => {
  it("paints the kept transcript at once, then refreshes it quietly", async () => {
    const first = [turn("1u", "hello"), turn("2a", "hi there")]
    mockGetFolderConversation.mockResolvedValueOnce(detail(5, first))
    actions().fetchDetail(5)
    await flush()
    expect(state().byConversationId.get(5)?.detail?.turns).toHaveLength(2)

    // The tab closes: the session is released, its detail kept.
    releaseRuntimeSession(5)
    await flush()
    expect(state().byConversationId.has(5)).toBe(false)
    expect(leftDetailCache.size).toBe(1)

    // Reopened: on screen before the refresh answers, with no loading state.
    let answer!: (d: DbConversationDetail) => void
    mockGetFolderConversation.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    actions().fetchDetail(5)
    const reopened = state().byConversationId.get(5)!
    expect(reopened.detailLoading).toBe(false)
    expect(reopened.detail?.turns.map((t) => t.id)).toEqual(["1u", "2a"])
    expect(mockGetFolderConversation).toHaveBeenLastCalledWith(5, {
      fromIndex: 0,
    })

    // The refresh adds a turn; the unchanged rows keep their objects.
    const shown = reopened.detail!.turns
    answer(
      detail(5, [
        turn("1u", "hello"),
        turn("2a", "hi there"),
        turn("3u", "more"),
      ])
    )
    await flush()
    const refreshed = state().byConversationId.get(5)!.detail!.turns
    expect(refreshed.map((t) => t.id)).toEqual(["1u", "2a", "3u"])
    expect(refreshed[0]).toBe(shown[0])
    expect(refreshed[1]).toBe(shown[1])
  })

  it("keeps the kept transcript when the refresh fails (offline)", async () => {
    mockGetFolderConversation.mockResolvedValueOnce(
      detail(6, [turn("1u", "hello")])
    )
    actions().fetchDetail(6)
    await flush()
    releaseRuntimeSession(6)
    await flush()

    mockGetFolderConversation.mockRejectedValueOnce(new Error("offline"))
    actions().fetchDetail(6)
    await flush()
    const session = state().byConversationId.get(6)!
    expect(session.detail?.turns).toHaveLength(1)
    expect(session.detailError).toBeNull()
    expect(session.detailLoading).toBe(false)
  })

  it("does not keep a session a view claims straight back", async () => {
    mockGetFolderConversation.mockResolvedValueOnce(
      detail(7, [turn("1u", "hello")])
    )
    actions().fetchDetail(7)
    await flush()
    releaseRuntimeSession(7)
    claimRuntimeSession(7)
    await flush()
    expect(state().byConversationId.has(7)).toBe(true)
    expect(leftDetailCache.size).toBe(0)
  })
})

describe("fetching a session ahead of its view", () => {
  it("has the transcript on screen the moment its view opens", async () => {
    mockGetFolderConversation.mockResolvedValueOnce(
      detail(9, [turn("1u", "hello"), turn("2a", "hi")])
    )
    prefetchConversationDetail(9)
    await flush()
    expect(state().byConversationId.has(9)).toBe(false)
    expect(leftDetailCache.has(9)).toBe(true)

    mockGetFolderConversation.mockImplementationOnce(
      () => new Promise(() => {})
    )
    actions().fetchDetail(9)
    const session = state().byConversationId.get(9)!
    expect(session.detailLoading).toBe(false)
    expect(session.detail?.turns.map((t) => t.id)).toEqual(["1u", "2a"])
  })

  it("lets a view that opens meanwhile take the request over", async () => {
    let answer!: (d: DbConversationDetail) => void
    mockGetFolderConversation.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    prefetchConversationDetail(10)
    actions().fetchDetail(10)
    expect(mockGetFolderConversation).toHaveBeenCalledTimes(1)
    expect(state().byConversationId.get(10)?.detailLoading).toBe(true)

    answer(detail(10, [turn("1u", "hello")]))
    await flush()
    const session = state().byConversationId.get(10)!
    expect(session.detail?.turns).toHaveLength(1)
    expect(session.detailLoading).toBe(false)
    expect(leftDetailCache.has(10)).toBe(false)
  })

  it("leaves alone a session a view holds, or one already on its way", async () => {
    mockGetFolderConversation.mockResolvedValue(detail(11, [turn("1u", "hi")]))
    actions().fetchDetail(11)
    await flush()
    prefetchConversationDetail(11)
    expect(mockGetFolderConversation).toHaveBeenCalledTimes(1)

    mockGetFolderConversation.mockImplementationOnce(
      () => new Promise(() => {})
    )
    prefetchConversationDetail(12)
    prefetchConversationDetail(12)
    expect(mockGetFolderConversation).toHaveBeenCalledTimes(2)
  })
})

describe("keepUnchangedTurns", () => {
  it("reuses unchanged turns of the same window only", () => {
    const a = turn("1u", "hello")
    const b = turn("2a", "hi")
    const prev = detail(1, [a, b])
    const next = detail(1, [turn("1u", "hello"), turn("2a", "hi, edited")])
    const merged = keepUnchangedTurns(prev, next)
    expect(merged.turns[0]).toBe(a)
    expect(merged.turns[1]).not.toBe(b)

    const otherWindow = detail(1, [turn("1u", "hello")], {
      prefix_hash: "ffffffffffffffff",
    })
    expect(keepUnchangedTurns(prev, otherWindow)).toBe(otherWindow)
    expect(keepUnchangedTurns(null, next)).toBe(next)
  })
})
