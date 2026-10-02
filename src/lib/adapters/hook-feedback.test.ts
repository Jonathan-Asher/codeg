/**
 * A blocking Stop hook reaches the adapter as a settled tool call tagged
 * `_meta["codeg.hookFeedback"]`, on both paths: `parsers::claude` synthesizes
 * it from the transcript, and the live mapper from the raw SDK stream. Either
 * way it must come out as ONE `hook-feedback` part in place, never as a tool
 * card, so the completed-turn fold can cut the reply there.
 */

import { describe, expect, it } from "vitest"

import {
  adaptMessageTurn,
  hookFeedbackFromMeta,
  HOOK_FEEDBACK_META_KEY,
  type AdaptedContentPart,
  type AdapterMessageText,
} from "@/lib/adapters/ai-elements-adapter"
import type { MessageTurn } from "@/lib/types"
import { buildStreamingTurnsFromLiveMessage } from "@/stores/conversation-runtime-store"

const TEXT: AdapterMessageText = {
  attachedResources: "attached",
  toolCallFailed: "Tool failed",
  pageHandoffName: () => "",
}

const FEEDBACK =
  "Release check outstanding: confirm the notes.\nIf they already do, say so and stop."
const META = {
  [HOOK_FEEDBACK_META_KEY]: { event: "Stop", feedback: FEEDBACK },
}

describe("hookFeedbackFromMeta", () => {
  it("reads the marker and nothing else", () => {
    expect(hookFeedbackFromMeta(META)).toEqual({
      event: "Stop",
      feedback: FEEDBACK,
    })
    expect(hookFeedbackFromMeta(null)).toBeNull()
    expect(hookFeedbackFromMeta({ contextCompaction: true })).toBeNull()
    // A malformed payload still marks the boundary.
    expect(hookFeedbackFromMeta({ [HOOK_FEEDBACK_META_KEY]: {} })).toEqual({
      event: "Stop",
      feedback: "",
    })
  })
})

describe("the Stop-hook marker in a reply", () => {
  it("adapts the transcript's marker turn to one hook-feedback part", () => {
    // Exactly what `parsers::claude` emits for the isMeta record.
    const turn: MessageTurn = {
      id: "turn-4",
      role: "assistant",
      timestamp: "2026-10-02T10:18:17.673Z",
      blocks: [
        {
          type: "tool_use",
          tool_use_id: "stop-hook-u-hook",
          tool_name: "stop_hook",
          input_preview: null,
          meta: META,
        },
        {
          type: "tool_result",
          tool_use_id: "stop-hook-u-hook",
          output_preview: null,
          is_error: false,
        },
      ],
    }

    expect(adaptMessageTurn(turn, TEXT, false).content).toEqual([
      { type: "hook-feedback", event: "Stop", feedback: FEEDBACK },
    ])
  })

  it("places the live marker between the answer and the reply to the hook", () => {
    const { turns } = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-stop-hook",
      role: "assistant",
      startedAt: 0,
      content: [
        { type: "text", text: "The notes mention the flag. Publish it?" },
        {
          type: "tool_call",
          info: {
            tool_call_id: "stop-hook-54ea87b2",
            title: "Stop hook",
            kind: "other",
            status: "completed",
            content: null,
            raw_input: null,
            raw_output_chunks: [],
            raw_output_total_bytes: 0,
            locations: null,
            meta: META,
            images: [],
          },
        },
        { type: "thinking", text: "Check the notes again." },
        { type: "text", text: "They already mention it." },
      ],
    })

    const parts: AdaptedContentPart[] = turns.flatMap(
      (turn) => adaptMessageTurn(turn, TEXT, true).content
    )
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "hook-feedback",
      "reasoning",
      "text",
    ])
    expect(parts[1]).toEqual({
      type: "hook-feedback",
      event: "Stop",
      feedback: FEEDBACK,
    })
  })
})
