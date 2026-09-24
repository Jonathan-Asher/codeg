import { describe, expect, it } from "vitest"
import { RETRY_NUDGE_TEXT, isRetryNudge } from "./retry-nudge"

describe("isRetryNudge", () => {
  it("recognises the Retry instruction, whitespace-tolerant", () => {
    expect(isRetryNudge(RETRY_NUDGE_TEXT)).toBe(true)
    expect(isRetryNudge(`\n${RETRY_NUDGE_TEXT}  `)).toBe(true)
  })

  it("never swallows a real message", () => {
    expect(isRetryNudge("Summarize yesterday's changes")).toBe(false)
    expect(isRetryNudge(`${RETRY_NUDGE_TEXT} Also fix the tests.`)).toBe(false)
  })
})
