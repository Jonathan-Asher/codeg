import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __resetResyncForTests,
  getResyncGeneration,
  isResyncing,
  registerResyncTask,
  startResyncPass,
  subscribeResync,
} from "./resync-coordinator"
import type { Transport } from "./transport/types"

function fakeTransport() {
  const callbacks = new Set<() => void>()
  const transport = {
    call: vi.fn(),
    subscribe: vi.fn(),
    isDesktop: () => false,
    onReconnect: (cb: () => void) => {
      callbacks.add(cb)
      return () => callbacks.delete(cb)
    },
  } as unknown as Transport
  return { transport, reconnect: () => callbacks.forEach((cb) => cb()) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  __resetResyncForTests()
})

describe("resync coordinator", () => {
  it("is inert on a transport with no reconnect lifecycle", () => {
    const local = { isDesktop: () => true } as unknown as Transport
    expect(registerResyncTask(local, vi.fn())).toBeNull()
  })

  it("runs a reconnect's tasks by priority, two at a time, and reports syncing until done", async () => {
    const { transport, reconnect } = fakeTransport()
    const order: string[] = []
    const gates = new Map<string, ReturnType<typeof deferred>>()
    const task = (name: string) => () => {
      order.push(name)
      const gate = deferred()
      gates.set(name, gate)
      return gate.promise
    }
    registerResyncTask(transport, task("rest"))
    registerResyncTask(transport, task("status"), { priority: "status" })
    registerResyncTask(transport, task("lists"), { priority: "lists" })
    registerResyncTask(transport, task("visible"), { priority: "visible" })
    const changes = vi.fn()
    subscribeResync(changes)

    reconnect()
    expect(isResyncing()).toBe(true)
    expect(getResyncGeneration()).toBe(1)
    expect(order).toEqual(["visible", "lists"])

    gates.get("lists")!.resolve()
    await flush()
    expect(order).toEqual(["visible", "lists", "status"])

    gates.get("visible")!.resolve()
    gates.get("status")!.resolve()
    await flush()
    expect(order).toEqual(["visible", "lists", "status", "rest"])
    expect(isResyncing()).toBe(true)

    gates.get("rest")!.resolve()
    await flush()
    expect(isResyncing()).toBe(false)
    expect(changes).toHaveBeenCalled()
  })

  it("runs tasks sharing a key once, and joins one still in flight from an earlier pass", async () => {
    const { transport, reconnect } = fakeTransport()
    const gate = deferred()
    const first = vi.fn(() => gate.promise)
    const second = vi.fn()
    registerResyncTask(transport, first, { key: "folders" })
    registerResyncTask(transport, second, { key: "folders" })

    reconnect()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()

    // A new reconnect while the first fetch is still out: joined, not repeated.
    reconnect()
    expect(first).toHaveBeenCalledTimes(1)
    expect(isResyncing()).toBe(true)
    gate.resolve()
    await flush()
    expect(isResyncing()).toBe(false)
  })

  it("drops what an earlier pass had not started when a new reconnect lands", async () => {
    const { transport, reconnect } = fakeTransport()
    const gates: ReturnType<typeof deferred>[] = []
    const slow = () => {
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    }
    const late = vi.fn()
    registerResyncTask(transport, slow, { key: "a" })
    registerResyncTask(transport, slow, { key: "b" })
    registerResyncTask(transport, late, { key: "c" })

    reconnect()
    expect(late).not.toHaveBeenCalled()
    reconnect() // a and b are joined; c is queued once, in the new pass
    for (const gate of gates) gate.resolve()
    await flush()
    expect(late).toHaveBeenCalledTimes(1)
    expect(isResyncing()).toBe(false)
  })

  it("keeps going when a task throws or rejects", async () => {
    const { transport } = fakeTransport()
    const after = vi.fn()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    registerResyncTask(transport, () => {
      throw new Error("boom")
    })
    registerResyncTask(transport, () => Promise.reject(new Error("nope")))
    registerResyncTask(transport, after)
    startResyncPass()
    await flush()
    expect(after).toHaveBeenCalledTimes(1)
    expect(isResyncing()).toBe(false)
    errors.mockRestore()
  })

  it("forgets an unregistered task", () => {
    const { transport, reconnect } = fakeTransport()
    const run = vi.fn()
    const off = registerResyncTask(transport, run)
    off?.()
    reconnect()
    expect(run).not.toHaveBeenCalled()
  })
})
