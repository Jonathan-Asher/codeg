import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import {
  resetTabStore,
  useTabStore,
  type TabItemInternal,
} from "@/stores/tab-store"
import { useArrangedTabs, useSwitchToManualOrder } from "./use-arranged-tabs"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const folders = [1, 2].map(
  (id) => ({ id, name: `repo${id}`, path: `/repo${id}` }) as FolderDetail
)

function tab(
  id: string,
  folderId: number,
  title: string,
  isAnchored = false
): TabItemInternal {
  return {
    id,
    kind: "conversation",
    folderId,
    conversationId: Number(id.replace(/\D/g, "")),
    agentType: "claude_code",
    title,
    isPinned: true,
    status: "completed",
    ...(isAnchored ? { isAnchored: true } : {}),
  }
}

// Manual order; by name it would be: alpha, bravo, kilo, zulu.
const TABS = [
  tab("t1", 1, "zulu"),
  tab("p2", 2, "yankee", true),
  tab("t3", 2, "bravo"),
  tab("p4", 1, "xray", true),
  tab("t5", 1, "alpha"),
  tab("t6", 2, "kilo"),
]

const ids = (list: readonly { id: string }[]) => list.map((t) => t.id)

function setView(
  over: Partial<ReturnType<typeof useTabArrangeStore.getState>>
) {
  useTabArrangeStore.setState({
    groupBy: "none",
    sort: "manual",
    groupOrder: { folder: [], status: [] },
    collapsedRuns: new Set(),
    hydrated: true,
    ...over,
  })
}

beforeEach(() => {
  localStorage.clear()
  resetTabStore()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    conversationsLoading: false,
  })
  setView({})
})

describe("next / previous tab order", () => {
  // The tab-switching shortcuts walk `shown` (workspace-chrome-controller).
  it.each([
    ["ungrouped, manual", {}, ["p2", "p4", "t1", "t3", "t5", "t6"]],
    [
      "ungrouped, by name",
      { sort: "name" },
      ["p2", "p4", "t5", "t3", "t6", "t1"],
    ],
    [
      "by folder, by name",
      { groupBy: "folder", sort: "name" },
      ["p2", "p4", "t5", "t1", "t3", "t6"],
    ],
    [
      "by folder, folder 1 folded",
      { groupBy: "folder", collapsedRuns: new Set(["folder-1"]) },
      ["p2", "p4", "t3", "t6"],
    ],
  ] as const)(
    "%s: pinned tabs first, then the rest as shown",
    (_, view, order) => {
      setView(view as Parameters<typeof setView>[0])
      const { result } = renderHook(() => useArrangedTabs(TABS, "t3"))
      expect(ids(result.current.shown)).toEqual(order)
    }
  )
})

describe("Switch to manual order", () => {
  function seed(tabs: TabItemInternal[]) {
    useTabStore.setState({
      rawTabs: tabs,
      tabs,
      activeTabId: tabs[0].id,
      tabsHydrated: true,
    })
  }

  it("makes the order on screen the manual one, then sorts manually", () => {
    seed(TABS)
    setView({ groupBy: "folder", sort: "name" })
    const before = renderHook(() => useArrangedTabs(TABS, "t1"))
    const shownBefore = ids(before.result.current.shown)

    const { result } = renderHook(() => useSwitchToManualOrder())
    act(() => result.current())

    expect(useTabArrangeStore.getState().sort).toBe("manual")
    // The grouping is left alone.
    expect(useTabArrangeStore.getState().groupBy).toBe("folder")
    const raw = useTabStore.getState().rawTabs
    expect(ids(raw)).toEqual(shownBefore)
    // Nothing moved on screen.
    const after = renderHook(() => useArrangedTabs(raw, "t1"))
    expect(ids(after.result.current.shown)).toEqual(shownBefore)
  })

  it("does nothing while the sort already is manual", () => {
    seed(TABS)
    const before = useTabStore.getState().rawTabs
    const { result } = renderHook(() => useSwitchToManualOrder())
    act(() => result.current())
    expect(useTabStore.getState().rawTabs).toBe(before)
  })

  it("keeps each split group's order within its own slots", () => {
    seed(TABS)
    useTabStore.setState({
      groupLayout: {
        type: "split",
        id: "s",
        orientation: "horizontal",
        children: [
          { type: "group", id: "g1" },
          { type: "group", id: "g2" },
        ],
        ratios: [0.5, 0.5],
      },
      // Folder 2's tabs in the second group.
      groupOf: { p2: "g2", t3: "g2", t6: "g2" },
    })
    setView({ sort: "name" })
    const { result } = renderHook(() => useSwitchToManualOrder())
    act(() => result.current())
    // g1 (slots 0, 3, 4): p4, t5 (alpha), t1 (zulu); g2 (slots 1, 2, 5): p2,
    // t3 (bravo), t6 (kilo).
    expect(ids(useTabStore.getState().rawTabs)).toEqual([
      "p4",
      "p2",
      "t3",
      "t5",
      "t1",
      "t6",
    ])
  })
})
