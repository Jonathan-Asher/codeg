/**
 * A message the user sends while a turn runs is absorbed into that turn: the
 * agent reads it at its next step, works on, and answers in the same turn.
 * Claude Code records it as a user message in the middle of the reply, so the
 * transcript (and every detail parsed from it) carries
 *
 *   prompt, first half of the reply, the inserted message, second half
 *
 * while this client holds its own copy of all four: the optimistic prompt, and
 * the live message with the insert as a `steering` block between the halves.
 *
 * These tests walk one such turn from the send to the settled transcript and
 * check what the thread reads at every step: each assistant block present, in
 * order, the inserted message once, and each half of the reply timed on its own.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  LiveContentBlock,
  LiveMessage,
  ToolCallInfo,
} from "@/contexts/acp-connections-context"
import type {
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
  TurnRole,
} from "@/lib/types"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import {
  computeTurnMetadataPatches,
  getTimelineTurns,
  localCopyMissesReplyText,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 203
const PROMPT = "make the front text a little bolder"
const INSERT = "Do we have to write the info in red?"
const PNG = "iVBORw0KGgo="
const FINAL = "The updated box files are on your Mac."

const at = (secs: number) =>
  new Date(Date.UTC(2026, 9, 28, 9, 50, 0) + secs * 1000).toISOString()

function text(t: string): ContentBlock {
  return { type: "text", text: t }
}

function turn(
  id: string,
  role: TurnRole,
  blocks: ContentBlock[],
  secs: number,
  extra: Partial<MessageTurn> = {}
): MessageTurn {
  return { id, role, blocks, timestamp: at(secs), ...extra }
}

/** One finished tool round as the parser writes it: the call and its result. */
function toolRound(id: string, command: string): ContentBlock[] {
  return [
    {
      type: "tool_use",
      tool_use_id: id,
      tool_name: "Bash",
      input_preview: JSON.stringify({ command }),
    },
    {
      type: "tool_result",
      tool_use_id: id,
      output_preview: "ok",
      is_error: false,
    },
  ]
}

/** History before this turn: one settled exchange. */
const HISTORY: MessageTurn[] = [
  turn("turn-0", "user", [text("earlier question")], 0),
  turn("turn-1", "assistant", [text("earlier answer")], 5, {
    completed_at: at(5),
    duration_ms: 5_000,
  }),
]

/**
 * The transcript after the turn, as the parser returns it. Each half of the
 * reply is several turns (a thinking block, each tool round, the answer), and
 * every one carries the span since the previous record ended.
 */
const SETTLED_TURN: MessageTurn[] = [
  turn("turn-2", "user", [text(PROMPT)], 60),
  turn(
    "turn-3",
    "assistant",
    [text("Sending the files:"), ...toolRound("t1", "scp box")],
    70,
    { completed_at: at(108), duration_ms: 48_000 }
  ),
  turn(
    "turn-4",
    "user",
    [text(INSERT), { type: "image", data: PNG, mime_type: "image/png" }],
    108
  ),
  turn("turn-5", "assistant", [{ type: "thinking", text: "" }], 122, {
    completed_at: at(122),
    duration_ms: 14_000,
  }),
  turn("turn-6", "assistant", toolRound("t2", "cat out"), 124, {
    completed_at: at(124),
    duration_ms: 2_000,
  }),
  turn("turn-7", "assistant", toolRound("t3", "wait for it"), 132, {
    completed_at: at(220),
    duration_ms: 96_000,
  }),
  turn("turn-8", "assistant", [{ type: "thinking", text: "" }], 229, {
    completed_at: at(229),
    duration_ms: 9_000,
  }),
  turn("turn-9", "assistant", [text(FINAL)], 229, {
    completed_at: at(229.4),
    duration_ms: 400,
  }),
]

const FULL = [...HISTORY, ...SETTLED_TURN]

function prefixHash(count: number): string {
  const h = extendPrefixFingerprint(FNV_SEED_HEX, FULL.slice(0, count))
  if (h === null) throw new Error("fingerprint failed")
  return h
}

function windowed(
  offset: number,
  turns: MessageTurn[],
  extra: Partial<DbConversationDetail> = {}
): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: null,
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-203",
      message_count: offset + turns.length,
      child_count: 0,
      created_at: at(0),
      updated_at: at(230),
      pinned_at: null,
    },
    turns,
    session_stats: null,
    transcript_watermark: null,
    in_flight_user_turn_id: null,
    turns_offset: offset,
    turns_total: offset + turns.length,
    assistant_turns_before_offset: FULL.slice(0, offset).filter(
      (t) => t.role === "assistant"
    ).length,
    prefix_hash: prefixHash(offset),
    uncovered_prefix_max_ts: offset > 0 ? FULL[offset - 1].timestamp : null,
    ...extra,
  }
}

