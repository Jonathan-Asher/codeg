import { describe, expect, it } from "vitest"

import {
  formatBytes,
  formatDuration,
  formatRate,
  RateMeter,
  secondsRemaining,
  transferPercent,
} from "./transfer-format"

const MB = 1024 * 1024
const GB = 1024 * MB

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [-5, "0 B"],
    [Number.NaN, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [5 * MB, "5.0 MB"],
    [1.2 * GB, "1.2 GB"],
    [4.25 * GB, "4.3 GB"],
    [2 * 1024 * GB, "2.0 TB"],
  ])("%s -> %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it("carries a value that rounds up to 1024 into the next unit", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB")
  })
})

describe("formatRate", () => {
  it("appends /s to a positive rate", () => {
    expect(formatRate(8.4 * MB)).toBe("8.4 MB/s")
  })

  it("hides a rate that isn't measurable yet", () => {
    expect(formatRate(null)).toBeNull()
    expect(formatRate(0)).toBeNull()
    expect(formatRate(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("transferPercent", () => {
  it("floors so 100% only ever means done", () => {
    expect(transferPercent(0, 100)).toBe(0)
    expect(transferPercent(425, 1000)).toBe(42)
    expect(transferPercent(999, 1000)).toBe(99)
    expect(transferPercent(1000, 1000)).toBe(100)
  })

  it("clamps to 0..100", () => {
    expect(transferPercent(1500, 1000)).toBe(100)
    expect(transferPercent(-1, 1000)).toBe(0)
  })

  it("is unknown without a total (a streamed ZIP)", () => {
    expect(transferPercent(500, null)).toBeNull()
    expect(transferPercent(500, undefined)).toBeNull()
    expect(transferPercent(500, 0)).toBeNull()
  })

  it("stays exact for multi-GB transfers", () => {
    expect(transferPercent(3 * GB, 6 * GB)).toBe(50)
  })
})

describe("secondsRemaining", () => {
  it("divides what is left by the current rate, rounding up", () => {
    expect(secondsRemaining(0, 100 * MB, 10 * MB)).toBe(10)
    expect(secondsRemaining(95 * MB, 100 * MB, 2 * MB)).toBe(3)
  })

  it("can't estimate without a total, a rate, or anything left", () => {
    expect(secondsRemaining(10, null, 5)).toBeNull()
    expect(secondsRemaining(10, 100, null)).toBeNull()
    expect(secondsRemaining(10, 100, 0)).toBeNull()
    expect(secondsRemaining(100, 100, 5)).toBeNull()
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0 sec"],
    [42, "42 sec"],
    [59.2, "1 min"],
    [61, "2 min"],
    [59 * 60, "59 min"],
    [3541, "1 hr"],
    [3600, "1 hr"],
    [3600 + 5 * 60, "1 hr 5 min"],
    [2 * 3600 + 30 * 60, "2 hr 30 min"],
  ])("%s s -> %s", (seconds, expected) => {
    expect(formatDuration(seconds, "en")).toBe(expected)
  })

  it("localizes the units", () => {
    expect(formatDuration(90, "de")).toBe("2 Min.")
  })
})

describe("RateMeter", () => {
  it("needs half a second of samples before reporting", () => {
    const meter = new RateMeter()
    meter.push(0, 0)
    expect(meter.rate()).toBeNull()
    meter.push(200, 2 * MB)
    expect(meter.rate()).toBeNull()
    meter.push(1000, 10 * MB)
    expect(meter.rate()).toBe(10 * MB)
  })

  it("follows the recent window rather than the lifetime average", () => {
    const meter = new RateMeter(2000)
    meter.push(0, 0)
    meter.push(1000, 10 * MB) // 10 MB/s
    meter.push(2000, 20 * MB)
    // Stall, then 1 MB/s.
    meter.push(10_000, 21 * MB)
    meter.push(11_000, 22 * MB)
    meter.push(12_000, 23 * MB)
    expect(meter.rate()).toBe(1 * MB)
  })

  it("starts over when the counter goes backwards", () => {
    const meter = new RateMeter()
    meter.push(0, 0)
    meter.push(1000, 50 * MB)
    meter.push(1100, 0)
    expect(meter.rate()).toBeNull()
  })
})
