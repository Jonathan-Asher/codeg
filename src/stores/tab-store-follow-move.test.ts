import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"
import type {
  DbConversationSummary,
  FolderDetail,
  OpenedTab,
} from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(async () => ({ accepted: true, version: 1, tabs: [] })),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const AT = new Date(1_700_000_000_000).toISOString()
const app = { id: 1, name: "app", path: "/work/app" } as unknown as FolderDetail
const site = {
  id: 2,
  name: "site",
  path: "/work/site",
} as unknown as FolderDetail

function conv(folderId: number): DbConversationSummary {
  return {
    id: 7,
    folder_id: folderId,
    title: "Topic",
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: "session-S1",
    message_count: 0,
    child_count: 0,
    created_at: AT,
    updated_at: AT,
    pinned_at: null,
  }
}

/** The tab set the server broadcasts once it re-filed the moved tab. */
function refiled(version: number): {
  version: number
  origin: string
  tabs: OpenedTab[]
} {
  return {
    version,
    origin: "server",
    tabs: [
      {
        id: 11,
        folder_id: 2,
        conversation_id: 7,
        agent_type: "claude_code",
        position: 0,
        is_active: true,
        is_pinned: true,
      },
    ],
  }
}

beforeEach(() => {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [app, site],
    allFolders: [app, site],
    conversations: [conv(1)],
  })
  resetTabStore()
  useTabStore.setState({
    rawTabs: [
      {
        id: "conv-1-claude_code-7",
        kind: "conversation",
        folderId: 1,
        conversationId: 7,
        agentType: "claude_code",
        title: "Topic",
        isPinned: true,
        workingDir: "/work/app",
      },
    ],
    activeTabId: "conv-1-claude_code-7",
    tabsHydrated: true,
  })
  // The client is in sync with the server: its tab is the persisted one.
  useTabStore.getState().handleTabsChanged({
    version: 1,
    origin: "server",
    tabs: [{ ...refiled(1).tabs[0], folder_id: 1 }],
  })
})

describe("an open tab follows its conversation to another project", () => {
  it("keeps the same tab and rewrites its folder when the row moves", () => {
    useAppWorkspaceStore.setState({ conversations: [conv(2)] })
    const { rawTabs, activeTabId } = useTabStore.getState()
    expect(rawTabs).toHaveLength(1)
    expect(rawTabs[0]).toMatchObject({
      id: "conv-1-claude_code-7",
      folderId: 2,
      conversationId: 7,
    })
    // It connects where the row says the session runs from now on.
    expect(rawTabs[0].workingDir).toBeUndefined()
    expect(activeTabId).toBe("conv-1-claude_code-7")

    // The server's re-filed tab set then lands on the same tab: no second one.
    useTabStore.getState().handleTabsChanged(refiled(5))
    const after = useTabStore.getState()
    expect(after.rawTabs).toHaveLength(1)
    expect(after.rawTabs[0].id).toBe("conv-1-claude_code-7")
    expect(after.rawTabs[0].folderId).toBe(2)
    expect(after.activeTabId).toBe("conv-1-claude_code-7")
  })

  it("still ends with one tab when the re-filed set lands first", () => {
    useTabStore.getState().handleTabsChanged(refiled(5))
    useAppWorkspaceStore.setState({ conversations: [conv(2)] })
    const { rawTabs, activeTabId } = useTabStore.getState()
    expect(rawTabs).toHaveLength(1)
    expect(rawTabs[0]).toMatchObject({ folderId: 2, conversationId: 7 })
    expect(activeTabId).toBe(rawTabs[0].id)
  })

  it("leaves a chat tab and a tab whose row did not move alone", () => {
    useTabStore.setState({
      rawTabs: [
        {
          id: "conv-9-claude_code-7",
          kind: "conversation",
          folderId: 9,
          conversationId: 7,
          agentType: "claude_code",
          title: "Topic",
          isPinned: true,
          isChat: true,
          workingDir: "/chat/scratch",
        },
      ],
    })
    useAppWorkspaceStore.setState({ conversations: [conv(2)] })
    expect(useTabStore.getState().rawTabs[0]).toMatchObject({
      folderId: 9,
      workingDir: "/chat/scratch",
    })
  })
})
