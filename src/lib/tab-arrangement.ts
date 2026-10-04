import type { AttentionKind, ConversationStatus } from "@/lib/types"
import {
  FOLDER_THEME_COLOR_INHERIT,
  normalizeFolderThemeColor,
  type ThemeColor,
} from "@/lib/theme-presets"

/**
 * How the conversation tab strip is laid out: two independent DISPLAY
 * choices. Grouping splits the strip into labelled runs (folder groups or
 * status bands); sorting orders the tabs inside each run (or the whole strip
 * when ungrouped).
 *
 * The underlying order (`rawTabs`, persisted via `save_opened_tabs`) is the
 * manual order. Grouping and the non-manual sorts never rewrite it; only a drag
 * under `manual` sorting does (see {@link reinsertInGroupOrder}), so switching
 * back to no grouping always shows the order the user dragged.
 */
export const TAB_GROUP_BYS = ["none", "folder", "status"] as const
export type TabGroupBy = (typeof TAB_GROUP_BYS)[number]

export const TAB_SORTS = ["manual", "status", "recent", "name"] as const
export type TabSort = (typeof TAB_SORTS)[number]

export interface TabView {
  groupBy: TabGroupBy
  sort: TabSort
}

export const DEFAULT_TAB_VIEW: TabView = { groupBy: "none", sort: "manual" }

/** Status bands, most urgent first. */
export const TAB_STATUS_BANDS = [
  "needs_you",
  "awaiting_reply",
  "running",
  "other",
] as const
export type TabStatusBand = (typeof TAB_STATUS_BANDS)[number]

/**
 * The user's order of the groups themselves, per grouping: folder ids for
 * folder grouping, bands for status grouping. A folder with no entry here goes
 * after the placed ones, in the order its first tab appears; a band with no
 * entry goes after the placed ones, in the default urgency order.
 */
export interface TabGroupOrder {
  folder: readonly number[]
  status: readonly TabStatusBand[]
}

export const EMPTY_GROUP_ORDER: TabGroupOrder = { folder: [], status: [] }

/**
 * The single setting this replaced (`workspace:tab-arrange-mode`): "manual",
 * "folder" (group by folder) or "status" (group by status). Every old mode
 * grouped while keeping the manual order inside each group, so it maps onto
 * the same grouping with manual sorting. Anything else → null.
 */
export function migrateArrangeMode(
  raw: string | null | undefined
): TabView | null {
  switch (raw) {
    case "manual":
      return { groupBy: "none", sort: "manual" }
    case "folder":
      return { groupBy: "folder", sort: "manual" }
    case "status":
      return { groupBy: "status", sort: "manual" }
    default:
      return null
  }
}

/**
 * The sort that actually applies. Sorting by status inside status bands is a
 * no-op (every tab in a band has the same status), so that combination keeps
 * the manual order — and with it, dragging tabs inside a band.
 */
export function effectiveSort(view: TabView): TabSort {
  return view.groupBy === "status" && view.sort === "status"
    ? "manual"
    : view.sort
}

interface ArrangeableTab {
  id: string
  folderId: number
  conversationId: number | null
  status?: ConversationStatus
  title?: string
}

export type TabRun<T> =
  | { kind: "folder"; key: string; folderId: number; tabs: T[] }
  | { kind: "status"; key: string; band: TabStatusBand; tabs: T[] }

export interface ArrangedTabs<T> {
  ordered: readonly T[]
  /** Null when ungrouped. */
  runs: TabRun<T>[] | null
}

/**
 * - `needs_you`: blocked on a permission, a question or a plan approval (the
 *   same signal as the sidebar's rose indicator);
 * - `awaiting_reply`: the agent finished its turn and it's the user's move
 *   (`pending_review`);
 * - `running`: a turn in flight;
 * - `other`: done, cancelled, or a draft with nothing sent yet.
 */
export function tabStatusBand(
  tab: ArrangeableTab,
  attention: ReadonlyMap<number, AttentionKind>
): TabStatusBand {
  if (tab.conversationId != null && attention.has(tab.conversationId)) {
    return "needs_you"
  }
  if (tab.status === "pending_review") return "awaiting_reply"
  if (tab.status === "in_progress") return "running"
  return "other"
}

/** The bands in the user's order: placed ones first, the rest in urgency
 *  order. Unknown or repeated entries are dropped. */
export function bandOrder(
  persisted: readonly string[]
): readonly TabStatusBand[] {
  const seen = new Set<TabStatusBand>()
  for (const band of persisted) {
    if ((TAB_STATUS_BANDS as readonly string[]).includes(band)) {
      seen.add(band as TabStatusBand)
    }
  }
  for (const band of TAB_STATUS_BANDS) seen.add(band)
  return [...seen]
}

