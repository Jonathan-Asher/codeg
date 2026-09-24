import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConversationAttentionEntry } from "@/lib/types"

const listConversationAttention = vi.fn<
  () => Promise<ConversationAttentionEntry[]>
>(async () => [])
vi.mock("@/lib/api", () => ({
  listConversationAttention: () => listConversationAttention(),
}))

import {
  __resetConversationAttentionForTests,
  applyLiveAttentionChange,
  attentionByRoot,
  refreshConversationAttention,
  strongerAttention,
  useConversationAttentionStore,
} from "./conversation-attention-store"

const map = () => useConversationAttentionStore.getState().byConversationId

beforeEach(() => {
  vi.useFakeTimers()
  __resetConversationAttentionForTests()
  listConversationAttention.mockReset()
  listConversationAttention.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("attention precedence", () => {
  it("shows the most blocking kind when several wait under one row", () => {
    expect(strongerAttention(undefined, "plan_approval")).toBe("plan_approval")
    expect(strongerAttention("question", "permission")).toBe("permission")
    expect(strongerAttention("permission", "question")).toBe("permission")
  })

  it("folds a waiting sub-agent onto the row the sidebar shows", () => {
    const folded = attentionByRoot([
      { conversation_id: 11, kind: "question", root_conversation_id: 1 },
      { conversation_id: 12, kind: "permission", root_conversation_id: 1 },
      { conversation_id: 2, kind: "plan_approval", root_conversation_id: 2 },
    ])
    expect(folded).toEqual(
      new Map([
        [1, "permission"],
        [2, "plan_approval"],
      ])
    )
  })
})

describe("sync", () => {
  it("lights a row up at once on a live event, then settles on the snapshot", async () => {
    applyLiveAttentionChange({ id: 5, kind: "permission" })
    expect(map().get(5)).toBe("permission")

    // The snapshot is authoritative: here it says the waiting session is a
    // sub-agent of row 1, which the event alone could not know.
    listConversationAttention.mockResolvedValue([
      { conversation_id: 5, kind: "permission", root_conversation_id: 1 },
    ])
    await vi.advanceTimersByTimeAsync(250)
    expect(listConversationAttention).toHaveBeenCalledTimes(1)
    expect(map()).toEqual(new Map([[1, "permission"]]))
  })

  it("clears a row on a live `kind: null`", () => {
    applyLiveAttentionChange({ id: 5, kind: "question" })
    applyLiveAttentionChange({ id: 5, kind: null })
    expect(map().has(5)).toBe(false)
  })

  it("coalesces a burst of events into one snapshot read", async () => {
    applyLiveAttentionChange({ id: 1, kind: "permission" })
    applyLiveAttentionChange({ id: 2, kind: "question" })
    applyLiveAttentionChange({ id: 3, kind: "plan_approval" })
    await vi.advanceTimersByTimeAsync(250)
    expect(listConversationAttention).toHaveBeenCalledTimes(1)
  })

  it("discards a snapshot that was taken before a newer event", async () => {
    let resolveStale!: (v: ConversationAttentionEntry[]) => void
    listConversationAttention.mockReturnValueOnce(
      new Promise((r) => {
        resolveStale = r
      })
    )
    const stale = refreshConversationAttention()
    // The permission is answered while that read is still in flight.
    applyLiveAttentionChange({ id: 7, kind: null })
    resolveStale([
      { conversation_id: 7, kind: "permission", root_conversation_id: 7 },
    ])
    await stale
    expect(map().has(7)).toBe(false)
  })

  it("keeps what it has when the server predates the command", async () => {
    applyLiveAttentionChange({ id: 3, kind: "question" })
    listConversationAttention.mockRejectedValue(new Error("HTTP 404"))
    await vi.advanceTimersByTimeAsync(250)
    expect(map().get(3)).toBe("question")
  })
})
