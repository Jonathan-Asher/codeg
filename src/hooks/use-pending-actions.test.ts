import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TOGGLE_GUARD_MS, type ActionGate } from "@/lib/pending-actions"
import type { PendingAction } from "@/lib/pending-actions"
import {
  usePendingActions,
  type PendingActionOutcome,
} from "./use-pending-actions"

type Payload = { label: string }

interface Deferred {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** The queue with a gate the test sets: "wait" while the session opens,
 *  "run" once it is ready. */
function setup(
  run: (action: PendingAction<Payload>) => Promise<unknown> = async (action) =>
    action.payload.label
) {
  type Gate = (action: PendingAction<Payload>) => ActionGate
  const runSpy = vi.fn(run)
  const onUnsupported = vi.fn()
  const waiting: Gate = () => "wait"
  const hook = renderHook(
    ({ gate }: { gate: Gate }) =>
      usePendingActions<Payload>({ gate, run: runSpy, onUnsupported }),
    { initialProps: { gate: waiting } }
  )
  const setGate = (gate: Gate) => hook.rerender({ gate })
  return { hook, run: runSpy, onUnsupported, setGate }
}

/** Let the queue's next-macrotask run, and what it awaits, settle. */
async function flush() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("usePendingActions", () => {
  it("holds an action while the session is not ready, and says which control waits", async () => {
    const { hook, run } = setup()
    act(() => {
      void hook.result.current.enqueue("fork", "fork:t1", { label: "a" }, [])
    })
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(hook.result.current.pendingTargets.has("fork:t1")).toBe(true)
    expect(hook.result.current.queue).toHaveLength(1)
    // Waiting, it holds no message back.
    expect(hook.result.current.holdsSends).toBe(false)
  })

  it("runs it once the session is ready, and settles it with the result", async () => {
    const { hook, run, setGate } = setup()
    let outcome: Promise<PendingActionOutcome> | undefined
    act(() => {
      outcome = hook.result.current.enqueue(
        "edit",
        "edit:m1",
        { label: "a" },
        []
      )
    })
    setGate(() => "run")
    // Due: messages queued after it hold until it is done.
    expect(hook.result.current.holdsSends).toBe(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    await expect(outcome).resolves.toEqual({ status: "ran", result: "a" })
    expect(hook.result.current.pendingTargets.size).toBe(0)
    expect(hook.result.current.running).toBeNull()
    expect(hook.result.current.holdsSends).toBe(false)
  })

  it("runs several in the order they were taken, one at a time", async () => {
    const order: string[] = []
    const first = deferred()
    const { hook, setGate } = setup(async (action) => {
      order.push(`start ${action.payload.label}`)
      if (action.payload.label === "a") await first.promise
      order.push(`end ${action.payload.label}`)
    })
    act(() => {
      void hook.result.current.enqueue("fork", "fork:t1", { label: "a" }, [])
      void hook.result.current.enqueue(
        "continue",
        "continue",
        { label: "b" },
        []
      )
      void hook.result.current.enqueue("retry", "retry", { label: "c" }, [])
    })
    setGate(() => "run")
    await flush()
    // The second waits for the first to finish.
    expect(order).toEqual(["start a"])
    expect(hook.result.current.running?.payload.label).toBe("a")
    expect(hook.result.current.holdsSends).toBe(true)
    await act(async () => {
      first.resolve(undefined)
    })
    await flush()
    await flush()
    expect(order).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ])
  })

  it("takes an action back on a second click, but not on a double click", async () => {
    const { hook, run, setGate } = setup()
    act(() => {
      hook.result.current.toggle("fork", "fork:t1", { label: "a" }, [])
    })
    // The second half of a double click.
    act(() => {
      vi.advanceTimersByTime(TOGGLE_GUARD_MS - 100)
      hook.result.current.toggle("fork", "fork:t1", { label: "a" }, [])
    })
    expect(hook.result.current.pendingTargets.has("fork:t1")).toBe(true)
    // A deliberate second click.
    act(() => {
      vi.advanceTimersByTime(200)
      hook.result.current.toggle("fork", "fork:t1", { label: "a" }, [])
    })
    expect(hook.result.current.pendingTargets.has("fork:t1")).toBe(false)
    setGate(() => "run")
    await flush()
    expect(run).not.toHaveBeenCalled()
  })

  it("cancels by control, and Esc takes back the one taken last", async () => {
    const { hook, run, setGate } = setup()
    let editOutcome: Promise<PendingActionOutcome> | undefined
    act(() => {
      void hook.result.current.enqueue("fork", "fork:t1", { label: "a" }, [])
      editOutcome = hook.result.current.enqueue(
        "edit",
        "edit:m1",
        { label: "b" },
        []
      )
    })
    let cancelled = false
    act(() => {
      cancelled = hook.result.current.cancelLast()
    })
    expect(cancelled).toBe(true)
    // An editor waiting on it gets its text back.
    await expect(editOutcome).resolves.toEqual({ status: "cancelled" })
    expect([...hook.result.current.pendingTargets]).toEqual(["fork:t1"])
    act(() => {
      expect(hook.result.current.cancel("fork:t1")).toBe(true)
      expect(hook.result.current.cancel("fork:t1")).toBe(false)
    })
    setGate(() => "run")
    await flush()
    expect(run).not.toHaveBeenCalled()
  })

  it("drops everything waiting when the session cannot be reached", async () => {
    const { hook, run, setGate } = setup()
    const outcomes: Promise<PendingActionOutcome>[] = []
    act(() => {
      outcomes.push(
        hook.result.current.enqueue("fork", "fork:t1", { label: "a" }, []),
        hook.result.current.enqueue("continue", "continue", { label: "b" }, [])
      )
    })
    let dropped: PendingAction<Payload>[] = []
    act(() => {
      dropped = hook.result.current.dropAll()
    })
    expect(dropped.map((action) => action.kind)).toEqual(["fork", "continue"])
    for (const outcome of outcomes) {
      await expect(outcome).resolves.toEqual({
        status: "dropped",
        reason: "unreachable",
      })
    }
    expect(hook.result.current.pendingTargets.size).toBe(0)
    setGate(() => "run")
    await flush()
    expect(run).not.toHaveBeenCalled()
  })

  it("drops what the session turns out not to support, says so, and goes on", async () => {
    const { hook, run, onUnsupported, setGate } = setup()
    let forkOutcome: Promise<PendingActionOutcome> | undefined
    act(() => {
      forkOutcome = hook.result.current.enqueue(
        "fork",
        "fork:t1",
        { label: "a" },
        []
      )
      void hook.result.current.enqueue(
        "continue",
        "continue",
        { label: "b" },
        []
      )
    })
    setGate((action) => (action.kind === "fork" ? "unsupported" : "run"))
    await flush()
    await expect(forkOutcome).resolves.toEqual({
      status: "dropped",
      reason: "unsupported",
    })
    expect(onUnsupported).toHaveBeenCalledTimes(1)
    expect(onUnsupported.mock.calls[0][0].kind).toBe("fork")
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].kind).toBe("continue")
  })

  it("keeps one waiting action per control", async () => {
    const { hook, run, setGate } = setup()
    const outcomes: Promise<PendingActionOutcome>[] = []
    act(() => {
      outcomes.push(
        hook.result.current.enqueue("edit", "edit:m1", { label: "a" }, []),
        hook.result.current.enqueue("edit", "edit:m1", { label: "a" }, [])
      )
    })
    expect(hook.result.current.queue).toHaveLength(1)
    setGate(() => "run")
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    for (const outcome of outcomes) {
      await expect(outcome).resolves.toEqual({ status: "ran", result: "a" })
    }
  })

  it("reports a run that throws instead of losing it", async () => {
    const { hook, setGate } = setup(async () => {
      throw new Error("boom")
    })
    let outcome: Promise<PendingActionOutcome> | undefined
    act(() => {
      outcome = hook.result.current.enqueue(
        "fork",
        "fork:t1",
        { label: "a" },
        []
      )
    })
    setGate(() => "run")
    await flush()
    const settled = await outcome
    expect(settled?.status).toBe("failed")
    expect(hook.result.current.running).toBeNull()
  })

  it("lets an editor waiting on an action go when the view goes away", async () => {
    const { hook } = setup()
    let outcome: Promise<PendingActionOutcome> | undefined
    act(() => {
      outcome = hook.result.current.enqueue(
        "edit",
        "edit:m1",
        { label: "a" },
        []
      )
    })
    hook.unmount()
    await expect(outcome).resolves.toEqual({ status: "cancelled" })
  })
})
