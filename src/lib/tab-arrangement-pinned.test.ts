import { describe, expect, it } from "vitest"
import type { AttentionKind, ConversationStatus } from "@/lib/types"
import {
  TAB_GROUP_BYS,
  TAB_SORTS,
  arrangeTabs,
  reinsertInGroupOrder,
  shownTabs,
  tabsWithClosableRight,
} from "./tab-arrangement"

function tab(
  id: string,
  folderId: number,
  status: ConversationStatus,
  title: string,
  isAnchored = false
) {
  return {
    id,
    folderId,
    conversationId: Number(id.replace(/\D/g, "")),
    status,
    title,
    ...(isAnchored ? { isAnchored: true } : {}),
  }
}

const ids = (list: readonly { id: string }[]) => list.map((t) => t.id)
const attention = new Map<number, AttentionKind>([[4, "permission"]])
const activity = new Map([
  [1, 100],
  [2, 500],
  [3, 300],
  [4, 200],
  [5, 400],
  [6, 600],
])

// Manual order: pinned tabs scattered among the rest, and in an order every
// sort would change ("zulu" before "alpha", the idle one before the running
// one, the stale one before the recent one).
const TABS = [
  tab("t1", 1, "completed", "kilo"),
  tab("p2", 2, "completed", "zulu", true),
  tab("t3", 1, "pending_review", "bravo"),
  tab("t4", 3, "in_progress", "echo"),
  tab("p5", 1, "in_progress", "alpha", true),
  tab("t6", 2, "completed", "delta"),
]

describe("arrangeTabs with pinned tabs", () => {
  it.each(
    TAB_GROUP_BYS.flatMap((groupBy) =>
      TAB_SORTS.map((sort) => [groupBy, sort] as const)
    )
  )("%s + %s: pinned tabs first, in their manual order", (groupBy, sort) => {
    const r = arrangeTabs(TABS, { groupBy, sort }, attention, { activity })
    expect(ids(r.anchored)).toEqual(["p2", "p5"])
    expect(ids(r.ordered).slice(0, 2)).toEqual(["p2", "p5"])
    // Every tab exactly once.
    expect([...ids(r.ordered)].sort()).toEqual(ids(TABS).sort())
    // The rest is laid out as if the pinned tabs weren't there.
    const rest = TABS.filter((t) => t.isAnchored !== true)
    const alone = arrangeTabs(rest, { groupBy, sort }, attention, {
      activity,
    })
    expect(ids(r.ordered).slice(2)).toEqual(ids(alone.ordered))
    if (groupBy === "none") {
      expect(r.runs).toBeNull()
    } else {
      // No group holds a pinned tab, and the groups are the rest's.
      expect(r.runs!.map((run) => run.key)).toEqual(
        alone.runs!.map((run) => run.key)
      )
      expect(r.runs!.flatMap((run) => run.tabs).some((t) => t.isAnchored)).toBe(
        false
      )
    }
  })

  it("keeps the tab objects", () => {
    const r = arrangeTabs(TABS, { groupBy: "folder", sort: "name" }, attention)
    expect(r.anchored[0]).toBe(TABS[1])
    expect(r.ordered[0]).toBe(TABS[1])
  })

  it("with nothing pinned, ungrouped manual is still the very same array", () => {
    const plain = TABS.map((t) => ({ ...t, isAnchored: false }))
    const r = arrangeTabs(plain, { groupBy: "none", sort: "manual" }, attention)
    expect(r.ordered).toBe(plain)
    expect(r.anchored).toEqual([])
  })
})

describe("shownTabs with pinned tabs", () => {
  it("never folds a pinned tab away, and shows them first", () => {
    const r = arrangeTabs(
      TABS,
      { groupBy: "folder", sort: "manual" },
      attention
    )
    const everyRun = new Set(r.runs!.map((run) => run.key))
    expect(ids(shownTabs(r, everyRun, "t3"))).toEqual(["p2", "p5", "t3"])
    expect(ids(shownTabs(r, new Set(), null))).toEqual(ids(r.ordered))
  })

  it("is the walk of the next/previous tab shortcuts: pinned first, then the rest as shown", () => {
    const r = arrangeTabs(
      TABS,
      { groupBy: "status", sort: "manual" },
      attention
    )
    // Pinned (manual order), then needs you, awaiting reply, other.
    expect(ids(shownTabs(r, new Set(), "t1"))).toEqual([
      "p2",
      "p5",
      "t4",
      "t3",
      "t1",
      "t6",
    ])
  })
})

describe("dragging among pinned tabs", () => {
  it("moves only the dragged pinned tab in the manual order, under any sort", () => {
    // p5 dragged in front of p2 on screen.
    const next = reinsertInGroupOrder(TABS, ["p5", "p2"], "p5")
    expect(ids(next!)).toEqual(["t1", "p5", "p2", "t3", "t4", "t6"])
    for (const sort of TAB_SORTS) {
      const r = arrangeTabs(next!, { groupBy: "folder", sort }, attention, {
        activity,
      })
      expect(ids(r.anchored)).toEqual(["p5", "p2"])
    }
    // The rest keeps its relative order.
    expect(ids(next!.filter((t) => !t.isAnchored))).toEqual(
      ids(TABS.filter((t) => !t.isAnchored))
    )
  })

  it("is a no-op when the pinned order did not change", () => {
    expect(reinsertInGroupOrder(TABS, ["p2", "p5"], "p5")).toBeNull()
  })
})

describe("tabsWithClosableRight", () => {
  it("is every tab with an unpinned tab after it", () => {
    const ordered = arrangeTabs(
      TABS,
      { groupBy: "none", sort: "manual" },
      attention
    ).ordered
    // p2 p5 t1 t3 t4 t6
    expect([...tabsWithClosableRight(ordered)]).toEqual([
      "t4",
      "t3",
      "t1",
      "p5",
      "p2",
    ])
  })

  it("leaves out a tab followed by pinned tabs only", () => {
    const t1 = tab("t1", 1, "completed", "a")
    const p2 = tab("p2", 1, "completed", "b", true)
    const t3 = tab("t3", 1, "completed", "c")
    expect(tabsWithClosableRight([t1, p2]).size).toBe(0)
    expect([...tabsWithClosableRight([t1, p2, t3])]).toEqual(["p2", "t1"])
  })
})