function tool(id: string, title: string): LiveContentBlock {
  const info: ToolCallInfo = {
    tool_call_id: id,
    title,
    kind: "execute",
    status: "completed",
    content: null,
    raw_input: JSON.stringify({ command: title }),
    raw_output_chunks: ["ok"],
    raw_output_total_bytes: 2,
    locations: null,
    meta: null as unknown as ToolCallInfo["meta"],
    images: [],
  }
  return { type: "tool_call", info }
}

/** The reply as this client streamed it, the insert between its halves. */
const LIVE: LiveMessage = {
  id: "lm-1",
  role: "assistant",
  startedAt: Date.parse(at(61)),
  content: [
    { type: "text", text: "Sending the files:" },
    tool("t1", "scp box"),
    {
      type: "steering",
      id: "note-1",
      text: INSERT,
      // Stamped before the agent had it, so before its own record of it.
      createdAt: at(107.9),
      blocks: [
        { type: "text", text: INSERT },
        { type: "image", data: PNG, mime_type: "image/png" },
      ],
    },
    tool("t2", "cat out"),
    tool("t3", "wait for it"),
    { type: "text", text: FINAL },
  ],
}

function emptySession(): ConversationRuntimeSession {
  return {
    conversationId: CID,
    externalId: "ext-203",
    dbConversationId: null,
    detail: windowed(0, HISTORY),
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    optimisticTurns: [],
    liveMessage: null,
    syncState: "idle",
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
}

const actions = () => useConversationRuntimeStore.getState().actions

/** Send the prompt and stream the whole reply, insert included. */
function runTurn(): void {
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, emptySession()]]),
  })
  actions().appendOptimisticTurn(
    CID,
    turn("opt-1", "user", [text(PROMPT)], 60),
    "token-1"
  )
  actions().setLiveMessage(CID, LIVE, true)
}

/** The thread top to bottom, one line per rendered block. */
function readThread(): string[] {
  const lines: string[] = []
  for (const { turn: t } of getTimelineTurns(CID)) {
    for (const b of t.blocks) {
      if (b.type === "text") lines.push(`${t.role}: ${b.text}`)
      else if (b.type === "tool_use") lines.push(`tool: ${b.tool_use_id}`)
    }
  }
  return lines
}

const EXPECTED_THREAD = [
  "user: earlier question",
  "assistant: earlier answer",
  `user: ${PROMPT}`,
  "assistant: Sending the files:",
  "tool: t1",
  `user: ${INSERT}`,
  "tool: t2",
  "tool: t3",
  `assistant: ${FINAL}`,
]

/** Summed `duration_ms` of each run of assistant turns, i.e. what each
 *  "Worked for" header shows once the thread merges the run into one reply. */
function workedFor(): number[] {
  const runs: number[] = []
  let open = false
  for (const { turn: t } of getTimelineTurns(CID)) {
    if (t.role !== "assistant") {
      open = false
      continue
    }
    if (!open) runs.push(0)
    open = true
    runs[runs.length - 1] += t.duration_ms ?? 0
  }
  return runs
}

afterEach(() => {
  vi.useRealTimers()
  mockGet.mockReset()
  resetConversationRuntimeStore()
})

