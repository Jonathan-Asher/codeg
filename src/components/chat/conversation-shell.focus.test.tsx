import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// The composer is a plain field here (its editor is beside the point), one per
// conversation so a test can tell them apart.
vi.mock("@/components/chat/chat-input", () => ({
  ChatInput: ({ agentName }: { agentName?: string }) => (
    <textarea data-composer-input="" aria-label={`${agentName} composer`} />
  ),
}))
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
// Plan markdown and permission content go through Streamdown, which is heavy
// and beside the point here.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ConversationShell } from "./conversation-shell"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import enMessages from "@/i18n/messages/en.json"
import type {
  PendingPermission,
  PendingQuestion,
} from "@/contexts/acp-connections-context"
import type {
  PendingPlanApprovalState,
  PendingQuestionState,
  QuestionAnswer,
} from "@/lib/types"

type Name = "A" | "B"

interface Cards {
  ask?: PendingQuestionState
  permission?: PendingPermission
  plan?: PendingPlanApprovalState
  question?: PendingQuestion
}

function handlers() {
  return {
    onRespondPermission: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onAnswerAskQuestion: vi.fn(),
    onAnswerPlanApproval: vi.fn(),
  }
}
type Handlers = ReturnType<typeof handlers>

const noop = () => {}

/**
 * A conversation tab as the workspace keeps it (`renderTabWrapper` in
 * ConversationDetailPanel): in the background it stays mounted, hidden by its
 * `conversation-tab-hidden` wrapper and flagged hidden for whatever portals
 * out of it. Split panes and tiles show several at once, one of them active.
 */
function Tab({
  name,
  active,
  shown,
  cards,
  on,
}: {
  name: Name
  active: boolean
  shown: boolean
  cards: Cards
  on: Handlers
}) {
  return (
    <div
      data-testid={`tab-${name}`}
      className={
        shown
          ? "h-full"
          : "conversation-tab-hidden absolute inset-0 invisible pointer-events-none"
      }
    >
      <OverlayHostHiddenProvider hidden={!shown}>
        <ConversationShell
          status="prompting"
          promptCapabilities={{
            image: true,
            audio: false,
            embedded_context: true,
          }}
          agentName={name}
          claudeApiRetry={null}
          pendingPermission={cards.permission ?? null}
          pendingQuestion={cards.question ?? null}
          pendingAskQuestion={cards.ask ?? null}
          pendingPlanApproval={cards.plan ?? null}
          onFocus={noop}
          onSend={noop}
          onCancel={noop}
          onRespondPermission={on.onRespondPermission}
          onAnswerQuestion={on.onAnswerQuestion}
          onAnswerAskQuestion={on.onAnswerAskQuestion}
          onAnswerPlanApproval={on.onAnswerPlanApproval}
          isActive={active}
        >
          <div />
        </ConversationShell>
      </OverlayHostHiddenProvider>
    </div>
  )
}

interface Layout {
  /** The active tab (the focused pane when split). */
  front: Name
  /** Split panes: both tabs on screen, only `front` active. */
  split?: boolean
  a?: Cards
  b?: Cards
}

function renderWorkspace(initial: Layout) {
  const on = { A: handlers(), B: handlers() }
  const ui = ({ front, split = false, a = {}, b = {} }: Layout) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Tab
        name="A"
        active={front === "A"}
        shown={split || front === "A"}
        cards={a}
        on={on.A}
      />
      <Tab
        name="B"
        active={front === "B"}
        shown={split || front === "B"}
        cards={b}
        on={on.B}
      />
    </NextIntlClientProvider>
  )
  const view = render(ui(initial))
  return { on, show: (next: Layout) => view.rerender(ui(next)) }
}

const tab = (name: Name) => screen.getByTestId(`tab-${name}`)
const askList = (name: Name) => within(tab(name)).getByRole("radiogroup")
const questionField = (name: Name) =>
  tab(name).querySelector<HTMLTextAreaElement>("textarea[data-card-entry]")

const ask = (name: Name): PendingQuestionState => ({
  question_id: `q-${name}`,
  created_at: "2026-01-01T00:00:00Z",
  questions: [
    {
      id: "qa",
      question: `Which approach for ${name}?`,
      header: "Approach",
      multi_select: false,
      options: [
        { label: "Incremental", description: "" },
        { label: "Rewrite", description: "" },
      ],
    },
  ],
})

