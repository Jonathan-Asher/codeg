import { describe, expect, it } from "vitest"

import {
  POOL_RETRY_FALLBACK_MS,
  POOL_RETRY_MARGIN_MS,
  formatPoolResumeTime,
  poolHoldFromError,
  poolReadingReleases,
  poolRetryDelayMs,
  stripPoolMarker,
} from "./pool-hold"

const BACKEND =
  "All Claude subscriptions behind the account pool are at their limit, so Claude Code cannot take a request yet; the next one frees at 17:40 UTC. [pool_exhausted resumes_at=1800000000]"

describe("poolHoldFromError", () => {
  it("reads the reset from the Tauri string", () => {
    expect(poolHoldFromError(BACKEND)).toEqual({ resumesAt: 1_800_000_000 })
  })

  it("reads it from the web error body, by marker or by code", () => {
    expect(
      poolHoldFromError({ code: "pool_exhausted", message: BACKEND })
    ).toEqual({ resumesAt: 1_800_000_000 })
    expect(
      poolHoldFromError({ code: "pool_exhausted", message: "held back" })
    ).toEqual({ resumesAt: null })
  })

  it("knows a hold with no known reset", () => {
    expect(poolHoldFromError("… yet. [pool_exhausted]")).toEqual({
      resumesAt: null,
    })
  })

  it("is not fooled by other errors", () => {
    expect(poolHoldFromError("turn already in progress")).toBeNull()
    expect(poolHoldFromError({ code: "turn_in_progress" })).toBeNull()
    expect(poolHoldFromError(new Error("boom"))).toBeNull()
    expect(poolHoldFromError(null)).toBeNull()
  })

  it("strips the marker for display", () => {
    expect(stripPoolMarker(BACKEND)).not.toContain("[pool_exhausted")
  })
})

describe("formatPoolResumeTime", () => {
  const now = 1_800_000_000 * 1000
  it("names a future reset as a clock time", () => {
    const text = formatPoolResumeTime(1_800_000_000 + 3600, "en-GB", now)
    expect(text).toMatch(/^\d{2}:\d{2}$/)
  })

  it("says nothing for an unknown or past reset", () => {
    expect(formatPoolResumeTime(null, "en-GB", now)).toBeNull()
    expect(formatPoolResumeTime(undefined, "en-GB", now)).toBeNull()
    expect(formatPoolResumeTime(1_800_000_000 - 60, "en-GB", now)).toBeNull()
  })
})

describe("poolRetryDelayMs", () => {
  const now = 1_800_000_000 * 1000
  it("tries again just after the first reset", () => {
    expect(poolRetryDelayMs({ resumesAt: 1_800_000_000 + 600 }, now)).toBe(
      600_000 + POOL_RETRY_MARGIN_MS
    )
  })

  it("falls back to a minute without a known reset", () => {
    expect(poolRetryDelayMs({ resumesAt: null }, now)).toBe(
      POOL_RETRY_FALLBACK_MS
    )
  })

  it("never retries in a tight loop on a reset already past", () => {
    expect(poolRetryDelayMs({ resumesAt: 1_800_000_000 - 600 }, now)).toBe(
      POOL_RETRY_MARGIN_MS
    )
  })
})

describe("poolReadingReleases", () => {
  it("lets held messages go once the pool has room, is gone or can't tell", () => {
    expect(poolReadingReleases(null)).toBe(true)
    expect(poolReadingReleases({ exhausted: false, stale: false })).toBe(true)
    expect(poolReadingReleases({ exhausted: true, stale: true })).toBe(true)
    expect(poolReadingReleases({ exhausted: true, stale: false })).toBe(false)
  })
})
