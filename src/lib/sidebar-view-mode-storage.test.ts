import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_FOLDER_SESSION_LIMIT,
  DEFAULT_SECTION_ORDER,
  FOLDER_SESSION_LIMIT_OPTIONS,
  folderSessionLimitValue,
  loadFolderSessionLimit,
  loadFolderShowAll,
  loadSectionCollapsed,
  loadSectionOrder,
  loadShowRecent,
  loadSortMode,
  moveSectionInOrder,
  normalizeSectionOrder,
  parseFolderSessionLimit,
  saveFolderSessionLimit,
  saveFolderShowAll,
  saveSectionOrder,
  saveShowRecent,
  saveSortMode,
} from "./sidebar-view-mode-storage"

const SECTION_ORDER_KEY = "workspace:sidebar-section-order"
const SHOW_RECENT_KEY = "workspace:sidebar-show-recent"

describe("normalizeSectionOrder", () => {
  it("passes a complete order through unchanged", () => {
    expect(normalizeSectionOrder(["recent", "chats", "folders"])).toEqual([
      "recent",
      "chats",
      "folders",
    ])
  })

  it("appends missing sections in default order", () => {
    // Forward compatibility in reverse: a store written before "Recent" existed
    // gets it at the bottom rather than losing the section entirely.
    expect(normalizeSectionOrder(["chats", "folders"])).toEqual([
      "chats",
      "folders",
      "recent",
    ])
  })

  it("drops unknown entries and repeats", () => {
    expect(
      normalizeSectionOrder(["recent", "bogus", "recent", 7, null, "chats"])
    ).toEqual(["recent", "chats", "folders"])
  })

  it("migrates the legacy two-way strings, preserving the user's choice", () => {
    expect(normalizeSectionOrder("chats-first")).toEqual([
      "chats",
      "folders",
      "recent",
    ])
    expect(normalizeSectionOrder("folders-first")).toEqual(
      DEFAULT_SECTION_ORDER
    )
  })

  it("falls back to the default for anything unusable", () => {
    expect(normalizeSectionOrder(undefined)).toEqual(DEFAULT_SECTION_ORDER)
    expect(normalizeSectionOrder("nonsense")).toEqual(DEFAULT_SECTION_ORDER)
    expect(normalizeSectionOrder({ folders: 1 })).toEqual(DEFAULT_SECTION_ORDER)
    expect(normalizeSectionOrder([])).toEqual(DEFAULT_SECTION_ORDER)
  })
})

describe("moveSectionInOrder", () => {
  const order = ["folders", "chats", "recent"] as const

  it("moves a section one slot in either direction", () => {
    expect(moveSectionInOrder(order, "recent", -1)).toEqual([
      "folders",
      "recent",
      "chats",
    ])
    expect(moveSectionInOrder(order, "folders", 1)).toEqual([
      "chats",
      "folders",
      "recent",
    ])
  })

  it("moves across multiple slots", () => {
    expect(moveSectionInOrder(order, "recent", -2)).toEqual([
      "recent",
      "folders",
      "chats",
    ])
  })

  it("returns the SAME reference for a move that would fall off an end", () => {
    // Identity matters: the sidebar skips the state update and the localStorage
    // write when a clamped nudge changes nothing.
    expect(moveSectionInOrder(order, "folders", -1)).toBe(order)
    expect(moveSectionInOrder(order, "recent", 1)).toBe(order)
    expect(moveSectionInOrder(order, "chats", 0)).toBe(order)
  })
})

describe("section-order persistence", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips through localStorage", () => {
    saveSectionOrder(["recent", "folders", "chats"])
    expect(loadSectionOrder()).toEqual(["recent", "folders", "chats"])
  })

  it("defaults to Folders → Chat → Recent with nothing stored", () => {
    expect(loadSectionOrder()).toEqual(["folders", "chats", "recent"])
  })

  it("migrates a legacy bare string left by an older build", () => {
    // The old format was not JSON, so the loader must survive the parse failure
    // rather than resetting the user's preference.
    localStorage.setItem(SECTION_ORDER_KEY, "chats-first")
    expect(loadSectionOrder()).toEqual(["chats", "folders", "recent"])
  })

  it("falls back to the default for corrupt JSON", () => {
    localStorage.setItem(SECTION_ORDER_KEY, "{oops")
    expect(loadSectionOrder()).toEqual(DEFAULT_SECTION_ORDER)
  })
})

