import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"
import {
  isRemoteActivation,
  noteTabActivation,
  onComposerFocusRequest,
} from "@/lib/composer-focus"
import type { FolderDetail, OpenedTab } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(async () => ({ accepted: true, version: 1, tabs: [] })),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const app = { id: 1, name: "app", path: "/work/app" } as unknown as FolderDetail
const TAB_7 = "conv-1-claude_code-7"
const TAB_8 = "conv-1-claude_code-8"

function served(activeId: number, version: number) {
  const tabs: OpenedTab[] = [7, 8].map((id, position) => ({
    id: id + 100,
    folder_id: 1,
    conversation_id: id,
    agent_type: "claude_code",
    position,
    is_active: id === activeId,
    is_pinned: true,
  }))
  return { version, origin: "server", tabs }
}

const requested = vi.fn()
let stopListening = () => {}

beforeEach(() => {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({ folders: [app], allFolders: [app] })
  resetTabStore()
  useTabStore.setState({
    rawTabs: [7, 8].map((id) => ({
      id: `conv-1-claude_code-${id}`,
      kind: "conversation" as const,
      folderId: 1,
      conversationId: id,
      agentType: "claude_code" as const,
      title: `Topic ${id}`,
      isPinned: true,
    })),
    activeTabId: TAB_7,
    tabsHydrated: true,
  })
  // In sync with the server: tab 7 in front.
  useTabStore.getState().handleTabsChanged(served(7, 1))
  noteTabActivation(false)
  requested.mockReset()
  stopListening = onComposerFocusRequest(requested)
})

afterEach(() => {
  stopListening()
  noteTabActivation(false)
})

describe("who moved the tab in front", () => {
  it("another client's snapshot is remote: its composer is not handed the keyboard", () => {
    useTabStore.getState().handleTabsChanged(served(8, 2))
    expect(useTabStore.getState().activeTabId).toBe(TAB_8)
    expect(isRemoteActivation()).toBe(true)
  })

  it("a switch made here is the user's", () => {
    useTabStore.getState().handleTabsChanged(served(8, 2))
    useTabStore.getState().switchTab(TAB_7)
    expect(useTabStore.getState().activeTabId).toBe(TAB_7)
    expect(isRemoteActivation()).toBe(false)
  })

  it("so is opening a conversation here", () => {
    useTabStore.getState().handleTabsChanged(served(8, 2))
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    expect(isRemoteActivation()).toBe(false)
  })

  it("a snapshot that leaves the tab in front alone changes nothing", () => {
    useTabStore.getState().switchTab(TAB_8)
    useTabStore.getState().handleTabsChanged(served(8, 2))
    expect(isRemoteActivation()).toBe(false)
  })
})

describe("asking again for the tab in front", () => {
  it("asks its composer for the keyboard: no tab change will", () => {
    useTabStore.getState().switchTab(TAB_7)
    expect(requested).toHaveBeenCalledTimes(1)

    // A sidebar row, a search pick, a notification: all open the tab.
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    expect(requested).toHaveBeenCalledTimes(2)
  })

  it("asks before the store writes, while the composer in front is the one asked for", () => {
    requested.mockImplementation(() => {
      expect(useTabStore.getState().activeTabId).toBe(TAB_7)
    })
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    expect(requested).toHaveBeenCalledTimes(1)
  })

  it("does not ask on a real switch, which hands the keyboard over itself", () => {
    useTabStore.getState().switchTab(TAB_8)
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    expect(requested).not.toHaveBeenCalled()
  })

  it("asks when New conversation lands on the draft already in front", () => {
    const { tabId } = useTabStore
      .getState()
      .openNewConversationTab(1, "/work/app")
    expect(useTabStore.getState().activeTabId).toBe(tabId)
    expect(requested).not.toHaveBeenCalled()

    useTabStore.getState().openNewConversationTab(1, "/work/app")
    expect(useTabStore.getState().activeTabId).toBe(tabId)
    expect(requested).toHaveBeenCalledTimes(1)
  })
})
