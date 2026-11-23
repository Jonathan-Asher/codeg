/**
 * The aux panel's Prompts tab: the active session's prepared prompts, added,
 * edited, deleted and dragged into order here, sent through the session's own
 * composer (now, or into its queue while a reply runs) or put into it to edit
 * first, and marked with when they were sent.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PreparedPrompt } from "@/lib/types"

// jsdom has no layout, so Motion can never tell that a dragged row crossed
// its neighbour: the fake hands the group's reorder and the rows' drag end to
// the test to drive.
const motion = vi.hoisted(() => ({
  onReorder: null as ((next: unknown[]) => void) | null,
  dragEnd: null as (() => void) | null,
}))
vi.mock("motion/react", async () => {
  const { useLayoutEffect } = await import("react")
  const MOTION_ONLY = new Set([
    "as",
    "axis",
    "values",
    "onReorder",
    "value",
    "drag",
    "dragListener",
    "dragControls",
    "dragMomentum",
    "layout",
    "onDragEnd",
  ])
  const domProps = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).filter(([key]) => !MOTION_ONLY.has(key))
    )
  function Group(
    props: Record<string, unknown> & {
      children?: ReactNode
      onReorder: (next: unknown[]) => void
    }
  ) {
    const { onReorder } = props
    useLayoutEffect(() => {
      motion.onReorder = onReorder
    })
    return <ul {...domProps(props)}>{props.children}</ul>
  }
  function Item(
    props: Record<string, unknown> & {
      children?: ReactNode
      onDragEnd: () => void
    }
  ) {
    const { onDragEnd } = props
    useLayoutEffect(() => {
      motion.dragEnd = onDragEnd
    })
    return <li {...domProps(props)}>{props.children}</li>
  }
  return {
    Reorder: { Group, Item },
    useDragControls: () => ({ start: vi.fn() }),
  }
})

// The server's table, in memory: what the panel reads back is only what it
// (or "another window") stored.
const server = vi.hoisted(() => ({
  rows: [] as PreparedPrompt[],
  nextId: 1,
  failCreate: false,
}))
vi.mock("@/lib/api", () => {
  const clone = (p: PreparedPrompt) => ({ ...p })
  const listOf = (conversationId: number) =>
    server.rows
      .filter((p) => p.conversationId === conversationId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map(clone)
  const find = (id: number) => {
    const row = server.rows.find((p) => p.id === id)
    if (!row) throw new Error(`Prepared prompt ${id} not found`)
    return row
  }
  return {
    listPreparedPrompts: vi.fn(async (conversationId: number) =>
      listOf(conversationId)
    ),
    createPreparedPrompt: vi.fn(
      async (conversationId: number, content: string) => {
        if (server.failCreate) throw new Error("A prompt can't be empty")
        const order = listOf(conversationId)
        const now = new Date().toISOString()
        const row: PreparedPrompt = {
          id: server.nextId++,
          conversationId,
          content,
          sortOrder: order.length ? order[order.length - 1].sortOrder + 1 : 0,
          lastSentAt: null,
          createdAt: now,
          updatedAt: now,
        }
        server.rows.push(row)
        return clone(row)
      }
    ),
    updatePreparedPrompt: vi.fn(async (id: number, content: string) => {
      const row = find(id)
      row.content = content
      return clone(row)
    }),
    deletePreparedPrompt: vi.fn(async (id: number) => {
      server.rows = server.rows.filter((p) => p.id !== id)
    }),
    reorderPreparedPrompts: vi.fn(
      async (conversationId: number, ids: number[]) => {
        ids.forEach((id, index) => {
          find(id).sortOrder = index
        })
        return listOf(conversationId)
      }
    ),
    markPreparedPromptSent: vi.fn(async (id: number) => {
      const row = find(id)
      row.lastSentAt = new Date().toISOString()
      return clone(row)
    }),
  }
})

// The server's change nudges, delivered by the test.
const events = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async (event: string, handler: (p: unknown) => void) => {
    events.handlers.set(event, handler)
    return () => events.handlers.delete(event)
  }),
  onTransportReconnect: () => () => {},
}))

const tabs = vi.hoisted(() => ({
  state: {
    activeTabId: "tab-1" as string | null,
    tabs: [] as Array<{
      id: string
      kind: "conversation" | "subagent"
      conversationId: number | null
    }>,
  },
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (s: typeof tabs.state) => unknown) =>
    selector(tabs.state),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  })
)
vi.mock("sonner", () => ({ toast }))

import enMessages from "@/i18n/messages/en.json"
import * as api from "@/lib/api"
import {
  registerComposerBridge,
  resetComposerBridgesForTests,
  type ComposerBridge,
} from "@/lib/composer-bridge"
import { PREPARED_PROMPTS_CHANGED_EVENT } from "@/lib/types"
import { PreparedPromptsTab } from "./aux-panel-prompts-tab"

const T = enMessages.Folder.preparedPrompts
const CONVERSATION = 7

function seed(content: string, extra: Partial<PreparedPrompt> = {}) {
  const now = new Date().toISOString()
  const row: PreparedPrompt = {
    id: server.nextId++,
    conversationId: CONVERSATION,
    content,
    sortOrder: server.rows.filter((p) => p.conversationId === CONVERSATION)
      .length,
    lastSentAt: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  }
  server.rows.push(row)
  return row
}

function composer(overrides: Partial<ComposerBridge> = {}) {
  const bridge: ComposerBridge = {
    sendRoute: "send",
    isReplying: false,
    send: vi.fn(() => overrides.sendRoute ?? "send"),
    insert: vi.fn(() => true),
    ...overrides,
  }
  act(() => {
    registerComposerBridge("tab-1", bridge)
  })
  return bridge
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PreparedPromptsTab />
    </NextIntlClientProvider>
  )
}

/** The listed prompts' text, top to bottom. */
function shown(): string[] {
  return screen
    .queryAllByTestId("prepared-prompt-text")
    .map((el) => el.textContent ?? "")
}

