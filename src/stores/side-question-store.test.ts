import { beforeEach, describe, expect, it } from "vitest"

import type { SideQuestionRecord } from "@/lib/types"

import {
  EMPTY_SIDE_QUESTION_PANEL,
  useSideQuestionStore,
} from "./side-question-store"

const S = "conv:7"

function record(id: number, question: string): SideQuestionRecord {
  return {
    id,
    conversationId: 7,
    question,
    answer: `answer to ${question}`,
    synthetic: false,
    fallbackNotice: null,
    createdAt: "2026-11-12T10:00:00Z",
  }
}

const panel = () =>
  useSideQuestionStore.getState().panels[S] ?? EMPTY_SIDE_QUESTION_PANEL
const store = () => useSideQuestionStore.getState()

describe("side-question store", () => {
  beforeEach(() => useSideQuestionStore.setState({ panels: {} }))

  it("opens on a question and settles it in place", () => {
    store().addPending(S, "local-1", "why?")
    expect(panel()).toMatchObject({ open: true, index: 0 })
    store().settle(S, "local-1", {
      status: "answered",
      record: record(4, "why?"),
    })
    expect(panel().entries[0]).toMatchObject({
      key: "local-1",
      status: "answered",
      record: { id: 4 },
    })
    store().settle(S, "missing", { status: "failed", error: "x" })
    expect(panel().entries).toHaveLength(1)
  })

  it("puts the stored exchanges first and keeps the shown one on screen", () => {
    store().addPending(S, "local-1", "third?")
    store().loadHistory(S, [record(1, "first?"), record(2, "second?")])
    expect(panel().entries.map((e) => e.question)).toEqual([
      "first?",
      "second?",
      "third?",
    ])
    expect(panel().index).toBe(2)
    expect(panel().historyLoaded).toBe(true)
  })

  it("drops a stand-in whose exchange the history already brought", () => {
    store().addPending(S, "local-1", "second?")
    store().loadHistory(S, [record(1, "first?"), record(2, "second?")])
    store().settle(S, "local-1", {
      status: "answered",
      record: record(2, "second?"),
    })
    expect(panel().entries.map((e) => e.key)).toEqual(["sq-1", "sq-2"])
    expect(panel().index).toBe(1)
  })

  it("does not repeat an exchange it already has", () => {
    store().addPending(S, "local-1", "first?")
    store().settle(S, "local-1", {
      status: "answered",
      record: record(1, "first?"),
    })
    store().loadHistory(S, [record(1, "first?")])
    expect(panel().entries).toHaveLength(1)
  })

  it("clears everything but what is still on its way", () => {
    store().loadHistory(S, [record(1, "first?")])
    store().addPending(S, "local-1", "second?")
    store().clear(S)
    expect(panel().entries.map((e) => e.key)).toEqual(["local-1"])
    expect(panel().index).toBe(0)
  })

  it("keeps each conversation's panel apart", () => {
    store().addPending(S, "local-1", "why?")
    expect(
      useSideQuestionStore.getState().panels["conv:8"] ??
        EMPTY_SIDE_QUESTION_PANEL
    ).toBe(EMPTY_SIDE_QUESTION_PANEL)
    store().close(S)
    expect(panel().open).toBe(false)
  })
})