const permission = (name: Name): PendingPermission => ({
  request_id: `req-${name}`,
  tool_call: { title: `ls ${name}`, kind: "execute" },
  options: [
    { option_id: "once", name: "Allow", kind: "allow_once" },
    { option_id: "reject", name: "Reject", kind: "reject_once" },
  ],
})

const plan = (name: Name): PendingPlanApprovalState => ({
  approval_id: `ap-${name}`,
  tool_call_id: `call-${name}`,
  plan_markdown: `1. Migrate ${name}`,
  created_at: "2026-01-01T00:00:00Z",
})

const question = (name: Name): PendingQuestion => ({
  tool_call_id: `tq-${name}`,
  question: `Which branch for ${name}?`,
})

const picked = (label: string): QuestionAnswer => ({
  answers: [{ questionId: "qa", labels: [label] }],
  declined: false,
})

/** Anything a test planted focus on or left blurred: the window is back. */
function windowComesBack() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"))
  })
}

afterEach(windowComesBack)

describe("cards of a conversation kept in a background tab", () => {
  it("only the tab in front takes the keyboard when both have a question waiting", () => {
    renderWorkspace({ front: "B", a: { ask: ask("A") }, b: { ask: ask("B") } })
    expect(askList("B")).toHaveFocus()
  })

  it("a key at the background tab's card answers nothing and lets go of the keyboard", async () => {
    const user = userEvent.setup()
    const { on } = renderWorkspace({
      front: "B",
      a: { ask: ask("A") },
      b: { ask: ask("B") },
    })
    // Where an engine keeps focus in a subtree it hides, or something focuses
    // into one, the keyboard sits in a card nobody can see.
    for (const keys of [
      "1",
      "{Enter}",
      " ",
      "{Meta>}{Enter}{/Meta}",
      "{Control>}{Enter}{/Control}",
    ]) {
      act(() => askList("A").focus())
      await user.keyboard(keys)
      expect(document.body).toHaveFocus()
    }
    expect(on.A.onAnswerAskQuestion).not.toHaveBeenCalled()

    // In the tab in front the same key answers.
    act(() => askList("B").focus())
    await user.keyboard("1")
    expect(on.B.onAnswerAskQuestion).toHaveBeenCalledWith(
      "q-B",
      picked("Incremental")
    )
  })

  it.each([
    {
      kind: "permission request",
      cards: { permission: permission("A") },
      entry: () => within(tab("A")).getByRole("button", { name: "Allow" }),
      answered: (on: Handlers) => on.onRespondPermission,
      keys: ["1", "{Enter}", " "],
    },
    {
      kind: "plan approval",
      cards: { plan: plan("A") },
      entry: () =>
        within(tab("A")).getByRole("button", { name: "Approve & build" }),
      answered: (on: Handlers) => on.onAnswerPlanApproval,
      keys: ["1", "{Enter}", " "],
    },
    {
      kind: "free-text question",
      cards: { question: question("A") },
      entry: () => questionField("A")!,
      answered: (on: Handlers) => on.onAnswerQuestion,
      keys: ["x{Enter}", "{Meta>}{Enter}{/Meta}"],
    },
  ])(
    "a background $kind answers no key either",
    async ({ cards, entry, answered, keys }) => {
      const user = userEvent.setup()
      const { on } = renderWorkspace({ front: "B", a: cards })
      for (const k of keys) {
        act(() => entry().focus())
        await user.keyboard(k)
        expect(document.body).toHaveFocus()
      }
      expect(answered(on.A)).not.toHaveBeenCalled()
      expect(questionField("A")?.value ?? "").toBe("")
    }
  )

  it("switching tabs hands the keyboard to the card of the tab switched to", async () => {
    const user = userEvent.setup()
    const layout = { a: { ask: ask("A") }, b: { ask: ask("B") } }
    const { on, show } = renderWorkspace({ front: "A", ...layout })
    expect(askList("A")).toHaveFocus()

    // A keyboard tab switch: the card left behind lets go, the one in front
    // takes the keyboard, and a digit answers the question on screen.
    show({ front: "B", ...layout })
    expect(askList("B")).toHaveFocus()
    await user.keyboard("1")
    expect(on.B.onAnswerAskQuestion).toHaveBeenCalledWith(
      "q-B",
      picked("Incremental")
    )
    expect(on.A.onAnswerAskQuestion).not.toHaveBeenCalled()
    // The answer hands the keyboard back to B's composer.
    await act(async () => {})

    show({ front: "A", ...layout })
    expect(askList("A")).toHaveFocus()
  })

  it("switching to a tab without a card leaves no keyboard in the hidden one", async () => {
    const user = userEvent.setup()
    const { on, show } = renderWorkspace({ front: "A", a: { ask: ask("A") } })
    expect(askList("A")).toHaveFocus()

    show({ front: "B", a: { ask: ask("A") } })
    expect(document.body).toHaveFocus()
    await user.keyboard("1")
    expect(on.A.onAnswerAskQuestion).not.toHaveBeenCalled()
  })

  it("a card arriving in front takes the keyboard left behind in a hidden card", () => {
    const { show } = renderWorkspace({ front: "B", a: { ask: ask("A") } })
    act(() => askList("A").focus())

    show({ front: "B", a: { ask: ask("A") }, b: { ask: ask("B") } })
    expect(askList("B")).toHaveFocus()
  })

  it("a conversation under a full-page route takes the keyboard once it is shown again", () => {
    const on = handlers()
    // The workspace surface under a route: `KeptMountedSurface`.
    const ui = (covered: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <OverlayHostHiddenProvider hidden={covered}>
          <div
            className={covered ? "conversation-tab-hidden invisible" : ""}
            inert={covered || undefined}
          >
            <Tab name="A" active shown cards={{ ask: ask("A") }} on={on} />
          </div>
        </OverlayHostHiddenProvider>
      </NextIntlClientProvider>
    )
    const view = render(ui(true))
    expect(document.body).toHaveFocus()

    view.rerender(ui(false))
    expect(askList("A")).toHaveFocus()
  })
})

