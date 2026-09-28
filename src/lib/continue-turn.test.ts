import { describe, expect, it } from "vitest"

import {
  canOfferContinue,
  continuePromptDraft,
  isContinuationGroup,
  isContinuePrompt,
  threadEndsWithAgentReply,
  type ContinueGateInputs,
  type ContinuationGroupLike,
} from "./continue-turn"
import {
  CONTINUE_PROMPT,
  deriveSessionActivity,
  type SessionActivityInputs,
} from "./session-activity"

/** A conversation that can take a Continue: connected, idle, the agent has
 *  replied, nothing owed or queued. Each case changes one thing. */
const OPEN: Omit<ContinueGateInputs, "activity"> = {
  endsWithAgentReply: true,
  pendingInteraction: false,
  queuedCount: 0,
  connectionReady: true,
  composerAvailable: true,
}

/** The gate fed the way the panel feeds it: activity derived from the live
 *  signals. */
function gate(
  signals: SessionActivityInputs,
  overrides: Partial<Omit<ContinueGateInputs, "activity">> = {}
): boolean {
  return canOfferContinue({
    ...OPEN,
    ...overrides,
    activity: deriveSessionActivity(signals),
  })
}

describe("canOfferContinue", () => {
  it("offers Continue once the agent has replied and the session is idle", () => {
    // The summary records no turn in flight, the live connection is idle.
    expect(gate({ connectionStatus: "connected", turnState: null })).toBe(true)
    // A server that predates `turn_state`.
    expect(gate({ connectionStatus: "connected" })).toBe(true)
    // A persisted "running" the live connection has already outrun.
    expect(gate({ connectionStatus: "connected", turnState: "running" })).toBe(
      true
    )
  })

  it("offers it while background work holds an idle agent's turn open", () => {
    expect(
      gate({ connectionStatus: "prompting", awaitingBackground: true })
    ).toBe(true)
    // The held turn is not the idle send path: its readiness is the held
    // turn's business, not the idle connection's.
    expect(
      gate(
        { connectionStatus: "prompting", awaitingBackground: true },
        { connectionReady: false }
      )
    ).toBe(true)
  })

  it("hides it while a turn is in flight", () => {
    expect(gate({ connectionStatus: "prompting" })).toBe(false)
    // No live connection here, but the summary says a turn runs.
    expect(gate({ turnState: "running" }, { connectionReady: false })).toBe(
      false
    )
  })

  it("hides it while the session waits on the user", () => {
    for (const attention of [
      "permission",
      "question",
      "plan_approval",
    ] as const) {
      expect(gate({ connectionStatus: "connected", attention })).toBe(false)
      // A background sub-agent asking while the turn is held.
      expect(
        gate({
          connectionStatus: "prompting",
          awaitingBackground: true,
          attention,
        })
      ).toBe(false)
    }
    // This tab's own pending dialog, before the attention store catches up.
    expect(
      gate({ connectionStatus: "connected" }, { pendingInteraction: true })
    ).toBe(false)
  })

  it("hides it while disconnected, connecting or unreachable", () => {
    expect(
      gate({ connectionStatus: "disconnected" }, { connectionReady: false })
    ).toBe(false)
    expect(
      gate({ connectionStatus: "connecting" }, { connectionReady: false })
    ).toBe(false)
    expect(
      gate(
        { connectionStatus: "connecting", connection: "connecting" },
        { connectionReady: false }
      )
    ).toBe(false)
    expect(gate({ connection: "failed" }, { connectionReady: false })).toBe(
      false
    )
    // Connected, but not yet ready for this tab (selectors loading, another
    // agent's connection, a stale working directory).
    expect(
      gate({ connectionStatus: "connected" }, { connectionReady: false })
    ).toBe(false)
  })

  it("leaves an interrupted turn to its banner's Continue", () => {
    expect(
      gate({ connectionStatus: "connected", turnState: "interrupted" })
    ).toBe(false)
  })

  it("hides it before the agent has replied", () => {
    expect(
      gate({ connectionStatus: "connected" }, { endsWithAgentReply: false })
    ).toBe(false)
  })

  it("hides it while a message is queued — that one starts the next turn", () => {
    expect(gate({ connectionStatus: "connected" }, { queuedCount: 1 })).toBe(
      false
    )
    expect(
      gate(
        { connectionStatus: "prompting", awaitingBackground: true },
        { queuedCount: 2 }
      )
    ).toBe(false)
  })

  it("hides it where the composer itself is not shown", () => {
    expect(
      gate({ connectionStatus: "connected" }, { composerAvailable: false })
    ).toBe(false)
  })
})

describe("threadEndsWithAgentReply", () => {
  const t = (role: "user" | "assistant" | "system") => ({ turn: { role } })

  it("is true when the newest message is the agent's", () => {
    expect(threadEndsWithAgentReply([t("user"), t("assistant")])).toBe(true)
  })

  it("looks past system notices (a compaction, a session event)", () => {
    expect(
      threadEndsWithAgentReply([t("user"), t("assistant"), t("system")])
    ).toBe(true)
  })

  it("is false for an empty thread or one that ends on the user", () => {
    expect(threadEndsWithAgentReply([])).toBe(false)
    expect(threadEndsWithAgentReply([t("system")])).toBe(false)
    expect(threadEndsWithAgentReply([t("assistant"), t("user")])).toBe(false)
  })
})

describe("continuePromptDraft", () => {
  it("is the plain CONTINUE_PROMPT, as a typed message would be", () => {
    expect(continuePromptDraft()).toEqual({
      blocks: [{ type: "text", text: CONTINUE_PROMPT }],
      displayText: CONTINUE_PROMPT,
    })
  })
})

describe("isContinuePrompt", () => {
  it("matches the exact prompt, ignoring surrounding whitespace", () => {
    expect(isContinuePrompt(CONTINUE_PROMPT)).toBe(true)
    expect(isContinuePrompt(`  ${CONTINUE_PROMPT}\n`)).toBe(true)
  })

  it("leaves any other text alone", () => {
    expect(isContinuePrompt("continue with the tests")).toBe(false)
    expect(isContinuePrompt("please continue")).toBe(false)
    expect(isContinuePrompt("Continue.")).toBe(false)
    expect(isContinuePrompt("")).toBe(false)
  })
})

describe("isContinuationGroup", () => {
  const group = (
    overrides: Partial<ContinuationGroupLike> = {}
  ): ContinuationGroupLike => ({
    role: "user",
    parts: [{ type: "text", text: CONTINUE_PROMPT }],
    images: [],
    resources: [],
    ...overrides,
  })

  it("is a user message of exactly the Continue prompt", () => {
    expect(isContinuationGroup(group())).toBe(true)
  })

  it("keeps a genuine message that merely says continue as a bubble", () => {
    expect(
      isContinuationGroup(
        group({ parts: [{ type: "text", text: "continue with the plan" }] })
      )
    ).toBe(false)
    // "continue" with a screenshot, or a file, is something the user wrote.
    expect(isContinuationGroup(group({ images: [{}] }))).toBe(false)
    expect(isContinuationGroup(group({ resources: [{}] }))).toBe(false)
  })

  it("never treats the agent's own words as one", () => {
    expect(isContinuationGroup(group({ role: "assistant" }))).toBe(false)
  })

  it("needs text and nothing but text", () => {
    expect(isContinuationGroup(group({ parts: [] }))).toBe(false)
    expect(
      isContinuationGroup(
        group({
          parts: [
            { type: "text", text: CONTINUE_PROMPT },
            { type: "reasoning", content: "", isStreaming: false },
          ],
        })
      )
    ).toBe(false)
  })
})
