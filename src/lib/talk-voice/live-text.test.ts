import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ConnectionState,
  LiveContentBlock,
} from "@/contexts/acp-connections-context"
import { GRACE_MS, LiveTurnTracker, mainThreadText } from "./live-text"
import type { WindowMessage } from "./protocol"

const text = (value: string, parentToolUseId?: string): LiveContentBlock =>
  parentToolUseId
    ? { type: "text", text: value, parentToolUseId }
    : { type: "text", text: value }

const tool = (id: string): LiveContentBlock => ({
  type: "tool_call",
  info: {
    tool_call_id: id,
    title: "Bash",
    kind: "execute",
    status: "in_progress",
    content: null,
    raw_input: null,
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta: null,
    images: [],
  },
})

const thinking = (value: string): LiveContentBlock => ({
  type: "thinking",
  text: value,
})

const steering = (id: string, value: string): LiveContentBlock => ({
  type: "steering",
  id,
  text: value,
  createdAt: "2026-11-01T10:00:00Z",
  spoken: true,
})

function conn(
  status: ConnectionState["status"],
  content: LiveContentBlock[],
  extra: Partial<ConnectionState> = {}
): ConnectionState {
  return {
    status,
    liveMessage: { id: "live-1", role: "assistant", content, startedAt: 0 },
    error: null,
    ...extra,
  } as ConnectionState
}

describe("mainThreadText (the iPhone's rule)", () => {
  // codeg-ios TalkSessionTests.testTheMainThreadTextIsJoinedInOrderAndOnlyGrows
  it("joins the agent's own words in order, and only grows", () => {
    const content: LiveContentBlock[] = [text("Checking")]
    expect(mainThreadText(content)).toBe("Checking")
    content[0] = text("Checking the build.")
    content.push(text("helper output", "toolu_1"), text(" Still checking"))
    expect(mainThreadText(content)).toBe("Checking the build. Still checking")
    content.push(tool("t1"))
    expect(mainThreadText(content)).toBe(
      "Checking the build. Still checking\n\n"
    )
    content.push(tool("t2"), thinking("hmm"), text("Passed."))
    expect(mainThreadText(content)).toBe(
      "Checking the build. Still checking\n\nPassed."
    )
    content.push(steering("m1", "and lint?"), text("Lint is clean."))
    expect(mainThreadText(content)).toBe(
      "Checking the build. Still checking\n\nPassed.\n\nLint is clean."
    )
  })

  it("leaves out sub-agents, reasoning and the plan", () => {
    expect(
      mainThreadText([
        thinking("let me see"),
        { type: "plan", entries: [] },
        text("sub-agent notes", "toolu_sub"),
        text("Looking now."),
      ])
    ).toBe("Looking now.")
  })

  it("is empty until the agent says something, breaks included", () => {
    expect(mainThreadText([])).toBe("")
    expect(mainThreadText([tool("t1"), steering("m1", "hi")])).toBe("")
    expect(mainThreadText([tool("t1"), text("Done.")])).toBe("Done.")
  })
})

