import { describe, expect, it, vi } from "vitest"

import {
  buildEditedMessageDraft,
  editableUserMessageText,
  resolveEditForkPointInTranscript,
  resolveEditForkTurnId,
  supportsMessageEdit,
} from "./edit-message"
import type { MessageTurn } from "@/lib/types"

function userTurn(blocks: MessageTurn["blocks"]): MessageTurn {
  return { id: "turn-2", role: "user", blocks, timestamp: "" }
}

function said(
  id: string,
  role: MessageTurn["role"],
  text: string | null
): MessageTurn {
  return {
    id,
    role,
    blocks: text === null ? [] : [{ type: "text", text }],
    timestamp: "",
  }
}

const PNG = {
  type: "image" as const,
  data: "iVBORw0KGgo=",
  mime_type: "image/png",
  uri: "file:///tmp/shot.png",
}

describe("supportsMessageEdit", () => {
  it("offers editing where the fork lands exactly on the named reply", () => {
    for (const agent of ["claude_code", "codex", "deepseek"]) {
      expect(supportsMessageEdit(agent)).toBe(true)
    }
  })

  it("withholds it everywhere else", () => {
    // pi-acp forks at the tail when it can't find the reply — which would
    // silently continue the original conversation, message and all.
    for (const agent of ["pi", "gemini", "open_code", "custom:acme"]) {
      expect(supportsMessageEdit(agent)).toBe(false)
    }
  })
})

describe("editableUserMessageText", () => {
  it("is the text as it was sent, file mentions included", () => {
    const text = "check [main.rs](file:///repo/src/main.rs) please"
    expect(editableUserMessageText(userTurn([{ type: "text", text }]))).toBe(
      text
    )
  })

  it("joins several text blocks and leaves images out", () => {
    expect(
      editableUserMessageText(
        userTurn([
          { type: "text", text: "first" },
          PNG,
          { type: "text", text: "second" },
        ])
      )
    ).toBe("first\nsecond")
  })

  it("is empty for a message that was only an image", () => {
    expect(editableUserMessageText(userTurn([PNG]))).toBe("")
  })
})

describe("buildEditedMessageDraft", () => {
  it("sends the edited text, then the original's images as they were", () => {
    const draft = buildEditedMessageDraft(
      "  sharper question  ",
      userTurn([{ type: "text", text: "question" }, PNG]),
      { image: true, embedded_context: true }
    )
    expect(draft).toEqual({
      blocks: [{ type: "text", text: "sharper question" }, PNG],
      displayText: "sharper question",
    })
  })

  it("re-encodes images for an agent that takes embedded context only", () => {
    // The composer's own choice for such an agent (`imageAttachmentToPromptBlock`).
    const draft = buildEditedMessageDraft("look", userTurn([PNG]), {
      image: false,
      embedded_context: true,
    })
    expect(draft?.blocks[1]).toEqual({
      type: "resource",
      uri: PNG.uri,
      mime_type: "image/png",
      text: null,
      blob: PNG.data,
    })
  })

  it("keeps an image-only message sendable with its text cleared", () => {
    const draft = buildEditedMessageDraft("   ", userTurn([PNG]), null)
    expect(draft).toEqual({ blocks: [PNG], displayText: "" })
  })

  it("has nothing to send without text or images", () => {
    expect(
      buildEditedMessageDraft(" ", userTurn([{ type: "text", text: "x" }]))
    ).toBeNull()
  })
})

/**
 * A reply this session streamed can stay `live-…` for the rest of the session
 * (a quick follow-up cancels the reparse that names it). Editing the message
 * after it looks the reply's parser name up in a fresh read of the transcript.
 */
