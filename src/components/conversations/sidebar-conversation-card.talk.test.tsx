import { cleanup, fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SidebarConversationCard } from "./sidebar-conversation-card"
import type { DbConversationSummary } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

const L = enMessages.Folder.conversationCard

const onSelect = vi.fn()
const onRename = vi.fn(async () => {})
const onDelete = vi.fn(async () => {})
const onStatusChange = vi.fn(async () => {})
const onToggleTalk = vi.fn()

function conv(
  id: number,
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "open_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

function renderCard(c: DbConversationSummary, withToggle = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel=""
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
        onStatusChange={onStatusChange}
        onToggleTalk={withToggle ? onToggleTalk : undefined}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  onToggleTalk.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("SidebarConversationCard Talk mode", () => {
  it("offers to turn Talk on, and shows no badge while it is off", () => {
    const { getByText, container } = renderCard(conv(1))
    expect(container.querySelector("[data-talk-badge]")).toBeNull()
    fireEvent.contextMenu(getByText("conv-1"))
    fireEvent.click(getByText(L.talkOn))
    expect(onToggleTalk).toHaveBeenCalledWith(1, true)
  })

  it("shows the badge while Talk is on, and offers to turn it off", () => {
    const { getByText, getAllByTitle, queryByText } = renderCard(
      conv(2, { talk_mode: true })
    )
    expect(
      getAllByTitle(enMessages.Folder.sidebar.talkBadge).length
    ).toBeGreaterThan(0)
    fireEvent.contextMenu(getByText("conv-2"))
    expect(queryByText(L.talkOn)).toBeNull()
    fireEvent.click(getByText(L.talkOff))
    expect(onToggleTalk).toHaveBeenCalledWith(2, false)
  })

  it("leaves the item out when the list offers no toggle", () => {
    const { getByText, queryByText } = renderCard(conv(3), false)
    fireEvent.contextMenu(getByText("conv-3"))
    expect(queryByText(L.talkOn)).toBeNull()
  })

  it("only offers to turn Talk off on a delegation sub-session", () => {
    const { getByText, queryByText, unmount } = renderCard(
      conv(4, { parent_id: 1 })
    )
    fireEvent.contextMenu(getByText("conv-4"))
    expect(queryByText(L.talkOn)).toBeNull()
    unmount()

    const again = renderCard(conv(5, { parent_id: 1, talk_mode: true }))
    fireEvent.contextMenu(again.getByText("conv-5"))
    fireEvent.click(again.getByText(L.talkOff))
    expect(onToggleTalk).toHaveBeenCalledWith(5, false)
  })
})