function row(content: string): HTMLElement {
  const text = screen
    .getAllByTestId("prepared-prompt-text")
    .find((el) => el.textContent === content)
  const item = text?.closest<HTMLElement>("[data-testid=prepared-prompt]")
  if (!item) throw new Error(`no prompt "${content}" listed`)
  return item
}

function inRow(el: HTMLElement) {
  return {
    button: (name: string | RegExp) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) =>
          (b.getAttribute("aria-label") ?? b.textContent ?? "").match(
            typeof name === "string" ? new RegExp(`^${name}$`) : name
          ) != null
      ) ?? null,
  }
}

beforeEach(() => {
  server.rows = []
  server.nextId = 1
  server.failCreate = false
  tabs.state = {
    activeTabId: "tab-1",
    tabs: [{ id: "tab-1", kind: "conversation", conversationId: CONVERSATION }],
  }
  events.handlers.clear()
  motion.onReorder = null
  motion.dragEnd = null
})

afterEach(() => {
  resetComposerBridgesForTests()
  vi.clearAllMocks()
})

describe("Prompts tab: which session", () => {
  it("says prompts belong to a saved session when none is open", () => {
    tabs.state = { activeTabId: null, tabs: [] }
    renderTab()
    expect(screen.getByText(T.noSession)).toBeInTheDocument()
    expect(api.listPreparedPrompts).not.toHaveBeenCalled()
  })

  it("says the same for a draft, until its first message makes it a session", async () => {
    tabs.state = {
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", kind: "conversation", conversationId: null }],
    }
    const view = renderTab()
    expect(screen.getByText(T.draftSession)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(T.newPlaceholder)).toBeNull()

    // The first send bound the draft to its new conversation.
    tabs.state = {
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", kind: "conversation", conversationId: 9 }],
    }
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PreparedPromptsTab />
      </NextIntlClientProvider>
    )
    expect(await screen.findByText(T.empty)).toBeInTheDocument()
    expect(api.listPreparedPrompts).toHaveBeenCalledWith(9)
    expect(screen.getByPlaceholderText(T.newPlaceholder)).toBeInTheDocument()
  })

  it("lists only the active session's prompts, in their order", async () => {
    seed("first")
    seed("elsewhere", { conversationId: 99 })
    seed("second")
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["first", "second"]))
  })

  it("explains itself when the list is empty", async () => {
    renderTab()
    expect(
      await screen.findByTestId("prepared-prompts-empty")
    ).toHaveTextContent(T.empty)
  })
})

