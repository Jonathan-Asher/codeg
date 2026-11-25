import { describe, expect, it } from "vitest"

import {
  arrangeTabs,
  holdForRecentDrop,
  isSortHoldLive,
  sortAllowsDrag,
  sortTabs,
  type TabSortHold,
} from "./tab-arrangement"

interface T {
  id: string
  folderId: number
  conversationId: number | null
}

const tab = (id: string, conversationId: number | null, folderId = 1): T => ({
  id,
  folderId,
  conversationId,
})

const NO_ATTENTION = new Map()
const ids = (list: readonly T[]) => list.map((t) => t.id)

// Activity by conversation id: c is the newest, a the oldest.
const activity = new Map([
  [1, 100],
  [2, 200],
  [3, 300],
])
const A = tab("a", 1)
const B = tab("b", 2)
const C = tab("c", 3)
const DRAFT = tab("draft", null)

function recent(list: readonly T[], holds?: Map<string, TabSortHold>) {
  return ids(sortTabs(list, "recent", NO_ATTENTION, activity, holds))
}

describe("sortAllowsDrag", () => {
  it("lets manual and recent-activity strips drag, not status or name", () => {
    expect(sortAllowsDrag("manual")).toBe(true)
    expect(sortAllowsDrag("recent")).toBe(true)
    expect(sortAllowsDrag("status")).toBe(false)
    expect(sortAllowsDrag("name")).toBe(false)
  })
})

describe("isSortHoldLive", () => {
  it("holds until the activity moves past what it was dropped with", () => {
    const hold = { key: 999, heldAt: 100 }
    expect(isSortHoldLive(hold, 100)).toBe(true)
    expect(isSortHoldLive(hold, 101)).toBe(false)
  })

  it("keeps a hold while the activity is unknown (not loaded yet)", () => {
    expect(isSortHoldLive({ key: 1, heldAt: 100 }, undefined)).toBe(true)
  })

  it("lets go of a draft's hold once it has activity of its own", () => {
    expect(isSortHoldLive({ key: 1, heldAt: null }, undefined)).toBe(true)
    expect(isSortHoldLive({ key: 1, heldAt: null }, 5)).toBe(false)
  })
})

describe("holdForRecentDrop", () => {
  it("holds a tab dragged to the front just above the first", () => {
    // a (oldest) dragged in front of c.
    const hold = holdForRecentDrop([A, C, B], "a", activity, undefined)
    expect(hold).toEqual({ key: 301, heldAt: 100 })
    expect(recent([A, B, C], new Map([["a", hold!]]))).toEqual(["a", "c", "b"])
  })

  it("holds a tab dropped between two others half way between them", () => {
    const hold = holdForRecentDrop([C, A, B], "a", activity, undefined)
    expect(hold).toEqual({ key: 250, heldAt: 100 })
    expect(recent([A, B, C], new Map([["a", hold!]]))).toEqual(["c", "a", "b"])
  })

  it("holds a tab dragged to the end just below the last dated one", () => {
    // c (newest) dragged past a (oldest).
    const hold = holdForRecentDrop([B, A, C], "c", activity, undefined)
    expect(hold).toEqual({ key: 99, heldAt: 300 })
    expect(recent([A, B, C], new Map([["c", hold!]]))).toEqual(["b", "a", "c"])
  })

  it("needs no hold where its own activity already puts it", () => {
    expect(holdForRecentDrop([C, B, A], "b", activity, undefined)).toBeNull()
    expect(holdForRecentDrop([A], "a", activity, undefined)).toBeNull()
  })

  it("places around other held tabs by their holds", () => {
    const holds = new Map([["a", { key: 301, heldAt: 100 }]])
    // Shown a, c, b; b dragged between a and c.
    const hold = holdForRecentDrop([A, B, C], "b", activity, holds)
    expect(hold).toEqual({ key: 300.5, heldAt: 200 })
  })

  it("puts a draft dragged ahead of other undated tabs above them", () => {
    const other = tab("other", null)
    const hold = holdForRecentDrop(
      [A, DRAFT, other],
      "draft",
      activity,
      undefined
    )
    expect(hold).toEqual({ key: 99, heldAt: null })
  })

  it("has no key between two tabs with no activity at all", () => {
    const x = tab("x", null)
    const y = tab("y", null)
    expect(holdForRecentDrop([C, x, A, y], "a", activity, undefined)).toBe(
      undefined
    )
  })
})

describe("recent sort with holds", () => {
  it("keeps a held tab in place while others sort by activity around it", () => {
    const holds = new Map([["a", { key: 250, heldAt: 100 }]])
    expect(recent([A, B, C], holds)).toEqual(["c", "a", "b"])
    // b becomes the newest: it moves to the front, a stays held.
    const later = new Map([...activity, [2, 400]])
    expect(
      ids(sortTabs([A, B, C], "recent", NO_ATTENTION, later, holds))
    ).toEqual(["b", "c", "a"])
  })

  it("sorts a held tab back to the front once its session has new activity", () => {
    const holds = new Map([["a", { key: 150, heldAt: 100 }]])
    const later = new Map([...activity, [1, 500]])
    expect(
      ids(sortTabs([A, B, C], "recent", NO_ATTENTION, later, holds))
    ).toEqual(["a", "c", "b"])
  })

  it("holds inside a folder group the same way", () => {
    const tabs = [A, B, C, tab("d", 4, 2)]
    const withD = new Map([...activity, [4, 50]])
    const holds = new Map([["a", { key: 301, heldAt: 100 }]])
    const { runs } = arrangeTabs(
      tabs,
      { groupBy: "folder", sort: "recent" },
      NO_ATTENTION,
      { activity: withD, holds }
    )
    expect(runs!.map((run) => ids(run.tabs))).toEqual([["a", "c", "b"], ["d"]])
  })

  it("ignores holds under every other sort", () => {
    const holds = new Map([["a", { key: 999, heldAt: 100 }]])
    expect(
      ids(sortTabs([C, B, A], "manual", NO_ATTENTION, activity, holds))
    ).toEqual(["c", "b", "a"])
  })
})
