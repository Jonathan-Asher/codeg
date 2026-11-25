"use client"

import { useCallback, useEffect, useMemo } from "react"
import type { DbConversationSummary } from "@/lib/types"
import {
  arrangeTabs,
  effectiveSort,
  isSortHoldLive,
  shownTabs,
  type ArrangedTabs,
  type TabSortHold,
} from "@/lib/tab-arrangement"
import type { TabItem } from "@/stores/tab-store"
import { groupOfTab, isTabInScope, useTabStore } from "@/stores/tab-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import { useConversationAttentionStore } from "@/stores/conversation-attention-store"

const NO_CONVERSATIONS: DbConversationSummary[] = []
const NO_CHILDREN = new Map<number, DbConversationSummary>()
const NO_ACTIVITY: ReadonlyMap<number, number> = new Map()
const NO_HOLDS: ReadonlyMap<string, TabSortHold> = new Map()

function holdsMap(
  record: Readonly<Record<string, TabSortHold>>
): ReadonlyMap<string, TabSortHold> {
  const keys = Object.keys(record)
  return keys.length === 0
    ? NO_HOLDS
    : new Map(keys.map((id) => [id, record[id]]))
}

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
 * Let go of the holds whose tab shows newer activity than when it was
 * dropped, or is no longer open. The arrangement already ignores a released
 * hold; this keeps the stored ones from piling up. Only once the tab set is
 * known — while it is still loading, every tab would read as closed.
 */
function useReleaseStaleHolds(
  enabled: boolean,
  activity: ReadonlyMap<number, number>,
  holds: Readonly<Record<string, TabSortHold>>
) {
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  useEffect(() => {
    if (!enabled || !tabsHydrated) return
    const ids = Object.keys(holds)
    if (ids.length === 0) return
    const open = new Map(useTabStore.getState().tabs.map((t) => [t.id, t]))
    const stale = ids.filter((id) => {
      const tab = open.get(id)
      if (!tab) return true
      const own =
        tab.conversationId != null
          ? activity.get(tab.conversationId)
          : undefined
      return !isSortHoldLive(holds[id], own)
    })
    if (stale.length > 0) {
      useTabArrangeStore.getState().releaseSortHolds(stale)
    }
  }, [enabled, tabsHydrated, activity, holds])
}

/**
 * A strip's tabs as displayed: grouped and sorted per the user's view
 * choices, with collapsed groups folded away. Shared by the tab strips and the
 * tab-switching shortcuts so both walk exactly the same order.
 *
 * Under the recent-activity sort it also hands back what that order is made
 * of — the activity per conversation and the holds of dragged tabs — so a drag
 * can work out where its tab now sits.
 */
export function useArrangedTabs(
  tabs: readonly TabItem[],
  activeTabId: string | null
): {
  arranged: ArrangedTabs<TabItem>
  shown: readonly TabItem[]
  activity: ReadonlyMap<number, number>
  holds: ReadonlyMap<string, TabSortHold>
} {
  const groupBy = useTabArrangeStore((s) => s.groupBy)
  const sort = useTabArrangeStore((s) => s.sort)
  const groupOrder = useTabArrangeStore((s) => s.groupOrder)
  const collapsedRuns = useTabArrangeStore((s) => s.collapsedRuns)
  const recent = effectiveSort({ groupBy, sort }) === "recent"
  const holdRecord = useTabArrangeStore((s) => s.sortHolds)
  const attention = useConversationAttentionStore((s) => s.byConversationId)
  useEffect(() => {
    useTabArrangeStore.getState().hydrate()
  }, [])
  const activity = useTabActivity(recent)
  const holds = useMemo(
    () => (recent ? holdsMap(holdRecord) : NO_HOLDS),
    [recent, holdRecord]
  )
  useReleaseStaleHolds(recent, activity, holdRecord)
  const arranged = useMemo(
    () =>
      arrangeTabs(tabs, { groupBy, sort }, attention, {
        groupOrder,
        activity,
        holds,
      }),
    [tabs, groupBy, sort, attention, groupOrder, activity, holds]
  )
  const shown = useMemo(
    () => shownTabs(arranged, collapsedRuns, activeTabId),
    [arranged, collapsedRuns, activeTabId]
  )
  return { arranged, shown, activity, holds }
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
    // A held tab stays where it is on screen, so where it was dropped.
    const holds = holdsMap(view.sortHolds)
    for (const [groupId, list] of byGroup) {
      const { ordered } = arrangeTabs(list, view, attention, {
        groupOrder: view.groupOrder,
        activity,
        holds,
      })
      if (split) st.reorderGroupTabs(groupId, [...ordered])
      else st.reorderTabs([...ordered])
    }
    view.setSort("manual")
  }, [])
}
