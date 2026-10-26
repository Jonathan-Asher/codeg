import type { AgentType, DbConversationSummary } from "@/lib/types"

export interface RecentSessionOptions {
  /** Folders that still exist; a row of any other folder is not listed. */
  knownFolderIds: ReadonlySet<number>
  /** The session already shown on its own (the current one). */
  excludeId?: number | null
  /** Only this folder's sessions, or every folder's when null. */
  folderId?: number | null
  /** Only this agent's sessions, or every agent's when null. */
  agentType?: AgentType | null
  /**
   * Folders whose sessions stay out of the list — the archived ones. Ignored
   * when `folderId` names one of them: narrowing to a folder is asking for
   * that folder's sessions, archived or not.
   */
  excludeFolderIds?: ReadonlySet<number>
  limit: number
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

/** The last activity in the session (ms): a turn, whoever started it. */
export function activityTime(conv: DbConversationSummary): number {
  return parseTime(conv.updated_at)
}

/** When the user last opened the session (ms), or 0 if never. */
export function viewedTime(conv: DbConversationSummary): number {
  return parseTime(conv.last_viewed_at)
}

/** The later of the session's last activity and the user's last view. */
export function recencyTime(conv: DbConversationSummary): number {
  return Math.max(activityTime(conv), viewedTime(conv))
}

/**
 * Like a browser's history: a session moves up when something happens in it
 * AND when the user opens it. The sidebar's Recent section reads this order.
 */
export function compareByRecencyDesc(
  a: DbConversationSummary,
  b: DbConversationSummary
): number {
  return (
    recencyTime(b) - recencyTime(a) ||
    activityTime(b) - activityTime(a) ||
    b.id - a.id
  )
}

/**
 * The session switcher's order, like Alt-Tab: most recently opened first, so
 * opening the switcher and pressing Enter goes back to the session viewed just
 * before the current one, whatever a background agent did elsewhere since.
 * Sessions never opened follow, most recently active first.
 */
export function compareBySwitchOrder(
  a: DbConversationSummary,
  b: DbConversationSummary
): number {
  // Never opened reads as 0, so every opened session sorts above them all.
  return (
    viewedTime(b) - viewedTime(a) ||
    activityTime(b) - activityTime(a) ||
    b.id - a.id
  )
}

/** Sorts newest first by `first`, then `second`, then id, reading each
 *  row's times once (the lists re-sort on every row update). */
function sortedBy(
  list: readonly DbConversationSummary[],
  first: (conv: DbConversationSummary) => number,
  second: (conv: DbConversationSummary) => number
): DbConversationSummary[] {
  return list
    .map((conv) => ({ conv, first: first(conv), second: second(conv) }))
    .sort(
      (a, b) =>
        b.first - a.first || b.second - a.second || b.conv.id - a.conv.id
    )
    .map((keyed) => keyed.conv)
}

/** `list` in {@link compareByRecencyDesc} order, as a new array. */
export function sortByRecencyDesc(
  list: readonly DbConversationSummary[]
): DbConversationSummary[] {
  return sortedBy(list, recencyTime, activityTime)
}

/** `list` in {@link compareBySwitchOrder} order, as a new array. */
export function sortBySwitchOrder(
  list: readonly DbConversationSummary[]
): DbConversationSummary[] {
  return sortedBy(list, viewedTime, activityTime)
}

/**
 * The sessions worth switching to, in switcher order
 * ({@link compareBySwitchOrder}): the rows the sidebar lists (top-level, not
 * deleted — delegation children and loop runs are reached through their
 * parent and the loops workbench instead).
 */
export function recentSessions(
  conversations: readonly DbConversationSummary[],
  options: RecentSessionOptions
): DbConversationSummary[] {
  const {
    knownFolderIds,
    excludeId,
    folderId,
    agentType,
    excludeFolderIds,
    limit,
  } = options
  const listed = conversations.filter(
    (c) =>
      c.parent_id == null &&
      c.kind !== "delegate" &&
      c.kind !== "loop" &&
      c.id !== excludeId &&
      knownFolderIds.has(c.folder_id) &&
      (folderId == null || c.folder_id === folderId) &&
      (folderId != null ||
        excludeFolderIds == null ||
        !excludeFolderIds.has(c.folder_id)) &&
      (agentType == null || c.agent_type === agentType)
  )
  return sortBySwitchOrder(listed).slice(0, limit)
}
