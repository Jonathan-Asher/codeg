import { describe, expect, it } from "vitest"

import {
  buildEditedMessageDraft,
  editableUserMessageText,
  supportsMessageEdit,
} from "./edit-message"
import type { MessageTurn } from "@/lib/types"

function userTurn(blocks: MessageTurn["blocks"]): MessageTurn {
  return { id: "turn-2", role: "user", blocks, timestamp: "" }
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
