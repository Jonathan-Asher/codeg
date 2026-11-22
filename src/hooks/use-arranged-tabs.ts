"use client"

import { useCallback, useEffect, useMemo } from "react"
import type { DbConversationSummary } from "@/lib/types"
import {
  arrangeTabs,
  effectiveSort,
  shownTabs,
  type ArrangedTabs,
} from "@/lib/tab-arrangement"
import type { TabItem } from "@/stores/tab-store"
import { groupOfTab, isTabInScope, useTabStore } from "@/stores/tab-store"
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

/** Latest activity per conversation id (ms): the `updated_at` the sidebar's
 *  "recently updated" order uses. */
function tabActivity(
  conversations: readonly DbConversationSummary[],
  childSummaries: ReadonlyMap<number, DbConversationSummary>
): ReadonlyMap<number, number> {
  const activity = new Map<number, number>()
  for (const summary of [...childSummaries.values(), ...conversations]) {
    const at = parseTime(summary.updated_at)
    if (at != null) activity.set(summary.id, at)
  }
  return activity
}

/**
 * {@link tabActivity}, only subscribed while `enabled`, so a strip that isn't
 * sorted by recent activity doesn't re-render on every conversation update.
 */
function useTabActivity(enabled: boolean): ReadonlyMap<number, number> {
  const conversations = useAppWorkspaceStore((s) =>
    enabled ? s.conversations : NO_CONVERSATIONS
  )
  const childSummaries = useTabStore((s) =>
    enabled ? s.childSummaries : NO_CHILDREN
  )
  return useMemo(
    () => (enabled ? tabActivity(conversations, childSummaries) : NO_ACTIVITY),
    [enabled, conversations, childSummaries]
  )
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

/**
 * "Switch to manual order": the order the strips show right now becomes the
 * manual order, then the sort goes to Manual — so no tab moves, and from then
 * on every tab drags. Each split group's strip keeps its own order (only that
 * group's slots are rewritten). The grouping stays as it is.
 *
 * Only ever run on the user's explicit pick: it changes their sort setting.
 */
export function useSwitchToManualOrder(): () => void {
  return useCallback(() => {
    const view = useTabArrangeStore.getState()
    if (effectiveSort(view) === "manual") return
    const st = useTabStore.getState()
    const attention = useConversationAttentionStore.getState().byConversationId
    const activity = tabActivity(
      useAppWorkspaceStore.getState().conversations,
      st.childSummaries
    )
    const byGroup = new Map<string, TabItem[]>()
    for (const tab of st.tabs) {
      if (!isTabInScope(tab)) continue
      const groupId = groupOfTab(st.groupOf, st.groupLayout, tab.id)
      const list = byGroup.get(groupId)
      if (list) list.push(tab)
      else byGroup.set(groupId, [tab])
    }
    const split = st.groupLayout.type !== "group"
    for (const [groupId, list] of byGroup) {
      const { ordered } = arrangeTabs(list, view, attention, {
        groupOrder: view.groupOrder,
        activity,
      })
      if (split) st.reorderGroupTabs(groupId, [...ordered])
      else st.reorderTabs([...ordered])
    }
    view.setSort("manual")
  }, [])
}
