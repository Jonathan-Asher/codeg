import { useCallback, useRef, useSyncExternalStore } from "react"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMessageQueue, type QueuedMessage } from "./use-message-queue"
import { useQueueAutoSend } from "./use-queue-auto-send"
import type { PromptDraft } from "@/lib/types"

/**
 * One conversation as the surfaces of one window see it: the connection's
 * status and held-turn state, plus the runtime session's `awaiting_persist`
 * (shared by every surface on the conversation, like the runtime store). The
 * backend gate admits one prompt at a time and bounces the rest; `accepted`
 * is what reached the agent, `delivered` what went into a held turn.
 */
function createSession() {
  const listeners = new Set<() => void>()
  const session = {
    state: {
      status: "prompting" as "connected" | "prompting" | "error",
      awaitingPersist: false,
      heldTurnReady: false,
    },
    busy: true,
    accepted: [] as string[],
    delivered: [] as string[],
    /** A prompt from `who`: accepted (its turn starts and is waiting to
     *  persist), or bounced because a turn is already running. */
    trySend(who: string, text: string): boolean {
      if (session.busy) return false
      session.busy = true
      session.accepted.push(`${who}:${text}`)
      session.set({ awaitingPersist: true })
      return true
    },
    deliver: vi.fn(async (text: string) => {
      session.delivered.push(text)
      // Delivering wakes the agent: the turn is working again.
      session.set({ heldTurnReady: false })
    }),
    set(patch: Partial<typeof session.state>) {
      session.state = { ...session.state, ...patch }
      listeners.forEach((l) => l())
    },
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    /** The turn running now ends; the surface that sent it settles. */
    endTurn() {
      session.busy = false
      session.set({
        status: "connected",
        awaitingPersist: false,
        heldTurnReady: false,
      })
    },
    /** A prompt reached the agent: its turn starts. */
    startTurn() {
      session.set({ status: "prompting" })
    },
  }
  return session
}
type Session = ReturnType<typeof createSession>

function draft(text: string): PromptDraft {
  return { blocks: [{ type: "text", text }], displayText: text }
}

/** A composer surface (a canvas card) on `session`: the message queue plus
 *  the engine, sending the way `CanvasConversationSurface.handleSend` does. */
function useSurface(name: string, session: Session) {
  const state = useSyncExternalStore(
    session.subscribe,
    () => session.state,
    () => session.state
  )
  const queue = useMessageQueue()
  const lastBounceAtRef = useRef(0)
  const { requeueFront } = queue
  const sendHead = useCallback(
    (item: QueuedMessage) => {
      if (session.trySend(name, item.draft.displayText)) return
      // TurnBusyError: back to the front, and back off.
      lastBounceAtRef.current = Date.now()
      requeueFront(item.draft, item.modeId)
    },
    [name, requeueFront, session]
  )
  useQueueAutoSend({
    queue: queue.queue,
    dequeue: queue.dequeue,
    remove: queue.remove,
    holdUntilTurnEnd: queue.holdUntilTurnEnd,
    editingItemId: queue.editingItemId,
    canSendNow: state.status === "connected" && !state.awaitingPersist,
    isConnectionReady: () => session.state.status === "connected",
    heldTurnReady: state.heldTurnReady,
    lastBounceAtRef,
    sendHead,
    deliverIntoHeldTurn: session.deliver,
    onHeldDeliveryFailed: onFailed,
  })
  return queue
}

const onFailed = vi.fn()

const advance = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

const texts = (q: QueuedMessage[]) => q.map((m) => m.draft.displayText)

