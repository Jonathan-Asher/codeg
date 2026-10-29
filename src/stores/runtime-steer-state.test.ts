/**
 * A message the user steers into a running reply shows at once as theirs,
 * with where it stands (sending, waiting for the agent, and why), until the
 * agent has read it; the transcript's own copy never doubles it, and the turn
 * ending keeps a native steer as a message while a pull note leaves the
 * transcript for the notes list.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  getTimelineTurns,
  liveMessageForPromotion,
  resetConversationRuntimeStore,
  steerStateOf,
  useConversationRuntimeStore,
} from "./conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const server = vi.mocked(getFolderConversation)

const CID = 77
const PROMPT = "ship the release"
const STEER = "Make sure there's no security risk"
const at = (s: number) =>
  new Date(Date.UTC(2026, 9, 29, 8, 27, 0) + s * 1000).toISOString()

function userTurn(id: string, body: string, s: number): MessageTurn {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text: body }],
    timestamp: at(s),
  }
}
function agentTurn(id: string, body: string, s: number): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text: body }],
    timestamp: at(s),
  }
}

function windowed(
  turns: MessageTurn[],
  extra: Partial<DbConversationDetail> = {}
) {
  return {
    summary: { id: CID, external_id: "ext-77" },
    turns,
    session_stats: null,
    turns_offset: 0,
    turns_total: turns.length,
    assistant_turns_before_offset: 0,
    prefix_hash: extendPrefixFingerprint(FNV_SEED_HEX, [])!,
    ...extra,
  } as unknown as DbConversationDetail
}

const steering = (
  state: "sending" | "waiting" | null,
  channel: "native" | "pull" = "native"
): LiveContentBlock => ({
  type: "steering",
  id: "c-1",
  text: STEER,
  createdAt: at(1),
  state,
  channel,
})

const subAgent = (status: string): LiveContentBlock =>
  ({
    type: "tool_call",
    info: {
      tool_call_id: "task-1",
      title: "Task",
      kind: "think",
      status,
      content: null,
      raw_input: JSON.stringify({
        subagent_type: "general-purpose",
        prompt: "dig",
      }),
      raw_output: null,
      raw_output_chunks: [],
      locations: null,
      meta: { claudeCode: { toolName: "Task" } },
    },
  }) as unknown as LiveContentBlock

function live(content: LiveContentBlock[]): LiveMessage {
  return {
    id: "lm-1",
    role: "assistant",
    startedAt: Date.parse(at(0)),
    content,
  }
}

const actions = () => useConversationRuntimeStore.getState().actions

function startTurn(content: LiveContentBlock[]) {
  actions().fetchDetail(CID)
  actions().appendOptimisticTurn(CID, userTurn("opt-1", PROMPT, 0), "token-1")
  actions().setLiveMessage(CID, live(content), true)
}

const thread = () =>
  getTimelineTurns(CID).flatMap(({ turn }) =>
    turn.blocks.flatMap((b) =>
      b.type === "text" ? [`${turn.role}: ${b.text}`] : []
    )
  )
const steerStates = () =>
  getTimelineTurns(CID).flatMap(({ turn }) =>
    turn.steer_state ? [turn.steer_state] : []
  )

afterEach(() => {
  resetConversationRuntimeStore()
  server.mockReset()
})

describe("steerStateOf", () => {
  it("reads sending, then waiting, then read once the agent says something past it", () => {
    const sent = [
      { type: "text", text: "a" } as LiveContentBlock,
      steering("sending"),
    ]
    expect(steerStateOf(sent, 1, false)).toBe("sending")
    const waiting = [sent[0], steering("waiting")]
    expect(steerStateOf(waiting, 1, false)).toBe("waiting")
    expect(
      steerStateOf([...waiting, { type: "text", text: "on it" }], 1, false)
    ).toBeNull()
    // A plan moving to the end, or a sub-agent's own words, are not the agent
    // taking the message in.
    expect(
      steerStateOf(
        [...waiting, { type: "text", text: "sub", parentToolUseId: "task-1" }],
        1,
        true
      )
    ).toBe("waiting_subagent")
    expect(steerStateOf([steering(null)], 0, false)).toBeNull()
  })
})

describe("a steered message in the running reply", () => {
  it("shows at once as the user's message, with where it stands", () => {
    server.mockResolvedValue(windowed([]))
    startTurn([{ type: "text", text: "Building." }, steering("sending")])
    expect(thread()).toEqual([
      `user: ${PROMPT}`,
      "assistant: Building.",
      `user: ${STEER}`,
    ])
    expect(steerStates()).toEqual(["sending"])

    actions().setLiveMessage(
      CID,
      live([
        { type: "text", text: "Building." },
        subAgent("in_progress"),
        steering("waiting"),
      ]),
      true
    )
    expect(steerStates()).toEqual(["waiting_subagent"])

    actions().setLiveMessage(
      CID,
      live([
        { type: "text", text: "Building." },
        subAgent("completed"),
        steering("waiting"),
        { type: "text", text: "Checked: no secrets in the bundle." },
      ]),
      true
    )
    expect(steerStates()).toEqual([])
  })

  it("is not doubled by the transcript's own copy", async () => {
    server.mockResolvedValue(windowed([]))
    startTurn([
      { type: "text", text: "Building." },
      steering("waiting"),
      { type: "text", text: "Checked." },
    ])
    // Mid-turn, the transcript already holds the steered message as a user
    // turn (written when the agent took it in, after it was sent).
    server.mockResolvedValue(
      windowed(
        [
          userTurn("opt-1", PROMPT, 0),
          agentTurn("turn-1", "Building.", 1),
          userTurn("turn-2", STEER, 2),
          agentTurn("turn-3", "Checked.", 3),
        ],
        { in_flight_user_turn_id: "opt-1" }
      )
    )
    await actions().refetchDetail(CID, { quiet: true })
    expect(thread().filter((line) => line === `user: ${STEER}`)).toHaveLength(1)
  })

  it("sits where the transcript put it once the turn settles, as after a reload", async () => {
    server.mockResolvedValue(windowed([]))
    startTurn([
      { type: "text", text: "Building." },
      steering("waiting"),
      { type: "text", text: "Checked." },
    ])
    actions().completeTurn(CID)
    // The agent took it in after one more step than the stream suggested:
    // the transcript's order wins.
    server.mockResolvedValue(
      windowed([
        userTurn("turn-0", PROMPT, 0),
        agentTurn("turn-1", "Building.", 1),
        agentTurn("turn-2", "Still building.", 2),
        userTurn("turn-3", STEER, 3),
        agentTurn("turn-4", "Checked.", 4),
      ])
    )
    await actions().refetchDetail(CID, { quiet: true })
    expect(thread()).toEqual([
      `user: ${PROMPT}`,
      "assistant: Building.",
      "assistant: Still building.",
      `user: ${STEER}`,
      "assistant: Checked.",
    ])
  })

  it("stays a message when the turn ends (native), and leaves for the notes list (pull)", () => {
    const native = liveMessageForPromotion(
      live([{ type: "text", text: "a" }, steering("waiting")])
    )
    expect(native.content[1]).toEqual(expect.objectContaining({ state: null }))
    const pull = liveMessageForPromotion(
      live([{ type: "text", text: "a" }, steering("waiting", "pull")])
    )
    expect(pull.content.map((b) => b.type)).toEqual(["text"])

    server.mockResolvedValue(windowed([]))
    startTurn([
      { type: "text", text: "Building." },
      steering("waiting", "pull"),
    ])
    actions().completeTurn(CID)
    const promoted = useConversationRuntimeStore
      .getState()
      .byConversationId.get(CID)!.localTurns
    expect(promoted.some((t) => t.role === "user" && t.id !== "opt-1")).toBe(
      false
    )
  })
})
