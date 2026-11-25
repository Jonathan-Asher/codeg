"use client"

import { create } from "zustand"
import {
  DEFAULT_TAB_VIEW,
  EMPTY_GROUP_ORDER,
  TAB_GROUP_BYS,
  TAB_SORTS,
  TAB_STATUS_BANDS,
  migrateArrangeMode,
  type TabGroupBy,
  type TabGroupOrder,
  type TabSort,
  type TabSortHold,
  type TabStatusBand,
  type TabView,
} from "@/lib/tab-arrangement"
import {
  DEFAULT_SESSION_OPEN_MODE,
  SESSION_OPEN_MODES,
  type SessionOpenMode,
} from "@/lib/session-open-decision"

/** Per-device display preferences, like the sidebar's view options. */
export const GROUP_BY_KEY = "workspace:tab-group-by"
export const SORT_KEY = "workspace:tab-sort"
/** The order of the groups themselves: `{ folder: number[], status: band[] }`. */
export const GROUP_ORDER_KEY = "workspace:tab-group-order"
/** The single setting grouping + sorting replaced; read once to migrate. */
export const LEGACY_MODE_KEY = "workspace:tab-arrange-mode"
/** Runs (folder groups / status bands, by run key) folded to their label. */
export const COLLAPSED_KEY = "workspace:tab-arrange-collapsed"
/** Tabs dragged on a recent-activity strip, held where they were dropped:
 *  `{ [tabId]: { key, heldAt } }` (see `TabSortHold`). */
export const SORT_HOLDS_KEY = "workspace:tab-sort-holds"
/** "When you open a session": smart / new_tab / replace. */
export const SESSION_OPEN_MODE_KEY = "workspace:session-open-mode"

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode / quota: the choice still applies for this session.
  }
}

function isOneOf<T extends string>(
  values: readonly T[],
  raw: string | null
): raw is T {
  return raw != null && (values as readonly string[]).includes(raw)
}

/**
 * The stored view. Once either new key exists it wins; before that, the old
 * single setting is migrated (and left in place, so an older build reading the
 * same storage still finds its own choice).
 */
export function loadView(): TabView {
  if (typeof window === "undefined") return DEFAULT_TAB_VIEW
  const groupBy = read(GROUP_BY_KEY)
  const sort = read(SORT_KEY)
  if (groupBy == null && sort == null) {
    return migrateArrangeMode(read(LEGACY_MODE_KEY)) ?? DEFAULT_TAB_VIEW
  }
  return {
    groupBy: isOneOf(TAB_GROUP_BYS, groupBy)
      ? groupBy
      : DEFAULT_TAB_VIEW.groupBy,
    sort: isOneOf(TAB_SORTS, sort) ? sort : DEFAULT_TAB_VIEW.sort,
  }
}

export function loadGroupOrder(): TabGroupOrder {
  if (typeof window === "undefined") return EMPTY_GROUP_ORDER
  try {
    const raw: unknown = JSON.parse(read(GROUP_ORDER_KEY) ?? "null")
    if (!raw || typeof raw !== "object") return EMPTY_GROUP_ORDER
    const { folder, status } = raw as { folder?: unknown; status?: unknown }
    return {
      folder: Array.isArray(folder)
        ? folder.filter((id): id is number => Number.isInteger(id))
        : [],
      status: Array.isArray(status)
        ? status.filter((band): band is TabStatusBand =>
            isOneOf(TAB_STATUS_BANDS, band)
          )
        : [],
    }
  } catch {
    return EMPTY_GROUP_ORDER
  }
}

/** The stored holds, junk entries dropped. */
export function loadSortHolds(): Record<string, TabSortHold> {
  if (typeof window === "undefined") return {}
  try {
    const raw: unknown = JSON.parse(read(SORT_HOLDS_KEY) ?? "null")
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const holds: Record<string, TabSortHold> = {}
    for (const [tabId, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue
      const { key, heldAt } = value as { key?: unknown; heldAt?: unknown }
      if (typeof key !== "number" || !Number.isFinite(key)) continue
      if (
        heldAt !== null &&
        (typeof heldAt !== "number" || !Number.isFinite(heldAt))
      )
        continue
      holds[tabId] = { key, heldAt }
    }
    return holds
  } catch {
    return {}
  }
}

export function loadSessionOpenMode(): SessionOpenMode {
  if (typeof window === "undefined") return DEFAULT_SESSION_OPEN_MODE
  const raw = read(SESSION_OPEN_MODE_KEY)
  return isOneOf(SESSION_OPEN_MODES, raw) ? raw : DEFAULT_SESSION_OPEN_MODE
}

function loadCollapsed(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = JSON.parse(read(COLLAPSED_KEY) ?? "[]")
    return Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : []
  } catch {
    return []
  }
}

