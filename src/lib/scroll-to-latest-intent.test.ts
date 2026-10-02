import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  getScrollToLatestVersion,
  requestScrollToLatest,
  resetScrollToLatestIntents,
  subscribeScrollToLatest,
  takeScrollToLatest,
} from "./scroll-to-latest-intent"

beforeEach(() => resetScrollToLatestIntents())

describe("scroll-to-latest intent", () => {
  it("is taken once, and only for its own conversation", () => {
    requestScrollToLatest([7])
    expect(takeScrollToLatest([8])).toBe(false)
    expect(takeScrollToLatest([7])).toBe(true)
    expect(takeScrollToLatest([7])).toBe(false)
  })

  it("is found under any id the conversation goes by", () => {
    // A tab that began as a draft: virtual runtime id, persisted id later.
    requestScrollToLatest([42, null, -3])
    expect(takeScrollToLatest([-3, null])).toBe(true)
    expect(takeScrollToLatest([42])).toBe(false)

    requestScrollToLatest([42, undefined])
    expect(takeScrollToLatest([-9, 42])).toBe(true)
  })

  it("keeps one request per conversation, and each conversation's own", () => {
    requestScrollToLatest([7])
    requestScrollToLatest([7, -2])
    requestScrollToLatest([9])
    expect(takeScrollToLatest([7])).toBe(true)
    expect(takeScrollToLatest([-2])).toBe(false)
    expect(takeScrollToLatest([9])).toBe(true)
  })

  it("names nothing without an id", () => {
    const before = getScrollToLatestVersion()
    requestScrollToLatest([null, undefined])
    expect(getScrollToLatestVersion()).toBe(before)
    expect(takeScrollToLatest([null])).toBe(false)
  })

  it("tells a mounted transcript that a request was posted", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeScrollToLatest(listener)
    const before = getScrollToLatestVersion()

    requestScrollToLatest([7])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getScrollToLatestVersion()).toBe(before + 1)

    unsubscribe()
    requestScrollToLatest([8])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
