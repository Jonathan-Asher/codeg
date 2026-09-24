import { describe, expect, it, vi } from "vitest"

import {
  getPendingFindVersion,
  setPendingFind,
  subscribePendingFind,
  takePendingFind,
} from "./pending-find"

describe("pending find handoff", () => {
  it("is taken once, and only by its own conversation", () => {
    setPendingFind(7, "auth")
    expect(takePendingFind(8)).toBeNull()
    expect(takePendingFind(7)).toBe("auth")
    expect(takePendingFind(7)).toBeNull()
  })

  it("tells an already-open transcript that a new query was posted", () => {
    const listener = vi.fn()
    const unsubscribe = subscribePendingFind(listener)
    const before = getPendingFindVersion()

    setPendingFind(7, "first")
    setPendingFind(7, "second")

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getPendingFindVersion()).toBe(before + 2)
    expect(takePendingFind(7)).toBe("second")

    unsubscribe()
    setPendingFind(7, "third")
    expect(listener).toHaveBeenCalledTimes(2)
    takePendingFind(7)
  })
})
