import { describe, expect, it } from "vitest"

import {
  deriveSessionActivity,
  isTurnRunning,
  summaryActivity,
} from "./session-activity"

describe("deriveSessionActivity", () => {
  it("reads the persisted turn state", () => {
    expect(deriveSessionActivity({ turnState: "running" })).toBe("working")
    expect(deriveSessionActivity({ turnState: "interrupted" })).toBe(
      "interrupted"
    )
    expect(deriveSessionActivity({ turnState: null })).toBe("idle")
  })

  it("does not read the review status as running once the server reports turns", () => {
    // The bug this exists for: `in_progress` is the default for every
    // conversation and survives a killed turn, so it can't mean "working".
    expect(
      deriveSessionActivity({ turnState: null, status: "in_progress" })
    ).toBe("idle")
    expect(
      deriveSessionActivity({ turnState: "interrupted", status: "in_progress" })
    ).toBe("interrupted")
  })

  it("falls back to the review status for a server that predates turn state", () => {
    expect(deriveSessionActivity({ status: "in_progress" })).toBe("working")
    expect(deriveSessionActivity({ status: "pending_review" })).toBe("idle")
    expect(deriveSessionActivity({})).toBe("idle")
  })

  it("puts a pending permission or question above everything", () => {
    for (const attention of [
      "permission",
      "question",
      "plan_approval",
    ] as const) {
      expect(
        deriveSessionActivity({
          attention,
          turnState: "running",
          connectionStatus: "prompting",
        })
      ).toBe("needs_you")
    }
    expect(
      deriveSessionActivity({ attention: "question", turnState: null })
    ).toBe("needs_you")
  })

  it("trusts this client's own streaming connection first", () => {
    // A turn just started here; the persisted state hasn't caught up yet.
    expect(
      deriveSessionActivity({ turnState: null, connectionStatus: "prompting" })
    ).toBe("working")
    // "continue" was just sent on an interrupted session.
    expect(
      deriveSessionActivity({
        turnState: "interrupted",
        connectionStatus: "prompting",
      })
    ).toBe("working")
  })

  it("lets an idle live connection overrule a persisted running mark", () => {
    // The turn just ended here; the upsert clearing the mark is still in flight.
    expect(
      deriveSessionActivity({
        turnState: "running",
        connectionStatus: "connected",
      })
    ).toBe("idle")
    expect(
      deriveSessionActivity({
        status: "in_progress",
        connectionStatus: "connected",
      })
    ).toBe("idle")
  })

  it("keeps an interruption visible after the session is resumed, until a turn is sent", () => {
    expect(
      deriveSessionActivity({
        turnState: "interrupted",
        connectionStatus: "connected",
      })
    ).toBe("interrupted")
    expect(
      deriveSessionActivity({
        turnState: "interrupted",
        connectionStatus: "connecting",
      })
    ).toBe("interrupted")
  })

  it("keeps a persisted running turn when this client has no idle connection to say otherwise", () => {
    for (const connectionStatus of [
      null,
      undefined,
      "connecting",
      "disconnected",
      "error",
    ] as const) {
      expect(
        deriveSessionActivity({ turnState: "running", connectionStatus })
      ).toBe("working")
    }
  })
})

describe("summary helpers", () => {
  it("derive from a summary's own fields", () => {
    expect(summaryActivity({ status: "in_progress", turn_state: null })).toBe(
      "idle"
    )
    expect(
      summaryActivity({ status: "cancelled", turn_state: "interrupted" })
    ).toBe("interrupted")
    expect(
      summaryActivity(
        { status: "in_progress", turn_state: "running" },
        "permission"
      )
    ).toBe("needs_you")
  })

  it("count a turn as running whether or not it is blocked on the user", () => {
    expect(
      isTurnRunning({ status: "in_progress", turn_state: "running" })
    ).toBe(true)
    expect(isTurnRunning({ status: "in_progress", turn_state: null })).toBe(
      false
    )
    expect(
      isTurnRunning({ status: "in_progress", turn_state: "interrupted" })
    ).toBe(false)
    // Older server: the review status is all there is.
    expect(isTurnRunning({ status: "in_progress" })).toBe(true)
  })
})
