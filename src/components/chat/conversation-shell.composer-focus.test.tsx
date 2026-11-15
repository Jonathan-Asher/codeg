import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// The composer is a plain field driven by the real focus hook: its rich editor
// is beside the point here (MessageInput's own tests cover that it wires the
// hook to the editor), the rules and how they meet the cards are not.
vi.mock("@/components/chat/chat-input", async () => {
  const { useCallback, useRef } = await import("react")
  const { useComposerAutoFocus } =
    await import("@/hooks/use-composer-auto-focus")
  return {
    ChatInput: function ChatInputStub({
      agentName,
      isActive,
    }: {
      agentName?: string
      isActive?: boolean
    }) {
      const rootRef = useRef<HTMLDivElement>(null)
      const focus = useCallback(() => {
        const input = rootRef.current?.querySelector("textarea")
        if (!input) return
        input.focus({ preventScroll: true })
        input.setSelectionRange(input.value.length, input.value.length)
      }, [])
      useComposerAutoFocus(rootRef, {
        active: isActive ?? false,
        ready: true,
        focus,
      })
      return (
        <div ref={rootRef}>
          <textarea
            data-composer-input=""
            aria-label={`${agentName} composer`}
          />
        </div>
      )
    },
  }
})
vi.mock("@/components/chat/composer-status-strips", () => ({
  ComposerStatusStrips: () => null,
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ConversationShell } from "./conversation-shell"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import enMessages from "@/i18n/messages/en.json"
import { noteTabActivation, requestComposerFocus } from "@/lib/composer-focus"
import type {
  PendingPermission,
  PendingQuestion,
} from "@/contexts/acp-connections-context"
import type { PendingQuestionState } from "@/lib/types"

type Name = "A" | "B"

interface Cards {
  ask?: PendingQuestionState
  permission?: PendingPermission
  question?: PendingQuestion
}

const noop = () => {}

/** A conversation tab as the workspace keeps it: in the background it stays
 *  mounted, hidden by its `conversation-tab-hidden` wrapper. Its transcript
 *  holds a control and some text. */
function Tab({
  name,
  active,
  shown,
  cards,
}: {
  name: Name
  active: boolean
  shown: boolean
  cards: Cards
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
          pendingPlanApproval={null}
          onFocus={noop}
          onSend={noop}
          onCancel={noop}
          onRespondPermission={noop}
          onAnswerQuestion={noop}
          onAnswerAskQuestion={noop}
          onAnswerPlanApproval={noop}
          isActive={active}
        >
          <div>
            <p>The reply in {name}, worth copying.</p>
            <button type="button">Copy reply {name}</button>
          </div>
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
  /** A full-page route covers the whole workspace. */
  covered?: boolean
  /** The conversations sit in an open drawer (a canvas card opened). */
  inDrawer?: boolean
  a?: Cards
  b?: Cards
}

/** The window around the conversations: a sidebar row, a tab item, the
 *  terminal, a search box and a settings field. */
function renderWorkspace(initial: Layout) {
  const ui = ({
    front,
    split = false,
    covered = false,
    inDrawer = false,
    a = {},
    b = {},
  }: Layout) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <nav>
        <button type="button">Sidebar row</button>
        <button type="button" role="tab">
          Tab item
        </button>
      </nav>
      <div className="xterm">
        <textarea aria-label="Terminal" />
      </div>
      <input type="search" aria-label="Search" />
      <input type="text" aria-label="Settings field" />
      <OverlayHostHiddenProvider hidden={covered}>
        <div
          className={covered ? "conversation-tab-hidden invisible" : ""}
          inert={covered || undefined}
          role={inDrawer ? "dialog" : undefined}
          data-open={inDrawer ? "" : undefined}
        >
          <Tab
            name="A"
            active={front === "A"}
            shown={split || front === "A"}
            cards={a}
          />
          <Tab
            name="B"
            active={front === "B"}
            shown={split || front === "B"}
            cards={b}
          />
        </div>
      </OverlayHostHiddenProvider>
    </NextIntlClientProvider>
  )
  const view = render(ui(initial))
  return { show: (next: Layout) => view.rerender(ui(next)) }
}

const tab = (name: Name) => screen.getByTestId(`tab-${name}`)
const composer = (name: Name) =>
  screen.getByLabelText<HTMLTextAreaElement>(`${name} composer`)
const askList = (name: Name) => within(tab(name)).getByRole("radiogroup")
const questionField = (name: Name) =>
  tab(name).querySelector<HTMLTextAreaElement>("textarea[data-card-entry]")!
const transcriptControl = (name: Name) =>
  within(tab(name)).getByRole("button", { name: `Copy reply ${name}` })
const transcriptText = (name: Name) =>
  within(tab(name)).getByText(`The reply in ${name}, worth copying.`)

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

const question = (name: Name): PendingQuestion => ({
  tool_call_id: `tq-${name}`,
  question: `Which branch for ${name}?`,
})

/** Lets the frame the composer waits for go by. */
async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

/** Put focus on `el`; the page itself means nowhere. */
function place(el: HTMLElement) {
  act(() => {
    if (el !== document.body) el.focus()
    else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
}

function leaveWindow() {
  act(() => {
    window.dispatchEvent(new FocusEvent("blur"))
  })
}

/** The window comes back to the front (⌘Tab, the Dock): no press in it. */
async function windowComesBack() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"))
  })
  await nextFrame()
}

function selectText(el: Element) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  noteTabActivation(false)
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"))
  })
})

