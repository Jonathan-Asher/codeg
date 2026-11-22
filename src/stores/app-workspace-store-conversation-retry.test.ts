import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CONVERSATION_RETRY_DELAYS_MS,
  cancelConversationRetry,
  resetAppWorkspaceStore,
  retryConversationsIfFailed,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import type { DbConversationSummary } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolder: vi.fn(),
  getGitHead: vi.fn(),
  listOpenFolderDetails: vi.fn(async () => []),
  listAllFolderDetails: vi.fn(async () => []),
  listFolderGroups: vi.fn(async () => []),
  listAllConversations: vi.fn(async () => []),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  openWorktreeFolder: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  updateFolderGroup: vi.fn(),
  deleteFolderGroup: vi.fn(),
  setFolderGroup: vi.fn(),
  setFolderArchived: vi.fn(),
  setFolderGroupArchived: vi.fn(),
}))

const { listAllConversations } = await import("@/lib/api")
const listAll = vi.mocked(listAllConversations)

/** What the proxy reports when the server restarts mid-answer. */
const INTERRUPTED = {
  code: "network_error",
  message: "Remote response was interrupted",
  detail:
    "error decoding response body: request or response body error: " +
    "error reading a body from connection",
}

function summary(id: number): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pinned_at: null,
  }
}

const state = () => useAppWorkspaceStore.getState()
const refresh = () => state().refreshConversations()

/** Load a good list, then make every later read fail. */
async function loadThenFail() {
  listAll.mockResolvedValueOnce([summary(1), summary(2)])
  await refresh()
  listAll.mockRejectedValue(INTERRUPTED)
}

beforeEach(() => {
  vi.useFakeTimers()
  listAll.mockReset()
  resetAppWorkspaceStore()
})

afterEach(() => {
  resetAppWorkspaceStore()
  vi.useRealTimers()
})

describe("refreshConversations — a failure keeps the list", () => {
  it("keeps the last good list and records why the refresh failed", async () => {
    await loadThenFail()

    await refresh()

    expect(state().conversations.map((c) => c.id)).toEqual([1, 2])
    expect(state().conversationsHydrated).toBe(true)
    expect(state().conversationsError).toBe(INTERRUPTED.detail)
    expect(state().conversationsLoading).toBe(false)
  })

  it("is not hydrated until a refresh has succeeded", async () => {
    listAll.mockRejectedValue(INTERRUPTED)

    await refresh()

    expect(state().conversationsHydrated).toBe(false)
    expect(state().conversationsError).toBe(INTERRUPTED.detail)
  })

  it("ignores a failure from a refresh older than one that succeeded", async () => {
    let failOld!: (err: unknown) => void
    listAll.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failOld = reject
        })
    )
    const old = refresh()
    listAll.mockResolvedValueOnce([summary(3)])
    await refresh()

    failOld(INTERRUPTED)
    await old

    expect(state().conversationsError).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("refreshConversations — retry on a backoff", () => {
  it("retries after 2 s, 5 s, 15 s, then every 30 s while it keeps failing", async () => {
    expect(CONVERSATION_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000, 30_000])
    await loadThenFail()
    await refresh()
    expect(listAll).toHaveBeenCalledTimes(2)

    const calls: number[] = []
    for (const delay of [2_000, 5_000, 15_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      calls.push(listAll.mock.calls.length)
      await vi.advanceTimersByTimeAsync(1)
      calls.push(listAll.mock.calls.length)
    }

    // Nothing a millisecond early; exactly one read on each step.
    expect(calls).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 7])
  })

  it("recovers on its own and then stops", async () => {
    await loadThenFail()
    await refresh()

    listAll.mockResolvedValue([summary(1), summary(2), summary(4)])
    await vi.advanceTimersByTimeAsync(2_000)

    expect(state().conversationsError).toBeNull()
    expect(state().conversations.map((c) => c.id)).toContain(4)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(listAll).toHaveBeenCalledTimes(3)
  })

  it("keeps one timer however many callers fail", async () => {
    await loadThenFail()

    await Promise.all([refresh(), refresh(), refresh()])

    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    // One retry, not three.
    expect(listAll).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(1)
  })

  it("does not reset the wait when another caller fails meanwhile", async () => {
    await loadThenFail()
    await refresh()

    await vi.advanceTimersByTimeAsync(1_500)
    await refresh() // e.g. a reconnect's refetch, failing too
    await vi.advanceTimersByTimeAsync(500)

    // The retry still fired 2 s after the FIRST failure.
    expect(listAll).toHaveBeenCalledTimes(4)
  })

  it("stops waiting once any other refresh succeeds", async () => {
    await loadThenFail()
    await refresh()
    expect(vi.getTimerCount()).toBe(1)

    listAll.mockResolvedValue([summary(1)])
    await refresh() // a reconnect landed and its refetch worked

    expect(vi.getTimerCount()).toBe(0)
    expect(state().conversationsError).toBeNull()
  })

  it("starts the backoff over after a success", async () => {
    await loadThenFail()
    await refresh()
    await vi.advanceTimersByTimeAsync(2_000) // retry 1 fails → next wait 5 s
    listAll.mockResolvedValueOnce([summary(1)])
    await refresh()

    listAll.mockRejectedValue(INTERRUPTED)
    await refresh()
    const before = listAll.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)

    expect(listAll.mock.calls.length).toBe(before + 1)
  })

  it.each([
    ["a rejected token", { code: "authentication_failed", message: "no" }],
    ["a connection that is gone", { code: "not_found", message: "gone" }],
  ])("does not retry %s", async (_label, err) => {
    await loadThenFail()
    listAll.mockRejectedValue(err)

    await refresh()

    expect(state().conversationsError).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops for good when cancelled", async () => {
    await loadThenFail()
    await refresh()

    cancelConversationRetry()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(listAll).toHaveBeenCalledTimes(2)
  })

  it("is cleared by a store reset", async () => {
    await loadThenFail()
    await refresh()

    resetAppWorkspaceStore()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("retryConversationsIfFailed", () => {
  it("does nothing while the list is fine", async () => {
    listAll.mockResolvedValue([summary(1)])
    await refresh()
    await vi.advanceTimersByTimeAsync(5_000)

    retryConversationsIfFailed()

    expect(listAll).toHaveBeenCalledTimes(1)
  })

  it("refreshes at once after a failure, without waiting out the backoff", async () => {
    await loadThenFail()
    await refresh()
    await vi.advanceTimersByTimeAsync(1_000)
    listAll.mockResolvedValue([summary(1)])

    retryConversationsIfFailed()
    await vi.advanceTimersByTimeAsync(0)

    expect(listAll).toHaveBeenCalledTimes(3)
    expect(state().conversationsError).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not pile onto a refresh still under way", async () => {
    await loadThenFail()
    await refresh()
    await vi.advanceTimersByTimeAsync(1_000)
    listAll.mockImplementation(() => new Promise(() => {}))

    retryConversationsIfFailed()
    await vi.advanceTimersByTimeAsync(1_500)
    retryConversationsIfFailed()

    expect(listAll).toHaveBeenCalledTimes(3)
  })

  it("asks at most once a second", async () => {
    await loadThenFail()
    await refresh()

    retryConversationsIfFailed() // right after the failure

    expect(listAll).toHaveBeenCalledTimes(2)
  })
})
