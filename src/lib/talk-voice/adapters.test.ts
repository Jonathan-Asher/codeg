import { describe, expect, it, vi } from "vitest"

import { nextSendFailure } from "@/lib/send-failure"
import {
  registerTalkSendAdapter,
  spokenSender,
  subscribeTalkSendAdapters,
  talkSendAdapter,
  type SpokenSenderDeps,
  type TalkSendAdapter,
} from "./adapters"

const noActiveTurn = new Error("no active turn")

function deps(overrides: Partial<SpokenSenderDeps> = {}) {
  const calls = {
    send: [] as { text: string; clientMessageId?: string }[],
    steer: [] as { text: string; clientId: string }[],
    enqueue: [] as { text: string; opts: Record<string, unknown> }[],
  }
  const base: SpokenSenderDeps = {
    connection: () => ({ status: "connected", nativeSteering: true }),
    steerAvailable: () => true,
    send: (draft, opts) => {
      calls.send.push({ text: draft.displayText, ...opts })
      return "sent"
    },
    steer: async (text, clientId) => {
      calls.steer.push({ text, clientId })
    },
    enqueue: (draft, opts) => {
      calls.enqueue.push({
        text: draft.displayText,
        opts: opts as Record<string, unknown>,
      })
    },
    newClientId: () => "optimistic-1",
    isNoActiveTurn: (error) => error === noActiveTurn,
    failure: (error) => nextSendFailure(error, undefined),
  }
  return { deps: { ...base, ...overrides }, calls }
}

describe("spokenSender (codeg-ios sendSpoken)", () => {
  // TalkSessionTests.testASpokenPromptGoesMarkedSpokenAndLeavesTheDraftAlone
  it("sends a prompt when the session is idle", async () => {
    const { deps: d, calls } = deps()
    await expect(spokenSender(d)("  תבדוק למה הבילד נופל  ")).resolves.toBe(
      "prompt"
    )
    expect(calls.send).toEqual([{ text: "תבדוק למה הבילד נופל" }])
    expect(calls.steer).toEqual([])
  })

  it("queues when the idle tab can't send yet", async () => {
    const { deps: d } = deps({ send: () => "queued" })
    await expect(spokenSender(d)("hello")).resolves.toBe("queued")
  })

  // TalkSessionTests.testASpokenInsertGoesIntoTheTurnMarkedSpokenAndLeavesTheDraftAlone
  it("goes into the running turn when it takes a message", async () => {
    const { deps: d, calls } = deps({
      connection: () => ({ status: "prompting", nativeSteering: true }),
    })
    await expect(spokenSender(d)("and lint?")).resolves.toBe("insert")
    expect(calls.steer).toEqual([
      { text: "and lint?", clientId: "optimistic-1" },
    ])
    expect(calls.send).toEqual([])
  })

  // TalkSessionTests.testASpokenInsertIntoATurnThatJustEndedGoesAsASpokenPrompt
  it("sends the same words as the next prompt when the turn just ended (NoActiveTurn)", async () => {
    const { deps: d, calls } = deps({
      connection: () => ({ status: "prompting", nativeSteering: true }),
      steer: async () => {
        throw noActiveTurn
      },
    })
    await expect(spokenSender(d)("one more")).resolves.toBe("prompt")
    expect(calls.send).toEqual([
      { text: "one more", clientMessageId: "optimistic-1" },
    ])
  })

  it("keeps a failed insert in the queue until the turn ends, marked not sent", async () => {
    const { deps: d, calls } = deps({
      connection: () => ({ status: "prompting", nativeSteering: true }),
      steer: async () => {
        throw new Error("network down")
      },
    })
    await expect(spokenSender(d)("try this")).resolves.toBe("queued")
    expect(calls.enqueue).toHaveLength(1)
    expect(calls.enqueue[0].opts).toMatchObject({
      clientMessageId: "optimistic-1",
      spoken: true,
      holdUntilTurnEnd: true,
    })
    expect(calls.enqueue[0].opts.failure).toBeDefined()
  })

  // TalkSessionTests.testASpokenMessageWhileTheAgentRepliesWithoutSteeringIsQueuedSpoken
  it("queues spoken while the agent replies without native steering", async () => {
    const { deps: d, calls } = deps({
      connection: () => ({ status: "prompting", nativeSteering: false }),
    })
    await expect(spokenSender(d)("wait")).resolves.toBe("queued")
    expect(calls.enqueue).toEqual([{ text: "wait", opts: { spoken: true } }])
    expect(calls.steer).toEqual([])
  })

  it("queues when steering is off for the session", async () => {
    const { deps: d, calls } = deps({
      connection: () => ({ status: "prompting", nativeSteering: true }),
      steerAvailable: () => false,
    })
    await expect(spokenSender(d)("wait")).resolves.toBe("queued")
    expect(calls.enqueue).toHaveLength(1)
  })

  it("sends nothing for empty words", async () => {
    const { deps: d, calls } = deps()
    await expect(spokenSender(d)("   ")).resolves.toBe("queued")
    expect(calls.send).toEqual([])
    expect(calls.enqueue).toEqual([])
  })
})

describe("the send adapter registry", () => {
  const adapter = (key: string): TalkSendAdapter => ({
    contextKey: key,
    sendSpoken: async () => "prompt",
  })

  it("keeps the newest registration, and a stale release leaves it alone", () => {
    const onChange = vi.fn()
    const off = subscribeTalkSendAdapters(onChange)
    const first = adapter("tab-a")
    const second = adapter("tab-b")
    const releaseFirst = registerTalkSendAdapter(42, first)
    const releaseSecond = registerTalkSendAdapter(42, second)
    expect(talkSendAdapter(42)).toBe(second)
    releaseFirst()
    expect(talkSendAdapter(42)).toBe(second)
    releaseSecond()
    expect(talkSendAdapter(42)).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(3)
    off()
  })
})
