import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as api from "@/lib/api"
import {
  peekClosedTab,
  popClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import {
  isDraftTab,
  isSubagentTab,
  makeSubagentTabId,
  resetTabStore,
  useTabStore,
  type SubagentTabTarget,
  type TabItemInternal,
} from "./tab-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(async () => ({ accepted: true, version: 2, tabs: [] })),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const AT = new Date(1_700_000_000_000).toISOString()
const folder = {
  id: 1,
  name: "repo",
  path: "/repo",
} as unknown as FolderDetail

function conv(id: number, title: string): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: `session-${id}`,
    message_count: 0,
    child_count: 0,
    created_at: AT,
    updated_at: AT,
    pinned_at: null,
  }
}

function conversationTab(
  conversationId: number,
  isPinned: boolean
): TabItemInternal {
  return {
    id: `conv-1-claude_code-${conversationId}`,
    kind: "conversation",
    folderId: 1,
    conversationId,
    agentType: "claude_code",
    title: `Session ${conversationId}`,
    isPinned,
  }
}

const target = (toolCallId: string, extra = {}): SubagentTabTarget => ({
  parentConversationId: 7,
  toolCallId,
  subagentType: "Explore",
  description: `Look into ${toolCallId}`,
  ...extra,
})

const ids = () => useTabStore.getState().rawTabs.map((t) => t.id)
const tab = (id: string) =>
  useTabStore.getState().rawTabs.find((t) => t.id === id)

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
  localStorage.clear()
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    conversations: [conv(7, "Parent"), conv(8, "Other")],
    conversationsLoading: false,
  })
  useTabStore.setState({
    rawTabs: [conversationTab(7, true), conversationTab(8, true)],
    activeTabId: "conv-1-claude_code-7",
    tabsHydrated: true,
  })
})

afterEach(() => {
  resetClosedTabStackForTests()
})

