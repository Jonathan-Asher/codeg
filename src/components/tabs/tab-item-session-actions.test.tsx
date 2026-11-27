import {
  act,
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
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

const h = vi.hoisted(() => ({
  updateConversationTitle: vi.fn(),
  deleteConversation: vi.fn(),
  updateConversationPinned: vi.fn(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateConversationTitle: h.updateConversationTitle,
  deleteConversation: h.deleteConversation,
  updateConversationPinned: h.updateConversationPinned,
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  // Session Details reads the transcript; it stays loading here.
  getFolderConversation: vi.fn(() => new Promise(() => {})),
}))

import { TabItem } from "./tab-item"
import {
  SessionDialogHost,
  resetSessionDialogHostForTests,
} from "@/components/conversations/session-dialog-host"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetTabStore,
  useTabStore,
  type TabItemInternal,
} from "@/stores/tab-store"

const card = enMessages.Folder.conversationCard
const tabs = enMessages.Folder.tabs

const folder = { id: 3, name: "proj", path: "/proj" } as unknown as FolderDetail

function row(over: Partial<DbConversationSummary> = {}): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Deploy fix",
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
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

const sessionTab: TabItemInternal = {
  id: "conv-3-claude_code-7",
  kind: "conversation",
  folderId: 3,
  conversationId: 7,
  agentType: "claude_code",
  title: "Deploy fix",
  isPinned: true,
}

const noop = () => {}

/** The tab as the strip shows it: read from the store, so a rename or a
 *  delete shows the way it would there. */
function StoreTab({ id }: { id: string }) {
  const tab = useTabStore((s) => s.tabs.find((t) => t.id === id))
  if (!tab) return <span data-testid="tab-gone" />
  return (
    <Reorder.Group axis="x" values={[tab.id]} onReorder={noop} as="div">
      <TabItem
        tab={tab}
        isActive
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
        onSetAnchored={noop}
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
  )
}

function seed(tab: TabItemInternal, summary: DbConversationSummary | null) {
  useTabStore.setState({ rawTabs: [tab], activeTabId: tab.id })
  // The conversation list landing derives the strip's tabs from it.
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    conversations: summary ? [summary] : [],
  })
}

function renderTab(id = sessionTab.id) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StoreTab id={id} />
      <SessionDialogHost />
    </NextIntlClientProvider>
  )
}

function openMenu() {
  fireEvent.contextMenu(screen.getByRole("tab"))
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetSessionDialogHostForTests()
  h.updateConversationTitle.mockReset().mockResolvedValue(undefined)
  h.deleteConversation.mockReset().mockResolvedValue(undefined)
  h.updateConversationPinned.mockReset().mockResolvedValue(undefined)
  seed(sessionTab, row())
})

afterEach(() => {
  cleanup()
  resetSessionDialogHostForTests()
})

describe("TabItem session actions", () => {
  it("offers the sidebar's session actions beside the tab's own", () => {
    renderTab()
    openMenu()
    for (const label of [
      card.newConversation,
      card.rename,
      card.fork,
      enMessages.Folder.moveSession.menuLabel,
      enMessages.ContinueInAgent.menuLabel,
      card.pinInSidebar,
      card.markCritical,
      enMessages.Folder.sessionDetails.menuLabel,
      card.attachToCurrentSession,
      enMessages.ConversationTags.tags,
      card.status,
      enMessages.Folder.sidebar.folderHeaderMenu.manageConversations,
      card.delete,
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // The tab's own items stay.
    for (const label of [tabs.pinTab, tabs.close, tabs.splitRight]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it("lists each shared item once (critical, Talk, continue are not doubled)", () => {
    renderTab()
    openMenu()
    expect(screen.getAllByText(card.markCritical)).toHaveLength(1)
    expect(
      screen.getAllByText(enMessages.ContinueInAgent.menuLabel)
    ).toHaveLength(1)
    expect(screen.getAllByText(card.talkOn)).toHaveLength(1)
  })

  it("renames from the tab, and the tab's title follows at once", async () => {
    renderTab()
    openMenu()
    fireEvent.click(screen.getByText(card.rename))
    const field = await screen.findByDisplayValue("Deploy fix")
    fireEvent.change(field, { target: { value: "Ship the deploy fix" } })
    fireEvent.click(screen.getByText(card.save))
    await waitFor(() =>
      expect(h.updateConversationTitle).toHaveBeenCalledWith(
        7,
        "Ship the deploy fix"
      )
    )
    await waitFor(() =>
      expect(screen.getByRole("tab").textContent).toContain(
        "Ship the deploy fix"
      )
    )
  })

  it("deletes from the tab once confirmed, and the tab closes", async () => {
    renderTab()
    openMenu()
    fireEvent.click(screen.getByText(card.delete))
    expect(await screen.findByText(card.deleteConversationTitle)).toBeTruthy()
    expect(h.deleteConversation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: card.delete }))
    await waitFor(() => expect(h.deleteConversation).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.getByTestId("tab-gone")).toBeTruthy())
  })

  it("pins the session in the sidebar, named apart from Pin tab", async () => {
    renderTab()
    openMenu()
    fireEvent.click(screen.getByText(card.pinInSidebar))
    await waitFor(() =>
      expect(h.updateConversationPinned).toHaveBeenCalledWith(7, true)
    )
    expect(
      useAppWorkspaceStore.getState().conversations[0].pinned_at
    ).not.toBeNull()
  })

  it("opens Session Details over the workspace", async () => {
    renderTab()
    openMenu()
    act(() => {
      fireEvent.click(
        screen.getByText(enMessages.Folder.sessionDetails.menuLabel)
      )
    })
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    )
  })

  it("shows on a sub-session's tab only what its sidebar row shows", () => {
    seed(sessionTab, row({ parent_id: 2 }))
    renderTab()
    openMenu()
    for (const label of [card.rename, card.fork, card.status, card.delete]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    for (const label of [
      enMessages.Folder.moveSession.menuLabel,
      enMessages.ContinueInAgent.menuLabel,
      enMessages.ConversationTags.tags,
      enMessages.Folder.sidebar.folderHeaderMenu.manageConversations,
      card.markCritical,
      card.talkOn,
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it("offers no session actions on a draft", () => {
    const draft: TabItemInternal = {
      ...sessionTab,
      id: "draft-1",
      conversationId: null,
      workingDir: "/proj",
    }
    seed(draft, null)
    renderTab(draft.id)
    openMenu()
    expect(screen.queryByText(card.rename)).toBeNull()
    expect(screen.getByText(tabs.close)).toBeTruthy()
  })
})
