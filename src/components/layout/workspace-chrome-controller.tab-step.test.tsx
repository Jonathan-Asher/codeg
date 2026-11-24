import { act, createEvent, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { create } from "zustand"

import { DEFAULT_SHORTCUTS } from "@/lib/keyboard-shortcuts"
import {
  TAB_STEP_SETTLE_MS,
  resetTabStep,
  useTabStepStore,
} from "@/stores/tab-step-store"

// A stand-in for the tab store: the controller and the stepping both read it,
// and switching writes it, the way the real one does.
const tabsModule = vi.hoisted(() => ({
  store: null as unknown as ReturnType<typeof makeStore>,
  switchTab: null as unknown as ReturnType<
    typeof vi.fn<(tabId: string) => void>
  >,
}))
function makeStore() {
  return create<{
    rawTabs: { id: string }[]
    tabs: { id: string }[]
    activeTabId: string | null
    switchTab: (tabId: string) => void
  }>()(() => ({
    rawTabs: [],
    tabs: [],
    activeTabId: null,
    switchTab: (tabId: string) => tabsModule.switchTab(tabId),
  }))
}

vi.mock("@/stores/tab-store", () => ({
  get useTabStore() {
    return tabsModule.store
  },
  useVisibleConversationTabs: () => tabsModule.store((s) => s.tabs),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: vi.fn(),
    openTab: vi.fn(),
    switchTab: (tabId: string) => tabsModule.switchTab(tabId),
    closeTab: vi.fn(),
  }),
  useTabStore: <T,>(selector: (s: { activeTabId: string | null }) => T) =>
    tabsModule.store(selector),
}))
// No grouping or sorting: the walk is the strip's own order.
vi.mock("@/hooks/use-arranged-tabs", () => ({
  useArrangedTabs: <T,>(tabs: readonly T[]) => ({
    arranged: { ordered: tabs, runs: null },
    shown: tabs,
  }),
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
  useAuxPanelActions: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: "fusion",
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
  useSearchDialogSetter: () => vi.fn(),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: DEFAULT_SHORTCUTS }),
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
  getShellTransport: () => ({ subscribe: vi.fn() }),
}))

import { WorkspaceChromeController } from "./workspace-chrome-controller"

const TABS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]
// Long enough for the next frame to come round (fake frames are 16 ms apart)
// and the task queued after it to run.
const FRAME_MS = 32

function setTabs(activeTabId: string) {
  const tabs = TABS.map((id) => ({ id }))
  tabsModule.store.setState({ rawTabs: tabs, tabs, activeTabId })
}

const highlighted = () =>
  useTabStepStore.getState().previewTabId ??
  tabsModule.store.getState().activeTabId

function pressNextTab(shift = false) {
  const event = createEvent.keyDown(document, {
    key: "Tab",
    code: "Tab",
    ctrlKey: true,
    shiftKey: shift,
  })
  act(() => {
    fireEvent(document, event)
  })
  return event
}

function releaseControl() {
  act(() => {
    fireEvent.keyUp(window, { key: "Control", code: "ControlLeft" })
  })
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetTabStep()
  // One store for the whole file: the stepping subscribes to it once.
  tabsModule.store ??= makeStore()
  tabsModule.switchTab = vi.fn<(tabId: string) => void>((tabId) =>
    tabsModule.store.setState({ activeTabId: tabId })
  )
  setTabs("t1")
})

afterEach(() => {
  act(() => resetTabStep())
  vi.useRealTimers()
})

describe("WorkspaceChromeController — next/previous tab", () => {
  it("highlights a single press at once and switches right after", () => {
    render(<WorkspaceChromeController />)
    const event = pressNextTab()
    expect(event.defaultPrevented).toBe(true)
    expect(highlighted()).toBe("t2")
    expect(tabsModule.switchTab).not.toHaveBeenCalled()
    advance(FRAME_MS)
    expect(tabsModule.switchTab.mock.calls).toEqual([["t2"]])
    expect(tabsModule.store.getState().activeTabId).toBe("t2")
    expect(useTabStepStore.getState().previewTabId).toBeNull()
  })

  it("moves the highlight on every press of a burst and only switches where it stops", () => {
    render(<WorkspaceChromeController />)
    const seen: (string | null)[] = []
    for (let press = 0; press < 6; press++) {
      if (press > 0) advance(80)
      pressNextTab()
      seen.push(highlighted())
    }
    expect(seen).toEqual(["t2", "t3", "t4", "t5", "t6", "t7"])
    // The first press switched as a lone press does (it could not know more
    // would follow); t3..t6 were only passed.
    expect(tabsModule.switchTab.mock.calls).toEqual([["t2"]])
    advance(TAB_STEP_SETTLE_MS)
    expect(tabsModule.switchTab.mock.calls).toEqual([["t2"], ["t7"]])
    expect(tabsModule.store.getState().activeTabId).toBe("t7")
    expect(useTabStepStore.getState().previewTabId).toBeNull()
  })

  it("switches as soon as Ctrl is let go", () => {
    render(<WorkspaceChromeController />)
    pressNextTab()
    advance(FRAME_MS)
    advance(70)
    pressNextTab()
    advance(70)
    pressNextTab()
    releaseControl()
    advance(0)
    expect(tabsModule.switchTab.mock.calls).toEqual([["t2"], ["t4"]])
  })

  it("steps back with Shift, wrapping round the strip", () => {
    render(<WorkspaceChromeController />)
    pressNextTab(true)
    expect(highlighted()).toBe("t8")
    advance(60)
    pressNextTab(true)
    expect(highlighted()).toBe("t7")
    advance(TAB_STEP_SETTLE_MS)
    expect(tabsModule.store.getState().activeTabId).toBe("t7")
  })

  it("lets another key end the run first, so it acts on the tab the run reached", () => {
    render(<WorkspaceChromeController />)
    pressNextTab()
    advance(FRAME_MS)
    advance(60)
    pressNextTab()
    const seenByKey: (string | null)[] = []
    const onKey = () => seenByKey.push(tabsModule.store.getState().activeTabId)
    document.addEventListener("keydown", onKey)
    act(() => {
      fireEvent.keyDown(document, { key: "x" })
    })
    document.removeEventListener("keydown", onKey)
    expect(seenByKey).toEqual(["t3"])
  })

  it("drops the run when a tab is chosen some other way", () => {
    render(<WorkspaceChromeController />)
    pressNextTab()
    advance(FRAME_MS)
    advance(60)
    pressNextTab()
    act(() => tabsModule.store.setState({ activeTabId: "t6" }))
    expect(highlighted()).toBe("t6")
    advance(1000)
    expect(tabsModule.store.getState().activeTabId).toBe("t6")
    expect(tabsModule.switchTab.mock.calls).toEqual([["t2"]])
  })

  it("drops the run on a pointer press", () => {
    render(<WorkspaceChromeController />)
    pressNextTab()
    advance(FRAME_MS)
    advance(60)
    pressNextTab()
    act(() => {
      fireEvent.pointerDown(document.body)
    })
    expect(highlighted()).toBe("t2")
    advance(1000)
    expect(tabsModule.switchTab.mock.calls).toEqual([["t2"]])
  })
})
