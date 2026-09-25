/**
 * `useWakeResync` wired to the real runtime store: what the conversation ends
 * up showing, not only whether a refetch was asked for. The transcript read
 * (`getFolderConversation`) and the transport's reconnect signal are the only
 * stand-ins.
 */
import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { useWakeResync } from "./use-wake-resync"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const reconnectCallbacks = new Set<() => void>()
vi.mock("@/lib/platform", () => ({
  onTransportReconnect: (cb: () => void) => {
    reconnectCallbacks.add(cb)
    return () => {
      reconnectCallbacks.delete(cb)
    }
  },
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

const CID = 7

function turn(
  id: string,
  role: MessageTurn["role"],
  text: string
): MessageTurn {
  return {
    id,
    role,
    blocks: [{ type: "text", text }],
    timestamp: "2026-09-24T10:00:00.000Z",
  }
}

const FIRST_PROMPT = turn("turn-1", "user", "what does the worker do?")
const FIRST_REPLY = turn("turn-2", "assistant", "It polls the queue.")
const SECOND_PROMPT = turn("turn-3", "user", "and on shutdown?")
const SECOND_REPLY = turn(
  "turn-4",
  "assistant",
  "It drains the queue, then closes the pool."
)

function detail(turns: MessageTurn[]): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "session-1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-09-24T10:00:00.000Z",
      updated_at: "2026-09-24T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
  }
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

/** The text of every turn the conversation renders, in order. */
function shownTexts(): string[] {
  return getTimelineTurns(CID).map((entry) =>
    entry.turn.blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
  )
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

function fireVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

function fireWake() {
  fireVisibility("hidden")
  vi.advanceTimersByTime(60_000)
  fireVisibility("visible")
}

function fireReconnect() {
  for (const cb of reconnectCallbacks) cb()
}

type WakeResyncProps = Parameters<typeof useWakeResync>[0]

function renderResync(initial?: Partial<WakeResyncProps>) {
  const base: WakeResyncProps = {
    enabled: true,
    conversationId: CID,
    isStreaming: false,
    refetch: actions().refetchDetail,
  }
  const view = renderHook((props: WakeResyncProps) => useWakeResync(props), {
    initialProps: { ...base, ...initial },
  })
  return (next: Partial<WakeResyncProps>) =>
    view.rerender({ ...base, ...initial, ...next })
}

// The conversation as it was on screen before the lid closed.
async function openConversation() {
  mockGetFolderConversation.mockResolvedValueOnce(
    detail([FIRST_PROMPT, FIRST_REPLY])
  )
  await actions().refetchDetail(CID)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
  reconnectCallbacks.clear()
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
})

afterEach(() => {
  resetConversationRuntimeStore()
  vi.useRealTimers()
})

describe("useWakeResync with the runtime store", () => {
  it("recovers the transcript when the wake's refetch fails and the reconnect follows within 2s", async () => {
    await openConversation()
    // A whole turn ran on the server while this client slept.
    mockGetFolderConversation
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        detail([FIRST_PROMPT, FIRST_REPLY, SECOND_PROMPT, SECOND_REPLY])
      )
    renderResync()

    fireWake() // the Wi-Fi is not back yet: this read fails
    await flush()
    expect(shownTexts()).toEqual([
      "what does the worker do?",
      "It polls the queue.",
    ])

    vi.advanceTimersByTime(1_000)
    fireReconnect() // the link is back
    await flush()

    expect(mockGetFolderConversation).toHaveBeenCalledTimes(3)
    expect(shownTexts()).toEqual([
      "what does the worker do?",
      "It polls the queue.",
      "and on shutdown?",
      "It drains the queue, then closes the pool.",
    ])
  })
})
