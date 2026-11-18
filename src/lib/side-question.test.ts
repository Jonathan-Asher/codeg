import { describe, expect, it, vi } from "vitest"

import {
  divertSideQuestionDraft,
  parseSideQuestionCommand,
  sideQuestionForkPrompt,
  sideQuestionOfDraft,
  withSideQuestionCommand,
} from "./side-question"

describe("parseSideQuestionCommand", () => {
  it("reads the question after a leading /btw", () => {
    expect(parseSideQuestionCommand("/btw why is it slow?")).toEqual({
      question: "why is it slow?",
    })
    expect(parseSideQuestionCommand("  /btw\n  what about\nthis?  ")).toEqual({
      question: "what about\nthis?",
    })
  })

  it("treats a bare /btw as reopening the answers", () => {
    expect(parseSideQuestionCommand("/btw")).toEqual({ question: "" })
    expect(parseSideQuestionCommand("/btw   ")).toEqual({ question: "" })
  })

  it("reads /btw in any case", () => {
    expect(parseSideQuestionCommand("/BTW מה העלות?")).toEqual({
      question: "מה העלות?",
    })
    expect(parseSideQuestionCommand("/Btw why")).toEqual({ question: "why" })
    expect(parseSideQuestionCommand(" \n /bTw")).toEqual({ question: "" })
  })

  it("leaves everything else to be sent as a message", () => {
    expect(parseSideQuestionCommand("/btwx hi")).toBeNull()
    expect(parseSideQuestionCommand("/BTWX hi")).toBeNull()
    expect(parseSideQuestionCommand("so /BTW then")).toBeNull()
    expect(parseSideQuestionCommand("tell me /btw something")).toBeNull()
    expect(parseSideQuestionCommand("/compact")).toBeNull()
    expect(parseSideQuestionCommand("")).toBeNull()
  })
})

describe("sideQuestionOfDraft", () => {
  it("reads the draft's display text", () => {
    expect(
      sideQuestionOfDraft({
        displayText: "/BTW why?",
        blocks: [{ type: "text", text: "/BTW why?" }],
      })
    ).toEqual({ question: "why?" })
  })

  it("falls back to the text blocks of a draft built elsewhere", () => {
    expect(
      sideQuestionOfDraft({
        displayText: "",
        blocks: [{ type: "text", text: "/btw from blocks" }],
      })
    ).toEqual({ question: "from blocks" })
  })

  it("is null for an ordinary message", () => {
    expect(
      sideQuestionOfDraft({
        displayText: "please run /btw later",
        blocks: [{ type: "text", text: "please run /btw later" }],
      })
    ).toBeNull()
    expect(
      sideQuestionOfDraft({
        displayText: "Attached 1 attachment",
        blocks: [{ type: "image", data: "AAAA", mime_type: "image/png" }],
      })
    ).toBeNull()
  })
})

describe("divertSideQuestionDraft", () => {
  const draft = (text: string) => ({
    displayText: text,
    blocks: [{ type: "text" as const, text }],
  })

  it("asks a queued or edited /BTW where the session answers side questions", () => {
    const ask = vi.fn()
    const keep = vi.fn()
    expect(
      divertSideQuestionDraft(draft("/BTW how much?"), {
        supported: true,
        ask,
        keep,
      })
    ).toBe(true)
    expect(ask).toHaveBeenCalledWith("how much?")
    expect(keep).not.toHaveBeenCalled()
  })

  it("hands the text back, unsent, where it cannot be answered", () => {
    const ask = vi.fn()
    const keep = vi.fn()
    expect(
      divertSideQuestionDraft(draft("/btw how much?"), {
        supported: false,
        ask,
        keep,
      })
    ).toBe(true)
    expect(keep).toHaveBeenCalledWith("/btw how much?")
    expect(ask).not.toHaveBeenCalled()
  })

  it("lets an ordinary message through", () => {
    const ask = vi.fn()
    const keep = vi.fn()
    expect(
      divertSideQuestionDraft(draft("by the way /btw"), {
        supported: true,
        ask,
        keep,
      })
    ).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(keep).not.toHaveBeenCalled()
  })
})

describe("withSideQuestionCommand", () => {
  const btw = { name: "btw", description: "Ask a side question" }

  it("puts /btw first and drops an agent-listed one", () => {
    const merged = withSideQuestionCommand(
      [
        { name: "compact", description: "Compact" },
        { name: "btw", description: "the agent's own" },
      ],
      btw
    )
    expect(merged.map((c) => c.name)).toEqual(["btw", "compact"])
    expect(merged[0]).toBe(btw)
  })

  it("works before the agent listed anything", () => {
    expect(withSideQuestionCommand(null, btw)).toEqual([btw])
  })
})

describe("sideQuestionForkPrompt", () => {
  it("quotes the question and the answer and leaves room to go on", () => {
    expect(
      sideQuestionForkPrompt("why the cache?", "It is warm.\n\nAnd cheap.")
    ).toBe(
      "Earlier I asked you a side question:\n\n> why the cache?\n\nYour answer:\n\n> It is warm.\n>\n> And cheap.\n\n"
    )
  })

  it("carries just the question when there was no answer", () => {
    expect(sideQuestionForkPrompt("why?", null)).toBe(
      "Earlier I asked you a side question:\n\n> why?\n\n"
    )
  })
})