describe("Prompts tab: writing them", () => {
  it("adds a prompt with the button and clears the field", async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByText(T.empty)
    const field = screen.getByPlaceholderText(T.newPlaceholder)
    const add = screen.getByRole("button", { name: T.add })
    expect(add).toBeDisabled()

    await user.type(field, "Run the tests{Shift>}{Enter}{/Shift}then lint")
    await user.click(add)

    await waitFor(() => expect(shown()).toEqual(["Run the tests\nthen lint"]))
    expect(api.createPreparedPrompt).toHaveBeenCalledWith(
      CONVERSATION,
      "Run the tests\nthen lint"
    )
    expect(field).toHaveValue("")
  })

  it("adds a prompt with ⌘↩", async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByText(T.empty)
    const field = screen.getByPlaceholderText(T.newPlaceholder)
    await user.type(field, "Summarize the diff")
    fireEvent.keyDown(field, { key: "Enter", metaKey: true })
    await waitFor(() => expect(shown()).toEqual(["Summarize the diff"]))
    expect(screen.getByText("⌘Enter to add")).toBeInTheDocument()
  })

  it("never adds a blank one, and keeps the text when the server refuses", async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByText(T.empty)
    const field = screen.getByPlaceholderText(T.newPlaceholder)
    await user.type(field, "   ")
    fireEvent.keyDown(field, { key: "Enter", metaKey: true })
    expect(api.createPreparedPrompt).not.toHaveBeenCalled()

    server.failCreate = true
    await user.clear(field)
    await user.type(field, "kept")
    fireEvent.keyDown(field, { key: "Enter", metaKey: true })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(T.saveFailed, expect.anything())
    )
    expect(field).toHaveValue("kept")
  })

  it("edits a prompt in place, saving with ⌘↩ or the button and cancelling with Esc", async () => {
    const user = userEvent.setup()
    seed("Check the logs")
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["Check the logs"]))

    await user.click(inRow(row("Check the logs")).button(T.edit)!)
    const editor = screen.getByRole("textbox", { name: T.editLabel })
    expect(editor).toHaveValue("Check the logs")
    await user.type(editor, " for errors")
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true })
    await waitFor(() => expect(shown()).toEqual(["Check the logs for errors"]))
    expect(api.updatePreparedPrompt).toHaveBeenCalledWith(
      1,
      "Check the logs for errors"
    )

    await user.click(inRow(row("Check the logs for errors")).button(T.edit)!)
    const again = screen.getByRole("textbox", { name: T.editLabel })
    await user.clear(again)
    await user.type(again, "discarded")
    fireEvent.keyDown(again, { key: "Escape" })
    expect(shown()).toEqual(["Check the logs for errors"])
    expect(api.updatePreparedPrompt).toHaveBeenCalledTimes(1)

    await user.click(inRow(row("Check the logs for errors")).button(T.edit)!)
    const third = screen.getByRole("textbox", { name: T.editLabel })
    await user.clear(third)
    await user.type(third, "Saved by the button")
    await user.click(screen.getByRole("button", { name: T.save }))
    await waitFor(() => expect(shown()).toEqual(["Saved by the button"]))
  })

  it("deletes a prompt, and Undo puts it back where it was", async () => {
    const user = userEvent.setup()
    seed("one")
    seed("two")
    seed("three")
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["one", "two", "three"]))

    await user.click(inRow(row("two")).button(T.delete)!)
    await waitFor(() => expect(shown()).toEqual(["one", "three"]))
    expect(api.deletePreparedPrompt).toHaveBeenCalledWith(2)
    expect(toast).toHaveBeenCalledWith(
      T.deleted,
      expect.objectContaining({
        action: expect.objectContaining({ label: T.undo }),
      })
    )

    const undo = vi.mocked(toast).mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    act(() => undo.action.onClick())
    await waitFor(() => expect(shown()).toEqual(["one", "two", "three"]))
  })

  it("stores the order a drag leaves", async () => {
    seed("one")
    seed("two")
    seed("three")
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["one", "two", "three"]))

    const [one, two, three] = server.rows.map((p) => ({ ...p }))
    act(() => motion.onReorder?.([three, one, two]))
    expect(shown()).toEqual(["three", "one", "two"])
    // Nothing is stored mid-drag.
    expect(api.reorderPreparedPrompts).not.toHaveBeenCalled()

    act(() => motion.dragEnd?.())
    await waitFor(() =>
      expect(api.reorderPreparedPrompts).toHaveBeenCalledWith(
        CONVERSATION,
        [3, 1, 2]
      )
    )
    expect(shown()).toEqual(["three", "one", "two"])
  })

  it("re-reads when another window changes this session's list, and only this one's", async () => {
    seed("one")
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["one"]))
    await waitFor(() =>
      expect(events.handlers.has(PREPARED_PROMPTS_CHANGED_EVENT)).toBe(true)
    )
    const calls = vi.mocked(api.listPreparedPrompts).mock.calls.length

    act(() =>
      events.handlers.get(PREPARED_PROMPTS_CHANGED_EVENT)?.({
        conversationId: 99,
      })
    )
    expect(api.listPreparedPrompts).toHaveBeenCalledTimes(calls)

    seed("added elsewhere")
    act(() =>
      events.handlers.get(PREPARED_PROMPTS_CHANGED_EVENT)?.({
        conversationId: CONVERSATION,
      })
    )
    await waitFor(() => expect(shown()).toEqual(["one", "added elsewhere"]))
  })
})

