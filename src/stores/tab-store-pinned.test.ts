import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as api from "@/lib/api"
import {
  popClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import {
  isDraftTab,
  isPreviewTab,
  resetTabStore,
  useTabStore,
  type TabItemInternal,
} from "./tab-store"
import type { FolderDetail, OpenedTab } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(async () => ({ accepted: true, version: 2, tabs: [] })),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const folder = {
  id: 1,
  name: "repo",
  path: "/repo",
} as unknown as FolderDetail

const id = (conversationId: number) => `conv-1-claude_code-${conversationId}`

function conversationTab(
  conversationId: number,
  over: Partial<TabItemInternal> = {}
): TabItemInternal {
  return {
    id: id(conversationId),
    kind: "conversation",
    folderId: 1,
    conversationId,
    agentType: "claude_code",
    title: `Session ${conversationId}`,
    isPinned: true,
    ...over,
  }
}

const pinned = (conversationId: number, over: Partial<TabItemInternal> = {}) =>
  conversationTab(conversationId, { isAnchored: true, ...over })

function seed(tabs: TabItemInternal[], activeTabId = tabs[0].id) {
  useTabStore.setState({ rawTabs: tabs, activeTabId, tabsHydrated: true })
}

const ids = () => useTabStore.getState().rawTabs.map((t) => t.id)
const tab = (tabId: string) =>
  useTabStore.getState().rawTabs.find((t) => t.id === tabId)
const store = () => useTabStore.getState()

function opened(conversationId: number, over: Partial<OpenedTab> = {}) {
  return {
    id: conversationId,
    folder_id: 1,
    conversation_id: conversationId,
    agent_type: "claude_code",
    position: 0,
    is_active: false,
    is_pinned: true,
    ...over,
  } as OpenedTab
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
  localStorage.clear()
  vi.mocked(api.saveOpenedTabs).mockClear()
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    conversationsLoading: false,
  })
})

afterEach(() => {
  resetClosedTabStackForTests()
})

describe("Pin tab", () => {
  it("puts the tab after the pinned ones and keeps it open", () => {
    seed([
      pinned(1),
      conversationTab(2),
      conversationTab(3, { isPinned: false }),
    ])
    store().setTabAnchored(id(3), true)
    expect(ids()).toEqual([id(1), id(3), id(2)])
    expect(tab(id(3))).toMatchObject({ isAnchored: true, isPinned: true })
    expect(isPreviewTab(tab(id(3))!)).toBe(false)
  })

  it("puts the first pinned tab at the very start", () => {
    seed([conversationTab(1), conversationTab(2), conversationTab(3)])
    store().setTabAnchored(id(3), true)
    expect(ids()).toEqual([id(3), id(1), id(2)])
  })

  it("makes an unpinned tab the first of the rest", () => {
    seed([pinned(3), pinned(1), conversationTab(2)])
    store().setTabAnchored(id(1), false)
    expect(ids()).toEqual([id(3), id(1), id(2)])
    expect(tab(id(1))!.isAnchored).toBe(false)
    // Still a kept tab, not a preview.
    expect(tab(id(1))!.isPinned).toBe(true)
  })

  it("makes it the first of the rest even when the pinned tabs are scattered", () => {
    // Another client may have saved the manual order with pinned tabs anywhere.
    seed([conversationTab(1), pinned(2), conversationTab(3), pinned(4)])
    store().setTabAnchored(id(4), false)
    expect(ids()).toEqual([id(4), id(1), id(2), id(3)])
  })

  it("does nothing when the tab already is (or is not) pinned", () => {
    seed([pinned(1), conversationTab(2)])
    const before = store().rawTabs
    store().setTabAnchored(id(1), true)
    store().setTabAnchored(id(2), false)
    store().setTabAnchored("missing", true)
    expect(store().rawTabs).toBe(before)
  })
})

describe("close commands skip pinned tabs", () => {
  it("Close Others keeps the pinned tabs", () => {
    seed([pinned(1), conversationTab(2), conversationTab(3), pinned(4)])
    store().closeOtherTabs(id(3))
    expect(ids()).toEqual([id(1), id(3), id(4)])
    expect(store().activeTabId).toBe(id(3))
  })

  it("Close to the Right closes the unpinned tabs after it, in shown order", () => {
    // Shown: 1 (pinned), 4 (pinned), 2, 3, 5 — the strip's order, not rawTabs'.
    seed(
      [
        pinned(1),
        conversationTab(2),
        conversationTab(3),
        pinned(4),
        conversationTab(5),
      ],
      id(5)
    )
    const shown = [id(1), id(4), id(2), id(3), id(5)]
    store().closeTabsToRight(id(2), shown)
    expect(ids()).toEqual([id(1), id(2), id(4)])
    // The tab in front went: the one the menu was opened on takes over.
    expect(store().activeTabId).toBe(id(2))
    // Recorded for reopen.
    expect(popClosedTab()).toMatchObject({ key: id(5) })
    expect(popClosedTab()).toMatchObject({ key: id(3) })
  })

  it("Close to the Right from a pinned tab spares every pinned tab", () => {
    seed([pinned(1), pinned(2), conversationTab(3)], id(2))
    store().closeTabsToRight(id(1), [id(1), id(2), id(3)])
    expect(ids()).toEqual([id(1), id(2)])
    expect(store().activeTabId).toBe(id(2))
  })

  it("Close All keeps the pinned tabs, with no replacement draft", () => {
    seed([conversationTab(1), pinned(2), conversationTab(3), pinned(4)], id(3))
    store().closeAllTabs()
    expect(ids()).toEqual([id(2), id(4)])
    expect(store().rawTabs.some(isDraftTab)).toBe(false)
    // The tab in front closed: the first pinned tab takes over.
    expect(store().activeTabId).toBe(id(2))
  })

  it("Close All keeps the pinned tab in front", () => {
    seed([conversationTab(1), pinned(2), pinned(4)], id(4))
    store().closeAllTabs()
    expect(ids()).toEqual([id(2), id(4)])
    expect(store().activeTabId).toBe(id(4))
  })

  it("Close All with nothing pinned still leaves a fresh draft", () => {
    seed([conversationTab(1), conversationTab(2)])
    store().closeAllTabs()
    expect(store().rawTabs).toHaveLength(1)
    expect(isDraftTab(store().rawTabs[0])).toBe(true)
  })

  it("a plain close (the close shortcut) still closes a pinned tab", () => {
    seed([pinned(1), conversationTab(2)])
    store().closeTab(id(1))
    expect(ids()).toEqual([id(2)])
    expect(store().activeTabId).toBe(id(2))
  })
})