describe("loadShowRecent", () => {
  beforeEach(() => localStorage.clear())

  it("defaults to on", () => {
    expect(loadShowRecent()).toBe(true)
  })

  it("respects an explicitly-stored false", () => {
    saveShowRecent(false)
    expect(localStorage.getItem(SHOW_RECENT_KEY)).toBe("false")
    expect(loadShowRecent()).toBe(false)
    saveShowRecent(true)
    expect(loadShowRecent()).toBe(true)
  })
})

describe("loadSectionCollapsed", () => {
  beforeEach(() => localStorage.clear())

  it("reads the recent section's collapsed flag", () => {
    localStorage.setItem(
      "workspace:sidebar-section-collapsed",
      JSON.stringify({ recent: true, chats: false, bogus: 1 })
    )
    expect(loadSectionCollapsed()).toEqual({ recent: true, chats: false })
  })
})

describe("loadSortMode", () => {
  beforeEach(() => localStorage.clear())

  it("puts the most recently active sessions first by default", () => {
    expect(loadSortMode()).toBe("updated")
  })

  it("keeps a sort order the user picked", () => {
    saveSortMode("created")
    expect(loadSortMode()).toBe("created")
  })
})

describe("folder session limit", () => {
  const LIMIT_KEY = "workspace:sidebar-folder-session-limit"
  beforeEach(() => localStorage.clear())

  it("shows three sessions per folder by default", () => {
    expect(DEFAULT_FOLDER_SESSION_LIMIT).toBe(3)
    expect(loadFolderSessionLimit()).toBe(3)
  })

  it("round-trips every option the menu offers", () => {
    for (const option of FOLDER_SESSION_LIMIT_OPTIONS) {
      saveFolderSessionLimit(option)
      expect(loadFolderSessionLimit()).toBe(option)
    }
    expect(localStorage.getItem(LIMIT_KEY)).toBe("all")
  })

  it("falls back to the default for anything the menu never offered", () => {
    for (const bad of ["7", "", "ALL", "{", "3.5", "-3"]) {
      localStorage.setItem(LIMIT_KEY, bad)
      expect(loadFolderSessionLimit()).toBe(DEFAULT_FOLDER_SESSION_LIMIT)
    }
    expect(parseFolderSessionLimit(null)).toBe(DEFAULT_FOLDER_SESSION_LIMIT)
    expect(parseFolderSessionLimit(10)).toBe(10)
    expect(parseFolderSessionLimit("5")).toBe(5)
  })

  it("maps All to no cap and a count to itself", () => {
    expect(folderSessionLimitValue("all")).toBeNull()
    expect(folderSessionLimitValue(3)).toBe(3)
    expect(folderSessionLimitValue(10)).toBe(10)
  })
})

describe("folder show-all persistence", () => {
  const SHOW_ALL_KEY = "workspace:sidebar-folder-show-all"
  beforeEach(() => localStorage.clear())

  it("is empty with nothing stored", () => {
    expect(loadFolderShowAll()).toEqual({})
  })

  it("round-trips the folders opened up, storing only true entries", () => {
    saveFolderShowAll({ 1: true, 2: false, 7: true })
    expect(JSON.parse(localStorage.getItem(SHOW_ALL_KEY) ?? "null")).toEqual({
      1: true,
      7: true,
    })
    expect(loadFolderShowAll()).toEqual({ 1: true, 7: true })
  })

  it("drops junk entries and survives corrupt storage", () => {
    localStorage.setItem(
      SHOW_ALL_KEY,
      JSON.stringify({ 3: true, x: true, 4: "yes", 5: false })
    )
    expect(loadFolderShowAll()).toEqual({ 3: true })
    localStorage.setItem(SHOW_ALL_KEY, "[1,2]")
    expect(loadFolderShowAll()).toEqual({})
    localStorage.setItem(SHOW_ALL_KEY, "{oops")
    expect(loadFolderShowAll()).toEqual({})
  })
})
