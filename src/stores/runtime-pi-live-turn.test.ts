/**
 * A run Pi starts by itself streams as a turn of its own (`acp::pi_meta`):
 * it opens with the marker of what woke it, and a notice no card claims shows
 * as a System note. History draws both as System turns of their own
 * (`parsers/pi/fold.rs`), so the live build makes the same turns, which then
 * draw through the same components.
 *
 * Such a run has no prompt, so the backend names its "woken by" divider as the
 * in-flight turn (`pi_agent_turn_anchor`): a detail fetched mid-run then hides
 * the persisted half of the reply the live stream is showing, exactly as it
 * does after a prompt.
 */

import { afterEach, describe, expect, it } from "vitest"

import type {
  LiveMessage,
  ToolCallInfo,
} from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  buildStreamingTurnsFromLiveMessage,
  getTimelineTurns,
  liveSystemTurnBlocks,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 91

const WAKE_META = {
  "codeg.agentWake": {
    version: 1,
    triggers: [
      { kind: "subagentSettled", text: "Background task completed: **scout**" },
    ],
  },
}

function call(id: string, meta: Record<string, unknown> | null): ToolCallInfo {
  return {
    tool_call_id: id,
    title: "agent_wake",
    kind: "other",
    status: "completed",
    content: null,
    raw_input: null,
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta,
    images: [],
  }
}

function liveMessage(content: LiveMessage["content"]): LiveMessage {
  return { id: "m1", role: "assistant", content, startedAt: 1_794_510_340_012 }
}

describe("live System turns", () => {
  it("draws the woken run's marker as a System turn ahead of the reply", () => {
    const { turns } = buildStreamingTurnsFromLiveMessage(
      CID,
      liveMessage([
        { type: "tool_call", info: call("pi-wake-t1", WAKE_META) },
        { type: "thinking", text: "Report result." },
        { type: "text", text: "The scout found 0 entries." },
      ])
    )
    expect(turns.map((t) => t.role)).toEqual(["system", "assistant"])
    const [marker, result] = turns[0].blocks
    expect(marker).toMatchObject({
      type: "tool_use",
      tool_use_id: "pi-wake-t1",
      tool_name: "agent_wake",
      meta: WAKE_META,
    })
    expect(result).toMatchObject({ type: "tool_result", is_error: false })
    expect(turns[1].blocks.map((b) => b.type)).toEqual(["thinking", "text"])
  })

  it("draws an unclaimed notice as a System note where it arrived", () => {
    const { turns } = buildStreamingTurnsFromLiveMessage(
      CID,
      liveMessage([
        { type: "text", text: "Working." },
        {
          type: "tool_call",
          info: call("pi-note-1", {
            "codeg.systemNote": {
              version: 1,
              customType: "my-ext",
              text: "Deploy window opens at 5pm",
            },
          }),
        },
        { type: "text", text: "Noted." },
      ])
    )
    expect(turns.map((t) => t.role)).toEqual(["assistant", "system", "assistant"])
    expect(turns[1].blocks).toEqual([
      { type: "text", text: "Deploy window opens at 5pm" },
    ])
  })

  it("leaves every other call alone", () => {
    expect(liveSystemTurnBlocks(call("c", null))).toBeNull()
    expect(
      liveSystemTurnBlocks(call("c", { "codeg.subagentRun": { status: "running" } }))
    ).toBeNull()
  })
})

function turn(
  id: string,
  role: MessageTurn["role"],
  blocks: MessageTurn["blocks"],
  timestamp: string
): MessageTurn {
  return { id, role, blocks, timestamp }
}

function detail(turns: MessageTurn[], inFlight: string | null): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      title: "t",
      title_locked: false,
      agent_type: "pi",
      status: "pending_review",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-11-12T19:05:30.000Z",
      updated_at: "2026-11-12T19:05:41.000Z",
      pinned_at: null,
    },
    turns,
    in_flight_user_turn_id: inFlight,
  }
}

function seed(d: DbConversationDetail, live: LiveMessage) {
  const session = {
    conversationId: CID,
    externalId: null,
    dbConversationId: null,
    detail: d,
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: live,
    syncState: "idle" as const,
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
  }
  const next = new Map(useConversationRuntimeStore.getState().byConversationId)
  next.set(CID, session)
  useConversationRuntimeStore.setState({ byConversationId: next })
}

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("a detail fetched while a woken run streams", () => {
  const history = [
    turn("u1", "user", [{ type: "text", text: "launch a scout" }], "2026-11-12T19:05:35.000Z"),
    turn("a1", "assistant", [{ type: "text", text: "LAUNCHED" }], "2026-11-12T19:05:36.000Z"),
    // The run Pi started by itself, as far as Pi has written it.
    turn(
      "pi-wake-row",
      "system",
      [
        { type: "text", text: "Pi continued on its own, woken by a sub-agent finishing." },
        {
          type: "tool_use",
          tool_use_id: "pi-wake-caad67a7",
          tool_name: "agent_wake",
          input_preview: null,
          meta: WAKE_META,
        },
        {
          type: "tool_result",
          tool_use_id: "pi-wake-caad67a7",
          output_preview: null,
          is_error: false,
        },
      ],
      "2026-11-12T19:05:40.000Z"
    ),
    turn("a2", "assistant", [{ type: "text", text: "The scout" }], "2026-11-12T19:05:41.000Z"),
  ]
  const live = liveMessage([
    { type: "tool_call", info: call("pi-wake-t1", WAKE_META) },
    { type: "text", text: "The scout found 0 entries." },
  ])

  it("hides the persisted half the live run re-shows, keeping the divider once", () => {
    seed(detail(history, "pi-wake-row"), live)
    const ids = getTimelineTurns(CID).map((t) => `${t.phase}:${t.turn.role}`)
    expect(ids).toEqual([
      "persisted:user",
      "persisted:assistant",
      "persisted:system",
      "streaming:assistant",
    ])
    expect(
      getTimelineTurns(CID).some((t) => t.turn.id === "a2"),
      "the persisted partial reply"
    ).toBe(false)
  })

  it("keeps everything when the backend reports no run in flight", () => {
    seed(detail(history, null), live)
    expect(getTimelineTurns(CID).some((t) => t.turn.id === "a2")).toBe(true)
  })
})
