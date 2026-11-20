import { act, fireEvent, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_SHORTCUTS,
  analyzeShortcutAssignment,
  readShortcutSettings,
  withShortcutTakenOver,
  writeShortcutSettings,
} from "@/lib/keyboard-shortcuts"

/**
 * The workspace's real shortcut dispatch, fed by the real stored profile (no
 * mocked `useShortcutSettings`): what Settings → Shortcuts writes is what the
 * keys do.
 */
const spies = vi.hoisted(() => ({
  setSearchOpen: vi.fn(),
  openNewConversationTab: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ openSettingsWindow: vi.fn() }))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: 1, path: "/repo" } }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => false,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/stores/tab-store", () => ({
  useVisibleConversationTabs: () => [],
}))
vi.mock("@/hooks/use-arranged-tabs", () => ({
  useArrangedTabs: <T,>(tabs: readonly T[]) => ({ shown: tabs }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: spies.openNewConversationTab,
    openTab: vi.fn(),
    switchTab: vi.fn(),
    closeTab: vi.fn(),
  }),
  useTabStore: <T,>(
    selector: (s: { tabs: { id: string }[]; activeTabId: string | null }) => T
  ) => selector({ tabs: [], activeTabId: null }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: "conversation",
    activePane: "conversation",
    filesMaximized: false,
    conversationMaximized: false,
  }),
  useWorkspaceFileTabs: () => ({ activeFileTabId: null, fileTabs: [] }),
  useWorkspaceActions: () => ({
    closeFileTab: vi.fn(),
    closeAllFileTabs: vi.fn(),
    switchFileTab: vi.fn(),
    openFilePreview: vi.fn(),
    openBrowserTab: vi.fn(),
    setActivePane: vi.fn(),
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ open: false, setOpen: vi.fn() }),
  useSearchDialogSetter: () => spies.setSearchOpen,
}))
vi.mock("@/stores/app-workspace-store", () => ({
  isConversationDeleted: () => false,
  useAppWorkspaceStore: { getState: () => ({ getFolder: () => null }) },
}))
vi.mock("@/lib/closed-tab-stack", () => ({ popClosedTab: () => null }))
vi.mock("@/components/conversations/search-command-dialog", () => ({
  SearchCommandDialog: () => null,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: () => null,
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => false,
  getShellTransport: () => ({ subscribe: vi.fn(async () => () => {}) }),
}))
vi.mock("@/lib/platform", () => ({ closeCurrentWindow: vi.fn() }))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => "main",
}))

import { WorkspaceChromeController } from "./workspace-chrome-controller"

function pressModT() {
  fireEvent.keyDown(document, { key: "t", code: "KeyT", metaKey: true })
}

beforeEach(() => {
  localStorage.clear()
  spies.setSearchOpen.mockReset()
  spies.openNewConversationTab.mockReset()
})

describe("WorkspaceChromeController after a shortcut takeover", () => {
  it("opens a new conversation on ⌘T with the defaults", () => {
    render(<WorkspaceChromeController />)
    pressModT()
    expect(spies.openNewConversationTab).toHaveBeenCalledWith(1, "/repo")
    expect(spies.setSearchOpen).not.toHaveBeenCalled()
  })

  it("runs Search on ⌘T once Search took the chord over", () => {
    render(<WorkspaceChromeController />)

    // What Settings → Shortcuts writes when ⌘T is given to Search and the
    // takeover is confirmed: Search on ⌘T, New Conversation unassigned, the
    // terminal's binding left alone.
    const { clashes } = analyzeShortcutAssignment(
      "toggle_search",
      "mod+t",
      readShortcutSettings()
    )
    act(() => {
      writeShortcutSettings(
        withShortcutTakenOver(
          readShortcutSettings(),
          "toggle_search",
          "mod+t",
          clashes
        )
      )
    })
    expect(readShortcutSettings().new_terminal_tab).toBe(
      DEFAULT_SHORTCUTS.new_terminal_tab
    )

    pressModT()
    expect(spies.setSearchOpen).toHaveBeenCalledTimes(1)
    expect(spies.openNewConversationTab).not.toHaveBeenCalled()

    // The old chord no longer opens it.
    fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true })
    expect(spies.setSearchOpen).toHaveBeenCalledTimes(1)
  })

  it("picks the takeover up from another window's write", () => {
    render(<WorkspaceChromeController />)
    // Settings is its own window: its write reaches this one as a storage
    // event, not through this window's own updated-event.
    const next = withShortcutTakenOver(
      DEFAULT_SHORTCUTS,
      "toggle_search",
      "mod+t",
      ["new_conversation"]
    )
    act(() => {
      localStorage.setItem("settings:shortcuts:v1", JSON.stringify(next))
      window.dispatchEvent(
        new StorageEvent("storage", { key: "settings:shortcuts:v1" })
      )
    })
    pressModT()
    expect(spies.setSearchOpen).toHaveBeenCalledTimes(1)
    expect(spies.openNewConversationTab).not.toHaveBeenCalled()
  })
})
