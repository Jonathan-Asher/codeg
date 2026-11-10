import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useMemo, useRef, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The composer and the status strips are chrome with heavy dependencies of
// their own; the plan and permission markdown goes through Streamdown. Neither
// is what is under test.
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: () => <textarea data-composer-input="" aria-label="composer" />,
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { AskQuestionCard } from "./ask-question-card"
import { ConversationShell } from "./conversation-shell"
import { PermissionDialog } from "./permission-dialog"
import { PlanApprovalCard } from "./plan-approval-card"
import enMessages from "@/i18n/messages/en.json"
import {
  promptCardHeightKey,
  type PromptCardDock,
  type PromptCardKind,
} from "@/hooks/use-prompt-card-resize"
import type { PendingPermission } from "@/contexts/acp-connections-context"
import type {
  PendingPlanApprovalState,
  PendingQuestionState,
} from "@/lib/types"

const single: PendingQuestionState = {
  question_id: "q-1",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: "Which approach?",
      header: "Approach",
      multi_select: false,
      options: [
        { label: "Incremental", description: "smaller diffs" },
        { label: "Rewrite", description: "clean slate" },
      ],
    },
  ],
}

const twoSingle: PendingQuestionState = {
  question_id: "q-two",
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "q1",
      question: "Which approach?",
      header: "Approach",
      multi_select: false,
      options: [
        { label: "Incremental", description: "" },
        { label: "Rewrite", description: "" },
      ],
    },
    {
      id: "q2",
      question: "Which database?",
      header: "Database",
      multi_select: false,
      options: [
        { label: "Postgres", description: "" },
        { label: "SQLite", description: "" },
      ],
    },
  ],
}

const plan: PendingPlanApprovalState = {
  approval_id: "ap-1",
  tool_call_id: "call-1",
  plan_markdown: "1. Migrate the table",
  created_at: "2026-01-01T00:00:00Z",
}

const permission: PendingPermission = {
  request_id: "req-1",
  tool_call: {
    title: "pnpm test",
    kind: "execute",
    rawInput: { command: "pnpm test" },
  },
  options: [
    { option_id: "once", name: "Allow", kind: "allow_once" },
    { option_id: "reject", name: "Reject", kind: "reject_once" },
  ],
}

// Today's reserve for the two-question set above (see the chat text size
// tests in ask-question-card.test.tsx).
const TAB_RESERVE =
  "min(calc(3 * (var(--spacing) * 7 + var(--chat-rem, 1rem) * 2.25) + var(--chat-rem, 1rem)), calc(50svh - (var(--chat-rem, 1rem) - var(--chat-text-unit, 1rem)) * 4))"

/** A conversation as the shell lays it out: the thread a docked card takes
 *  height from, the card, and the composer it hands the keyboard back to. */
function Docked({
  children,
}: {
  children: (dock: PromptCardDock) => ReactNode
}) {
  const threadRef = useRef<HTMLDivElement>(null)
  const dock = useMemo<PromptCardDock>(
    () => ({ roomRef: threadRef, edge: "top" }),
    []
  )
  return (
    <div data-composer-scope="">
      <div ref={threadRef} />
      {children(dock)}
      <textarea data-composer-input="" aria-label="composer" />
    </div>
  )
}

function renderIntl(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function remember(kind: PromptCardKind, height: number) {
  localStorage.setItem(promptCardHeightKey(kind), String(height))
}

const stored = (kind: PromptCardKind) =>
  localStorage.getItem(promptCardHeightKey(kind))

beforeEach(() => {
  localStorage.clear()
})

describe("the question card's resize handle", () => {
  it("is on the live card in a conversation's dock", () => {
    renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard question={single} onAnswer={vi.fn()} dock={dock} />
        )}
      </Docked>
    )
    const separator = screen.getByRole("separator", {
      name: "Resize question",
    })
    expect(separator).toHaveAttribute("aria-orientation", "horizontal")
    expect(separator).toHaveAttribute(
      "title",
      "Drag to resize · double-click to reset"
    )
  })

  it("is not on the answered record, nor where the card is not docked", () => {
    remember("question", 360)
    const { unmount } = renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard
            readOnly
            question={twoSingle}
            onAnswer={vi.fn()}
            dock={dock}
          />
        )}
      </Docked>
    )
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    // The record keeps its layout, whatever height the live card was given.
    expect(screen.getByRole("tabpanel").style.height).toBe(TAB_RESERVE)
    unmount()

    // Quick Ask mounts the card with no dock: it scrolls with the thread.
    renderIntl(<AskQuestionCard question={twoSingle} onAnswer={vi.fn()} />)
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(screen.getByRole("tabpanel").style.height).toBe(TAB_RESERVE)
  })

  it("goes away while the card is collapsed", () => {
    renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard question={single} onAnswer={vi.fn()} dock={dock} />
        )}
      </Docked>
    )
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    expect(
      screen.getByRole("separator", { name: "Resize question" })
    ).toBeInTheDocument()
  })

  it("opens every tab at the remembered height", () => {
    remember("question", 360)
    renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard
            question={twoSingle}
            onAnswer={vi.fn()}
            dock={dock}
          />
        )}
      </Docked>
    )
    expect(screen.getByRole("tabpanel").style.height).toBe("360px")
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Database/ }))
    fireEvent.click(screen.getByRole("tab", { name: /Database/ }))
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Which database?")
    expect(screen.getByRole("tabpanel").style.height).toBe("360px")
  })

  it("caps a single question's options at the remembered height", () => {
    remember("question", 360)
    renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard question={single} onAnswer={vi.fn()} dock={dock} />
        )}
      </Docked>
    )
    const body = screen
      .getByRole("radiogroup")
      .closest<HTMLElement>(".overflow-y-auto")
    expect(body?.style.maxHeight).toBe("360px")
  })

  it("goes back to today's reserve on a double-click", () => {
    remember("question", 360)
    renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard
            question={twoSingle}
            onAnswer={vi.fn()}
            dock={dock}
          />
        )}
      </Docked>
    )
    fireEvent.doubleClick(screen.getByRole("separator"))
    expect(stored("question")).toBeNull()
    expect(screen.getByRole("tabpanel").style.height).toBe(TAB_RESERVE)
  })

  it("keeps its keys from the card's own, and Esc still goes to the composer", () => {
    remember("question", 300)
    renderIntl(
      <Docked>
        {(dock) => (
          <AskQuestionCard
            question={twoSingle}
            onAnswer={vi.fn()}
            dock={dock}
          />
        )}
      </Docked>
    )
    const separator = screen.getByRole("separator")
    // The card took the keyboard on arrival; moving it off the options
    // re-renders them.
    act(() => separator.focus())
    fireEvent.keyDown(separator, { key: "ArrowUp" })
    expect(stored("question")).toBe("324")
    expect(screen.getByRole("tabpanel").style.height).toBe("324px")
    expect(separator).toHaveFocus()
    fireEvent.keyDown(separator, { key: "Escape" })
    expect(screen.getByRole("textbox", { name: "composer" })).toHaveFocus()
  })
})

