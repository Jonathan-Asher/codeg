/**
 * A message steered into the running reply that was spoken through the
 * phone's Talk mode shows as the user's message with the mic marker, like the
 * history turn a reload brings: the live turn carries `spoken`, and keeps it
 * when the turn ends and the reply is promoted.
 */
import { describe, expect, it, vi } from "vitest"
import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import {
  buildStreamingTurnsFromLiveMessage,
  liveMessageForPromotion,
} from "./conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const CID = 42
const AT = "2026-11-01T10:00:00.000Z"

function steer(
  id: string,
  text: string,
  extra: Partial<Extract<LiveContentBlock, { type: "steering" }>> = {}
): LiveContentBlock {
  return {
    type: "steering",
    id,
    text,
    createdAt: AT,
    state: "waiting",
    channel: "native",
    ...extra,
  }
}

function live(content: LiveContentBlock[]): LiveMessage {
  return {
    id: "lm-1",
    role: "assistant",
    startedAt: Date.parse(AT),
    content,
  }
}

const userTurns = (message: LiveMessage, promoted = false) =>
  buildStreamingTurnsFromLiveMessage(
    CID,
    message,
    promoted ? { attachAgentTranscripts: false } : undefined
  ).turns.filter((turn) => turn.role === "user")

describe("a spoken message steered into the running reply", () => {
  it("is marked spoken, and a typed one beside it is not", () => {
    const turns = userTurns(
      live([
        { type: "text", text: "Building." },
        steer("n1", "wait, use the other API", { spoken: true }),
        { type: "text", text: "Switching." },
        steer("n2", "typed note"),
      ])
    )
    expect(turns.map((turn) => turn.blocks)).toEqual([
      [{ type: "text", text: "wait, use the other API" }],
      [{ type: "text", text: "typed note" }],
    ])
    expect(turns[0].spoken).toBe(true)
    // No flag at all on a typed message: the shape history has.
    expect(turns[1]).not.toHaveProperty("spoken")
  })

  it("stays marked when the turn ends and the reply is promoted", () => {
    const promoted = liveMessageForPromotion(
      live([
        { type: "text", text: "Building." },
        steer("n1", "stop for a second", { spoken: true }),
        { type: "text", text: "Stopped." },
      ])
    )
    const turns = userTurns(promoted, true)
    expect(turns).toHaveLength(1)
    expect(turns[0].spoken).toBe(true)
    // Read once its turn is over, like every native steer.
    expect(turns[0]).not.toHaveProperty("steer_state")
  })
})
