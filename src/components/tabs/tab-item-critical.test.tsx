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

const h = vi.hoisted(() => ({ updateConversationCritical: vi.fn() }))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateConversationCritical: h.updateConversationCritical,
}))

import { TabItem } from "./tab-item"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

function row(over: Partial<DbConversationSummary> = {}): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Deploy fix",
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
  agentType: "claude_code",
  title: "Deploy fix",
  isPinned: true,
} as TabItemData

beforeEach(() => {
  h.updateConversationCritical.mockReset().mockResolvedValue(undefined)
  useAppWorkspaceStore.setState({ conversations: [row()] })
})

afterEach(() => {
  cleanup()
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("TabItem critical mark", () => {
  it("marks the tab's conversation critical from the context menu and flags the tab", async () => {
    const { container } = renderTab(conversationTab)
    expect(container.querySelector("[data-critical-flag]")).toBeNull()
    fireEvent.contextMenu(screen.getByText("Deploy fix"))
    fireEvent.click(screen.getByText("Mark as critical"))
    await waitFor(() =>
      expect(h.updateConversationCritical).toHaveBeenCalledWith(
        7,
        true,
        undefined
      )
    )
    // Optimistic: the row flips at once, so the tab shows the flag.
    await waitFor(() =>
      expect(container.querySelector("[data-critical-flag]")).not.toBeNull()
    )
  })

  it("offers Unmark critical on a critical conversation's tab", async () => {
    useAppWorkspaceStore.setState({ conversations: [row({ critical: true })] })
    renderTab(conversationTab)
    fireEvent.contextMenu(screen.getByText("Deploy fix"))
    fireEvent.click(screen.getByText("Unmark critical"))
    await waitFor(() =>
      expect(h.updateConversationCritical).toHaveBeenCalledWith(
        7,
        false,
        undefined
      )
    )
  })

  it("has no critical item on a draft tab", () => {
    renderTab({ ...conversationTab, id: "draft", conversationId: null })
    fireEvent.contextMenu(screen.getByText("Deploy fix"))
    expect(screen.queryByText("Mark as critical")).toBeNull()
  })

  it("has no mark on a delegation sub-session's tab", () => {
    useAppWorkspaceStore.setState({ conversations: [row({ parent_id: 2 })] })
    renderTab(conversationTab)
    fireEvent.contextMenu(screen.getByText("Deploy fix"))
    expect(screen.queryByText("Mark as critical")).toBeNull()
  })
})
