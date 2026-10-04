"use client"

import { useEffect, useMemo } from "react"
import type { DbConversationSummary } from "@/lib/types"
import {
  arrangeTabs,
  effectiveSort,
  shownTabs,
  type ArrangedTabs,
} from "@/lib/tab-arrangement"
import type { TabItem } from "@/stores/tab-store"
import { useTabStore } from "@/stores/tab-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import { useConversationAttentionStore } from "@/stores/conversation-attention-store"

const NO_CONVERSATIONS: DbConversationSummary[] = []
const NO_CHILDREN = new Map<number, DbConversationSummary>()
const NO_ACTIVITY: ReadonlyMap<number, number> = new Map()

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Latest activity per conversation id (ms), the same `updated_at` the
 * sidebar's "recently updated" order uses. Only subscribed while `enabled`, so
 * a strip that isn't sorted by recent activity doesn't re-render on every
 * conversation update.
 */
function useTabActivity(enabled: boolean): ReadonlyMap<number, number> {
  const conversations = useAppWorkspaceStore((s) =>
    enabled ? s.conversations : NO_CONVERSATIONS
  )
  const childSummaries = useTabStore((s) =>
    enabled ? s.childSummaries : NO_CHILDREN
  )
  return useMemo(() => {
    if (!enabled) return NO_ACTIVITY
    const activity = new Map<number, number>()
    for (const summary of [...childSummaries.values(), ...conversations]) {
      const at = parseTime(summary.updated_at)
      if (at != null) activity.set(summary.id, at)
    }
    return activity
  }, [enabled, conversations, childSummaries])
}

/**
 * A strip's tabs as displayed: grouped and sorted per the user's view
 * choices, with collapsed groups folded away. Shared by the tab strips and the
 * tab-switching shortcuts so both walk exactly the same order.
 */
export function useArrangedTabs(
  tabs: readonly TabItem[],
  activeTabId: string | null
): {
  arranged: ArrangedTabs<TabItem>
  shown: readonly TabItem[]
} {
  const groupBy = useTabArrangeStore((s) => s.groupBy)
  const sort = useTabArrangeStore((s) => s.sort)
  const groupOrder = useTabArrangeStore((s) => s.groupOrder)
  const collapsedRuns = useTabArrangeStore((s) => s.collapsedRuns)
  const attention = useConversationAttentionStore((s) => s.byConversationId)
  useEffect(() => {
    useTabArrangeStore.getState().hydrate()
  }, [])
  const activity = useTabActivity(effectiveSort({ groupBy, sort }) === "recent")
  const arranged = useMemo(
    () =>
      arrangeTabs(tabs, { groupBy, sort }, attention, {
        groupOrder,
        activity,
      }),
    [tabs, groupBy, sort, attention, groupOrder, activity]
  )
  const shown = useMemo(
    () => shownTabs(arranged, collapsedRuns, activeTabId),
    [arranged, collapsedRuns, activeTabId]
  )
  return { arranged, shown }
}
