import { describe, expect, it } from "vitest"

import {
  buildUserTurnFromMessageBlocks,
  contentBlocksFromUserMessage,
} from "./user-message-blocks"

describe("contentBlocksFromUserMessage", () => {
  it("passes text through unchanged", () => {
    expect(
      contentBlocksFromUserMessage([{ type: "text", text: "ship it" }])
    ).toEqual([{ type: "text", text: "ship it" }])
  })

  it("widens an image to a content block with an explicit null uri", () => {
    // A broadcast image is carried by its bytes — there is no path to name, and
    // the display-name derivation downstream keys off that absence.
    expect(
      contentBlocksFromUserMessage([
        { type: "image", data: "aGk=", mime_type: "image/png" },
      ])
    ).toEqual([
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ])
  })

  it("preserves order across a mixed message", () => {
    // Order is the message: an image sent after a sentence must not float above
    // it, since the same list renders as one user turn.
    expect(
      contentBlocksFromUserMessage([
        { type: "text", text: "this colour" },
        { type: "image", data: "aGk=", mime_type: "image/png" },
        { type: "text", text: "please" },
      ])
    ).toEqual([
      { type: "text", text: "this colour" },
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
      { type: "text", text: "please" },
    ])
  })

  it("maps an empty list to an empty list", () => {
    expect(contentBlocksFromUserMessage([])).toEqual([])
  })
})

describe("buildUserTurnFromMessageBlocks", () => {
  it("builds the user turn a viewer shows, under the broadcast id", () => {
    const turn = buildUserTurnFromMessageBlocks("optimistic-1", [
      { type: "text", text: "ship it" },
      { type: "image", data: "aGk=", mime_type: "image/png" },
    ])
    expect(turn).toEqual({
      id: "optimistic-1",
      role: "user",
      blocks: [
        { type: "text", text: "ship it" },
        { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
      ],
      timestamp: expect.any(String),
    })
    // A typed message carries no flag at all, the shape history has.
    expect(turn).not.toHaveProperty("spoken")
  })

  it("keeps a message spoken through Talk mode marked as spoken", () => {
    // The mic marker shows on the live turn, before any reload brings the
    // history turn (which says the same).
    expect(
      buildUserTurnFromMessageBlocks(
        "optimistic-2",
        [{ type: "text", text: "stop for a second" }],
        true
      ).spoken
    ).toBe(true)
    expect(
      buildUserTurnFromMessageBlocks(
        "optimistic-3",
        [{ type: "text", text: "typed" }],
        false
      )
    ).not.toHaveProperty("spoken")
  })
})