describe("switching to a chat puts the caret in its composer", () => {
  it("lands in the composer of the chat that opens", async () => {
    renderWorkspace({ front: "A" })
    await nextFrame()
    expect(composer("A")).toHaveFocus()
  })

  it("from the composer of the tab left behind (a keyboard switch)", async () => {
    const { show } = renderWorkspace({ front: "A" })
    await nextFrame()
    composer("A").value = "half a thought"

    show({ front: "B" })
    await nextFrame()
    expect(composer("B")).toHaveFocus()
  })

  it.each([
    { from: "a sidebar row", el: () => screen.getByText("Sidebar row") },
    { from: "a tab item", el: () => screen.getByRole("tab") },
    { from: "the terminal", el: () => screen.getByLabelText("Terminal") },
    { from: "a search box", el: () => screen.getByLabelText("Search") },
  ])("from $from", async ({ el }) => {
    const { show } = renderWorkspace({ front: "A" })
    await nextFrame()
    place(el())

    show({ front: "B" })
    await nextFrame()
    expect(composer("B")).toHaveFocus()
  })

  it("at the end of the draft it holds", async () => {
    const { show } = renderWorkspace({ front: "A" })
    await nextFrame()
    composer("B").value = "restored draft"

    show({ front: "B" })
    await nextFrame()
    expect(composer("B")).toHaveFocus()
    expect(composer("B").selectionStart).toBe("restored draft".length)
    expect(composer("B").selectionEnd).toBe("restored draft".length)
  })

  it("but a card waiting in the chat switched to keeps the keyboard", async () => {
    const { show } = renderWorkspace({ front: "A", b: { ask: ask("B") } })
    await nextFrame()
    expect(composer("A")).toHaveFocus()

    show({ front: "B", b: { ask: ask("B") } })
    await nextFrame()
    expect(askList("B")).toHaveFocus()
  })
})

describe("asking again for the chat in front", () => {
  it("puts the caret in its composer (a sidebar row or search pick of the open chat)", async () => {
    renderWorkspace({ front: "A" })
    await nextFrame()
    place(screen.getByText("Sidebar row"))

    act(() => requestComposerFocus())
    await nextFrame()
    expect(composer("A")).toHaveFocus()
  })

  it("reaches only the composer of the chat in front", async () => {
    const { show } = renderWorkspace({ front: "A", split: true })
    await nextFrame()
    show({ front: "B", split: true })
    await nextFrame()
    place(screen.getByText("Sidebar row"))

    act(() => requestComposerFocus())
    await nextFrame()
    expect(composer("B")).toHaveFocus()
  })

  it("leaves the caret where it is when the user is typing there", async () => {
    renderWorkspace({ front: "A" })
    await nextFrame()
    composer("A").value = "half a thought"
    composer("A").setSelectionRange(4, 4)

    act(() => requestComposerFocus())
    await nextFrame()
    expect(composer("A")).toHaveFocus()
    expect(composer("A").selectionStart).toBe(4)
  })

  it("gives the keyboard to a card waiting there instead", async () => {
    renderWorkspace({ front: "A", a: { ask: ask("A") } })
    await nextFrame()
    expect(askList("A")).toHaveFocus()
    place(screen.getByText("Sidebar row"))

    act(() => requestComposerFocus())
    await nextFrame()
    expect(composer("A")).not.toHaveFocus()
  })
})

