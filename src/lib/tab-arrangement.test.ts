import { describe, expect, it } from "vitest"
import type { AttentionKind, ConversationStatus } from "@/lib/types"
import {
  TAB_GROUP_BYS,
  TAB_SORTS,
  arrangeTabs,
  bandOrder,
  effectiveSort,
  folderAccentColor,
  mergeGroupOrder,
  migrateArrangeMode,
  moveGroupKey,
  reinsertInGroupOrder,
  shownTabs,
  sortTabs,
  tabStatusBand,
  type TabView,
} from "./tab-arrangement"

function tab(
  id: string,
  folderId: number,
  status?: ConversationStatus,
  conversationId: number | null = Number(id.replace(/\D/g, "")) || null,
  title: string = id
) {
  return { id, folderId, conversationId, status, title }
}

const none = new Map<number, AttentionKind>()
const ids = (list: readonly { id: string }[]) => list.map((t) => t.id)
const view = (groupBy: TabView["groupBy"], sort: TabView["sort"]) => ({
  groupBy,
  sort,
})

describe("migrateArrangeMode", () => {
  it("maps every old single setting onto grouping + manual sort", () => {
    expect(migrateArrangeMode("manual")).toEqual(view("none", "manual"))
    expect(migrateArrangeMode("folder")).toEqual(view("folder", "manual"))
    expect(migrateArrangeMode("status")).toEqual(view("status", "manual"))
  })

  it("ignores anything else", () => {
    expect(migrateArrangeMode(null)).toBeNull()
    expect(migrateArrangeMode(undefined)).toBeNull()
    expect(migrateArrangeMode("bogus")).toBeNull()
  })
})

describe("effectiveSort", () => {
  it("is the chosen sort, except status inside status bands", () => {
    for (const groupBy of TAB_GROUP_BYS) {
      for (const sort of TAB_SORTS) {
        const expected =
          groupBy === "status" && sort === "status" ? "manual" : sort
        expect(effectiveSort({ groupBy, sort })).toBe(expected)
      }
    }
  })
})

describe("sortTabs", () => {
  const attention = new Map<number, AttentionKind>([[4, "permission"]])
  const tabs = [
    tab("t1", 1, "completed", 1, "beta"),
    tab("t2", 1, "in_progress", 2, "Tab 10"),
    tab("t3", 1, "pending_review", 3, "alpha"),
    tab("t4", 1, "in_progress", 4, "Tab 2"),
    tab("t5", 1, undefined, null, "Draft"),
  ]

  it("returns the very same array for manual", () => {
    expect(sortTabs(tabs, "manual", attention)).toBe(tabs)
  })

  it("status: needs you, awaiting reply, running, then the rest (stable)", () => {
    expect(ids(sortTabs(tabs, "status", attention))).toEqual([
      "t4",
      "t3",
      "t2",
      "t1",
      "t5",
    ])
  })

  it("recent: latest activity first, unknown activity last in manual order", () => {
    const activity = new Map([
      [1, 100],
      [2, 300],
      [3, 200],
    ])
    expect(ids(sortTabs(tabs, "recent", none, activity))).toEqual([
      "t2",
      "t3",
      "t1",
      "t4",
      "t5",
    ])
  })

  it("name: natural, case-blind", () => {
    expect(ids(sortTabs(tabs, "name", none))).toEqual([
      "t3",
      "t1",
      "t5",
      "t4",
      "t2",
    ])
  })

  it("never touches the input", () => {
    const before = ids(tabs)
    sortTabs(tabs, "name", none)
    expect(ids(tabs)).toEqual(before)
  })
})

