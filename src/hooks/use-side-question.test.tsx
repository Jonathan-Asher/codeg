import { act, renderHook, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  acpSideQuestion: vi.fn(),
  acpListSideQuestions: vi.fn(),
  acpClearSideQuestions: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
const fork = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-fork-conversation", () => ({
  useForkConversation: () => fork,
}))
const clipboard = vi.hoisted(() => vi.fn(async () => true))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: clipboard,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import enMessages from "@/i18n/messages/en.json"
import type { SideQuestionRecord } from "@/lib/types"
import { useSideQuestionStore } from "@/stores/side-question-store"

import {
  useSideQuestion,
  type UseSideQuestionOptions,
} from "./use-side-question"

function record(
  id: number,
  question: string,
  answer: string | null
): SideQuestionRecord {
  return {
    id,
    conversationId: 7,
    question,
    answer,
    synthetic: false,
    fallbackNotice: null,
    createdAt: "2026-11-12T10:00:00Z",
  }
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    {children}
  </NextIntlClientProvider>
)

function mount(options: Partial<UseSideQuestionOptions> = {}) {
  return renderHook(
    () =>
      useSideQuestion({
        scope: "conv:7",
        connectionId: "conn-1",
        conversationId: 7,
        agentType: "claude_code",
        supported: true,
        ...options,
      }),
    { wrapper }
  )
}

describe("useSideQuestion", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSideQuestionStore.setState({ panels: {} })
    api.acpListSideQuestions.mockResolvedValue([])
    api.acpClearSideQuestions.mockResolvedValue(0)
  })
  afterEach(() => {
    useSideQuestionStore.setState({ panels: {} })
  })

  it("asks on the conversation's connection and shows the answer when it lands", async () => {
    let answer!: (value: SideQuestionRecord) => void
    api.acpSideQuestion.mockReturnValue(
      new Promise<SideQuestionRecord>((resolve) => {
        answer = resolve
      })
    )
    const { result } = mount()
    act(() => result.current.ask("  what is it doing?  "))
    expect(api.acpSideQuestion).toHaveBeenCalledWith({
      connectionId: "conn-1",
      conversationId: 7,
      question: "what is it doing?",
    })
    expect(result.current.panel.open).toBe(true)
    expect(
      result.current.panel.entries[result.current.panel.entries.length - 1]
    ).toMatchObject({
      question: "what is it doing?",
      status: "pending",
    })

    await act(async () => {
      answer(record(11, "what is it doing?", "Reading the config."))
    })
    expect(
      result.current.panel.entries[result.current.panel.entries.length - 1]
    ).toMatchObject({
      status: "answered",
      record: { id: 11, answer: "Reading the config." },
    })
  })

  it("puts earlier exchanges in front once, and keeps the new one on screen", async () => {
    api.acpListSideQuestions.mockResolvedValue([
      record(1, "first?", "one"),
      record(2, "second?", "two"),
    ])
    api.acpSideQuestion.mockResolvedValue(record(3, "third?", "three"))
    const { result } = mount()
    await act(async () => {
      result.current.ask("third?")
    })
    await waitFor(() => expect(result.current.panel.historyLoaded).toBe(true))
    const questions = result.current.panel.entries.map((e) => e.question)
    expect(questions).toEqual(["first?", "second?", "third?"])
    expect(result.current.panel.index).toBe(2)
    // Asking again does not fetch the history again.
    await act(async () => {
      result.current.ask("fourth?")
    })
    expect(api.acpListSideQuestions).toHaveBeenCalledTimes(1)
  })

  it("reopens on a bare /btw without asking anything", async () => {
    api.acpListSideQuestions.mockResolvedValue([record(1, "first?", "one")])
    const { result } = mount()
    await act(async () => {
      result.current.ask("")
    })
    expect(api.acpSideQuestion).not.toHaveBeenCalled()
    expect(result.current.panel.open).toBe(true)
    await waitFor(() =>
      expect(result.current.panel.entries.map((e) => e.question)).toEqual([
        "first?",
      ])
    )
  })

  it("shows a failure and retries the same question", async () => {
    api.acpSideQuestion
      .mockRejectedValueOnce(new Error("Claude Code is not running"))
      .mockResolvedValueOnce(record(5, "why?", "Because."))
    const { result } = mount()
    await act(async () => {
      result.current.ask("why?")
    })
    const failed =
      result.current.panel.entries[result.current.panel.entries.length - 1]!
    expect(failed).toMatchObject({
      status: "failed",
      error: "Claude Code is not running",
    })
    await act(async () => {
      result.current.retry(failed)
    })
    expect(api.acpSideQuestion).toHaveBeenLastCalledWith({
      connectionId: "conn-1",
      conversationId: 7,
      question: "why?",
    })
    expect(result.current.panel.entries).toHaveLength(1)
    expect(result.current.panel.entries[0]).toMatchObject({
      status: "answered",
      record: { answer: "Because." },
    })
  })

  it("does nothing on a session that cannot answer", () => {
    const { result } = mount({ supported: false })
    act(() => result.current.ask("why?"))
    expect(api.acpSideQuestion).not.toHaveBeenCalled()
    expect(result.current.panel.open).toBe(false)
  })

  it("steps, closes and clears", async () => {
    api.acpListSideQuestions.mockResolvedValue([
      record(1, "first?", "one"),
      record(2, "second?", "two"),
    ])
    const { result } = mount()
    await act(async () => {
      result.current.ask("")
    })
    await waitFor(() => expect(result.current.panel.entries).toHaveLength(2))
    expect(result.current.panel.index).toBe(1)
    act(() => result.current.step(-1))
    expect(result.current.panel.index).toBe(0)
    act(() => result.current.step(-1))
    expect(result.current.panel.index).toBe(0)
    act(() => result.current.close())
    expect(result.current.panel.open).toBe(false)

    await act(async () => {
      result.current.clear?.()
    })
    expect(api.acpClearSideQuestions).toHaveBeenCalledWith(7)
    await waitFor(() => expect(result.current.panel.entries).toHaveLength(0))
  })

  it("forks with the exchange in the new composer", async () => {
    api.acpSideQuestion.mockResolvedValue(record(9, "why?", "Because."))
    const { result } = mount()
    await act(async () => {
      result.current.ask("why?")
    })
    const entry =
      result.current.panel.entries[result.current.panel.entries.length - 1]!
    act(() => result.current.continueInFork?.(entry))
    expect(fork).toHaveBeenCalledWith(
      { id: 7, agent_type: "claude_code" },
      {
        draft:
          "Earlier I asked you a side question:\n\n> why?\n\nYour answer:\n\n> Because.\n\n",
      }
    )
  })

  it("copies the answer", async () => {
    api.acpSideQuestion.mockResolvedValue(record(9, "why?", "Because."))
    const { result } = mount()
    await act(async () => {
      result.current.ask("why?")
    })
    act(() =>
      result.current.copy(
        result.current.panel.entries[result.current.panel.entries.length - 1]!
      )
    )
    expect(clipboard).toHaveBeenCalledWith("Because.")
  })

  it("has no clear or fork before the conversation exists", () => {
    const { result } = mount({ conversationId: null, scope: "tab:t1" })
    expect(result.current.clear).toBeUndefined()
    expect(result.current.continueInFork).toBeUndefined()
  })
})
