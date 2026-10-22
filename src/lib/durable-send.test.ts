import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { durableSendCallbacks, headSendDelayMs } from "./durable-send"
import { nextSendFailure } from "./send-failure"
import {
  resetOutboxStoresForTests,
  useMessageQueue,
  type QueuedMessage,
} from "@/hooks/use-message-queue"
import { outboxStorageKey } from "@/lib/outbox-storage"
import { TurnBusyError } from "@/lib/turn-busy"
import type { PromptDraft } from "@/lib/types"

vi.mock("@/lib/transport", () => ({
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))

function draft(text: string): PromptDraft {
  return { blocks: [{ type: "text", text }], displayText: text }
}

afterEach(() => {
  resetOutboxStoresForTests()
  localStorage.clear()
})

function fakeQueue() {
  return {
    enqueue: vi.fn(),
    requeueFront: vi.fn(),
    settleSend: vi.fn(),
  }
}

describe("durableSendCallbacks", () => {
  it("keeps a failed message at the front as not sent, under the same id", () => {
    const queue = fakeQueue()
    const rollback = vi.fn()
    const cb = durableSendCallbacks({
      queue,
      draft: draft("hi"),
      modeId: "default",
      clientMessageId: "optimistic-1",
      fromQueueFlush: false,
      rollback,
    })
    const shownInline = cb.onSendFailed(new TypeError("Load failed"))
    expect(shownInline).toBe(true)
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(queue.settleSend).toHaveBeenCalledWith("optimistic-1")
    expect(queue.enqueue).not.toHaveBeenCalled()
    const [d, mode, opts] = queue.requeueFront.mock.calls[0]
    expect(d.displayText).toBe("hi")
    expect(mode).toBe("default")
    expect(opts).toMatchObject({
      clientMessageId: "optimistic-1",
      failure: { reason: "network", autoRetry: true, attempts: 1 },
    })
  })

  it("asks for a toast when the failure waits for the user", () => {
    const cb = durableSendCallbacks({
      queue: fakeQueue(),
      draft: draft("x"),
      modeId: null,
      clientMessageId: "optimistic-2",
      fromQueueFlush: true,
      rollback: vi.fn(),
    })
    expect(
      cb.onSendFailed({ code: "network_error", message: "HTTP 413" })
    ).toBe(false)
  })

  it("counts attempts across resends", () => {
    const queue = fakeQueue()
    const previous = nextSendFailure(new TypeError("Load failed"), undefined)
    durableSendCallbacks({
      queue,
      draft: draft("x"),
      modeId: null,
      clientMessageId: "optimistic-3",
      previousFailure: previous,
      fromQueueFlush: true,
      rollback: vi.fn(),
    }).onSendFailed(new Error("Request timed out"))
    expect(queue.requeueFront.mock.calls[0][2].failure).toMatchObject({
      reason: "timeout",
      attempts: 2,
    })
  })

  it("a busy bounce waits unmarked, keeping its id (head to the front, direct to the tail)", () => {
    const direct = fakeQueue()
    const onBounce = vi.fn()
    durableSendCallbacks({
      queue: direct,
      draft: draft("d"),
      modeId: null,
      clientMessageId: "optimistic-d",
      fromQueueFlush: false,
      rollback: vi.fn(),
      onBounce,
    }).onTurnInProgress()
    expect(onBounce).toHaveBeenCalled()
    expect(direct.enqueue.mock.calls[0][2]).toEqual({
      clientMessageId: "optimistic-d",
    })

    const head = fakeQueue()
    const onPoolHold = vi.fn()
    durableSendCallbacks({
      queue: head,
      draft: draft("h"),
      modeId: null,
      clientMessageId: "optimistic-h",
      fromQueueFlush: true,
      rollback: vi.fn(),
      onPoolHold,
    }).onPoolExhausted({ resumesAt: 99 })
    expect(head.requeueFront.mock.calls[0][2]).toEqual({
      clientMessageId: "optimistic-h",
    })
    expect(onPoolHold).toHaveBeenCalledWith({ resumesAt: 99 })
  })

  it("an accepted send leaves the outbox; a duplicate also undoes the optimistic copy", () => {
    const queue = fakeQueue()
    const onDuplicate = vi.fn()
    const cb = durableSendCallbacks({
      queue,
      draft: draft("x"),
      modeId: null,
      clientMessageId: "optimistic-4",
      fromQueueFlush: false,
      rollback: vi.fn(),
      onDuplicate,
    })
    cb.onAccepted({ duplicate: false })
    expect(queue.settleSend).toHaveBeenCalledWith("optimistic-4")
    expect(onDuplicate).not.toHaveBeenCalled()
    cb.onAccepted({ duplicate: true })
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })
})

describe("headSendDelayMs", () => {
  it("sends a plain head now, holds a refused one, waits out a backoff", () => {
    expect(headSendDelayMs(undefined)).toBe(0)
    expect(headSendDelayMs({})).toBe(0)
    const refused = nextSendFailure(
      { code: "invalid_input", message: "no" },
      undefined
    )
    expect(headSendDelayMs({ failure: refused })).toBeNull()
    const lost = nextSendFailure(new TypeError("Load failed"), undefined, 1_000)
    expect(headSendDelayMs({ failure: lost }, 1_000)).toBe(
      lost.nextAttemptAt - 1_000
    )
    expect(headSendDelayMs({ failure: lost }, lost.nextAttemptAt + 5)).toBe(0)
  })
})

/**
 * A server that does what codeg's does with `client_message_id`: the first
 * copy of a message reaches the agent, a repeat is answered as a duplicate.
 * `loseAnswers` drops the answer after the server acted (the ambiguous case).
 */
function fakeServer() {
  const accepted = new Set<string>()
  const delivered: string[] = []
  let loseAnswers = 0
  let down = false
  return {
    delivered,
    goDown: () => {
      down = true
    },
    comeBack: () => {
      down = false
    },
    loseNextAnswer: () => {
      loseAnswers += 1
    },
    async prompt(text: string, clientMessageId: string) {
      if (down) throw new TypeError("Load failed")
      let duplicate = false
      if (accepted.has(clientMessageId)) duplicate = true
      else {
        accepted.add(clientMessageId)
        delivered.push(text)
      }
      if (loseAnswers > 0) {
        loseAnswers -= 1
        throw new TypeError("Load failed")
      }
      return { duplicate }
    },
  }
}

/** One flush step: send the queue's head the way the composers do. */
async function flushHead(
  q: ReturnType<typeof useMessageQueue>,
  server: ReturnType<typeof fakeServer>
): Promise<QueuedMessage | undefined> {
  const head = q.dequeue()
  if (!head) return undefined
  const cb = durableSendCallbacks({
    queue: q,
    draft: head.draft,
    modeId: head.modeId,
    clientMessageId: head.clientMessageId,
    previousFailure: head.failure,
    fromQueueFlush: true,
    rollback: () => {},
  })
  q.trackSend({
    clientMessageId: head.clientMessageId,
    draft: head.draft,
    modeId: head.modeId,
  })
  try {
    const accepted = await server.prompt(
      head.draft.displayText,
      head.clientMessageId
    )
    cb.onAccepted(accepted)
  } catch (e) {
    if (e instanceof TurnBusyError) cb.onTurnInProgress()
    else cb.onSendFailed(e)
  }
  return head
}

describe("exactly once", () => {
  const KEY = outboxStorageKey("conv:5")

  it("a send whose answer was lost is resent and delivered once", async () => {
    const server = fakeServer()
    const { result } = renderHook(() => useMessageQueue(KEY))
    act(() => result.current.enqueue(draft("hello"), null))

    server.loseNextAnswer()
    await act(async () => {
      await flushHead(result.current, server)
    })
    // The client could not tell it arrived: kept, marked, same id.
    expect(result.current.queue).toHaveLength(1)
    expect(result.current.queue[0].failure?.reason).toBe("network")

    await act(async () => {
      await flushHead(result.current, server)
    })
    expect(result.current.queue).toEqual([])
    expect(server.delivered).toEqual(["hello"])
  })

  it("a send while the server is down waits, then goes once it is back", async () => {
    const server = fakeServer()
    const { result } = renderHook(() => useMessageQueue(KEY))
    act(() => result.current.enqueue(draft("are you there"), null))
    server.goDown()
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await flushHead(result.current, server)
      })
    }
    expect(result.current.queue[0].failure).toMatchObject({
      reason: "network",
      attempts: 3,
      autoRetry: true,
    })
    server.comeBack()
    await act(async () => {
      await flushHead(result.current, server)
    })
    expect(result.current.queue).toEqual([])
    expect(server.delivered).toEqual(["are you there"])
  })

  it("a reload in the middle of a send that arrived resends it as a duplicate", async () => {
    const server = fakeServer()
    const first = renderHook(() => useMessageQueue(KEY))
    act(() => first.result.current.enqueue(draft("before reload"), null))
    // The send reaches the server, then the page goes away before the answer.
    const head = first.result.current.dequeue()!
    first.result.current.trackSend({
      clientMessageId: head.clientMessageId,
      draft: head.draft,
      modeId: head.modeId,
    })
    await server.prompt(head.draft.displayText, head.clientMessageId)
    resetOutboxStoresForTests()

    const after = renderHook(() => useMessageQueue(KEY))
    expect(after.result.current.queue[0]).toMatchObject({
      clientMessageId: head.clientMessageId,
      failure: { reason: "interrupted" },
    })
    await act(async () => {
      await flushHead(after.result.current, server)
    })
    expect(after.result.current.queue).toEqual([])
    expect(server.delivered).toEqual(["before reload"])
  })
})

describe("autoReconnectDelayMs", () => {
  it("backs off from 5 s to every 30 s", async () => {
    const { autoReconnectDelayMs } = await import("./durable-send")
    expect([0, 1, 2, 3, 9].map(autoReconnectDelayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000,
    ])
  })
})