describe("preview replacement never replaces a pinned tab", () => {
  it("opens beside a pinned tab even when it carries no keep-open flag", () => {
    // A pinned tab as a client that predates the pin flag's keep-open rule
    // could have synced it.
    seed([pinned(1, { isPinned: false })])
    store().openTab(1, 2, "claude_code", false)
    expect(ids()).toEqual([id(1), id(2)])
  })

  it("pinning the preview keeps it from the next one", () => {
    seed([conversationTab(1)])
    store().openTab(1, 2, "claude_code", false)
    expect(tab(id(2))!.isPinned).toBe(false)
    store().setTabAnchored(id(2), true)
    store().openTab(1, 3, "claude_code", false)
    expect(ids()).toEqual([id(2), id(1), id(3)])
    // …and the new preview is still replaced as before.
    store().openTab(1, 4, "claude_code", false)
    expect(ids()).toEqual([id(2), id(1), id(4)])
  })

  it("a sub-agent preview does not take a pinned tab's place", () => {
    seed([conversationTab(7), pinned(8, { isPinned: false })])
    const sub = store().openSubagentTab({
      parentConversationId: 7,
      toolCallId: "toolu_a",
    })
    expect(ids()).toEqual([id(7), sub, id(8)])
  })
})

describe("pins survive a restart", () => {
  async function hydrateFrom(items: OpenedTab[]) {
    resetTabStore()
    vi.mocked(api.listOpenedTabs).mockResolvedValue({
      version: 1,
      items,
    } as never)
    store().hydrate()
    await vi.waitFor(() => expect(store().tabsHydrated).toBe(true))
  }

  it("restores a synced pin, and saves one made here", async () => {
    await hydrateFrom([
      opened(7, { is_anchored: true, is_active: true }),
      opened(8, { position: 1 }),
    ])
    expect(tab(id(7))!.isAnchored).toBe(true)
    expect(tab(id(8))!.isAnchored).toBeFalsy()

    store().setTabAnchored(id(8), true)
    store().runSaveEffect()
    await vi.waitFor(() => expect(api.saveOpenedTabs).toHaveBeenCalled(), {
      timeout: 2000,
    })
    const saves = vi.mocked(api.saveOpenedTabs).mock.calls
    const [items] = saves[saves.length - 1]
    expect(
      items.map((it) => [it.conversation_id, it.is_anchored, it.is_pinned])
    ).toEqual([
      [7, true, true],
      [8, true, true],
    ])

    // What was saved comes back pinned.
    await hydrateFrom(items)
    expect(tab(id(7))!.isAnchored).toBe(true)
    expect(tab(id(8))!.isAnchored).toBe(true)
  })

  it("a server that predates pins restores the tab unpinned", async () => {
    await hydrateFrom([opened(7)])
    expect(tab(id(7))!.isAnchored).toBeFalsy()
  })

  it("follows a pin made on another client", async () => {
    await hydrateFrom([opened(7), opened(8, { position: 1 })])
    store().handleTabsChanged({
      version: 5,
      origin: "another-window",
      tabs: [opened(7), opened(8, { position: 1, is_anchored: true })],
    })
    expect(tab(id(8))!.isAnchored).toBe(true)
    store().handleTabsChanged({
      version: 6,
      origin: "another-window",
      tabs: [opened(7), opened(8, { position: 1 })],
    })
    expect(tab(id(8))!.isAnchored).toBeFalsy()
  })

  it("keeps a pinned draft and a pinned sub-agent tab, which live on this device", async () => {
    await hydrateFrom([opened(7, { is_active: true })])
    const draft = store().openNewConversationTab(1, "/repo").tabId
    store().setTabAnchored(draft, true)
    const sub = store().openSubagentTab(
      { parentConversationId: 7, toolCallId: "toolu_a" },
      { pin: true }
    )
    store().setTabAnchored(sub, true)
    const blob = JSON.parse(localStorage.getItem("workspace:tab-groups:v1")!)
    expect(blob.drafts).toEqual([
      expect.objectContaining({ id: draft, anchored: true }),
    ])
    expect(blob.subagents).toEqual([
      expect.objectContaining({ id: sub, anchored: true }),
    ])

    await hydrateFrom([opened(7, { is_active: true })])
    expect(tab(draft)).toMatchObject({ isAnchored: true, isPinned: true })
    expect(tab(sub)).toMatchObject({
      kind: "subagent",
      isAnchored: true,
      isPinned: true,
    })
  })
})