describe("cards in split panes", () => {
  it("only the active pane's cards take the keyboard, the free-text question included", () => {
    const { show } = renderWorkspace({
      front: "B",
      split: true,
      a: { question: question("A") },
    })
    expect(document.body).toHaveFocus()

    show({
      front: "B",
      split: true,
      a: { question: question("A") },
      b: { ask: ask("B") },
    })
    expect(askList("B")).toHaveFocus()
  })

  it("activating the other pane from nowhere hands it the keyboard", () => {
    const layout = { a: { question: question("A") }, b: { ask: ask("B") } }
    const { show } = renderWorkspace({ front: "B", split: true, ...layout })
    expect(askList("B")).toHaveFocus()

    // A click into pane A that lands on no control leaves focus nowhere.
    act(() => askList("B").blur())
    show({ front: "A", split: true, ...layout })
    expect(questionField("A")).toHaveFocus()
  })

  it("a card on screen keeps the keyboard when the other pane becomes active", () => {
    const layout = { a: { ask: ask("A") }, b: { ask: ask("B") } }
    const { show } = renderWorkspace({ front: "A", split: true, ...layout })
    expect(askList("A")).toHaveFocus()

    // E.g. another device moved the focus: the user is still in pane A.
    show({ front: "B", split: true, ...layout })
    expect(askList("A")).toHaveFocus()
  })
})

describe("cards in a window the user is not in", () => {
  function leaveWindow() {
    act(() => {
      window.dispatchEvent(new FocusEvent("blur"))
    })
  }

  it("take the keyboard only once the window comes back", () => {
    leaveWindow()
    renderWorkspace({ front: "A", a: { ask: ask("A") } })
    expect(document.body).toHaveFocus()

    windowComesBack()
    expect(askList("A")).toHaveFocus()
  })

  it("never take it from someone who came back to type", async () => {
    const user = userEvent.setup()
    leaveWindow()
    renderWorkspace({ front: "A", a: { ask: ask("A") } })
    const composer = screen.getByLabelText("A composer")
    act(() => composer.focus())
    await user.keyboard("still typing")

    windowComesBack()
    expect(composer).toHaveFocus()
  })
})
