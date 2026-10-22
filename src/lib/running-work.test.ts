import { afterEach, describe, expect, it, vi } from "vitest"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  elapsedMs,
  findToolCall,
  findToolCallMentioning,
  formatElapsed,
  partsContainToolCall,
  revealToolCallCard,
  runningKindKey,
} from "./running-work"

type ToolCall = Extract<AdaptedContentPart, { type: "tool-call" }>

const call = (
  id: string,
  output: string | null = null,
  state: ToolCall["state"] = "output-available"
): ToolCall => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "agent",
  input: null,
  output,
  state,
})

const PARTS: AdaptedContentPart[] = [
  { type: "text", text: "Starting." } as AdaptedContentPart,
  call("toolu_fg", null, "input-available"),
  {
    type: "tool-group",
    items: [
      call("toolu_ls"),
      call(
        "toolu_bg",
        "Async agent launched successfully.\nagentId: a4dc31ff (use SendMessage…)"
      ),
    ],
    isStreaming: false,
  } as AdaptedContentPart,
]

describe("running-work", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("finds tool calls nested in groups", () => {
    expect(partsContainToolCall(PARTS, "toolu_fg")).toBe(true)
    expect(partsContainToolCall(PARTS, "toolu_ls")).toBe(true)
    expect(partsContainToolCall(PARTS, "toolu_none")).toBe(false)
    expect(findToolCall(PARTS, "toolu_fg")?.state).toBe("input-available")
  })

  it("finds the call that launched a background task by the id its ack quotes", () => {
    expect(findToolCallMentioning(PARTS, "a4dc31ff")).toBe("toolu_bg")
    expect(findToolCallMentioning(PARTS, "zzzzzz")).toBeNull()
    // Too short to tell apart from any other text.
    expect(findToolCallMentioning(PARTS, "a4")).toBeNull()
  })

  it("reads elapsed time as a clock", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(65_000)).toBe("1:05")
    expect(formatElapsed(3_723_000)).toBe("1:02:03")
    const now = Date.parse("2026-10-22T10:00:30Z")
    expect(
      elapsedMs(
        { id: "x", kind: "shell", started_at: "2026-10-22T10:00:00Z" },
        now
      )
    ).toBe(30_000)
    expect(elapsedMs({ id: "x", kind: "shell" }, now)).toBeNull()
  })

  it("names unknown kinds as a plain task", () => {
    expect(runningKindKey("delegation")).toBe("taskKind.delegation")
    expect(runningKindKey("something-new")).toBe("taskKind.task")
  })

  it("scrolls to a card once the virtual list has rendered it, and marks it", () => {
    vi.useFakeTimers()
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 16)
    )
    const root = document.createElement("div")
    document.body.appendChild(root)
    const scrollIntoView = vi.fn()
    revealToolCallCard(root, "toolu_bg")
    // Not rendered yet: it keeps looking for a few frames.
    vi.advanceTimersByTime(50)
    const group = document.createElement("div")
    group.dataset.toolCallIds = "toolu_ls toolu_bg"
    group.scrollIntoView = scrollIntoView
    root.appendChild(group)
    vi.advanceTimersByTime(50)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
    expect(group.dataset.jumpHighlight).toBe("true")
    vi.advanceTimersByTime(2000)
    expect(group.dataset.jumpHighlight).toBeUndefined()
  })
})
