import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import enMessages from "@/i18n/messages/en.json"
import type { TabItem as TabItemData } from "@/contexts/tab-context"

// The strip's own highlight while next/previous-tab presses run ahead of the
// switch (see `stepConversationTab`). The rest of the strip is covered by
// tab-bar.test.tsx; the mocks here are the same, minus what these tests skip.
const h = vi.hoisted(() => ({
  tabs: [] as TabItemData[],
  groupOf: {} as Record<string, string>,
  activeTabId: "conv-1",
  groupSelection: { "g-main": "conv-1" } as Record<string, string>,
}))

vi.mock("motion/react", () => {
  const MOTION_ONLY = new Set([
    "as",
    "values",
    "onReorder",
    "axis",
    "drag",
    "dragControls",
    "dragListener",
    "whileDrag",
    "value",
  ])
  const passthrough = ({
    children,
    ...rest
  }: Record<string, unknown> & { children?: ReactNode }) => (
    <div
      {...Object.fromEntries(
        Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key))
      )}
    >
      {children}
    </div>
  )
  return { Reorder: { Group: passthrough, Item: passthrough } }
})
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: "fusion",
    activePane: "conversation",
    filesMaximized: false,
    conversationMaximized: false,
  }),
  useWorkspaceActions: () => ({ toggleConversationMaximized: vi.fn() }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/use-is-coarse-pointer", () => ({
  useIsCoarsePointer: () => false,
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: <T,>(
    selector: (s: { allFolders: never[]; branches: Map<number, string> }) => T
  ) => selector({ allFolders: [], branches: new Map() }),
}))
vi.mock("@/stores/tab-store", () => ({
  groupOfTab: (_groups: unknown, _layout: unknown, tabId: string) =>
    h.groupOf[tabId] ?? "g-main",
  useVisibleConversationTabs: () => h.tabs,
  useVisibleConversationLayout: () => ({ type: "group", id: "g-main" }),
  useTabStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({ childSummaries: new Map() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    switchTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeAllTabs: vi.fn(),
    pinTab: vi.fn(),
    toggleGroupTile: vi.fn(),
    splitTab: vi.fn(),
    moveTabToGroup: vi.fn(),
    toggleGroupOrientation: vi.fn(),
    dissolveGroup: vi.fn(),
    unsplitAll: vi.fn(),
    reorderTabs: vi.fn(),
    reorderGroupTabs: vi.fn(),
    updateTabDrag: vi.fn(),
    endTabDrag: vi.fn(),
    openNewConversationTab: vi.fn(),
    openChatModeTab: vi.fn(),
  }),
  useTabStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
    selector({
      activeTabId: h.activeTabId,
      groupOf: {},
      groupLayout: { type: "group", id: "g-main" },
      groupSelection: h.groupSelection,
      tileByGroup: {},
      tabDrag: null,
      tabs: h.tabs,
    }),
}))
vi.mock("./tab-item", () => ({
  TabItem: ({ tab, isActive }: { tab: TabItemData; isActive: boolean }) => (
    <div data-tab-id={tab.id} data-active={String(isActive)} />
  ),
}))

import { TabBar } from "./tab-bar"
import { useTabStepStore } from "@/stores/tab-step-store"

function conversationTab(id: string): TabItemData {
  return {
    id,
    kind: "conversation",
    folderId: 1,
    conversationId: 1,
    agentType: "claude_code",
    title: id,
    isPinned: false,
  }
}

function renderStrip(props: Parameters<typeof TabBar>[0] = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TabBar {...props} />
    </NextIntlClientProvider>
  )
}

const activeIn = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-active="true"]')].map((el) =>
    el.getAttribute("data-tab-id")
  )

beforeEach(() => {
  h.tabs = ["conv-1", "conv-2", "conv-3", "conv-4"].map(conversationTab)
  h.groupOf = {}
  h.activeTabId = "conv-1"
  h.groupSelection = { "g-main": "conv-1" }
  useTabStepStore.setState({ previewTabId: null })
})

afterEach(() => {
  useTabStepStore.setState({ previewTabId: null })
})

describe("TabBar — next/previous-tab steps", () => {
  it("highlights the tab a step has reached ahead of the switch, and the active one again after", () => {
    const { container } = renderStrip()
    expect(activeIn(container)).toEqual(["conv-1"])
    for (const tabId of ["conv-2", "conv-3", "conv-4"]) {
      act(() => useTabStepStore.setState({ previewTabId: tabId }))
      expect(activeIn(container)).toEqual([tabId])
    }
    act(() => useTabStepStore.setState({ previewTabId: null }))
    expect(activeIn(container)).toEqual(["conv-1"])
  })

  it("scrolls the stepped-to tab into view", () => {
    const scrolled: (string | null)[] = []
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(this.getAttribute("data-tab-id"))
      })
    renderStrip()
    act(() => useTabStepStore.setState({ previewTabId: "conv-3" }))
    expect(scrolled[scrolled.length - 1]).toBe("conv-3")
    scrollIntoView.mockRestore()
  })

  // While split, each group's strip shows its own selection; only the strip
  // holding the stepped-to tab moves its highlight.
  it("moves only the highlight of the split group holding the tab", () => {
    h.groupOf = { "conv-3": "g-b", "conv-4": "g-b" }
    h.groupSelection = { "g-main": "conv-1", "g-b": "conv-4" }
    const main = renderStrip({ groupId: "g-main" })
    const other = renderStrip({ groupId: "g-b" })
    act(() => useTabStepStore.setState({ previewTabId: "conv-3" }))
    expect(activeIn(main.container)).toEqual(["conv-1"])
    expect(activeIn(other.container)).toEqual(["conv-3"])
  })
})