describe("a tab another client moves", () => {
  it.each([
    { from: "the terminal", el: () => screen.getByLabelText("Terminal") },
    {
      from: "a settings field",
      el: () => screen.getByLabelText("Settings field"),
    },
    { from: "nowhere", el: () => document.body },
  ])("takes nothing from $from", async ({ el }) => {
    const { show } = renderWorkspace({ front: "A" })
    await nextFrame()
    place(el())

    // The phone (or another window) brought B to the front.
    noteTabActivation(true)
    show({ front: "B" })
    await nextFrame()
    expect(composer("B")).not.toHaveFocus()
  })

  it("leaves the composer for the window coming back to place it", async () => {
    const { show } = renderWorkspace({ front: "A" })
    await nextFrame()
    leaveWindow()
    noteTabActivation(true)
    show({ front: "B" })
    await nextFrame()
    expect(composer("B")).not.toHaveFocus()

    // Back at the desk: focus was left in the tab now hidden.
    await windowComesBack()
    expect(composer("B")).toHaveFocus()
  })
})

describe("split panes", () => {
  it("activating the other pane hands its composer the keyboard", async () => {
    const { show } = renderWorkspace({ front: "A", split: true })
    await nextFrame()
    expect(composer("A")).toHaveFocus()

    show({ front: "B", split: true })
    await nextFrame()
    expect(composer("B")).toHaveFocus()
  })

  it("a press into the other pane's transcript waits for the press to end", async () => {
    const { show } = renderWorkspace({ front: "A", split: true })
    await nextFrame()

    // The pane activates on the press (`onPointerDownCapture`).
    fireEvent.pointerDown(transcriptText("B"))
    show({ front: "B", split: true })
    await nextFrame()
    expect(composer("B")).not.toHaveFocus()

    fireEvent.pointerUp(transcriptText("B"))
    expect(composer("B")).toHaveFocus()
  })

  it("a press whose release never reached the page holds no later switch", async () => {
    const { show } = renderWorkspace({ front: "A", split: true })
    await nextFrame()
    // E.g. dragging the window by its title bar: the release is the system's.
    fireEvent.pointerDown(screen.getByText("Sidebar row"))
    const later = performance.now() + 5000
    const clock = vi.spyOn(performance, "now").mockReturnValue(later)
    try {
      show({ front: "B", split: true })
      await nextFrame()
      expect(composer("B")).toHaveFocus()
    } finally {
      clock.mockRestore()
      fireEvent.pointerUp(document.body)
    }
  })

  it("a drag selecting text in the other pane keeps its selection", async () => {
    const { show } = renderWorkspace({ front: "A", split: true })
    await nextFrame()

    fireEvent.pointerDown(transcriptText("B"))
    show({ front: "B", split: true })
    await nextFrame()
    selectText(transcriptText("B"))
    fireEvent.pointerUp(transcriptText("B"))
    expect(composer("B")).not.toHaveFocus()
    expect(document.getSelection()?.toString()).toContain("worth copying")
  })
})

describe("a workspace under a full-page route", () => {
  it("its chat takes the keyboard once the route closes, and not before", async () => {
    const { show } = renderWorkspace({ front: "A", covered: true })
    await nextFrame()
    expect(composer("A")).not.toHaveFocus()

    show({ front: "A", covered: false })
    await nextFrame()
    expect(composer("A")).toHaveFocus()
  })
})