describe("the plan card's resize handle", () => {
  it("caps the docked plan at the remembered height, and resets it", () => {
    remember("plan", 400)
    renderIntl(
      <Docked>
        {(dock) => (
          <PlanApprovalCard approval={plan} onAnswer={vi.fn()} dock={dock} />
        )}
      </Docked>
    )
    expect(
      screen.getByRole("separator", { name: "Resize plan" })
    ).toBeInTheDocument()
    const prose = screen
      .getByText("1. Migrate the table")
      .closest<HTMLElement>(".prose")
    expect(prose?.style.maxHeight).toBe("400px")
    expect(prose).not.toHaveClass("max-h-80")

    fireEvent.doubleClick(screen.getByRole("separator"))
    expect(stored("plan")).toBeNull()
    expect(prose?.style.maxHeight).toBe("")
    expect(prose).toHaveClass("max-h-80")
  })

  it("has no handle with no plan to show, nor undocked", () => {
    const { unmount } = renderIntl(
      <Docked>
        {(dock) => (
          <PlanApprovalCard
            approval={{ ...plan, plan_markdown: "  " }}
            onAnswer={vi.fn()}
            dock={dock}
          />
        )}
      </Docked>
    )
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    unmount()
    remember("plan", 400)
    renderIntl(<PlanApprovalCard approval={plan} onAnswer={vi.fn()} />)
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(
      screen.getByText("1. Migrate the table").closest(".prose")
    ).toHaveClass("max-h-80")
  })
})

describe("the permission card's resize handle", () => {
  it("caps the docked request's body at the remembered height, and resets it", () => {
    remember("permission", 250)
    renderIntl(
      <Docked>
        {(dock) => (
          <PermissionDialog
            permission={permission}
            onRespond={vi.fn()}
            dock={dock}
          />
        )}
      </Docked>
    )
    expect(
      screen.getByRole("separator", { name: "Resize permission request" })
    ).toBeInTheDocument()
    const body = screen
      .getByText("Command")
      .closest<HTMLElement>(".overflow-y-auto")
    expect(body?.style.maxHeight).toBe("250px")
    expect(body).not.toHaveClass("max-h-[min(36vh,18rem)]")

    fireEvent.doubleClick(screen.getByRole("separator"))
    expect(stored("permission")).toBeNull()
    expect(body?.style.maxHeight).toBe("")
    expect(body).toHaveClass("max-h-[min(36vh,18rem)]")
  })

  it("leaves its digits answering the request", () => {
    const onRespond = vi.fn()
    renderIntl(
      <Docked>
        {(dock) => (
          <PermissionDialog
            permission={permission}
            onRespond={onRespond}
            dock={dock}
          />
        )}
      </Docked>
    )
    const separator = screen.getByRole("separator")
    act(() => separator.focus())
    fireEvent.keyDown(separator, { key: "2" })
    expect(onRespond).toHaveBeenCalledWith("req-1", "reject")
  })
})

describe("ConversationShell", () => {
  it("docks all three cards resizable and leaves the transcript's record alone", () => {
    renderIntl(
      <ConversationShell
        status="connected"
        promptCapabilities={{
          image: true,
          audio: false,
          embedded_context: true,
        }}
        claudeApiRetry={null}
        pendingPermission={permission}
        pendingQuestion={null}
        pendingAskQuestion={single}
        pendingPlanApproval={plan}
        onFocus={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onRespondPermission={vi.fn()}
        onAnswerQuestion={vi.fn()}
        onAnswerAskQuestion={vi.fn()}
        onAnswerPlanApproval={vi.fn()}
      >
        <AskQuestionCard
          readOnly
          question={{ ...twoSingle, question_id: "result" }}
          onAnswer={vi.fn()}
          title="Question"
          subtitle=""
        />
      </ConversationShell>
    )
    expect(
      screen
        .getAllByRole("separator")
        .map((el) => el.getAttribute("aria-label"))
    ).toEqual(["Resize permission request", "Resize question", "Resize plan"])
  })
})
