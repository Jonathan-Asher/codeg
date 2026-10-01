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
  limit: number
}

function activityTime(conv: DbConversationSummary): number {
  const time = Date.parse(conv.updated_at)
  return Number.isNaN(time) ? 0 : time
}

/**
 * The sessions worth switching to, most recently active first: the rows the
 * sidebar lists (top-level, not deleted — delegation children and loop runs
 * are reached through their parent and the loops workbench instead).
 */
export function recentSessions(
  conversations: readonly DbConversationSummary[],
  options: RecentSessionOptions
): DbConversationSummary[] {
  const { knownFolderIds, excludeId, folderId, agentType, limit } = options
  return conversations
    .filter(
      (c) =>
        c.parent_id == null &&
        c.kind !== "delegate" &&
        c.kind !== "loop" &&
        c.id !== excludeId &&
        knownFolderIds.has(c.folder_id) &&
        (folderId == null || c.folder_id === folderId) &&
        (agentType == null || c.agent_type === agentType)
    )
    .sort((a, b) => activityTime(b) - activityTime(a) || b.id - a.id)
    .slice(0, limit)
}
