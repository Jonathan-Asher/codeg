import { beforeEach, describe, expect, it } from "vitest"
import {
  COLLAPSED_KEY,
  GROUP_BY_KEY,
  GROUP_ORDER_KEY,
  LEGACY_MODE_KEY,
  SORT_KEY,
  loadGroupOrder,
  loadView,
  useTabArrangeStore,
} from "./tab-arrangement-store"

function resetStore() {
  useTabArrangeStore.setState({
    groupBy: "none",
    sort: "manual",
    groupOrder: { folder: [], status: [] },
    collapsedRuns: new Set(),
    hydrated: false,
  })
}

beforeEach(() => {
  window.localStorage.clear()
  resetStore()
})

describe("loadView", () => {
  it("defaults to no grouping, manual sort", () => {
    expect(loadView()).toEqual({ groupBy: "none", sort: "manual" })
  })

  it.each([
    ["manual", { groupBy: "none", sort: "manual" }],
    ["folder", { groupBy: "folder", sort: "manual" }],
    ["status", { groupBy: "status", sort: "manual" }],
  ])("migrates the old %s setting", (legacy, expected) => {
    window.localStorage.setItem(LEGACY_MODE_KEY, legacy)
    expect(loadView()).toEqual(expected)
  })

  it("prefers the new keys over the old setting once either exists", () => {
    window.localStorage.setItem(LEGACY_MODE_KEY, "folder")
    window.localStorage.setItem(SORT_KEY, "name")
    expect(loadView()).toEqual({ groupBy: "none", sort: "name" })
  })

  it("falls back per key on junk", () => {
    window.localStorage.setItem(GROUP_BY_KEY, "folder")
    window.localStorage.setItem(SORT_KEY, "bogus")
    expect(loadView()).toEqual({ groupBy: "folder", sort: "manual" })
  })
})

describe("loadGroupOrder", () => {
  it("keeps only valid folder ids and bands", () => {
    window.localStorage.setItem(
      GROUP_ORDER_KEY,
      JSON.stringify({
        folder: [3, "x", 1.5, 7],
        status: ["running", "nope", "other"],
      })
    )
    expect(loadGroupOrder()).toEqual({
      folder: [3, 7],
      status: ["running", "other"],
    })
  })

  it("survives broken JSON", () => {
    window.localStorage.setItem(GROUP_ORDER_KEY, "{not json")
    expect(loadGroupOrder()).toEqual({ folder: [], status: [] })
  })
})

describe("useTabArrangeStore", () => {
  it("hydrates a migrated choice and keeps the old key in place", () => {
    window.localStorage.setItem(LEGACY_MODE_KEY, "folder")
    useTabArrangeStore.getState().hydrate()
    const s = useTabArrangeStore.getState()
    expect(s.groupBy).toBe("folder")
    expect(s.sort).toBe("manual")
    expect(window.localStorage.getItem(LEGACY_MODE_KEY)).toBe("folder")
  })

  it("persists grouping and sorting independently", () => {
    const { setGroupBy, setSort } = useTabArrangeStore.getState()
    setGroupBy("folder")
    setSort("recent")
    expect(window.localStorage.getItem(GROUP_BY_KEY)).toBe("folder")
    expect(window.localStorage.getItem(SORT_KEY)).toBe("recent")
    resetStore()
    useTabArrangeStore.getState().hydrate()
    expect(useTabArrangeStore.getState().groupBy).toBe("folder")
    expect(useTabArrangeStore.getState().sort).toBe("recent")
  })

  it("drops a status sort when grouping by status", () => {
    const { setGroupBy, setSort } = useTabArrangeStore.getState()
    setSort("status")
    setGroupBy("status")
    expect(useTabArrangeStore.getState().sort).toBe("manual")
    setGroupBy("folder")
    setSort("name")
    setGroupBy("status")
    expect(useTabArrangeStore.getState().sort).toBe("name")
  })

  it("persists the folder and band orders side by side", () => {
    const { setFolderOrder, setBandOrder } = useTabArrangeStore.getState()
    setFolderOrder([4, 2])
    setBandOrder(["other", "needs_you"])
    expect(
      JSON.parse(window.localStorage.getItem(GROUP_ORDER_KEY) ?? "null")
    ).toEqual({ folder: [4, 2], status: ["other", "needs_you"] })
    resetStore()
    useTabArrangeStore.getState().hydrate()
    expect(useTabArrangeStore.getState().groupOrder).toEqual({
      folder: [4, 2],
      status: ["other", "needs_you"],
    })
  })

  it("persists collapsed groups", () => {
    useTabArrangeStore.getState().toggleRunCollapsed("folder-1")
    expect(
      JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]")
    ).toEqual(["folder-1"])
    useTabArrangeStore.getState().toggleRunCollapsed("folder-1")
    expect(useTabArrangeStore.getState().collapsedRuns.size).toBe(0)
  })
})