describe("arrangeTabs", () => {
  const tabs = [
    tab("t1", 1, "completed", 1, "zeta"),
    tab("t2", 2, "in_progress", 2, "beta"),
    tab("t3", 1, "pending_review", 3, "alpha"),
    tab("t4", 3, "in_progress", 4, "gamma"),
    tab("t5", 2, "pending_review", 5, "alpha"),
  ]

  it("none + manual: the same array, no groups", () => {
    const r = arrangeTabs(tabs, view("none", "manual"), none)
    expect(r.ordered).toBe(tabs)
    expect(r.runs).toBeNull()
  })

  it("none + a sort: one sorted row, no groups", () => {
    const r = arrangeTabs(tabs, view("none", "name"), none)
    expect(r.runs).toBeNull()
    expect(ids(r.ordered)).toEqual(["t3", "t5", "t2", "t4", "t1"])
  })

  it("folder + manual: first-appearance group order, manual order inside", () => {
    const r = arrangeTabs(tabs, view("folder", "manual"), none)
    expect(r.runs?.map((run) => run.key)).toEqual([
      "folder-1",
      "folder-2",
      "folder-3",
    ])
    expect(ids(r.ordered)).toEqual(["t1", "t3", "t2", "t5", "t4"])
    // Same objects — the strip's reorder list keys on identity.
    expect(r.ordered[0]).toBe(tabs[0])
  })

  it("folder + a sort: sorts inside each group, groups stay put", () => {
    const r = arrangeTabs(tabs, view("folder", "name"), none)
    expect(r.runs?.map((run) => run.key)).toEqual([
      "folder-1",
      "folder-2",
      "folder-3",
    ])
    expect(ids(r.ordered)).toEqual(["t3", "t1", "t5", "t2", "t4"])
  })

  it("folder + status sort: most urgent first inside each group", () => {
    const r = arrangeTabs(tabs, view("folder", "status"), none)
    expect(ids(r.ordered)).toEqual(["t3", "t1", "t5", "t2", "t4"])
  })

  it("folder: follows the saved group order, unplaced folders after", () => {
    const r = arrangeTabs(tabs, view("folder", "manual"), none, {
      groupOrder: { folder: [3, 99, 2], status: [] },
    })
    expect(r.runs?.map((run) => run.key)).toEqual([
      "folder-3",
      "folder-2",
      "folder-1",
    ])
  })

  it("folder: several unplaced folders keep first-appearance order", () => {
    const r = arrangeTabs(tabs, view("folder", "manual"), none, {
      groupOrder: { folder: [2], status: [] },
    })
    expect(r.runs?.map((run) => run.key)).toEqual([
      "folder-2",
      "folder-1",
      "folder-3",
    ])
  })

  it("status + manual: bands by urgency, manual order inside", () => {
    const attention = new Map<number, AttentionKind>([[4, "permission"]])
    const r = arrangeTabs(tabs, view("status", "manual"), attention)
    expect(r.runs?.map((run) => run.key)).toEqual([
      "status-needs_you",
      "status-awaiting_reply",
      "status-running",
      "status-other",
    ])
    expect(ids(r.ordered)).toEqual(["t4", "t3", "t5", "t2", "t1"])
  })

  it("status + status: same as status + manual", () => {
    const a = arrangeTabs(tabs, view("status", "status"), none)
    const b = arrangeTabs(tabs, view("status", "manual"), none)
    expect(ids(a.ordered)).toEqual(ids(b.ordered))
  })

  it("status + name: sorts inside each band", () => {
    const r = arrangeTabs(tabs, view("status", "name"), none)
    expect(ids(r.ordered)).toEqual(["t3", "t5", "t2", "t4", "t1"])
  })

  it("status + recent: sorts inside each band by activity", () => {
    const r = arrangeTabs(tabs, view("status", "recent"), none, {
      activity: new Map([
        [2, 1],
        [4, 2],
        [3, 5],
        [5, 9],
      ]),
    })
    expect(ids(r.ordered)).toEqual(["t5", "t3", "t4", "t2", "t1"])
  })

  it("status: follows the saved band order", () => {
    const r = arrangeTabs(tabs, view("status", "manual"), none, {
      groupOrder: { folder: [], status: ["other", "running"] },
    })
    expect(r.runs?.map((run) => run.key)).toEqual([
      "status-other",
      "status-running",
      "status-awaiting_reply",
    ])
  })

  it("skips empty status bands", () => {
    const r = arrangeTabs(
      [tab("t1", 1, "completed")],
      view("status", "manual"),
      none
    )
    expect(r.runs?.map((run) => run.key)).toEqual(["status-other"])
  })

  it("every grouping × sort keeps each tab exactly once", () => {
    for (const groupBy of TAB_GROUP_BYS) {
      for (const sort of TAB_SORTS) {
        const r = arrangeTabs(tabs, { groupBy, sort }, none)
        expect([...ids(r.ordered)].sort()).toEqual(ids(tabs).sort())
        if (r.runs) {
          expect(ids(r.runs.flatMap((run) => run.tabs))).toEqual(ids(r.ordered))
        }
      }
    }
  })
})

describe("bandOrder", () => {
  it("defaults to urgency order", () => {
    expect(bandOrder([])).toEqual([
      "needs_you",
      "awaiting_reply",
      "running",
      "other",
    ])
  })

  it("puts placed bands first and drops unknown or repeated ones", () => {
    expect(bandOrder(["running", "bogus", "other", "running"])).toEqual([
      "running",
      "other",
      "needs_you",
      "awaiting_reply",
    ])
  })
})

describe("tabStatusBand", () => {
  it("puts a blocked session first whatever its status says", () => {
    const attention = new Map<number, AttentionKind>([[7, "question"]])
    expect(tabStatusBand(tab("t7", 1, "in_progress"), attention)).toBe(
      "needs_you"
    )
  })

  it("files a draft (no conversation yet) under other", () => {
    expect(tabStatusBand(tab("draft", 1, undefined, null), none)).toBe("other")
  })
})

describe("folderAccentColor", () => {
  it("uses the folder's own color when it has one", () => {
    expect(folderAccentColor(5, "violet")).toBe("violet")
    expect(folderAccentColor(5, "#22c55e")).toBe("green") // legacy hex
  })

  it("picks a stable color for an uncolored folder", () => {
    expect(folderAccentColor(1, null)).toBe(folderAccentColor(1, "inherit"))
    expect(folderAccentColor(1, null)).not.toBe(folderAccentColor(2, null))
  })
})

