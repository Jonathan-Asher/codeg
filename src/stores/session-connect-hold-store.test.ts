import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SESSION_CONNECT_SETTLE_MS,
  holdSessionConnect,
  releaseSessionConnectHold,
  useSessionConnectHoldStore,
} from "./session-connect-hold-store"

const held = () => useSessionConnectHoldStore.getState().held

describe("session connect hold", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    releaseSessionConnectHold()
    vi.useRealTimers()
  })

  it("is off until a step holds it", () => {
    expect(held()).toBe(false)
    holdSessionConnect()
    expect(held()).toBe(true)
  })

  it("lifts itself once the steps settle", () => {
    holdSessionConnect()
    vi.advanceTimersByTime(SESSION_CONNECT_SETTLE_MS - 1)
    expect(held()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(held()).toBe(false)
  })

  it("restarts the wait on every step", () => {
    holdSessionConnect()
    vi.advanceTimersByTime(300)
    holdSessionConnect()
    vi.advanceTimersByTime(300)
    expect(held()).toBe(true)
    vi.advanceTimersByTime(100)
    expect(held()).toBe(false)
  })

  it("notifies subscribers only when the hold starts and ends", () => {
    const changes: boolean[] = []
    const unsubscribe = useSessionConnectHoldStore.subscribe((state) =>
      changes.push(state.held)
    )
    holdSessionConnect()
    holdSessionConnect()
    holdSessionConnect()
    vi.advanceTimersByTime(SESSION_CONNECT_SETTLE_MS)
    unsubscribe()
    expect(changes).toEqual([true, false])
  })

  it("can be lifted early, cancelling the pending release", () => {
    holdSessionConnect()
    releaseSessionConnectHold()
    expect(held()).toBe(false)
    holdSessionConnect()
    vi.advanceTimersByTime(SESSION_CONNECT_SETTLE_MS - 1)
    expect(held()).toBe(true)
  })
})