let nameCollator: Intl.Collator | null = null
function compareNames(a: string, b: string): number {
  nameCollator ??= new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  })
  return nameCollator.compare(a, b)
}

/**
 * `tabs` ordered by `sort`. Always stable (Array#sort is), so ties keep the
 * manual order. Returns the same array for `manual`.
 *
 * - `status`: most urgent band first;
 * - `recent`: latest activity (`activity`, ms by conversation id) first; a tab
 *   with no known activity (a draft, a conversation not loaded) goes last;
 * - `name`: by title, natural order ("Tab 2" before "Tab 10"), case-blind.
 */
export function sortTabs<T extends ArrangeableTab>(
  tabs: readonly T[],
  sort: TabSort,
  attention: ReadonlyMap<number, AttentionKind>,
  activity?: ReadonlyMap<number, number>
): readonly T[] {
  if (sort === "manual" || tabs.length < 2) return tabs
  if (sort === "status") {
    const rank = new Map(tabs.map((tab) => [tab, bandRank(tab, attention)]))
    return [...tabs].sort((a, b) => rank.get(a)! - rank.get(b)!)
  }
  if (sort === "recent") {
    const at = (tab: T) =>
      tab.conversationId != null
        ? (activity?.get(tab.conversationId) ?? -Infinity)
        : -Infinity
    return [...tabs].sort((a, b) => {
      const x = at(a)
      const y = at(b)
      return x === y ? 0 : x > y ? -1 : 1
    })
  }
  return [...tabs].sort((a, b) => compareNames(a.title ?? "", b.title ?? ""))
}

function bandRank(
  tab: ArrangeableTab,
  attention: ReadonlyMap<number, AttentionKind>
): number {
  return TAB_STATUS_BANDS.indexOf(tabStatusBand(tab, attention))
}

/**
 * Lay the strip out for `view`.
 *
 * Grouped: folder groups follow `groupOrder.folder` (unplaced folders after,
 * in the order their first tab appears); status bands follow
 * `groupOrder.status` (see {@link bandOrder}) and empty bands are skipped.
 * Inside each run the tabs are ordered by the sort — under `manual`, that is
 * the manual order, so nothing jumps around except what changed group.
 *
 * `ordered` keeps the tab objects' identity (the strip's reorder list keys on
 * them) and is the very array passed in when nothing is grouped or sorted;
 * `runs` is null when ungrouped.
 */
export function arrangeTabs<T extends ArrangeableTab>(
  tabs: readonly T[],
  view: TabView,
  attention: ReadonlyMap<number, AttentionKind>,
  options: {
    groupOrder?: TabGroupOrder
    activity?: ReadonlyMap<number, number>
  } = {}
): ArrangedTabs<T> {
  const sort = effectiveSort(view)
  const { groupOrder = EMPTY_GROUP_ORDER, activity } = options
  const sorted = (list: readonly T[]) =>
    sortTabs(list, sort, attention, activity)

  if (view.groupBy === "none") return { ordered: sorted(tabs), runs: null }

  let runs: TabRun<T>[]
  if (view.groupBy === "folder") {
    const byFolder = new Map<number, T[]>()
    for (const tab of tabs) {
      const list = byFolder.get(tab.folderId)
      if (list) list.push(tab)
      else byFolder.set(tab.folderId, [tab])
    }
    const rank = new Map(groupOrder.folder.map((id, i) => [id, i]))
    // Map iteration is first-appearance order; the stable sort keeps it for
    // every unplaced folder.
    runs = [...byFolder]
      .sort(([a], [b]) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
      .map(([folderId, list]) => ({
        kind: "folder" as const,
        key: folderRunKey(folderId),
        folderId,
        tabs: [...sorted(list)],
      }))
  } else {
    const byBand = new Map<TabStatusBand, T[]>()
    for (const tab of tabs) {
      const band = tabStatusBand(tab, attention)
      const list = byBand.get(band)
      if (list) list.push(tab)
      else byBand.set(band, [tab])
    }
    runs = bandOrder(groupOrder.status)
      .filter((band) => byBand.has(band))
      .map((band) => ({
        kind: "status" as const,
        key: statusRunKey(band),
        band,
        tabs: [...sorted(byBand.get(band)!)],
      }))
  }
  return { ordered: runs.flatMap((run) => run.tabs), runs }
}

export function folderRunKey(folderId: number): string {
  return `folder-${folderId}`
}

export function statusRunKey(band: TabStatusBand): string {
  return `status-${band}`
}

/**
 * The tabs a strip actually shows, in display order: the arrangement with the
 * collapsed runs folded away. A collapsed run keeps only the active tab, so the
 * tab being worked in never disappears behind its group's label. Ungrouped,
 * nothing collapses. This is also the order the tab-switching shortcuts walk:
 * they follow what is on screen, not the manual order behind a grouped or
 * sorted strip.
 */
export function shownTabs<T extends { id: string }>(
  arranged: ArrangedTabs<T>,
  collapsedRuns: ReadonlySet<string>,
  activeTabId: string | null
): readonly T[] {
  if (!arranged.runs) return arranged.ordered
  return arranged.runs.flatMap((run) =>
    collapsedRuns.has(run.key)
      ? run.tabs.filter((tab) => tab.id === activeTabId)
      : run.tabs
  )
}

/**
 * Write a drag inside one group back to the manual order.
 *
 * `strip` is the strip's manual order (all its tabs, every group);
 * `groupOrder` is the dragged tab's group in its new on-screen order. Only the
 * moved tab moves: it is re-inserted right after the group-mate now before it
 * (or right before the one now after it, when it became the group's first).
 * Every other tab — the rest of its group and every other group — keeps its
 * place, so the other groups' relative order is never scrambled.
 *
 * Returns null when the manual order does not change.
 */
export function reinsertInGroupOrder<T extends { id: string }>(
  strip: readonly T[],
  groupOrder: readonly string[],
  movedId: string
): T[] | null {
  const from = strip.findIndex((tab) => tab.id === movedId)
  const at = groupOrder.indexOf(movedId)
  if (from < 0 || at < 0) return null
  // Already in this order among its group-mates: leave the manual order be,
  // rather than pulling the tab up against its neighbour.
  const members = new Set(groupOrder)
  const current = strip.filter((tab) => members.has(tab.id))
  if (
    current.length === groupOrder.length &&
    current.every((tab, i) => tab.id === groupOrder[i])
  ) {
    return null
  }
  const moved = strip[from]
  const rest = strip.filter((_, i) => i !== from)

  let insertAt = -1
  if (at > 0) {
    const before = rest.findIndex((tab) => tab.id === groupOrder[at - 1])
    if (before >= 0) insertAt = before + 1
  }
  if (insertAt < 0 && at + 1 < groupOrder.length) {
    const after = rest.findIndex((tab) => tab.id === groupOrder[at + 1])
    if (after >= 0) insertAt = after
  }
  if (insertAt < 0) return null

  const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)]
  return next.every((tab, i) => tab === strip[i]) ? null : next
}

