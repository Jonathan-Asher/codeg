/**
 * The conversation view's auto-connect waits until it knows which agent
 * session the conversation's row holds (`awaitsHistoricalSessionId`).
 *
 * The reported failure: a conversation opened cold — not in memory, no hover
 * prefetch — is read back from the history cache's disk before the server is
 * asked, and that wait is no loading state. The view's mount had already
 * created the conversation's runtime session (`setPendingCleanup`), so the
 * detail hook said "not loading" with nothing loaded, the gate opened with no
 * session id, and the tab connected to a brand-new session. "Fork from here"
 * on one of the conversation's replies then went to that session, and the
 * agent answered "Session … not found".
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail, DbConversationSummary } from "@/lib/types"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import {
  claimRuntimeSession,
  resetConversationRuntimeStore,
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { resetHistoryCacheForTests } from "@/stores/history-cache"
import {
  createMemoryDiskBackend,
  setHistoryDiskBackendForTests,
  type DiskBackend,
} from "@/stores/history-disk-cache"
import { awaitsHistoricalSessionId } from "./historical-session-gate"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const server = vi.mocked(getFolderConversation)

const ROW_SESSION = "c4d8b403-1d52-409b-a47d-554760d51e42"

/** A view of a persisted Claude Code conversation, opened from its row. */
const opened = {
  hasPersistedConversation: true,
  agentType: "claude_code" as const,
  opensRow: true,
  detailLoading: false,
  detailUnverified: false,
  hasDetail: false,
  detailFailed: false,
  sessionId: undefined,
}

describe("awaitsHistoricalSessionId", () => {
  it("waits while nothing has said which session the row holds", () => {
    // The disk-restore window: no loading state, no detail, no session id.
    expect(awaitsHistoricalSessionId(opened)).toBe(true)
  })

  it("waits while the detail loads or is an unconfirmed copy", () => {
    expect(
      awaitsHistoricalSessionId({
        ...opened,
        detailLoading: true,
        sessionId: ROW_SESSION,
      })
    ).toBe(true)
    expect(
      awaitsHistoricalSessionId({
        ...opened,
        detailUnverified: true,
        hasDetail: true,
        sessionId: ROW_SESSION,
      })
    ).toBe(true)
  })

  it("connects once the session id is known, or the row turns out to have none", () => {
    expect(
      awaitsHistoricalSessionId({ ...opened, sessionId: ROW_SESSION })
    ).toBe(false)
    expect(
      awaitsHistoricalSessionId({
        ...opened,
        hasDetail: true,
        sessionId: ROW_SESSION,
      })
    ).toBe(false)
    // A row created before its first prompt: the detail says it has no
    // session, so a new one is right.
    expect(awaitsHistoricalSessionId({ ...opened, hasDetail: true })).toBe(
      false
    )
  })

  it("leaves a failed load, a draft, a new chat and cline as they were", () => {
    expect(awaitsHistoricalSessionId({ ...opened, detailFailed: true })).toBe(
      false
    )
    // A draft's view after its first send: keyed by a virtual id, no detail
    // is ever fetched, its session id comes from its own connection.
    expect(awaitsHistoricalSessionId({ ...opened, opensRow: false })).toBe(
      false
    )
    expect(
      awaitsHistoricalSessionId({ ...opened, hasPersistedConversation: false })
    ).toBe(false)
    expect(
      awaitsHistoricalSessionId({
        ...opened,
        agentType: "cline",
        detailLoading: true,
      })
    ).toBe(false)
  })
})

// ─── The cold open, through the real runtime store and detail hook ─────────

const CONVERSATION_ID = 173

function detailOf(externalId: string): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION_ID,
      folder_id: 3,
      agent_type: "claude_code",
      title: "alphabeita-shipping-economics",
      external_id: externalId,
    } as unknown as DbConversationSummary,
    turns: [],
    session_stats: null,
  } as unknown as DbConversationDetail
}

/** A disk whose reads wait until released: an IndexedDB read takes a while. */
function slowDisk(): DiskBackend & { release: () => void } {
  const disk = createMemoryDiskBackend()
  const waiting: Array<() => void> = []
  let released = false
  return {
    ...disk,
    read: (key) =>
      released
        ? disk.read(key)
        : new Promise((resolve) => {
            waiting.push(() => resolve(disk.read(key)))
          }),
    release: () => {
      released = true
      waiting.splice(0).forEach((go) => go())
    },
  }
}

/** What the conversation view computes on mount, in its order: claim the
 *  runtime session (which creates it), then read the detail, then gate. */
function useOpenedConversation(conversationId: number) {
  const { setPendingCleanup } = useConversationRuntimeActions()
  useEffect(() => {
    claimRuntimeSession(conversationId)
    setPendingCleanup(conversationId, false)
  }, [conversationId, setPendingCleanup])
  const { detail, loading, error, unverified } =
    useConversationDetail(conversationId)
  const runtimeExternalId = useConversationRuntimeStore(
    (s) => s.byConversationId.get(conversationId)?.externalId ?? null
  )
  const sessionId =
    runtimeExternalId ?? detail?.summary.external_id ?? undefined
  return {
    loading,
    unverified,
    detail,
    sessionId,
    awaiting: awaitsHistoricalSessionId({
      hasPersistedConversation: true,
      agentType: "claude_code",
      opensRow: conversationId > 0,
      detailLoading: loading,
      detailUnverified: unverified,
      hasDetail: detail != null,
      detailFailed: error != null,
      sessionId,
    }),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
let disk: ReturnType<typeof slowDisk>

beforeEach(() => {
  disk = slowDisk()
  setHistoryDiskBackendForTests(disk)
  server.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  act(() => resetConversationRuntimeStore())
  resetHistoryCacheForTests()
  setHistoryDiskBackendForTests(undefined)
  server.mockReset()
})

describe("a conversation opened cold, read back from disk first", () => {
  it("holds the connect until the row's session id is known", async () => {
    let answer!: (detail: DbConversationDetail) => void
    server.mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    )

    const { result, unmount } = renderHook(() =>
      useOpenedConversation(CONVERSATION_ID)
    )

    // Waiting on the disk: the session exists, nothing is loading, nothing is
    // loaded, the server has not been asked. "Not loading" is all the gate
    // used to look at, and it let the connect through with no session id.
    expect(
      useConversationRuntimeStore
        .getState()
        .byConversationId.has(CONVERSATION_ID)
    ).toBe(true)
    expect(result.current.loading || result.current.unverified).toBe(false)
    expect(result.current.detail).toBeNull()
    expect(result.current.sessionId).toBeUndefined()
    expect(server).not.toHaveBeenCalled()
    expect(result.current.awaiting).toBe(true)

    // The disk has nothing: the server is asked, and the view keeps waiting.
    act(() => disk.release())
    await waitFor(() => expect(server).toHaveBeenCalledTimes(1))
    expect(result.current.loading).toBe(true)
    expect(result.current.awaiting).toBe(true)

    // The server names the row's session: the view connects to it.
    await act(async () => {
      answer(detailOf(ROW_SESSION))
      await flush()
    })
    expect(result.current.awaiting).toBe(false)
    expect(result.current.sessionId).toBe(ROW_SESSION)
    unmount()
  })
})