describe("a message inserted into a running Claude turn", () => {
  it("shows the whole reply around the insert while it streams", () => {
    runTurn()
    expect(readThread()).toEqual(EXPECTED_THREAD)
  })

  it("keeps every block once a mid-turn refetch brings the transcript's copy", async () => {
    runTurn()
    // The transcript so far: the prompt (stamped with this client's id, as
    // the backend does for the running prompt), the first half, the insert
    // and part of the second half.
    mockGet.mockResolvedValue(
      windowed(
        0,
        [
          ...HISTORY,
          { ...SETTLED_TURN[0], id: "opt-1" },
          ...SETTLED_TURN.slice(1, 5),
        ],
        { in_flight_user_turn_id: "opt-1" }
      )
    )
    await actions().refetchDetail(CID, { quiet: true })
    expect(readThread()).toEqual(EXPECTED_THREAD)
  })

  it("leaves no second copy of the reply once a turn refetched mid-way settles", async () => {
    vi.useFakeTimers()
    runTurn()
    mockGet.mockResolvedValue(
      windowed(
        0,
        [
          ...HISTORY,
          { ...SETTLED_TURN[0], id: "opt-1" },
          ...SETTLED_TURN.slice(1, 5),
        ],
        { in_flight_user_turn_id: "opt-1" }
      )
    )
    await actions().refetchDetail(CID, { quiet: true })
    actions().completeTurn(CID)

    // The mid-turn snapshot is still on screen beside the finished local copy
    // until the post-turn sync reads the settled transcript.
    mockGet.mockImplementation(async (_id, opts) =>
      opts?.fromIndex === 2 ? windowed(2, SETTLED_TURN) : windowed(0, FULL)
    )
    actions().syncTurnMetadata(CID)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(readThread()).toEqual(EXPECTED_THREAD)
    expect(workedFor()).toEqual([5_000, 48_000, 121_400])
  })

  it("keeps the final reply and times each half after the turn settles", async () => {
    vi.useFakeTimers()
    runTurn()
    actions().completeTurn(CID)
    expect(readThread()).toEqual(EXPECTED_THREAD)

    // The post-turn reparse, anchored at the batch boundary.
    mockGet.mockResolvedValue(windowed(2, SETTLED_TURN))
    actions().syncTurnMetadata(CID)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockGet).toHaveBeenCalledWith(CID, { fromIndex: 2 })

    expect(readThread()).toEqual(EXPECTED_THREAD)
    // Each half of the reply is timed on its own: the first from the prompt
    // to the insert, the second from the insert to the answer. Not the whole
    // second half on the 0.4 s it took to write the last sentence.
    expect(workedFor()).toEqual([5_000, 48_000, 121_400])
    // The local copy already says everything the transcript does, so the
    // thread is not reloaded under the reader.
    expect(mockGet.mock.calls.every(([, o]) => o?.fromIndex === 2)).toBe(true)
  })

  it("brings in the end of a reply the stream never delivered", async () => {
    vi.useFakeTimers()
    runTurn()
    // The stream stopped reaching this client after the second command: the
    // answer that closed the turn is not in its copy.
    actions().setLiveMessage(
      CID,
      { ...LIVE, content: LIVE.content.slice(0, -1) },
      true
    )
    actions().completeTurn(CID)
    expect(readThread()).toEqual(EXPECTED_THREAD.slice(0, -1))

    mockGet.mockImplementation(async (_id, opts) =>
      opts?.fromIndex === 2 ? windowed(2, SETTLED_TURN) : windowed(0, FULL)
    )
    actions().syncTurnMetadata(CID)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mockGet).toHaveBeenCalledWith(CID, { fromIndex: 0 })
    expect(readThread()).toEqual(EXPECTED_THREAD)
    expect(workedFor()).toEqual([5_000, 48_000, 121_400])
  })

  it("reads the same from the settled transcript alone", async () => {
    runTurn()
    actions().completeTurn(CID)
    mockGet.mockResolvedValue(windowed(0, FULL))
    await actions().refetchDetail(CID, { quiet: true })
    expect(readThread()).toEqual(EXPECTED_THREAD)
    expect(workedFor()).toEqual([5_000, 48_000, 121_400])
  })
})

describe("pairing the local copy with the transcript around user turns", () => {
  const u = (id: string) => turn(id, "user", [text(id)], 0)
  const a = (id: string, words: string, duration_ms?: number) =>
    turn(id, "assistant", [text(words)], 0, { duration_ms })

  it("falls back to the whole-batch alignment when the cuts disagree", () => {
    // The transcript has no record of the message sent mid-turn (an older
    // server): one user turn there, two here.
    const localTurns = [u("p"), a("l1", "one"), u("s"), a("l2", "two")]
    const parsedTurns = [u("p"), a("t1", "one", 10), a("t2", "two", 20)]
    const bySegment = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns: parsedTurns.filter((t) => t.role === "assistant"),
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
      bySegment: { localTurns, parsedTurns },
    })
    const whole = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns: parsedTurns.filter((t) => t.role === "assistant"),
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
    })
    expect(bySegment).toEqual(whole)
  })

  it("names each half of a split reply after its own transcript turn", () => {
    const localTurns = [u("p"), a("l1", "one"), u("s"), a("l2", "two")]
    const parsedTurns = [u("p"), a("t1", "one", 10), u("s"), a("t2", "two", 20)]
    const patches = computeTurnMetadataPatches({
      localAssistantIndices: [1, 3],
      parsedAssistantTurns: parsedTurns.filter((t) => t.role === "assistant"),
      persistedAssistantCount: 0,
      parseEndsWithAssistant: true,
      bySegment: { localTurns, parsedTurns },
    })
    expect(
      patches.map((p) => [p.index, p.duration_ms, p.source_turn_id])
    ).toEqual([
      [1, 10, "t1"],
      [3, 20, "t2"],
    ])
  })

  it("reads a local copy as cut short only when the transcript says more", () => {
    const parsed = [u("p"), a("t1", "one"), u("s"), a("t2", "two")]
    // Same words, same places: nothing to fetch.
    expect(
      localCopyMissesReplyText(
        [u("p"), a("l1", "one"), u("s"), a("l2", " two\n")],
        parsed
      )
    ).toBe(false)
    // The reply to the mid-turn message never arrived.
    expect(
      localCopyMissesReplyText([u("p"), a("l1", "one"), u("s")], parsed)
    ).toBe(true)
    // Worded differently: the two copies disagree, a reload would not
    // fill a gap.
    expect(
      localCopyMissesReplyText(
        [u("p"), a("l1", "uno"), u("s"), a("l2", "dos")],
        parsed
      )
    ).toBe(false)
  })
})