describe("useQueueAutoSend", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    onFailed.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends what was queued during a turn once, in order, one turn at a time", async () => {
    const session = createSession()
    const { result } = renderHook(() => useSurface("card", session))
    act(() => result.current.enqueue(draft("one"), null))
    act(() => result.current.enqueue(draft("two"), null))
    act(() => result.current.enqueue(draft("three"), null))
    await advance(5000)
    expect(session.accepted).toEqual([])

    act(() => session.endTurn())
    await advance()
    expect(session.accepted).toEqual(["card:one"])
    // Waits for that turn: the send is still waiting to persist.
    await advance(5000)
    expect(session.accepted).toEqual(["card:one"])

    act(() => session.startTurn())
    act(() => session.endTurn())
    await advance()
    act(() => session.startTurn())
    act(() => session.endTurn())
    await advance()
    act(() => session.endTurn())
    await advance(5000)
    expect(session.accepted).toEqual(["card:one", "card:two", "card:three"])
    expect(result.current.queue).toEqual([])
  })

  it("sends a message queued after the turn ended: no edge needed", async () => {
    const session = createSession()
    const { result } = renderHook(() => useSurface("card", session))
    act(() => session.endTurn())
    await advance(5000)
    act(() => result.current.enqueue(draft("late"), null))
    await advance()
    expect(session.accepted).toEqual(["card:late"])
  })

  it("retries a bounced head first, after backing off", async () => {
    const session = createSession()
    const { result } = renderHook(() => useSurface("card", session))
    act(() => result.current.enqueue(draft("a"), null))
    act(() => result.current.enqueue(draft("b"), null))
    // The session reads idle here, but a turn this card never saw is running.
    act(() => session.set({ status: "connected" }))
    await advance()
    expect(session.accepted).toEqual([])
    expect(texts(result.current.queue)).toEqual(["a", "b"])

    session.busy = false
    await advance(500)
    expect(session.accepted).toEqual([])
    await advance(600)
    expect(session.accepted).toEqual(["card:a"])
  })

  it("two surfaces on one conversation: every message goes out exactly once", async () => {
    // A canvas card and a workspace tab (or the canvas side panel) on the
    // same conversation, each with its own queue.
    const session = createSession()
    const card = renderHook(() => useSurface("card", session))
    const tab = renderHook(() => useSurface("tab", session))
    act(() => card.result.current.enqueue(draft("c1"), null))
    act(() => tab.result.current.enqueue(draft("t1"), null))
    act(() => card.result.current.enqueue(draft("c2"), null))
    act(() => tab.result.current.enqueue(draft("t2"), null))

    for (let turn = 0; turn < 8; turn += 1) {
      act(() => session.endTurn())
      await advance(1500)
      if (session.busy) act(() => session.startTurn())
    }
    act(() => session.endTurn())
    await advance(5000)

    expect(session.accepted).toHaveLength(4)
    expect(new Set(session.accepted)).toEqual(
      new Set(["card:c1", "card:c2", "tab:t1", "tab:t2"])
    )
    // Each surface's own order is kept.
    const order = (who: string) =>
      session.accepted.filter((m) => m.startsWith(who))
    expect(order("card")).toEqual(["card:c1", "card:c2"])
    expect(order("tab")).toEqual(["tab:t1", "tab:t2"])
    expect(card.result.current.queue).toEqual([])
    expect(tab.result.current.queue).toEqual([])
  })

  it("drains into a turn held open for background work, one idle stretch at a time", async () => {
    const session = createSession()
    const { result } = renderHook(() => useSurface("card", session))
    act(() => result.current.enqueue(draft("one"), null))
    act(() => result.current.enqueue(draft("two"), null))

    act(() => session.set({ heldTurnReady: true }))
    await advance()
    expect(session.delivered).toEqual(["one"])
    expect(texts(result.current.queue)).toEqual(["two"])

    // The agent is replying to it; the next waits for the next idle stretch.
    await advance(5000)
    expect(session.delivered).toEqual(["one"])
    act(() => session.set({ heldTurnReady: true }))
    await advance()
    expect(session.delivered).toEqual(["one", "two"])
    expect(session.accepted).toEqual([])
  })

  it("does not also send a held-turn delivery as a prompt when the turn ends mid-flight", async () => {
    const session = createSession()
    let confirm: () => void = () => {}
    session.deliver.mockImplementationOnce(
      (text: string) =>
        new Promise<void>((resolve) => {
          confirm = () => {
            session.delivered.push(text)
            resolve()
          }
        })
    )
    const { result } = renderHook(() => useSurface("card", session))
    act(() => result.current.enqueue(draft("one"), null))
    act(() => session.set({ heldTurnReady: true }))
    await advance()
    expect(session.deliver).toHaveBeenCalledTimes(1)

    act(() => session.endTurn())
    await advance(5000)
    expect(session.accepted).toEqual([])

    await act(async () => confirm())
    await advance(5000)
    expect(session.delivered).toEqual(["one"])
    expect(session.accepted).toEqual([])
    expect(result.current.queue).toEqual([])
  })

  it("sends a held-turn delivery that lost the race with the turn's end as a prompt", async () => {
    const session = createSession()
    let refused = false
    session.deliver.mockImplementationOnce(async () => {
      // The held turn ended just before the delivery reached it.
      refused = true
      session.set({ heldTurnReady: false })
      throw new Error("no active turn for feedback")
    })
    const { result } = renderHook(() => useSurface("card", session))
    act(() => result.current.enqueue(draft("one"), null))
    act(() => session.set({ heldTurnReady: true }))
    await advance()
    expect(refused).toBe(true)
    expect(texts(result.current.queue)).toEqual(["one"])
    expect(onFailed).not.toHaveBeenCalled()

    act(() => session.endTurn())
    await advance()
    expect(session.accepted).toEqual(["card:one"])
    expect(session.delivered).toEqual([])
  })

  it("holds a message the held turn refused until the turn ends, and says so", async () => {
    const session = createSession()
    session.deliver.mockRejectedValueOnce(new Error("channel closed"))
    const { result } = renderHook(() => useSurface("card", session))
    act(() => result.current.enqueue(draft("one"), null))
    act(() => result.current.enqueue(draft("two"), null))
    act(() => session.set({ heldTurnReady: true }))
    await advance(5000)
    expect(onFailed).toHaveBeenCalledTimes(1)
    // Neither retried into the failure nor overtaken by the one behind it.
    expect(session.deliver).toHaveBeenCalledTimes(1)
    expect(session.delivered).toEqual([])
    expect(result.current.queue[0]).toMatchObject({ holdUntilTurnEnd: true })

    act(() => session.endTurn())
    await advance()
    expect(session.accepted).toEqual(["card:one"])
  })
})
