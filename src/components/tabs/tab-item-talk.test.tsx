import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { Reorder } from "motion/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import type { DbConversationSummary } from "@/lib/types"

const h = vi.hoisted(() => ({
  setConversationTalkMode: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  setConversationTalkMode: h.setConversationTalkMode,
}))
vi.mock("sonner", () => ({ toast: { error: h.toastError } }))

import { TabItem } from "./tab-item"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const L = enMessages.Folder.tabs

function row(over: Partial<DbConversationSummary> = {}): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Deploy fix",
    title_locked: false,
    agent_type: "open_code",
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
    ...over,
  }
}

const noop = () => {}

function renderTab(tab: TabItemData) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Reorder.Group axis="x" values={[tab.id]} onReorder={noop} as="div">
        <TabItem
          tab={tab}
          isActive={false}
          isTileMode={false}
          folderName="proj"
          folderBranch={null}
          isSplit={false}
          canSplitMove={false}
          canMoveToGroup
          moveTargets={[]}
          onSwitch={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseAll={noop}
          onPin={noop}
          onToggleTile={noop}
          onSplit={noop}
          onMoveToGroup={noop}
          onToggleSplitOrientation={noop}
          onUnsplit={noop}
          onUnsplitAll={noop}
          isCoarsePointer={false}
          isTouchSorting={false}
          onTouchSortingStart={noop}
          onTouchSortingEnd={noop}
        />
      </Reorder.Group>
    </NextIntlClientProvider>
  )
}

const conversationTab = {
  id: "t7",
  kind: "conversation",
  folderId: 3,
  conversationId: 7,
  agentType: "open_code",
  title: "Deploy fix",
  isPinned: true,
} as TabItemData

function openMenu() {
  fireEvent.contextMenu(screen.getByText("Deploy fix"))
}

beforeEach(() => {
  h.setConversationTalkMode.mockReset().mockResolvedValue(undefined)
  h.toastError.mockReset()
  useAppWorkspaceStore.setState({ conversations: [row()] })
})

afterEach(() => {
  cleanup()
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("TabItem Talk mode", () => {
  it("turns Talk on from the context menu and shows the badge", async () => {
    const { container } = renderTab(conversationTab)
    expect(container.querySelector("[data-talk-badge]")).toBeNull()
    openMenu()
    fireEvent.click(screen.getByText(L.talkOn))
    await waitFor(() =>
      expect(h.setConversationTalkMode).toHaveBeenCalledWith(7, true)
    )
    // Optimistic: the row flips at once, so the tab shows the badge.
    await waitFor(() =>
      expect(container.querySelector("[data-talk-badge]")).not.toBeNull()
    )
  })

  it("shows the badge while Talk is on, and offers to turn it off", async () => {
    useAppWorkspaceStore.setState({ conversations: [row({ talk_mode: true })] })
    renderTab(conversationTab)
    expect(
      screen.getByTitle(enMessages.Folder.sidebar.talkBadge)
    ).toBeInTheDocument()
    openMenu()
    expect(screen.queryByText(L.talkOn)).toBeNull()
    fireEvent.click(screen.getByText(L.talkOff))
    await waitFor(() =>
      expect(h.setConversationTalkMode).toHaveBeenCalledWith(7, false)
    )
  })

  it("puts the badge back and says so when the backend refuses", async () => {
    useAppWorkspaceStore.setState({ conversations: [row({ talk_mode: true })] })
    h.setConversationTalkMode.mockRejectedValue(new Error("not_found"))
    const { container } = renderTab(conversationTab)
    openMenu()
    fireEvent.click(screen.getByText(L.talkOff))
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        "Could not update Talk mode: not_found"
      )
    )
    expect(container.querySelector("[data-talk-badge]")).not.toBeNull()
  })

  it("has no Talk item on a draft tab", () => {
    renderTab({ ...conversationTab, id: "draft", conversationId: null })
    openMenu()
    expect(screen.queryByText(L.talkOn)).toBeNull()
  })

  it("only offers to turn Talk off on a delegation sub-session's tab", () => {
    useAppWorkspaceStore.setState({ conversations: [row({ parent_id: 2 })] })
    const { unmount } = renderTab(conversationTab)
    openMenu()
    expect(screen.queryByText(L.talkOn)).toBeNull()
    unmount()

    useAppWorkspaceStore.setState({
      conversations: [row({ parent_id: 2, talk_mode: true })],
    })
    renderTab(conversationTab)
    openMenu()
    expect(screen.getByText(L.talkOff)).toBeInTheDocument()
    // The critical mark is still not offered there.
    expect(screen.queryByText(L.markCritical)).toBeNull()
  })
})