describe("LiveTurnTracker", () => {
  let sent: WindowMessage[]
  let tracker: LiveTurnTracker

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    tracker = new LiveTurnTracker(42, (message) => sent.push(message))
  })

  afterEach(() => {
    tracker.dispose()
    vi.useRealTimers()
  })

  const lives = () =>
    sent.filter(
      (m): m is Extract<WindowMessage, { type: "live" }> => m.type === "live"
    )
  const ends = () =>
    sent.filter(
      (m): m is Extract<WindowMessage, { type: "turnEnded" }> =>
        m.type === "turnEnded"
    )

  // codeg-ios TalkSessionTests.testTalkHearsTheAgentsOwnWordsWithoutItsSubAgents
  it("hears the agent's own words without its sub-agents, the final text before the end", () => {
    tracker.update(conn("connected", []))
    tracker.update(conn("prompting", []))
    expect(sent).toEqual([])
    tracker.update(conn("prompting", [text("Looking now.")]))
    tracker.update(
      conn("prompting", [
        text("Looking now."),
        text("sub-agent notes", "toolu_sub"),
      ])
    )
    tracker.update(
      conn("prompting", [
        text("Looking now."),
        text("sub-agent notes", "toolu_sub"),
        tool("t1"),
        text("Found it."),
      ])
    )
    expect(lives().at(-1)?.text).toBe("Looking now.\n\nFound it.")
    expect(lives().some((m) => m.text.includes("sub-agent notes"))).toBe(false)
    expect(lives().every((m) => m.streaming)).toBe(true)
    expect(new Set(lives().map((m) => m.turnId))).toEqual(new Set(["42:1"]))

    // The reducer moves the status first, then the raw `turn_complete`.
    const final = conn("connected", [
      text("Looking now."),
      tool("t1"),
      text("Found it."),
    ])
    tracker.update(final)
    tracker.turnComplete("end_turn")
    expect(ends()).toEqual([
      { type: "turnEnded", turnId: "42:1", stopReason: "end_turn" },
    ])
    const lastLive = sent.lastIndexOf(lives().at(-1) as WindowMessage)
    expect(lives().at(-1)).toMatchObject({ streaming: false })
    expect(lastLive).toBe(sent.length - 2)
  })

  it("gives every turn a new id, rising when the status enters prompting", () => {
    tracker.update(conn("prompting", [text("One.")]))
    tracker.update(conn("connected", [text("One.")]))
    tracker.turnComplete("end_turn")
    tracker.update(conn("prompting", [text("Two.")]))
    expect(lives().at(-1)).toMatchObject({ turnId: "42:2", text: "Two." })
    tracker.update(conn("connected", [text("Two.")]))
    tracker.turnComplete("cancelled")
    expect(ends()).toEqual([
      { type: "turnEnded", turnId: "42:1", stopReason: "end_turn" },
      { type: "turnEnded", turnId: "42:2", stopReason: "cancelled" },
    ])
  })

  it("keeps the turn through a reconnect that comes back within the grace", () => {
    tracker.update(conn("prompting", [text("Working on it.")]))
    tracker.update(conn("disconnected", [text("Working on it.")]))
    vi.advanceTimersByTime(GRACE_MS - 200)
    tracker.update(
      conn("prompting", [text("Working on it."), text(" Almost there.")])
    )
    vi.advanceTimersByTime(GRACE_MS * 2)
    expect(ends()).toEqual([])
    expect(new Set(lives().map((m) => m.turnId))).toEqual(new Set(["42:1"]))
    expect(lives().at(-1)?.text).toBe("Working on it. Almost there.")
  })

  it("tells a turn that left without turn_complete as ended after the grace", () => {
    tracker.update(conn("prompting", [text("Working on it.")]))
    tracker.update(conn("disconnected", [text("Working on it. Done.")]))
    expect(ends()).toEqual([])
    vi.advanceTimersByTime(GRACE_MS)
    expect(ends()).toEqual([
      { type: "turnEnded", turnId: "42:1", stopReason: null },
    ])
    expect(lives().at(-1)).toMatchObject({
      text: "Working on it. Done.",
      streaming: false,
    })
  })

  it("says error for a turn that ended on an error", () => {
    tracker.update(conn("prompting", [text("Trying.")]))
    tracker.update(conn("connected", [text("Trying.")], { error: "boom" }))
    vi.advanceTimersByTime(GRACE_MS)
    expect(ends().at(-1)?.stopReason).toBe("error")
  })

  it("ends a turn once", () => {
    tracker.update(conn("prompting", [text("Hi.")]))
    tracker.turnComplete("end_turn")
    tracker.turnComplete("end_turn")
    vi.advanceTimersByTime(GRACE_MS * 2)
    expect(ends()).toHaveLength(1)
  })

  // codeg-ios TalkSessionTests.testTalkHearsBackgroundTurnsAndTheBackgroundHold
  // (attaching replays the live turn)
  it("replays the turn in progress at the start, then follows it", () => {
    const live = tracker.prime(conn("prompting", [text("Started the build.")]))
    expect(live).toEqual({
      turnId: "42:1",
      text: "Started the build.",
      streaming: true,
    })
    tracker.update(conn("prompting", [text("Started the build.")]))
    expect(sent).toEqual([])
    tracker.update(conn("connected", [text("Started the build.")]))
    tracker.turnComplete("end_turn")
    expect(sent).toEqual([
      {
        type: "live",
        turnId: "42:1",
        text: "Started the build.",
        streaming: false,
      },
      { type: "turnEnded", turnId: "42:1", stopReason: "end_turn" },
    ])
  })

  it("replays nothing for an idle session", () => {
    expect(tracker.prime(conn("connected", [text("old reply")]))).toBeNull()
    expect(tracker.prime(undefined)).toBeNull()
    tracker.turnComplete("end_turn")
    expect(sent).toEqual([])
  })
})