describe("shownTabs", () => {
  const tabs = [
    { id: "a1", folderId: 1, conversationId: 11 },
    { id: "b1", folderId: 2, conversationId: 21 },
    { id: "a2", folderId: 1, conversationId: 12 },
    { id: "b2", folderId: 2, conversationId: 22 },
  ]
  const byFolder = arrangeTabs(tabs, view("folder", "manual"), new Map())

  it("follows the arrangement, not the manual order", () => {
    expect(ids(shownTabs(byFolder, new Set(), "a1"))).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
    ])
  })

  it("folds a collapsed group away but keeps its active tab", () => {
    const collapsed = new Set(["folder-1"])
    expect(ids(shownTabs(byFolder, collapsed, "b1"))).toEqual(["b1", "b2"])
    expect(ids(shownTabs(byFolder, collapsed, "a2"))).toEqual([
      "a2",
      "b1",
      "b2",
    ])
  })

  it("never folds an ungrouped strip", () => {
    const plain = arrangeTabs(tabs, view("none", "manual"), new Map())
    expect(shownTabs(plain, new Set(["folder-1"]), "a1")).toBe(tabs)
  })
})

describe("reinsertInGroupOrder", () => {
  // Manual order interleaves two folders: a = folder 1, b = folder 2.
  const strip = ["a1", "b1", "a2", "b2", "a3", "b3"].map((id) => ({ id }))

  it("moves a tab after the group-mate now before it", () => {
    // Folder 1 shown as a1 a2 a3 → dragged a1 to the end: a2 a3 a1.
    const next = reinsertInGroupOrder(strip, ["a2", "a3", "a1"], "a1")
    expect(ids(next!)).toEqual(["b1", "a2", "b2", "a3", "a1", "b3"])
  })

  it("moves a tab before the group-mate now after it when it became first", () => {
    const next = reinsertInGroupOrder(strip, ["a3", "a1", "a2"], "a3")
    expect(ids(next!)).toEqual(["a3", "a1", "b1", "a2", "b2", "b3"])
  })

  it("never scrambles the other groups' relative order", () => {
    const next = reinsertInGroupOrder(strip, ["a2", "a1", "a3"], "a1")!
    expect(ids(next).filter((id) => id.startsWith("b"))).toEqual([
      "b1",
      "b2",
      "b3",
    ])
    expect(ids(next).filter((id) => id.startsWith("a"))).toEqual([
      "a2",
      "a1",
      "a3",
    ])
  })

  it("keeps the manual order behind a grouped view when switched back", () => {
    // Folder 2 shown as b1 b2 b3; b3 dragged to the front.
    const next = reinsertInGroupOrder(strip, ["b3", "b1", "b2"], "b3")!
    const plain = arrangeTabs(
      next.map((t) => ({
        ...t,
        folderId: t.id.startsWith("a") ? 1 : 2,
        conversationId: null,
      })),
      view("none", "manual"),
      none
    )
    expect(ids(plain.ordered)).toEqual(["a1", "b3", "b1", "a2", "b2", "a3"])
  })

  it("returns null when nothing changes or the tab is unknown", () => {
    expect(reinsertInGroupOrder(strip, ["a1", "a2", "a3"], "a2")).toBeNull()
    expect(reinsertInGroupOrder(strip, ["a1"], "a1")).toBeNull()
    expect(reinsertInGroupOrder(strip, ["a1", "zz"], "zz")).toBeNull()
  })
})

describe("mergeGroupOrder", () => {
  it("writes the shown order into the places the shown keys held", () => {
    // 7 is not open right now: it keeps its place between the others.
    expect(mergeGroupOrder([1, 7, 2, 3], [3, 1, 2])).toEqual([3, 7, 1, 2])
  })

  it("appends keys that were never placed", () => {
    expect(mergeGroupOrder([2], [1, 2, 5])).toEqual([1, 2, 5])
    expect(mergeGroupOrder([], [5, 4])).toEqual([5, 4])
  })
})

describe("moveGroupKey", () => {
  const keys = ["a", "b", "c", "d"]

  it("moves a key to an insertion point on the full order", () => {
    expect(moveGroupKey(keys, "a", 4)).toEqual(["b", "c", "d", "a"])
    expect(moveGroupKey(keys, "d", 0)).toEqual(["d", "a", "b", "c"])
    expect(moveGroupKey(keys, "b", 3)).toEqual(["a", "c", "b", "d"])
    expect(moveGroupKey(keys, "c", 1)).toEqual(["a", "c", "b", "d"])
  })

  it("returns null for a drop in place or an unknown key", () => {
    expect(moveGroupKey(keys, "b", 1)).toBeNull()
    expect(moveGroupKey(keys, "b", 2)).toBeNull()
    expect(moveGroupKey(keys, "x", 0)).toBeNull()
  })

  it("clamps an out-of-range drop", () => {
    expect(moveGroupKey(keys, "a", 99)).toEqual(["b", "c", "d", "a"])
    expect(moveGroupKey(keys, "d", -3)).toEqual(["d", "a", "b", "c"])
  })
})
