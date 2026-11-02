import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"

// The composer and the status strips are composer chrome with their own heavy
// dependencies (editor, connections); the cards are what is under test here.
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: () => <div data-testid="composer" />,
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => <div data-testid="status-strips" />,
}))
// Plan markdown goes through Streamdown, which is beside the point here.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ConversationShell } from "./conversation-shell"
import enMessages from "@/i18n/messages/en.json"
import { CHAT_TEXT_SCOPE_CLASS } from "@/lib/chat-text-scale"

const SCOPE = `.${CHAT_TEXT_SCOPE_CLASS}`

type ShellProps = ComponentProps<typeof ConversationShell>

function renderShell(over: Partial<ShellProps> = {}) {
  const props: ShellProps = {
    status: "connected",
    promptCapabilities: { image: true, audio: false, embedded_context: true },
    claudeApiRetry: null,
    pendingPermission: {
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
    },
    pendingQuestion: { tool_call_id: "tq-1", question: "Which branch?" },
    pendingAskQuestion: {
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
    },
    pendingPlanApproval: {
      approval_id: "ap-1",
      tool_call_id: "call-1",
      plan_markdown: "1. Migrate the table",
      created_at: "2026-01-01T00:00:00Z",
    },
    onFocus: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onRespondPermission: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onAnswerAskQuestion: vi.fn(),
    onAnswerPlanApproval: vi.fn(),
    children: <div data-testid="thread" />,
    ...over,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationShell {...props} />
    </NextIntlClientProvider>
  )
}

describe("ConversationShell and the chat text size", () => {
  // Workspace tabs, split panes and canvas cards all dock their blocking
  // cards through this shell, so each card has to carry the chat text scope
  // itself: the agent's question, plan or request is read like the transcript
  // and grows with it.
  it("puts every docked card in a chat text scope", () => {
    renderShell()

    const askCard = screen.getByRole("group", {
      name: "The agent needs your input",
    })
    const planCard = screen.getByRole("group", {
      name: "The agent has a plan — review it",
    })
    const permissionCard = screen.getByRole("group", { name: "pnpm test" })
    for (const card of [askCard, planCard, permissionCard]) {
      expect(card).toHaveClass(CHAT_TEXT_SCOPE_CLASS)
    }
    expect(
      screen.getByText("Agent is asking a question").closest(SCOPE)
    ).toContainElement(screen.getByText("Which branch?"))

    // The cards' text is inside their scope, not just their frames.
    expect(screen.getByText("Which approach?").closest(SCOPE)).toBe(askCard)
    expect(screen.getByText("1. Migrate the table").closest(SCOPE)).toBe(
      planCard
    )
  })

  it("leaves the composer chrome around the cards at the app's size", () => {
    renderShell({
      composerBanner: <div data-testid="banner">Session interrupted</div>,
      feedbackList: <div data-testid="feedback">a note</div>,
    })
    // The composer opts its own input in (`followChatTextSize`); the dock,
    // banners, feedback notes and status strips are chrome.
    for (const id of [
      "composer",
      "banner",
      "feedback",
      "status-strips",
      "thread",
    ]) {
      expect(screen.getByTestId(id).closest(SCOPE), id).toBeNull()
    }
  })
})
