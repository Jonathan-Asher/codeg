import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PendingItem } from "@/lib/types"

const h = vi.hoisted(() => ({
  openNotificationTargetFromClick: vi.fn(),
}))

vi.mock("@/lib/notification-target", () => ({
  openNotificationTargetFromClick: h.openNotificationTargetFromClick,
}))
vi.mock("@/lib/api", () => ({
  listPendingItems: vi.fn(),
}))

import { PendingItemsIndicator } from "./pending-items-indicator"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePendingItemsStore } from "@/stores/pending-items-store"

const NOW = Date.parse("2026-10-26T12:00:00Z")

function item(over: Partial<PendingItem> = {}): PendingItem {
  return {
    id: "question:q1",
    kind: "question",
    source: "question",
    conversation_id: 51,
    root_conversation_id: 7,
    folder_id: 3,
    folder_name: "codeg",
    title: "Deploy fix",
    agent_type: "claude_code",
    agent_label: "Claude Code",
    connection_id: "conn-51",
    request_id: "q1",
    asked_at: new Date(NOW - 35 * 60_000).toISOString(),
    text: "Which database should we use?",
    options: [
      { id: "SQLite", label: "SQLite" },
      { id: "Postgres", label: "Postgres" },
    ],
    question: {
      item_id: "q1-0",
      header: "Storage",
      multi_select: false,
      count: 1,
    },
    queued: 0,
    reminders_sent: 2,
    last_reminded_at: null,
    next_reminder_at: null,
    phone_notified: true,
    ...over,
  }
}

function setItems(items: PendingItem[]) {
  act(() => {
    usePendingItemsStore
      .getState()
      .applySnapshot({ items, count: items.length })
  })
}

function renderIndicator() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PendingItemsIndicator />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  h.openNotificationTargetFromClick.mockReset()
  useAppWorkspaceStore.setState({ conversations: [] })
  usePendingItemsStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  usePendingItemsStore.getState().reset()
})

describe("PendingItemsIndicator", () => {
  it("shows nothing while nothing waits", () => {
    const { container } = renderIndicator()
    expect(container).toBeEmptyDOMElement()
  })

  it("counts what waits and lists each item with its age", () => {
    renderIndicator()
    setItems([
      item(),
      item({
        id: "permission:r1",
        kind: "permission",
        source: "permission",
        conversation_id: 9,
        root_conversation_id: 9,
        title: null,
        asked_at: new Date(NOW - 3 * 3600_000).toISOString(),
        text: "Run cargo test",
        reminders_sent: 0,
      }),
    ])
    const button = screen.getByRole("button", { name: "Waiting for you (2)" })
    fireEvent.click(button)

    const rows = screen.getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    const first = within(rows[0])
    expect(first.getByText("Deploy fix")).toBeInTheDocument()
    expect(first.getByText("waiting 35 min")).toBeInTheDocument()
    expect(
      first.getByText("Question · Claude Code · 2 reminders")
    ).toBeInTheDocument()
    expect(first.getByText("Which database should we use?")).toBeInTheDocument()
    const second = within(rows[1])
    expect(second.getByText("Untitled session")).toBeInTheDocument()
    expect(second.getByText("waiting 3 h")).toBeInTheDocument()
    expect(second.getByText("Permission · Claude Code")).toBeInTheDocument()
  })

  it("prefers the session's live title", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        {
          id: 7,
          folder_id: 3,
          title: "Renamed session",
          title_locked: false,
          agent_type: "claude_code",
          status: "in_progress",
          kind: "regular",
          model: null,
          git_branch: null,
          external_id: null,
          message_count: 1,
          child_count: 0,
          created_at: "2026-10-01T09:00:00.000Z",
          updated_at: "2026-10-01T09:30:00.000Z",
          pinned_at: null,
        },
      ],
    })
    renderIndicator()
    setItems([item()])
    fireEvent.click(screen.getByRole("button", { name: "Waiting for you (1)" }))
    expect(screen.getByText("Renamed session")).toBeInTheDocument()
  })

  it("opens the session the item belongs to and closes the list", () => {
    renderIndicator()
    setItems([item()])
    fireEvent.click(screen.getByRole("button", { name: "Waiting for you (1)" }))
    fireEvent.click(screen.getByText("Which database should we use?"))
    expect(h.openNotificationTargetFromClick).toHaveBeenCalledWith({
      contextKey: null,
      folderId: 3,
      conversationId: 7,
      agentType: "claude_code",
    })
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })

  it("goes away when the last item is answered", () => {
    renderIndicator()
    setItems([item()])
    fireEvent.click(screen.getByRole("button", { name: "Waiting for you (1)" }))
    setItems([])
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    // The next item does not spring the old list open.
    setItems([item({ id: "question:q2" })])
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })
})
