import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PlanUsagePool } from "@/lib/types"

type PoolHandler = (pool: PlanUsagePool | null) => void
const handlers = new Set<PoolHandler>()

vi.mock("@/lib/api", () => ({
  subscribePlanUsagePoolChanged: vi.fn(async (handler: PoolHandler) => {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }),
}))

import { usePoolHold } from "./use-pool-hold"

function push(pool: Partial<PlanUsagePool> | null) {
  for (const h of [...handlers]) h(pool as PlanUsagePool | null)
}

const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  handlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("usePoolHold", () => {
  it("holds until a pushed reading shows room again", async () => {
    const { result } = renderHook(() => usePoolHold())
    expect(result.current.hold).toBeNull()
    act(() => result.current.holdFor({ resumesAt: NOW / 1000 + 3600 }))
    expect(result.current.hold).toEqual({ resumesAt: NOW / 1000 + 3600 })
    await act(async () => {}) // the subscription settles
    act(() => push({ exhausted: true, stale: false }))
    expect(result.current.hold).not.toBeNull()
    act(() => push({ exhausted: false, stale: false }))
    expect(result.current.hold).toBeNull()
    expect(handlers.size).toBe(0)
  })

  it("lets go just after the first account's reset with no news", async () => {
    const { result } = renderHook(() => usePoolHold())
    act(() => result.current.holdFor({ resumesAt: NOW / 1000 + 10 }))
    await act(async () => {})
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.hold).not.toBeNull()
    act(() => vi.advanceTimersByTime(3_000))
    expect(result.current.hold).toBeNull()
  })

  it("lets go when the pool goes away", async () => {
    const { result } = renderHook(() => usePoolHold())
    act(() => result.current.holdFor({ resumesAt: null }))
    await act(async () => {})
    act(() => push(null))
    expect(result.current.hold).toBeNull()
  })
})