describe("a sub-agent tab", () => {
  it("opens as a preview right after its parent's tab, and focuses", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    expect(id).toBe(makeSubagentTabId(7, "toolu_a"))
    expect(ids()).toEqual(["conv-1-claude_code-7", id, "conv-1-claude_code-8"])
    const opened = tab(id)!
    expect(opened).toMatchObject({
      kind: "subagent",
      conversationId: null,
      folderId: 1,
      agentType: "claude_code",
      isPinned: false,
      title: "Look into toolu_a",
    })
    expect(isSubagentTab(opened)).toBe(true)
    expect(isDraftTab(opened)).toBe(false)
    expect(useTabStore.getState().activeTabId).toBe(id)
  })

  it("is replaced by the next preview, which takes its place beside the parent", () => {
    const first = useTabStore.getState().openSubagentTab(target("toolu_a"))
    const second = useTabStore.getState().openSubagentTab(target("toolu_b"))
    expect(ids()).toEqual([
      "conv-1-claude_code-7",
      second,
      "conv-1-claude_code-8",
    ])
    expect(useTabStore.getState().previewReplacedTabIds).toContain(first)
  })

  it("stays once pinned: the next one opens beside it", () => {
    const first = useTabStore.getState().openSubagentTab(target("toolu_a"))
    useTabStore.getState().pinTab(first)
    const second = useTabStore.getState().openSubagentTab(target("toolu_b"))
    expect(tab(first)?.isPinned).toBe(true)
    expect(ids()).toEqual([
      "conv-1-claude_code-7",
      second,
      first,
      "conv-1-claude_code-8",
    ])
  })

  it("focuses the tab already open for the same call, keeping what it learned", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    useTabStore.getState().switchTab("conv-1-claude_code-8")
    useTabStore
      .getState()
      .openSubagentTab(target("toolu_a", { agentId: "a1b2c3d4" }))
    expect(ids().filter((t) => t === id)).toHaveLength(1)
    expect(useTabStore.getState().activeTabId).toBe(id)
    expect(tab(id)?.subagent?.agentId).toBe("a1b2c3d4")
  })

  it("never replaces a parent that is itself the group's preview", () => {
    useTabStore.setState({
      rawTabs: [conversationTab(7, false), conversationTab(8, true)],
    })
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    expect(ids()).toEqual(["conv-1-claude_code-7", id, "conv-1-claude_code-8"])
    expect(tab("conv-1-claude_code-7")?.isPinned).toBe(true)
  })

  it("replaces another conversation's preview in the group", () => {
    useTabStore.setState({
      rawTabs: [conversationTab(7, true), conversationTab(8, false)],
    })
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    expect(ids()).toEqual(["conv-1-claude_code-7", id])
    expect(useTabStore.getState().previewReplacedTabIds).toContain(
      "conv-1-claude_code-8"
    )
  })

  it("is no draft: a new conversation gets a draft of its own", () => {
    useTabStore.getState().openSubagentTab(target("toolu_a"), { pin: true })
    const { tabId } = useTabStore.getState().openNewConversationTab(1, "/repo")
    expect(tab(tabId)).toMatchObject({
      kind: "conversation",
      conversationId: null,
    })
    expect(
      useTabStore.getState().rawTabs.filter((t) => t.kind === "subagent")
    ).toHaveLength(1)
  })

  it("is recorded for reopen and comes back on the same call", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    useTabStore.getState().closeTab(id)
    expect(tab(id)).toBeUndefined()
    const closed = peekClosedTab()
    expect(closed).toMatchObject({
      kind: "subagent",
      key: id,
      index: 1,
      target: { parentConversationId: 7, toolCallId: "toolu_a" },
    })
    popClosedTab()
    if (closed?.kind !== "subagent") throw new Error("not a sub-agent entry")
    useTabStore.getState().openSubagentTab(closed.target, {
      pin: closed.isPinned,
      title: closed.title,
      index: closed.index,
    })
    expect(ids()).toEqual(["conv-1-claude_code-7", id, "conv-1-claude_code-8"])
  })

  it("closes with its parent when the conversation is deleted", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    useTabStore.getState().closeConversationTab(1, 7, "claude_code")
    expect(tab(id)).toBeUndefined()
    expect(tab("conv-1-claude_code-7")).toBeUndefined()
    expect(peekClosedTab()).toBeNull()
  })

  it("can move to another group, unlike a draft", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    useTabStore.getState().splitTab(id, "right", { move: true })
    const st = useTabStore.getState()
    expect(st.groupLayout.type).toBe("split")
    expect(st.groupOf[id]).toBeDefined()
    expect(st.groupOf[id]).not.toBe(st.groupOf["conv-1-claude_code-7"])
  })

  it("learns its sub-agent's id, title and state from its reads", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"))
    useTabStore.getState().updateSubagentTab(id, {
      agentId: "a1b2c3d4",
      title: "Find the bug",
      status: "in_progress",
    })
    expect(tab(id)).toMatchObject({
      title: "Find the bug",
      status: "in_progress",
      subagent: { agentId: "a1b2c3d4", toolCallId: "toolu_a" },
    })
    const before = useTabStore.getState().rawTabs
    useTabStore.getState().updateSubagentTab(id, { agentId: "a1b2c3d4" })
    expect(useTabStore.getState().rawTabs).toBe(before)
  })

  it("never reaches the synced tab set", async () => {
    vi.mocked(api.saveOpenedTabs).mockClear()
    useTabStore.getState().openSubagentTab(target("toolu_a"), { pin: true })
    useTabStore.getState().runSaveEffect()
    await vi.waitFor(() => expect(api.saveOpenedTabs).toHaveBeenCalled(), {
      timeout: 2000,
    })
    const saves = vi.mocked(api.saveOpenedTabs).mock.calls
    const [items] = saves[saves.length - 1]
    expect(items.map((item) => item.conversation_id)).toEqual([7, 8])
  })

  it("survives a remote snapshot, right after the tab it followed", () => {
    const id = useTabStore.getState().openSubagentTab(target("toolu_a"), {
      pin: true,
    })
    useTabStore.getState().handleTabsChanged({
      version: 5,
      origin: "another-window",
      tabs: [7, 8].map((conversationId, position) => ({
        id: position,
        folder_id: 1,
        conversation_id: conversationId,
        agent_type: "claude_code",
        position,
        is_active: false,
        is_pinned: true,
      })),
    })
    expect(ids()).toEqual(["conv-1-claude_code-7", id, "conv-1-claude_code-8"])
  })
})

describe("a sub-agent tab across a restart", () => {
  function serverTabs() {
    vi.mocked(api.listOpenedTabs).mockResolvedValue({
      version: 1,
      items: [7, 8].map((conversationId, position) => ({
        id: position,
        folder_id: 1,
        conversation_id: conversationId,
        agent_type: "claude_code",
        position,
        is_active: position === 0,
        is_pinned: true,
      })),
    } as never)
  }

  async function start() {
    resetTabStore()
    serverTabs()
    useTabStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
  }

  it("comes back when pinned, and not as a preview", async () => {
    await start()
    const pinned = useTabStore
      .getState()
      .openSubagentTab(target("toolu_a", { agentId: "a1b2c3d4" }), {
        pin: true,
      })
    const preview = useTabStore.getState().openSubagentTab(target("toolu_b"))
    expect(ids()).toEqual([
      "conv-1-claude_code-7",
      preview,
      pinned,
      "conv-1-claude_code-8",
    ])
    useTabStore.getState().switchTab(pinned)

    await start()
    expect(ids()).toEqual([
      "conv-1-claude_code-7",
      pinned,
      "conv-1-claude_code-8",
    ])
    expect(tab(pinned)).toMatchObject({
      kind: "subagent",
      isPinned: true,
      title: "Look into toolu_a",
      subagent: {
        parentConversationId: 7,
        toolCallId: "toolu_a",
        agentId: "a1b2c3d4",
        subagentType: "Explore",
      },
    })
    // It was the tab in front when the app closed: it is again.
    expect(useTabStore.getState().activeTabId).toBe(pinned)
  })
})
