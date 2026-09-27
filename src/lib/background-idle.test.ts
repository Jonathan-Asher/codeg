import { describe, expect, it } from "vitest"
import {
  backgroundTaskCount,
  canDeliverIntoHeldTurn,
  isAwaitingBackground,
  routeComposerSend,
  shouldDrainIntoHeldTurn,
} from "@/lib/background-idle"
import type { AsyncTaskRecord } from "@/lib/types"

function task(id: string, state: string): AsyncTaskRecord {
  return {
    task_id: id,
    name: id,
    task_type: "shell",
    description: id,
    show_in_transcript: false,
    can_stop: true,
    state,
  }
}

describe("held-turn state", () => {
  it("is only a prompting turn the backend marked as held", () => {
    expect(
      isAwaitingBackground({ status: "prompting", awaitingBackground: true })
    ).toBe(true)
    expect(
      isAwaitingBackground({ status: "prompting", awaitingBackground: false })
    ).toBe(false)
    // A stale flag on a connection that already left the turn means nothing.
    expect(
      isAwaitingBackground({ status: "connected", awaitingBackground: true })
    ).toBe(false)
    expect(
      isAwaitingBackground({ status: null, awaitingBackground: true })
    ).toBe(false)
  })

  it("delivers only over native steering", () => {
    const held = { status: "prompting" as const, awaitingBackground: true }
    expect(canDeliverIntoHeldTurn({ ...held, nativeSteering: true })).toBe(true)
    expect(canDeliverIntoHeldTurn({ ...held, nativeSteering: false })).toBe(
      false
    )
    expect(
      canDeliverIntoHeldTurn({
        status: "prompting",
        awaitingBackground: false,
        nativeSteering: true,
      })
    ).toBe(false)
  })
})

describe("backgroundTaskCount", () => {
  it("takes the larger of the two sources rather than their sum", () => {
    expect(backgroundTaskCount(2, [task("a", "running")])).toBe(2)
    expect(
      backgroundTaskCount(0, [task("a", "running"), task("b", "paused")])
    ).toBe(2)
  })

  it("ignores settled async tasks", () => {
    expect(
      backgroundTaskCount(0, [
        task("a", "completed"),
        task("b", "failed"),
        task("c", "stopped"),
      ])
    ).toBe(0)
    expect(backgroundTaskCount(1, null)).toBe(1)
  })
})

describe("routeComposerSend", () => {
  const base = {
    isPrompting: false,
    queueSends: false,
    canDeliverNow: false,
    hasEnqueue: true,
    hasDeliver: true,
  }

  it("sends when the session is idle", () => {
    expect(routeComposerSend(base)).toBe("send")
  })

  it("queues while the agent is really replying", () => {
    expect(routeComposerSend({ ...base, isPrompting: true })).toBe("enqueue")
  })

  it("delivers right away while the turn is only held for background work", () => {
    expect(
      routeComposerSend({ ...base, isPrompting: true, canDeliverNow: true })
    ).toBe("deliver")
  })

  it("falls back to the queue when there is no delivery channel", () => {
    expect(
      routeComposerSend({
        ...base,
        isPrompting: true,
        canDeliverNow: true,
        hasDeliver: false,
      })
    ).toBe("enqueue")
  })

  it("keeps queueing while the session is still opening", () => {
    expect(
      routeComposerSend({ ...base, queueSends: true, canDeliverNow: true })
    ).toBe("enqueue")
  })

  it("sends when prompting without a queue (historical behaviour)", () => {
    expect(
      routeComposerSend({ ...base, isPrompting: true, hasEnqueue: false })
    ).toBe("send")
  })
})

describe("shouldDrainIntoHeldTurn", () => {
  const ready = {
    canDeliverNow: true,
    head: { id: "q1" },
    busy: false,
    editingItemId: null,
  }

  it("delivers the head once the agent is idle in a held turn", () => {
    expect(shouldDrainIntoHeldTurn(ready)).toBe(true)
  })

  it("waits while the agent is working or nothing is queued", () => {
    expect(shouldDrainIntoHeldTurn({ ...ready, canDeliverNow: false })).toBe(
      false
    )
    expect(shouldDrainIntoHeldTurn({ ...ready, head: undefined })).toBe(false)
  })

  it("never overlaps another delivery or an edit of the head", () => {
    expect(shouldDrainIntoHeldTurn({ ...ready, busy: true })).toBe(false)
    expect(shouldDrainIntoHeldTurn({ ...ready, editingItemId: "q1" })).toBe(
      false
    )
    expect(shouldDrainIntoHeldTurn({ ...ready, editingItemId: "q2" })).toBe(
      true
    )
  })

  it("leaves a message queued for the turn's end, and everything behind it", () => {
    expect(
      shouldDrainIntoHeldTurn({
        ...ready,
        head: { id: "q1", holdUntilTurnEnd: true },
      })
    ).toBe(false)
  })
})
