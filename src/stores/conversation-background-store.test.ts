import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ConversationBackground,
  ConversationBackgroundEntry,
} from "@/lib/types"

const listConversationBackground = vi.fn<
  () => Promise<ConversationBackgroundEntry[]>
>(async () => [])
vi.mock("@/lib/api", () => ({
  listConversationBackground: () => listConversationBackground(),
}))

import {
  __resetConversationBackgroundForTests,
  applyLiveBackgroundChange,
  refreshConversationBackground,
  useConversationBackgroundStore,
} from "./conversation-background-store"

const map = () => useConversationBackgroundStore.getState().byConversationId

const SHELL: ConversationBackground = {
  task_count: 1,
  tasks: [{ id: "bm227ltpx", kind: "shell", label: "Wait for runs" }],
  out_of_turn: false,
  held_open: false,
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetConversationBackgroundForTests()
  listConversationBackground.mockReset()
  listConversationBackground.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("background sync", () => {
  it("applies a live change at once, then settles on the snapshot", async () => {
    applyLiveBackgroundChange({ id: 144, background: SHELL })
    expect(map().get(144)).toEqual(SHELL)

    // The snapshot is authoritative: the work has since finished.
    listConversationBackground.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(300)
    expect(map().has(144)).toBe(false)
  })

  it("clears a row on a null change", () => {
    applyLiveBackgroundChange({ id: 144, background: SHELL })
    applyLiveBackgroundChange({ id: 144, background: null })
    expect(map().has(144)).toBe(false)
  })

  it("keeps the same map for a value re-announced unchanged", () => {
    applyLiveBackgroundChange({ id: 144, background: SHELL })
    const before = map()
    applyLiveBackgroundChange({ id: 144, background: { ...SHELL } })
    expect(map()).toBe(before)
  })

  it("drops a snapshot that an event overtook", async () => {
    let resolve: (v: ConversationBackgroundEntry[]) => void = () => {}
    listConversationBackground.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      })
    )
    const pending = refreshConversationBackground()
    // The agent wakes up out of turn while the snapshot is in flight.
    const working = { ...SHELL, out_of_turn: true }
    applyLiveBackgroundChange({ id: 7, background: working })
    resolve([])
    await pending
    expect(map().get(7)).toEqual(working)
  })

  it("loads the snapshot rows", async () => {
    listConversationBackground.mockResolvedValue([
      { conversation_id: 1, background: SHELL },
      {
        conversation_id: 2,
        background: { task_count: 0, out_of_turn: true },
      },
    ])
    await refreshConversationBackground()
    expect(map().get(1)).toEqual(SHELL)
    expect(map().get(2)?.out_of_turn).toBe(true)
  })

  it("keeps what it had when the server predates the command", async () => {
    applyLiveBackgroundChange({ id: 3, background: SHELL })
    await vi.advanceTimersByTimeAsync(300)
    listConversationBackground.mockRejectedValue(new Error("404"))
    await refreshConversationBackground()
    // The earlier settled snapshot (empty) stands; the failure changes nothing.
    expect(map().size).toBe(0)
    applyLiveBackgroundChange({ id: 3, background: SHELL })
    await refreshConversationBackground()
    expect(map().get(3)).toEqual(SHELL)
  })
})