describe("the window coming back to the front", () => {
  async function awayFrom(
    el: () => HTMLElement,
    layout: Layout = { front: "A" }
  ) {
    renderWorkspace(layout)
    await nextFrame()
    leaveWindow()
    place(el())
    await windowComesBack()
  }

  it.each([
    { from: "nowhere", el: () => document.body },
    {
      from: "an element now hidden",
      el: () => composer("B"),
    },
    { from: "a sidebar row", el: () => screen.getByText("Sidebar row") },
    { from: "a tab item", el: () => screen.getByRole("tab") },
    { from: "the transcript", el: () => transcriptControl("A") },
  ])("moves the keyboard to the composer from $from", async ({ el }) => {
    await awayFrom(el)
    expect(composer("A")).toHaveFocus()
  })

  it.each([
    { in: "the terminal", el: () => screen.getByLabelText("Terminal") },
    { in: "a search box", el: () => screen.getByLabelText("Search") },
    {
      in: "a settings field",
      el: () => screen.getByLabelText("Settings field"),
    },
  ])("leaves it in $in", async ({ el }) => {
    await awayFrom(el)
    expect(el()).toHaveFocus()
  })

  it("leaves the caret where it was in the composer", async () => {
    renderWorkspace({ front: "A" })
    await nextFrame()
    composer("A").value = "half a thought"
    composer("A").setSelectionRange(4, 4)
    leaveWindow()
    await windowComesBack()
    expect(composer("A")).toHaveFocus()
    expect(composer("A").selectionStart).toBe(4)
  })

  it("leaves it in a card's own text field", async () => {
    await awayFrom(() => questionField("A"), {
      front: "A",
      a: { question: question("A") },
    })
    expect(questionField("A")).toHaveFocus()
  })

  it.each([
    { layer: "dialog", role: "dialog", attrs: { "data-state": "open" } },
    { layer: "menu", role: "menu", attrs: { "data-state": "open" } },
    { layer: "drawer", role: "dialog", attrs: { "data-open": "" } },
  ])("leaves it alone while a $layer is open", async ({ role, attrs }) => {
    const layer = document.createElement("div")
    layer.setAttribute("role", role)
    for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v)
    document.body.appendChild(layer)
    try {
      await awayFrom(() => document.body)
      expect(composer("A")).not.toHaveFocus()
    } finally {
      layer.remove()
    }
  })

  it("moves the keyboard into a drawer holding the chat", async () => {
    await awayFrom(() => document.body, { front: "A", inDrawer: true })
    expect(composer("A")).toHaveFocus()
  })

  it("but not under a menu opened over that drawer", async () => {
    const menu = document.createElement("div")
    menu.setAttribute("role", "menu")
    menu.setAttribute("data-state", "open")
    document.body.appendChild(menu)
    try {
      await awayFrom(() => document.body, { front: "A", inDrawer: true })
      expect(composer("A")).not.toHaveFocus()
    } finally {
      menu.remove()
    }
  })

  it("leaves text selected in the transcript selected", async () => {
    renderWorkspace({ front: "A" })
    await nextFrame()
    leaveWindow()
    place(document.body)
    selectText(transcriptText("A"))
    await windowComesBack()
    expect(composer("A")).not.toHaveFocus()
    expect(document.getSelection()?.toString()).toContain("worth copying")
  })

  it("leaves a click that brought the window back to decide", async () => {
    renderWorkspace({ front: "A" })
    await nextFrame()
    leaveWindow()
    place(screen.getByText("Sidebar row"))
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"))
    })
    fireEvent.pointerDown(transcriptText("A"))
    fireEvent.pointerUp(transcriptText("A"))
    await nextFrame()
    expect(composer("A")).not.toHaveFocus()
  })

  it("gives the keyboard to a card waiting in the chat in front", async () => {
    await awayFrom(() => screen.getByText("Sidebar row"), {
      front: "A",
      a: { ask: ask("A") },
    })
    expect(askList("A")).toHaveFocus()
  })

  it("leaves the keyboard on the card control the user moved to", async () => {
    const reject = () =>
      within(tab("A")).getByRole("button", { name: "Reject" })
    await awayFrom(reject, { front: "A", a: { permission: permission("A") } })
    expect(reject()).toHaveFocus()
  })

  it("moves nothing in a background tab", async () => {
    await awayFrom(() => document.body, { front: "B" })
    expect(composer("A")).not.toHaveFocus()
    expect(composer("B")).toHaveFocus()
  })
})
