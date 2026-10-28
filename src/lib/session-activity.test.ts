import { describe, expect, it } from "vitest"

import {
  backgroundTaskTotal,
  deriveSessionActivity,
  isSessionRunning,
  isTurnRunning,
  lastReplyLine,
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

describe("deriveSessionActivity with this client's connection attempt", () => {
  it("never reads idle while the agent is still opening the session", () => {
    expect(
      deriveSessionActivity({ turnState: null, connection: "connecting" })
    ).toBe("connecting")
    // An interrupted turn can only be continued once the session is open.
    expect(
      deriveSessionActivity({
        turnState: "interrupted",
        connection: "connecting",
      })
    ).toBe("connecting")
  })

  it("says the session could not be opened rather than idle", () => {
    expect(
      deriveSessionActivity({ turnState: null, connection: "failed" })
    ).toBe("connect_failed")
    expect(
      deriveSessionActivity({ turnState: "running", connection: "failed" })
    ).toBe("connect_failed")
  })

  it("ranks a turn in flight and a block on the user above the connection", () => {
    expect(
      deriveSessionActivity({
        attention: "permission",
        connection: "connecting",
      })
    ).toBe("needs_you")
    expect(
      deriveSessionActivity({
        connectionStatus: "prompting",
        connection: "connecting",
      })
    ).toBe("working")
  })

  it("falls back to the persisted state once the connection is settled", () => {
    expect(deriveSessionActivity({ turnState: null, connection: null })).toBe(
      "idle"
    )
  })

  it("reads a turn held open for background work as idle with work running", () => {
    expect(
      deriveSessionActivity({
        turnState: "running",
        connectionStatus: "prompting",
        awaitingBackground: true,
      })
    ).toBe("background")
    // The agent replying is still just working.
    expect(
      deriveSessionActivity({
        turnState: "running",
        connectionStatus: "prompting",
        awaitingBackground: false,
      })
    ).toBe("working")
    // A stale flag on a turn that already ended means nothing.
    expect(
      deriveSessionActivity({
        turnState: null,
        connectionStatus: "connected",
        awaitingBackground: true,
      })
    ).toBe("idle")
  })

  it("still puts a background sub-agent's permission request first", () => {
    expect(
      deriveSessionActivity({
        attention: "permission",
        connectionStatus: "prompting",
        awaitingBackground: true,
      })
    ).toBe("needs_you")
  })

  it("keeps a held turn out of the sidebar's running count only via live state", () => {
    // The persisted summary alone still says running — only a client holding
    // the live connection knows the agent is idle.
    expect(
      isTurnRunning({ turn_state: "running", status: "in_progress" })
    ).toBe(true)
  })
})

describe("deriveSessionActivity with the server's background status", () => {
  const tasks = (task_count: number) => ({
    task_count,
    out_of_turn: false,
    held_open: false,
  })

  it("reads tasks still running after the turn ended as background", () => {
    expect(
      deriveSessionActivity({ turnState: null, background: tasks(2) })
    ).toBe("background")
    // Including on a client whose own connection is idle.
    expect(
      deriveSessionActivity({
        turnState: null,
        connectionStatus: "connected",
        background: tasks(1),
      })
    ).toBe("background")
    expect(
      deriveSessionActivity({ turnState: null, background: tasks(0) })
    ).toBe("idle")
  })

  it("reads the agent running a turn of its own as working", () => {
    const outOfTurn = { ...tasks(1), out_of_turn: true }
    expect(
      deriveSessionActivity({ turnState: null, background: outOfTurn })
    ).toBe("working")
    // The client's own idle connection doesn't know about that turn.
    expect(
      deriveSessionActivity({
        turnState: null,
        connectionStatus: "connected",
        background: outOfTurn,
      })
    ).toBe("working")
    // An interrupted codeg turn doesn't hide the agent working now.
    expect(
      deriveSessionActivity({ turnState: "interrupted", background: outOfTurn })
    ).toBe("working")
  })

  it("reads a turn the server says is held open as background", () => {
    const held = { ...tasks(0), held_open: true }
    expect(
      deriveSessionActivity({ turnState: "running", background: held })
    ).toBe("background")
    // This client's own connection is first-hand: prompting and not awaiting
    // means the agent is answering right now.
    expect(
      deriveSessionActivity({
        turnState: "running",
        connectionStatus: "prompting",
        awaitingBackground: false,
        background: held,
      })
    ).toBe("working")
  })

  it("keeps a normal turn working even with tasks around it", () => {
    expect(
      deriveSessionActivity({ turnState: "running", background: tasks(3) })
    ).toBe("working")
  })

  it("lets the user's attention outrank everything in the background", () => {
    expect(
      deriveSessionActivity({
        attention: "question",
        turnState: null,
        background: { ...tasks(2), out_of_turn: true },
      })
    ).toBe("needs_you")
  })

  it("keeps an interrupted turn's Continue when only tasks remain", () => {
    expect(
      deriveSessionActivity({ turnState: "interrupted", background: tasks(1) })
    ).toBe("interrupted")
  })

  it("behaves exactly as before against a server without the status", () => {
    expect(
      deriveSessionActivity({ turnState: null, background: undefined })
    ).toBe("idle")
    expect(
      deriveSessionActivity({ turnState: "running", background: null })
    ).toBe("working")
  })
})

describe("isSessionRunning", () => {
  it("counts turns and background work, not idle or interrupted sessions", () => {
    expect(
      isSessionRunning({ turn_state: "running", status: "in_progress" })
    ).toBe(true)
    expect(
      isSessionRunning(
        { turn_state: null, status: "pending_review" },
        { task_count: 1 }
      )
    ).toBe(true)
    expect(
      isSessionRunning(
        { turn_state: null, status: "pending_review" },
        { task_count: 0, out_of_turn: true }
      )
    ).toBe(true)
    expect(
      isSessionRunning({ turn_state: null, status: "pending_review" })
    ).toBe(false)
    expect(
      isSessionRunning(
        { turn_state: "interrupted", status: "pending_review" },
        { task_count: 1 }
      )
    ).toBe(false)
  })
})

describe("backgroundTaskTotal", () => {
  it("takes the larger of the held turn's own count and the server's", () => {
    expect(backgroundTaskTotal(null, undefined)).toBe(0)
    expect(backgroundTaskTotal(2, { task_count: 1 })).toBe(2)
    expect(backgroundTaskTotal(null, { task_count: 3 })).toBe(3)
  })
})

describe("lastReplyLine", () => {
  it("quotes the reply's last line and says when it asks", () => {
    expect(
      lastReplyLine("Changed the layout.\n\nWant me to change the box to that?\n")
    ).toEqual({ text: "Want me to change the box to that?", asks: true })
    expect(lastReplyLine("## Summary\n- **Ship it?**\n")).toEqual({
      text: "Ship it?",
      asks: true,
    })
    expect(lastReplyLine("All three tests pass.")).toEqual({
      text: "All three tests pass.",
      asks: false,
    })
  })

  it("cuts a long line and has nothing to say for an empty reply", () => {
    const long = lastReplyLine("word ".repeat(40))
    expect(long?.text.endsWith("…")).toBe(true)
    expect(Array.from(long?.text ?? "").length).toBeLessThanOrEqual(91)
    expect(lastReplyLine(" \n\n")).toBeNull()
  })
})
