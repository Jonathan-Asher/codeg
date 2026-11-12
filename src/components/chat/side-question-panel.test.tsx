import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// The real Streamdown pipeline renders the answer; only the link-safety hook
// is stubbed, as in the plan cards' tests.
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import enMessages from "@/i18n/messages/en.json"
import type { SideQuestionRecord } from "@/lib/types"
import type {
  SideQuestionEntry,
  SideQuestionPanelState,
} from "@/stores/side-question-store"

import {
  SideQuestionPanel,
  type SideQuestionPanelProps,
} from "./side-question-panel"

const T = enMessages.Folder.chat.sideQuestion

function record(
  id: number,
  question: string,
  answer: string | null,
  extra: Partial<SideQuestionRecord> = {}
): SideQuestionRecord {
  return {
    id,
    conversationId: 7,
    question,
    answer,
    synthetic: false,
    fallbackNotice: null,
    createdAt: "2026-11-12T10:00:00Z",
    ...extra,
  }
}

function answered(
  id: number,
  question: string,
  answer: string | null,
  extra: Partial<SideQuestionRecord> = {}
): SideQuestionEntry {
  return {
    key: `sq-${id}`,
    question,
    status: "answered",
    record: record(id, question, answer, extra),
    error: null,
  }
}

function panelOf(
  entries: SideQuestionEntry[],
  index = entries.length - 1
): SideQuestionPanelState {
  return { open: true, entries, index, historyLoaded: true }
}

function renderPanel(props: Partial<SideQuestionPanelProps> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onStep: vi.fn(),
    onRetry: vi.fn(),
    onCopy: vi.fn(),
    onClear: vi.fn(),
    onContinueInFork: vi.fn(),
  }
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SideQuestionPanel
        panel={panelOf([answered(1, "why?", "Because.")])}
        {...handlers}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { ...handlers, ...props, view }
}

describe("SideQuestionPanel", () => {
  it("renders nothing while closed", () => {
    renderPanel({ panel: { ...panelOf([]), open: false } })
    expect(screen.queryByTestId("side-question-panel")).toBeNull()
  })

  it("shows the question with a spinner while the answer is on its way", () => {
    renderPanel({
      panel: panelOf([
        {
          key: "local-1",
          question: "what is it doing?",
          status: "pending",
          record: null,
          error: null,
        },
      ]),
    })
    expect(screen.getByTestId("side-question-question")).toHaveTextContent(
      "what is it doing?"
    )
    expect(screen.getByRole("status")).toHaveTextContent(T.thinking)
    // Nothing to copy or fork yet.
    expect(screen.queryByRole("button", { name: T.copy })).toBeNull()
    expect(screen.queryByRole("button", { name: T.continueInFork })).toBeNull()
    expect(screen.getByText(T.notInConversation)).toBeInTheDocument()
  })

  it("renders the answer as Markdown", () => {
    renderPanel({
      panel: panelOf([answered(1, "list them", "- **alpha**\n- beta")]),
    })
    const answer = screen.getByTestId("side-question-answer")
    expect(within(answer).getAllByRole("listitem")).toHaveLength(2)
    expect(answer).toHaveTextContent("alpha")
    // Markdown, not the raw source.
    expect(answer).not.toHaveTextContent("**")
  })

  it("says so when the answer is a notice from Claude Code, and shows a fallback note", () => {
    renderPanel({
      panel: panelOf([
        answered(1, "why?", "(API error: overloaded)", {
          synthetic: true,
          fallbackNotice: "Answered with another model.",
        }),
      ]),
    })
    expect(screen.getByText(T.notice)).toBeInTheDocument()
    expect(screen.getByText("Answered with another model.")).toBeInTheDocument()
  })

  it("offers Retry on a failed question", () => {
    const failed: SideQuestionEntry = {
      key: "local-2",
      question: "why?",
      status: "failed",
      record: null,
      error: "Claude Code is not running for this session.",
    }
    const { onRetry } = renderPanel({ panel: panelOf([failed]) })
    expect(
      screen.getByText("Claude Code is not running for this session.")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: T.retry }))
    expect(onRetry).toHaveBeenCalledWith(failed)
  })

  it("steps through earlier exchanges", () => {
    const entries = [
      answered(1, "first?", "one"),
      answered(2, "second?", "two"),
      answered(3, "third?", "three"),
    ]
    const { onStep } = renderPanel({ panel: panelOf(entries, 1) })
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
    expect(screen.getByTestId("side-question-question")).toHaveTextContent(
      "second?"
    )
    fireEvent.click(screen.getByRole("button", { name: T.previous }))
    expect(onStep).toHaveBeenCalledWith(-1)
    fireEvent.click(screen.getByRole("button", { name: T.next }))
    expect(onStep).toHaveBeenCalledWith(1)
  })

  it("disables stepping past either end, and hides it for a single exchange", () => {
    renderPanel({
      panel: panelOf([answered(1, "a?", "a"), answered(2, "b?", "b")], 0),
    })
    expect(screen.getByRole("button", { name: T.previous })).toBeDisabled()
    expect(screen.getByRole("button", { name: T.next })).toBeEnabled()
  })

  it("copies the answer and continues in a fork", () => {
    const entry = answered(4, "why?", "Because.")
    const { onCopy, onContinueInFork } = renderPanel({
      panel: panelOf([entry]),
    })
    fireEvent.click(screen.getByRole("button", { name: T.copy }))
    expect(onCopy).toHaveBeenCalledWith(entry)
    fireEvent.click(screen.getByRole("button", { name: T.continueInFork }))
    expect(onContinueInFork).toHaveBeenCalledWith(entry)
  })

  it("has no fork or clear before the conversation exists", () => {
    renderPanel({ onClear: undefined, onContinueInFork: undefined })
    expect(screen.queryByRole("button", { name: T.continueInFork })).toBeNull()
    expect(screen.queryByRole("button", { name: T.clearHistory })).toBeNull()
  })

  it("asks before clearing the history", () => {
    const { onClear } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: T.clearHistory }))
    expect(onClear).not.toHaveBeenCalled()
    const confirm = screen.getByRole("alertdialog")
    fireEvent.click(within(confirm).getByRole("button", { name: T.cancel }))
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(onClear).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: T.clearHistory }))
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: T.clear,
      })
    )
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("closes on Esc and on the close button", () => {
    const { onClose } = renderPanel()
    fireEvent.keyDown(screen.getByTestId("side-question-panel"), {
      key: "Escape",
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: T.close }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("lets Esc take back a half-made clear before it closes anything", () => {
    const { onClose } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: T.clearHistory }))
    fireEvent.keyDown(screen.getByTestId("side-question-panel"), {
      key: "Escape",
    })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("lays the question and the answer out in their own direction", () => {
    renderPanel({ panel: panelOf([answered(1, "למה זה איטי?", "כי.")]) })
    expect(screen.getByTestId("side-question-question")).toHaveAttribute(
      "dir",
      "auto"
    )
  })
})
