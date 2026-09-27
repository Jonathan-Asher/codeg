import { describe, expect, it } from "vitest"
import {
  isAttachingPhase,
  splitElapsed,
  statusWhileAttaching,
} from "@/lib/attach-phase"

describe("attach phases", () => {
  it("knows which phases are still on the way to a usable session", () => {
    for (const phase of [
      "queued",
      "starting",
      "resuming",
      "loading",
      "creating",
      "configuring",
    ] as const) {
      expect(isAttachingPhase(phase)).toBe(true)
    }
    expect(isAttachingPhase("ready")).toBe(false)
    expect(isAttachingPhase("failed")).toBe(false)
    // A server that never said is treated as open.
    expect(isAttachingPhase(null)).toBe(false)
    expect(isAttachingPhase(undefined)).toBe(false)
  })

  it("holds `connected` at `connecting` only while the session is opening", () => {
    expect(statusWhileAttaching("connected", "resuming")).toBe("connecting")
    expect(statusWhileAttaching("connected", "configuring")).toBe("connecting")
    expect(statusWhileAttaching("connected", "ready")).toBe("connected")
    expect(statusWhileAttaching("connected", undefined)).toBe("connected")
    // Terminal and turn statuses pass through untouched.
    expect(statusWhileAttaching("error", "resuming")).toBe("error")
    expect(statusWhileAttaching("prompting", "ready")).toBe("prompting")
  })

  it("splits elapsed time into whole minutes and seconds", () => {
    expect(splitElapsed(14_900)).toEqual({ minutes: 0, seconds: 14 })
    expect(splitElapsed(125_000)).toEqual({ minutes: 2, seconds: 5 })
    expect(splitElapsed(-5)).toEqual({ minutes: 0, seconds: 0 })
  })
})