/**
 * Fold a new on-screen order of groups into the persisted group order.
 *
 * `shown` is every group currently on screen, in its new order. Groups placed
 * before but not on screen now (a folder whose tabs are all closed) keep their
 * position; groups never placed are appended. The on-screen groups then take
 * the slots they occupy, in their new order.
 */
export function mergeGroupOrder<K>(
  persisted: readonly K[],
  shown: readonly K[]
): K[] {
  const shownSet = new Set(shown)
  const known = new Set(persisted)
  const full = [...persisted, ...shown.filter((key) => !known.has(key))]
  let next = 0
  return full.map((key) => (shownSet.has(key) ? shown[next++] : key))
}

/**
 * The groups' order after dropping `dragged` at `dropIndex` — an insertion
 * point among `keys` (0 = before the first, `keys.length` = after the last),
 * counted on the order before the drop. Null when it lands where it was.
 */
export function moveGroupKey<K>(
  keys: readonly K[],
  dragged: K,
  dropIndex: number
): K[] | null {
  const from = keys.indexOf(dragged)
  if (from < 0) return null
  const to = Math.max(0, Math.min(keys.length, dropIndex))
  if (to === from || to === from + 1) return null
  const rest = keys.filter((_, i) => i !== from)
  const at = to > from ? to - 1 : to
  return [...rest.slice(0, at), dragged, ...rest.slice(at)]
}

/** Distinct, saturated presets for folders the user never colored — so every
 *  group under folder grouping is told apart by color, not just by its label. */
const AUTO_FOLDER_COLORS: readonly ThemeColor[] = [
  "blue",
  "green",
  "violet",
  "orange",
  "rose",
  "yellow",
  "red",
]

/** The color a folder's tab group is drawn in: its own theme color when set,
 *  otherwise a stable pick from {@link AUTO_FOLDER_COLORS} by folder id. */
export function folderAccentColor(
  folderId: number,
  rawColor: string | null | undefined
): ThemeColor {
  const color = normalizeFolderThemeColor(rawColor)
  if (color !== FOLDER_THEME_COLOR_INHERIT) return color
  const n = AUTO_FOLDER_COLORS.length
  return AUTO_FOLDER_COLORS[((folderId % n) + n) % n]
}

/** Band colors, matching the rest of the app: rose = waiting on you (the
 *  sidebar indicator), blue = review, yellow = in progress (the status dots).
 *  `other` stays neutral. */
export const STATUS_BAND_COLOR: Record<TabStatusBand, ThemeColor | null> = {
  needs_you: "rose",
  awaiting_reply: "blue",
  running: "yellow",
  other: null,
}
