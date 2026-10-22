import { describe, expect, it } from "vitest"

import {
  formatRemaining,
  isLimitContinuePrompt,
  LIMIT_CONTINUE_PROMPT,
  limitPauseReason,
  limitResetParts,
  limitStopReason,
  waitingLimitPause,
} from "./limit-continue"
import { deriveSessionActivity, summaryActivity } from "./session-activity"
import type { LimitPause } from "./types"

const pause = (state: LimitPause["state"]): LimitPause => ({
  resets_at: "2026-10-02T19:00:00.000Z",
  state,
  attempts: 0,
})

describe("the continuation prompt", () => {
  it("is recognized by its exact text only", () => {
    expect(isLimitContinuePrompt(LIMIT_CONTINUE_PROMPT)).toBe(true)
    expect(isLimitContinuePrompt(`  ${LIMIT_CONTINUE_PROMPT}\n`)).toBe(true)
    expect(isLimitContinuePrompt(`${LIMIT_CONTINUE_PROMPT} Also lint.`)).toBe(
      false
    )
    expect(isLimitContinuePrompt("continue")).toBe(false)
  })

  it("asks for stopped sub-agents to be picked up where they stopped", () => {
    expect(LIMIT_CONTINUE_PROMPT).toMatch(/resume any sub-agents/)
    expect(LIMIT_CONTINUE_PROMPT).toMatch(/rather than starting it over/)
  })

  it("still recognizes the earlier wording in older transcripts", () => {
    expect(
      isLimitContinuePrompt(
        "Your usage limit has reset. Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete."
      )
    ).toBe(true)
  })
})

describe("waitingLimitPause", () => {
  it("is the pause while the session waits for the reset", () => {
    expect(waitingLimitPause({ limit_pause: pause("scheduled") })).toEqual(
      pause("scheduled")
    )
    expect(waitingLimitPause({ limit_pause: pause("claimed") })).toEqual(
      pause("claimed")
    )
  })

  it("is nothing once the continuation runs, or with no pause", () => {
    expect(waitingLimitPause({ limit_pause: pause("continuing") })).toBeNull()
    expect(waitingLimitPause({ limit_pause: null })).toBeNull()
    expect(waitingLimitPause({})).toBeNull()
    expect(waitingLimitPause(undefined)).toBeNull()
  })
})

describe("the reset time", () => {
  it("counts down compactly", () => {
    expect(formatRemaining(0)).toBe("<1m")
    expect(formatRemaining(-5_000)).toBe("<1m")
    expect(formatRemaining(30_000)).toBe("1m")
    expect(formatRemaining(12 * 60_000)).toBe("12m")
    expect(formatRemaining(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m")
    expect(formatRemaining(2 * 3_600_000)).toBe("2h")
    expect(formatRemaining(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h")
  })

  it("names the clock time, with the day when it is more than a day out", () => {
    const now = Date.parse("2026-10-02T15:48:00.000Z")
    const soon = limitResetParts("2026-10-02T19:00:00.000Z", now, "en-GB")
    expect(soon.remaining).toBe("3h 12m")
    expect(soon.time).toMatch(/\d{2}:00/)
    expect(soon.time).not.toMatch(/Oct/)
    const later = limitResetParts("2026-10-05T19:00:00.000Z", now, "en-GB")
    expect(later.remaining).toBe("3d 3h")
    expect(later.time).toMatch(/Oct/)
  })
})

describe("the paused activity state", () => {
  it("reads a session waiting for the reset as limit_paused", () => {
    expect(
      deriveSessionActivity({
        turnState: null,
        limitPause: pause("scheduled"),
      })
    ).toBe("limit_paused")
    expect(
      deriveSessionActivity({ turnState: null, limitPause: pause("claimed") })
    ).toBe("limit_paused")
    expect(
      summaryActivity({
        turn_state: null,
        status: "pending_review",
        limit_pause: pause("scheduled"),
      })
    ).toBe("limit_paused")
    // A live connection sitting idle changes nothing: it still waits.
    expect(
      deriveSessionActivity({
        turnState: null,
        connectionStatus: "connected",
        limitPause: pause("scheduled"),
      })
    ).toBe("limit_paused")
  })

  it("lets a running turn, the user, and this client's connect state outrank it", () => {
    // The continuation (or the user's own message) is streaming.
    expect(
      deriveSessionActivity({
        turnState: null,
        connectionStatus: "prompting",
        limitPause: pause("scheduled"),
      })
    ).toBe("working")
    expect(
      deriveSessionActivity({
        turnState: "running",
        limitPause: pause("continuing"),
      })
    ).toBe("working")
    expect(
      deriveSessionActivity({
        attention: "permission",
        limitPause: pause("scheduled"),
      })
    ).toBe("needs_you")
    expect(
      deriveSessionActivity({
        connection: "connecting",
        limitPause: pause("scheduled"),
      })
    ).toBe("connecting")
  })

  it("is plain idle or interrupted once the pause is gone", () => {
    expect(
      deriveSessionActivity({
        turnState: null,
        limitPause: pause("continuing"),
      })
    ).toBe("idle")
    expect(
      deriveSessionActivity({ turnState: "interrupted", limitPause: null })
    ).toBe("interrupted")
  })
})

describe("why the turn stopped on a limit", () => {
  it("reads a pause's reason, the account's own limit by default", () => {
    expect(limitPauseReason({ limit_reason: "pool_capacity" })).toBe(
      "pool_capacity"
    )
    expect(limitPauseReason({ limit_reason: null })).toBe("usage_limit")
    // An older server sends no reason at all.
    expect(limitPauseReason({})).toBe("usage_limit")
  })

  it("names a limit stop only once nothing continues by itself", () => {
    const stopped = {
      turn_state: "interrupted" as const,
      limit_pause: null,
      limit_reason: "pool_capacity" as const,
    }
    expect(limitStopReason(stopped)).toBe("pool_capacity")
    // Still waiting, or its continuation running: not stopped.
    expect(
      limitStopReason({ ...stopped, limit_pause: pause("scheduled") })
    ).toBeNull()
    expect(
      limitStopReason({ ...stopped, limit_pause: pause("continuing") })
    ).toBeNull()
    // A plain interruption, a finished turn, or no summary.
    expect(limitStopReason({ ...stopped, limit_reason: null })).toBeNull()
    expect(limitStopReason({ ...stopped, turn_state: null })).toBeNull()
    expect(limitStopReason(null)).toBeNull()
  })
})
