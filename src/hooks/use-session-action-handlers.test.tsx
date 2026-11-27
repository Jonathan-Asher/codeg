import type { ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { saveShowWorktrees } from "@/lib/sidebar-view-mode-storage"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

const h = vi.hoisted(() => ({ openConversationManager: vi.fn() }))
vi.mock("@/components/conversations/conversation-manage-host", () => ({
  openConversationManager: h.openConversationManager,
}))

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

import {
  listedUnderFolderId,
  useSessionActionHandlers,
} from "./use-session-action-handlers"

const repo = { id: 1, parent_id: null } as FolderDetail
const worktree = { id: 2, parent_id: 1 } as FolderDetail
const orphan = { id: 3, parent_id: 99 } as FolderDetail

describe("listedUnderFolderId", () => {
  it("is the session's own folder while worktrees show on their own", () => {
    expect(listedUnderFolderId(2, [repo, worktree], true)).toBe(2)
  })

  it("is the repo a worktree's sessions are merged into otherwise", () => {
    expect(listedUnderFolderId(2, [repo, worktree], false)).toBe(1)
  })

  it("stays the worktree when its repo is not open", () => {
    expect(listedUnderFolderId(3, [repo, orphan], false)).toBe(3)
    expect(listedUnderFolderId(2, [worktree], false)).toBe(2)
  })

  it("is a repo's own folder", () => {
    expect(listedUnderFolderId(1, [repo, worktree], false)).toBe(1)
  })
})

describe("useSessionActionHandlers: Manage conversations", () => {
  const session = { id: 7, folder_id: 2 } as DbConversationSummary

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {children}
      </NextIntlClientProvider>
    )
  }

  beforeEach(() => {
    window.localStorage.clear()
    h.openConversationManager.mockReset()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      folders: [repo, worktree],
      allFolders: [repo, worktree],
    })
  })

  it("opens on the repo the sidebar lists a worktree session under", () => {
    saveShowWorktrees(false)
    const { result } = renderHook(() => useSessionActionHandlers(), {
      wrapper,
    })
    result.current.onManageConversations(session)
    expect(h.openConversationManager).toHaveBeenCalledWith(1)
  })

  it("opens on the worktree itself while the sidebar shows worktrees", () => {
    saveShowWorktrees(true)
    const { result } = renderHook(() => useSessionActionHandlers(), {
      wrapper,
    })
    result.current.onManageConversations(session)
    expect(h.openConversationManager).toHaveBeenCalledWith(2)
  })
})
