import { describe, expect, it } from "vitest"

import type { AgentCapabilities } from "@/lib/agent-capabilities"
import {
  actionGate,
  actionSupported,
  editActionTarget,
  forkActionTarget,
  type ActionGateInputs,
  type PendingActionKind,
} from "@/lib/pending-actions"

const FULL: AgentCapabilities = {
  supportsFork: true,
  forkStrictPoint: true,
  forkWhileRunning: true,
}
const NO_FORK: AgentCapabilities = {
  supportsFork: false,
  forkStrictPoint: false,
  forkWhileRunning: false,
}

const READY: ActionGateInputs = {
  ready: true,
  capabilities: FULL,
  agentType: "claude_code",
  turnRunning: false,
  waitingMessageIds: new Set(),
  busy: false,
}

function gate(
  kind: PendingActionKind,
  overrides: Partial<ActionGateInputs> = {},
  after: string[] = []
) {
  return actionGate({ kind, after }, { ...READY, ...overrides })
}

const ALL: PendingActionKind[] = ["fork", "edit", "continue", "retry"]

describe("pending action targets", () => {
  it("names one control per reply and per message", () => {
    expect(forkActionTarget("t1")).not.toBe(forkActionTarget("t2"))
    expect(forkActionTarget("t1")).not.toBe(editActionTarget("t1"))
  })
})

describe("actionSupported", () => {
  it("needs session/fork for a fork, and a strict fork point for an edit", () => {
    expect(actionSupported("fork", "pi", FULL)).toBe(true)
    expect(actionSupported("fork", "pi", NO_FORK)).toBe(false)
    expect(
      actionSupported("edit", "pi", { ...FULL, forkStrictPoint: false })
    ).toBe(false)
    // These agents' adapters fork strictly on every version codeg runs.
    expect(
      actionSupported("edit", "claude_code", {
        ...FULL,
        forkStrictPoint: false,
      })
    ).toBe(true)
    expect(actionSupported("edit", "claude_code", NO_FORK)).toBe(false)
  })

  it("asks nothing of the agent for Continue and Retry", () => {
    expect(actionSupported("continue", "pi", NO_FORK)).toBe(true)
    expect(actionSupported("retry", "pi", NO_FORK)).toBe(true)
  })
})

describe("actionGate", () => {
  it("waits while the session is not ready", () => {
    for (const kind of ALL) {
      expect(gate(kind, { ready: false })).toBe("wait")
    }
  })

  it("waits until the connection itself has said what it can do", () => {
    for (const kind of ALL) {
      expect(gate(kind, { capabilities: null })).toBe("wait")
    }
  })

  it("runs every kind on a ready, idle session", () => {
    for (const kind of ALL) expect(gate(kind)).toBe("run")
  })

  it("drops what the connection's answer rules out (mismatch)", () => {
    expect(gate("fork", { capabilities: NO_FORK })).toBe("unsupported")
    expect(
      gate("edit", {
        agentType: "pi",
        capabilities: { ...FULL, forkStrictPoint: false },
      })
    ).toBe("unsupported")
    // Unsupported is final even while the session is busy: nothing will make
    // it possible on this connection.
    expect(gate("fork", { capabilities: NO_FORK, busy: true })).toBe(
      "unsupported"
    )
  })

  it("runs after the messages that were waiting when it was taken", () => {
    const waiting = new Set(["m1"])
    expect(gate("fork", { waitingMessageIds: waiting }, ["m1"])).toBe("wait")
    // A message queued after it does not hold it back.
    expect(gate("fork", { waitingMessageIds: waiting }, [])).toBe("run")
    // Once the earlier message went out.
    expect(gate("fork", {}, ["m1"])).toBe("run")
  })

  it("waits while a fork, an edit or a send is under way", () => {
    for (const kind of ALL) expect(gate(kind, { busy: true })).toBe("wait")
  })

  it("lets a turn in flight hold only what it is in the way of", () => {
    const running = { turnRunning: true }
    // Claude Code forks a finished reply into a new tab mid-turn.
    expect(gate("fork", running)).toBe("run")
    // An agent that only forks between turns waits for it to end.
    expect(
      gate("fork", {
        ...running,
        agentType: "codex",
        capabilities: { ...FULL, forkWhileRunning: false },
      })
    ).toBe("wait")
    expect(gate("edit", running)).toBe("wait")
    expect(gate("retry", running)).toBe("wait")
    // Continue joins the message queue, which waits for the turn itself.
    expect(gate("continue", running)).toBe("run")
  })
})