interface TabArrangeState {
  groupBy: TabGroupBy
  sort: TabSort
  groupOrder: TabGroupOrder
  /** Run keys whose tabs are folded away (see `shownTabs`). */
  collapsedRuns: ReadonlySet<string>
  /** Tabs held where a drag put them on a recent-activity strip, by tab id.
   *  Cleared whenever the sort changes: a hold only means something against
   *  the activity order it was dropped into. */
  sortHolds: Readonly<Record<string, TabSortHold>>
  /** Where a session picked in the sidebar or ⌘K opens (see
   *  `lib/session-open-decision`). */
  sessionOpenMode: SessionOpenMode
  hydrated: boolean
  /** Read the stored choices. Called from an effect (not at module load) so the
   *  first client render matches the prerendered HTML. Idempotent. */
  hydrate: () => void
  /** Grouping by status while sorting by status would sort inside bands that
   *  are already one status each, so it switches the sort back to manual. */
  setGroupBy: (groupBy: TabGroupBy) => void
  setSort: (sort: TabSort) => void
  setFolderOrder: (folderIds: readonly number[]) => void
  setBandOrder: (bands: readonly TabStatusBand[]) => void
  toggleRunCollapsed: (runKey: string) => void
  /** Hold `tabId` (null: let it sort by activity again). */
  setSortHold: (tabId: string, hold: TabSortHold | null) => void
  /** Drop the holds of these tabs (released by new activity, or closed). */
  releaseSortHolds: (tabIds: readonly string[]) => void
  setSessionOpenMode: (mode: SessionOpenMode) => void
}

function writeHolds(holds: Readonly<Record<string, TabSortHold>>) {
  write(SORT_HOLDS_KEY, JSON.stringify(holds))
}

const NO_HOLDS: Readonly<Record<string, TabSortHold>> = {}

export const useTabArrangeStore = create<TabArrangeState>((set, get) => ({
  ...DEFAULT_TAB_VIEW,
  groupOrder: EMPTY_GROUP_ORDER,
  collapsedRuns: new Set(),
  sortHolds: NO_HOLDS,
  sessionOpenMode: DEFAULT_SESSION_OPEN_MODE,
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return
    set({
      ...loadView(),
      groupOrder: loadGroupOrder(),
      collapsedRuns: new Set(loadCollapsed()),
      sortHolds: loadSortHolds(),
      sessionOpenMode: loadSessionOpenMode(),
      hydrated: true,
    })
  },
  setGroupBy: (groupBy) => {
    const sort =
      groupBy === "status" && get().sort === "status" ? "manual" : get().sort
    write(GROUP_BY_KEY, groupBy)
    write(SORT_KEY, sort)
    set({ groupBy, sort, hydrated: true })
  },
  setSort: (sort) => {
    write(GROUP_BY_KEY, get().groupBy)
    write(SORT_KEY, sort)
    if (sort !== get().sort && Object.keys(get().sortHolds).length > 0) {
      writeHolds(NO_HOLDS)
      set({ sort, sortHolds: NO_HOLDS, hydrated: true })
      return
    }
    set({ sort, hydrated: true })
  },
  setFolderOrder: (folderIds) => {
    const groupOrder = { ...get().groupOrder, folder: [...folderIds] }
    write(GROUP_ORDER_KEY, JSON.stringify(groupOrder))
    set({ groupOrder })
  },
  setBandOrder: (bands) => {
    const groupOrder = { ...get().groupOrder, status: [...bands] }
    write(GROUP_ORDER_KEY, JSON.stringify(groupOrder))
    set({ groupOrder })
  },
  toggleRunCollapsed: (runKey) => {
    const next = new Set(get().collapsedRuns)
    if (next.has(runKey)) next.delete(runKey)
    else next.add(runKey)
    write(COLLAPSED_KEY, JSON.stringify([...next]))
    set({ collapsedRuns: next })
  },
  setSortHold: (tabId, hold) => {
    const current = get().sortHolds
    const known = current[tabId]
    if (hold == null) {
      if (!known) return
      const next = { ...current }
      delete next[tabId]
      writeHolds(next)
      set({ sortHolds: next })
      return
    }
    if (known && known.key === hold.key && known.heldAt === hold.heldAt) return
    const next = { ...current, [tabId]: hold }
    writeHolds(next)
    set({ sortHolds: next })
  },
  releaseSortHolds: (tabIds) => {
    const current = get().sortHolds
    if (!tabIds.some((id) => id in current)) return
    const next = { ...current }
    for (const id of tabIds) delete next[id]
    writeHolds(next)
    set({ sortHolds: next })
  },
  setSessionOpenMode: (mode) => {
    write(SESSION_OPEN_MODE_KEY, mode)
    set({ sessionOpenMode: mode })
  },
}))