describe("resolveEditForkPointInTranscript", () => {
  // What a fresh parse of msg1 → reply1 → msg2 → reply2 reads back as.
  const PARSED = [
    said("turn-0", "user", "what is 2+2?"),
    said("turn-1", "assistant", "4"),
    said("turn-2", "user", "and times 2?"),
    said("turn-3", "assistant", "8"),
  ]

  it("forks at the reply before the message found by its place", () => {
    expect(resolveEditForkPointInTranscript(PARSED, 1, "and times 2?")).toBe(
      "turn-1"
    )
  })

  it("forks at the LAST turn of a reply that spans several", () => {
    const parsed = [
      said("turn-0", "user", "fix it"),
      said("turn-1", "assistant", "looking"),
      said("turn-2", "assistant", "done"),
      said("turn-3", "user", "thanks, now test it"),
    ]
    expect(
      resolveEditForkPointInTranscript(parsed, 1, "thanks, now test it")
    ).toBe("turn-2")
  })

  it("steps over turns with nothing in them", () => {
    const parsed = [
      said("turn-0", "user", "hi"),
      said("turn-1", "assistant", "hello"),
      said("turn-2", "assistant", null),
      said("turn-3", "user", "again"),
    ]
    expect(resolveEditForkPointInTranscript(parsed, 1, "again")).toBe("turn-1")
  })

  it("matches the text as a person reads it", () => {
    expect(
      resolveEditForkPointInTranscript(PARSED, 1, "  and times\n2?  ")
    ).toBe("turn-1")
  })

  it("refuses when the text at that place is another message", () => {
    // Something shifted the count (a command the transcript keeps out of its
    // turns, say): forking there would continue the wrong conversation.
    expect(
      resolveEditForkPointInTranscript(PARSED, 1, "what is 2+2?")
    ).toBeNull()
  })

  it("refuses when the transcript has no message at that place", () => {
    expect(resolveEditForkPointInTranscript(PARSED, 5, "later")).toBeNull()
  })

  it("refuses when what precedes the message is not a reply", () => {
    const parsed = [
      said("turn-0", "user", "first"),
      said("turn-1", "user", "second"),
    ]
    expect(resolveEditForkPointInTranscript(parsed, 1, "second")).toBeNull()
    // …and when nothing does.
    expect(resolveEditForkPointInTranscript(parsed, 0, "first")).toBeNull()
  })
})

describe("resolveEditForkTurnId", () => {
  // The thread on screen after msg1 → reply1 → msg2 sent within seconds →
  // reply2: every turn is still this session's own, reply1 never named.
  const ON_SCREEN = [
    said("optimistic-a", "user", "what is 2+2?"),
    said("live-7-lm-1", "assistant", "4"),
    said("optimistic-b", "user", "and times 2?"),
    said("live-7-lm-2", "assistant", "8"),
  ]
  const PARSED = [
    said("turn-0", "user", "what is 2+2?"),
    said("turn-1", "assistant", "4"),
    said("turn-2", "user", "and times 2?"),
    said("turn-3", "assistant", "8"),
  ]

  it("keeps a parser id as it is, without reading anything", async () => {
    const readTranscript = vi.fn(() => Promise.resolve(PARSED))
    await expect(
      resolveEditForkTurnId({
        forkFromTurnId: "turn-1",
        message: ON_SCREEN[2],
        thread: ON_SCREEN,
        readTranscript,
      })
    ).resolves.toBe("turn-1")
    expect(readTranscript).not.toHaveBeenCalled()
  })

  it("looks a live id's parser name up in a fresh read", async () => {
    const readTranscript = vi.fn(() => Promise.resolve(PARSED))
    await expect(
      resolveEditForkTurnId({
        forkFromTurnId: "live-7-lm-1",
        message: ON_SCREEN[2],
        thread: ON_SCREEN,
        readTranscript,
      })
    ).resolves.toBe("turn-1")
    expect(readTranscript).toHaveBeenCalledTimes(1)
  })

  it("resolves nothing when the read doesn't hold the message", async () => {
    // The transcript ends before the message: nowhere safe to fork.
    await expect(
      resolveEditForkTurnId({
        forkFromTurnId: "live-7-lm-1",
        message: ON_SCREEN[2],
        thread: ON_SCREEN,
        readTranscript: () => Promise.resolve(PARSED.slice(0, 2)),
      })
    ).resolves.toBeNull()
  })

  it("resolves nothing for a message that isn't on screen", async () => {
    const readTranscript = vi.fn(() => Promise.resolve(PARSED))
    await expect(
      resolveEditForkTurnId({
        forkFromTurnId: "live-7-lm-1",
        message: said("optimistic-z", "user", "gone"),
        thread: ON_SCREEN,
        readTranscript,
      })
    ).resolves.toBeNull()
    expect(readTranscript).not.toHaveBeenCalled()
  })

  it("passes a failed read on to the caller", async () => {
    await expect(
      resolveEditForkTurnId({
        forkFromTurnId: "live-7-lm-1",
        message: ON_SCREEN[2],
        thread: ON_SCREEN,
        readTranscript: () => Promise.reject(new Error("offline")),
      })
    ).rejects.toThrow("offline")
  })
})
