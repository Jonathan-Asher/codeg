import { describe, expect, it } from "vitest"

import {
  parseSideQuestionCommand,
  sideQuestionForkPrompt,
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

  it("leaves everything else to be sent as a message", () => {
    expect(parseSideQuestionCommand("/btwx hi")).toBeNull()
    expect(parseSideQuestionCommand("tell me /btw something")).toBeNull()
    expect(parseSideQuestionCommand("/compact")).toBeNull()
    expect(parseSideQuestionCommand("")).toBeNull()
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