describe("Prompts tab: sending them", () => {
  it("sends through the session's composer and marks the prompt sent, keeping it", async () => {
    const user = userEvent.setup()
    seed("Run the tests")
    const bridge = composer()
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["Run the tests"]))
    const send = inRow(row("Run the tests")).button(T.send)!
    expect(send).toBeEnabled()
    expect(send).toHaveAttribute("title", T.sendTitle)
    expect(screen.getByTestId("prepared-prompt-sent")).toBeEmptyDOMElement()

    await user.click(send)
    expect(bridge.send).toHaveBeenCalledWith("Run the tests")
    await waitFor(() =>
      expect(screen.getByTestId("prepared-prompt-sent")).toHaveTextContent(
        "Sent now"
      )
    )
    expect(api.markPreparedPromptSent).toHaveBeenCalledWith(1)
    // Still listed, for the next round.
    expect(shown()).toEqual(["Run the tests"])
    expect(toast.info).not.toHaveBeenCalled()
  })

  it("queues while a reply runs, saying when it will go", async () => {
    const user = userEvent.setup()
    seed("Then update the docs")
    const bridge = composer({ sendRoute: "enqueue", isReplying: true })
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["Then update the docs"]))

    const queue = inRow(row("Then update the docs")).button(T.queue)!
    expect(queue).toBeEnabled()
    expect(queue).toHaveAttribute("title", T.queueTitle)
    await user.click(queue)
    expect(bridge.send).toHaveBeenCalledWith("Then update the docs")
    expect(toast.info).toHaveBeenCalledWith(T.queuedToast)
    await waitFor(() =>
      expect(api.markPreparedPromptSent).toHaveBeenCalledWith(1)
    )
  })

  it("queues for a session still opening with its own words", async () => {
    const user = userEvent.setup()
    seed("hello")
    composer({ sendRoute: "enqueue", isReplying: false })
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["hello"]))
    const queue = inRow(row("hello")).button(T.queue)!
    expect(queue).toHaveAttribute("title", T.queueUntilReadyTitle)
    await user.click(queue)
    expect(toast.info).toHaveBeenCalledWith(T.queuedUntilReady)
  })

  it("cannot send while the session takes no message, or has no composer", async () => {
    seed("hello")
    const bridge = composer({ sendRoute: null })
    const view = renderTab()
    await waitFor(() => expect(shown()).toEqual(["hello"]))
    const send = inRow(row("hello")).button(T.send)!
    expect(send).toBeDisabled()
    expect(send).toHaveAttribute("title", T.sendUnavailable)
    fireEvent.click(send)
    expect(bridge.send).not.toHaveBeenCalled()
    // Editing first still works: the composer is there.
    expect(inRow(row("hello")).button(T.insert)).toBeEnabled()

    act(() => resetComposerBridgesForTests())
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PreparedPromptsTab />
      </NextIntlClientProvider>
    )
    expect(inRow(row("hello")).button(T.send)).toBeDisabled()
    expect(inRow(row("hello")).button(T.insert)).toBeDisabled()
  })

  it("sends once for a double click", async () => {
    const user = userEvent.setup()
    seed("only once")
    const bridge = composer()
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["only once"]))
    await user.dblClick(inRow(row("only once")).button(T.send)!)
    expect(bridge.send).toHaveBeenCalledTimes(1)
  })

  it("puts a prompt in the composer to edit first, without marking it sent", async () => {
    const user = userEvent.setup()
    seed("Explain the failure")
    const bridge = composer()
    renderTab()
    await waitFor(() => expect(shown()).toEqual(["Explain the failure"]))
    const insert = inRow(row("Explain the failure")).button(T.insert)!
    expect(insert).toHaveAttribute("title", T.insertTitle)
    await user.click(insert)
    expect(bridge.insert).toHaveBeenCalledWith("Explain the failure")
    expect(bridge.send).not.toHaveBeenCalled()
    expect(api.markPreparedPromptSent).not.toHaveBeenCalled()
  })

  it("shows how long ago an earlier send was", async () => {
    seed("sent before", {
      lastSentAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    })
    renderTab()
    await waitFor(() =>
      expect(screen.getByTestId("prepared-prompt-sent")).toHaveTextContent(
        "Sent 2 hours ago"
      )
    )
  })
})
