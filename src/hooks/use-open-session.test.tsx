import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  popClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import {
  buildConversationDraftStorageKey,
  clearMessageInputDraftV2,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"
import {
  resetOpenMessageEditsForTests,
  setOpenMessageEdit,
} from "@/lib/open-message-edits"
import {
  noteTabSend,
  resetTabSendRecencyForTests,
} from "@/lib/tab-send-recency"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useConversationAttentionStore } from "@/stores/conversation-attention-store"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import {
  groupOfTab,
  resetTabStore,
  useTabStore,
  type TabItemInternal,
} from "@/stores/tab-store"
import { useOpenSession } from "./use-open-session"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const folder = { id: 1, name: "repo", path: "/repo" } as unknown as FolderDetail

const id = (conversationId: number) => `conv-1-claude_code-${conversationId}`

function sessionTab(
  conversationId: number,
  over: Partial<TabItemInternal> = {}
): TabItemInternal {
  return {
    id: id(conversationId),
    kind: "conversation",
    folderId: 1,
    conversationId,
    agentType: "claude_code",
    title: `t${conversationId}`,
    isPinned: true,
    ...over,
  }
}

function summary(
  conversationId: number,
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: conversationId,
    folder_id: 1,
    title: `t${conversationId}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 2,
    child_count: 0,
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    pinned_at: null,
    turn_state: null,
    ...over,
  } as DbConversationSummary
}

function seed(tabs: TabItemInternal[], activeTabId: string) {
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    conversations: [1, 2, 3, 9].map((n) => summary(n)),
  })
  useTabStore.setState({ rawTabs: tabs, activeTabId })
}

const ids = () => useTabStore.getState().rawTabs.map((tab) => tab.id)
const active = () => useTabStore.getState().activeTabId

function open(
  conversationId: number,
  options: Parameters<ReturnType<typeof useOpenSession>>[1]
) {
  const { result } = renderHook(() => useOpenSession())
  let decision: ReturnType<ReturnType<typeof useOpenSession>> | undefined
  act(() => {
    decision = result.current(
      { id: conversationId, folderId: 1, agentType: "claude_code" },
      options
    )
  })
  return decision!
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
  resetTabSendRecencyForTests()
  resetOpenMessageEditsForTests()
  useConversationAttentionStore.setState({ byConversationId: new Map() })
  useTabArrangeStore.setState({ hydrated: true, sessionOpenMode: "smart" })
  window.localStorage.clear()
})

afterEach(() => {
  clearMessageInputDraftV2(buildConversationDraftStorageKey(1))
})

describe("useOpenSession: the tab in front is only being looked at", () => {
  it("loads the session into that tab, in its slot", () => {
    seed([sessionTab(9), sessionTab(1), sessionTab(3)], id(1))
    expect(open(2, { source: "sidebar" })).toEqual({
      action: "replace",
      tabId: id(1),
    })
    expect(ids()).toEqual([id(9), id(2), id(3)])
    expect(active()).toBe(id(2))
  })

  it("puts the replaced session on the reopen stack, at its slot", () => {
    seed([sessionTab(9), sessionTab(1)], id(1))
    open(2, { source: "switcher" })
    const closed = popClosedTab()
    expect(closed).toMatchObject({
      kind: "conversation",
      conversationId: 1,
      index: 1,
    })
  })

  it("hands the replaced tab to the idle-only release, never a stop", () => {
    seed([sessionTab(1)], id(1))
    open(2, { source: "sidebar" })
    expect(useTabStore.getState().previewReplacedTabIds).toContain(id(1))
  })

  it("keeps a sidebar preview a preview, and a switcher pick a kept tab", () => {
    seed([sessionTab(1, { isPinned: false })], id(1))
    open(2, { source: "sidebar" })
    expect(useTabStore.getState().rawTabs[0].isPinned).toBe(false)
    open(3, { source: "switcher" })
    expect(useTabStore.getState().rawTabs[0]).toMatchObject({
      conversationId: 3,
      isPinned: true,
    })
  })

  it("stays in the tab's split group", () => {
    seed([sessionTab(9), sessionTab(1)], id(1))
    act(() => useTabStore.getState().splitTab(id(1), "right", { move: true }))
    const st = useTabStore.getState()
    const group = groupOfTab(st.groupOf, st.groupLayout, id(1))
    open(2, { source: "sidebar" })
    const after = useTabStore.getState()
    expect(groupOfTab(after.groupOf, after.groupLayout, id(2))).toBe(group)
  })
})

describe("useOpenSession: the tab in front is in use", () => {
  function expectNotReplaced() {
    expect(ids()).toContain(id(1))
    expect(ids()).toContain(id(2))
  }

  it("opens beside a tab whose turn is running", () => {
    seed([sessionTab(1)], id(1))
    useAppWorkspaceStore.setState({
      conversations: [summary(1, { turn_state: "running" }), summary(2)],
    })
    expect(open(2, { source: "sidebar" })).toEqual({ action: "default" })
    expectNotReplaced()
    // As before: the sidebar opens a preview.
    expect(
      useTabStore.getState().rawTabs.find((t) => t.id === id(2))?.isPinned
    ).toBe(false)
  })

  it("opens beside a tab waiting on him", () => {
    seed([sessionTab(1)], id(1))
    useConversationAttentionStore.setState({
      byConversationId: new Map([[1, "permission"]]),
    })
    expect(open(2, { source: "switcher" })).toEqual({ action: "default" })
    expectNotReplaced()
  })

  it("opens beside a tab with text in its composer", () => {
    seed([sessionTab(1)], id(1))
    saveMessageInputDraft(buildConversationDraftStorageKey(1), "half a thought")
    expect(open(2, { source: "switcher" })).toEqual({ action: "default" })
    expectNotReplaced()
  })

  it("opens beside a tab with an earlier message open in its editor", () => {
    seed([sessionTab(1)], id(1))
    setOpenMessageEdit(id(1), "list", true)
    expect(open(2, { source: "switcher" })).toEqual({ action: "default" })
    expectNotReplaced()
  })

  it("opens beside a tab he sent a message from a minute ago", () => {
    seed([sessionTab(1)], id(1))
    noteTabSend(id(1), Date.now() - 60_000)
    expect(open(2, { source: "switcher" })).toEqual({ action: "default" })
    expectNotReplaced()
  })

  it("opens beside a pinned tab", () => {
    seed([sessionTab(1, { isAnchored: true })], id(1))
    expect(open(2, { source: "switcher" })).toEqual({ action: "default" })
    expectNotReplaced()
  })
})

describe("useOpenSession: asked for one or the other", () => {
  it("switches to a session that is open already", () => {
    seed([sessionTab(1), sessionTab(2)], id(1))
    expect(open(2, { source: "switcher", intent: "replace" })).toEqual({
      action: "switch",
      tabId: id(2),
    })
    expect(ids()).toEqual([id(1), id(2)])
    expect(active()).toBe(id(2))
  })

  it("opens a kept tab of its own on ⌘", () => {
    seed([sessionTab(1, { isPinned: false })], id(1))
    expect(open(2, { source: "sidebar", intent: "new_tab" })).toEqual({
      action: "new_tab",
    })
    // Not the preview replacement a plain click would do.
    expect(ids()).toEqual([id(1), id(2)])
    expect(useTabStore.getState().rawTabs[1].isPinned).toBe(true)
  })

  it("replaces a busy tab on ⌥ and leaves its turn running", () => {
    seed([sessionTab(1)], id(1))
    useAppWorkspaceStore.setState({
      conversations: [summary(1, { turn_state: "running" }), summary(2)],
    })
    expect(open(2, { source: "switcher", intent: "replace" })).toEqual({
      action: "replace",
      tabId: id(1),
    })
    expect(ids()).toEqual([id(2)])
    expect(useTabStore.getState().previewReplacedTabIds).toContain(id(1))
  })

  it("never replaces a pinned tab: a new tab opens instead", () => {
    seed([sessionTab(1, { isAnchored: true })], id(1))
    expect(open(2, { source: "switcher", intent: "replace" })).toEqual({
      action: "new_tab",
    })
    expect(ids()).toEqual([id(1), id(2)])
    expect(useTabStore.getState().rawTabs[0].isAnchored).toBe(true)
  })

  it("never drops a message being edited: ⌥ opens a new tab instead", () => {
    seed([sessionTab(1)], id(1))
    setOpenMessageEdit(id(1), "list", true)
    expect(open(2, { source: "sidebar", intent: "replace" })).toEqual({
      action: "new_tab",
    })
    expect(ids()).toEqual([id(1), id(2)])
  })

  it("follows the setting: Always a new tab opens as before", () => {
    useTabArrangeStore.setState({ sessionOpenMode: "new_tab" })
    seed([sessionTab(1)], id(1))
    expect(open(2, { source: "switcher" })).toEqual({ action: "default" })
    expect(ids()).toEqual([id(1), id(2)])
  })

  it("follows the setting: Replace the current tab replaces a busy one too", () => {
    useTabArrangeStore.setState({ sessionOpenMode: "replace" })
    seed([sessionTab(1)], id(1))
    noteTabSend(id(1))
    expect(open(2, { source: "sidebar" })).toEqual({
      action: "replace",
      tabId: id(1),
    })
    expect(ids()).toEqual([id(2)])
  })
})

describe("replaceTabWithConversation: a message being edited", () => {
  it("is never replaced, asked directly: the session opens as usual", () => {
    seed([sessionTab(1)], id(1))
    setOpenMessageEdit(id(1), "list", true)
    act(() =>
      useTabStore
        .getState()
        .replaceTabWithConversation(id(1), 1, 2, "claude_code", { pin: true })
    )
    expect(ids()).toEqual([id(1), id(2)])
    expect(popClosedTab()).toBeNull()
  })

  it("can be replaced again once its editor has closed", () => {
    seed([sessionTab(1)], id(1))
    setOpenMessageEdit(id(1), "list", true)
    setOpenMessageEdit(id(1), "list", false)
    expect(open(2, { source: "sidebar" })).toEqual({
      action: "replace",
      tabId: id(1),
    })
  })
})

describe("⌘⇧T after a replacement", () => {
  it("brings a replaced preview back beside the session that took its slot", () => {
    seed([sessionTab(9), sessionTab(1, { isPinned: false })], id(1))
    open(2, { source: "sidebar" })
    expect(ids()).toEqual([id(9), id(2)])
    const closed = popClosedTab()
    // Kept: as a preview it would take the preview slot the new one holds.
    expect(closed).toMatchObject({ conversationId: 1, isPinned: true })
    if (closed?.kind !== "conversation") throw new Error("no conversation")
    act(() =>
      useTabStore
        .getState()
        .openTab(
          closed.folderId,
          closed.conversationId!,
          closed.agentType,
          closed.isPinned,
          closed.title,
          { index: closed.index }
        )
    )
    expect(ids()).toEqual([id(9), id(1), id(2)])
    expect(
      useTabStore.getState().rawTabs.find((t) => t.id === id(2))?.isPinned
    ).toBe(false)
  })
})
