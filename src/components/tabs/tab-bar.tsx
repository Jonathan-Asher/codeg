"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { Reorder } from "motion/react"
import type { PanInfo } from "motion/react"
import {
  ArrowDownWideNarrow,
  Maximize2,
  Minimize2,
  SquarePen,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import {
  useWorkspaceActions,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { useFolderTabsStore } from "@/stores/folder-tabs-store"
import {
  groupOfTab,
  useVisibleConversationLayout,
  useVisibleConversationTabs,
} from "@/stores/tab-store"
import {
  firstLeafId,
  leafIds,
  type SplitDirection,
} from "@/lib/tab-group-layout"
import {
  clientPointFromDrag,
  dropIndexFromMidpoints,
} from "@/lib/tab-drag-drop"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ANCHORED_RUN_KEY,
  STATUS_BAND_COLOR,
  TAB_GROUP_BYS,
  TAB_SORTS,
  UNGROUPED_RUN_KEY,
  bandOrder,
  effectiveSort,
  folderAccentColor,
  holdForRecentDrop,
  mergeGroupOrder,
  moveGroupKey,
  reinsertInGroupOrder,
  sortAllowsDrag,
  tabsWithClosableRight,
  type TabGroupBy,
  type TabRun,
  type TabSort,
  type TabStatusBand,
} from "@/lib/tab-arrangement"
import { folderTitleTintVars } from "@/lib/theme-presets"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import {
  useArrangedTabs,
  useSwitchToManualOrder,
} from "@/hooks/use-arranged-tabs"
import { useConversationAttentionStore } from "@/stores/conversation-attention-store"
import { STRIP_ICON_BTN } from "./strip-icon-button"
import { TabItem, type TabMoveTarget } from "./tab-item"
import { ForkPlaceholderTab } from "./fork-placeholder-tab"
import { useForkPlaceholderStore } from "@/stores/fork-placeholder-store"
import { useTabStepStore } from "@/stores/tab-step-store"
import { GroupDropMarker, TabGroupLabel } from "./tab-group-label"

/** i18n keys (Folder.tabs) for the view menu and the status band labels.
 *  `as const` keeps them literal: next-intl's `t` is typed against the
 *  message catalogue and rejects a plain `string` key. */
const GROUP_BY_LABEL = {
  none: { label: "groupNone", hint: "groupNoneHint" },
  folder: { label: "groupByFolder", hint: "groupByFolderHint" },
  status: { label: "groupByStatus", hint: "groupByStatusHint" },
} as const satisfies Record<TabGroupBy, { label: string; hint: string }>
const SORT_LABEL = {
  manual: { label: "sortManual", hint: "sortManualHint" },
  status: { label: "sortStatus", hint: "sortStatusHint" },
  recent: { label: "sortRecent", hint: "sortRecentHint" },
  name: { label: "sortName", hint: "sortNameHint" },
} as const satisfies Record<TabSort, { label: string; hint: string }>
const STATUS_BAND_LABEL = {
  needs_you: "bandNeedsYou",
  awaiting_reply: "bandAwaitingReply",
  running: "bandRunning",
  other: "bandOther",
} as const satisfies Record<TabStatusBand, string>

/** How far a press on a tab of a sorted strip must travel sideways before it
 *  reads as an attempt to drag it (and the strip says why it won't move). */
const DRAG_ATTEMPT_SLOP_PX = 12
const DRAG_NEEDS_MANUAL_TOAST_ID = "tab-drag-needs-manual-order"

interface TabBarProps {
  /** Split-group strip: render only this group's tabs, highlight the GROUP's
   *  selected tab, and target new tabs/reorders at the group. Omitted = the
   *  single title-bar strip shown while unsplit. */
  groupId?: string
  /** Carry the conversation column's maximize/restore button. The column has
   *  one, so exactly one strip does: the unsplit strip, or while split the
   *  top-right group's — the strip in the unsplit one's place. */
  maximizeControl?: boolean
}

// Rendered inside the desktop conversation-column title strip while unsplit,
// or once per group shell (with `groupId`) while split. The old standalone
// mobile variant is gone — mobile shows the conversation detail header instead
// and navigates tabs from the sidebar.
export function TabBar({ groupId, maximizeControl = false }: TabBarProps) {
  const t = useTranslations("Folder.conversationCard")
  const tTabs = useTranslations("Folder.tabs")
  const { mode, conversationMaximized } = useWorkspaceView()
  const { toggleConversationMaximized } = useWorkspaceActions()
  const isMobile = useIsMobile()
  // Maximizing means covering the file column, so it is offered only while
  // there is one (fusion) — the file strip's own button follows the same rule.
  // Mobile shows one pane at a time and has nothing to cover.
  const showMaximize = maximizeControl && mode === "fusion" && !isMobile
  const tabsFollowFolder = useFolderTabsStore((s) => s.enabled)
  const tabs = useVisibleConversationTabs()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const groupOf = useTabStore((s) => s.groupOf)
  const groupLayout = useTabStore((s) => s.groupLayout)
  const groupSelection = useTabStore((s) => s.groupSelection)
  const tileByGroup = useTabStore((s) => s.tileByGroup)
  const forkPlaceholders = useForkPlaceholderStore((s) => s.placeholders)
  const {
    switchTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    pinTab,
    setTabAnchored,
    toggleGroupTile,
    splitTab,
    moveTabToGroup,
    toggleGroupOrientation,
    dissolveGroup,
    unsplitAll,
    reorderTabs,
    reorderGroupTabs,
    updateTabDrag,
    endTabDrag,
    openNewConversationTab,
    openChatModeTab,
  } = useTabActions()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const branches = useAppWorkspaceStore((s) => s.branches)
  const { activeFolder } = useActiveFolder()
  const { openConversations } = useWorkbenchRoute()

  // The group this strip represents (unsplit strip = the single first leaf),
  // its tabs, and its displayed "active" tab: the GROUP's selected tab — for
  // the focused group (and the unsplit strip) that IS the global active tab.
  const stripGroupId =
    groupId ??
    (tabs[0]
      ? groupOfTab(groupOf, groupLayout, tabs[0].id)
      : firstLeafId(groupLayout))
  const groupTabs = useMemo(
    () =>
      groupId == null
        ? tabs
        : tabs.filter(
            (tab) => groupOfTab(groupOf, groupLayout, tab.id) === groupId
          ),
    [tabs, groupId, groupOf, groupLayout]
  )
  // A next/previous-tab press moves the highlight ahead of the switch itself
  // (see `stepConversationTab`); the strip holding that tab shows it.
  const stepPreviewId = useTabStepStore((s) => s.previewTabId)
  const displayActiveId =
    stepPreviewId != null && groupTabs.some((tab) => tab.id === stepPreviewId)
      ? stepPreviewId
      : groupId == null
        ? activeTabId
        : (groupSelection[groupId] ?? null)

  // Display view: grouping (none / work folder / status band) and sorting
  // (manual / status / recent activity / name) are independent choices. Pure
  // presentation over `groupTabs`: the manual order underneath is what a
  // manual sort shows and what a drag writes back to. Every strip (split
  // groups included) follows the one per-device choice.
  const groupBy = useTabArrangeStore((s) => s.groupBy)
  const sort = useTabArrangeStore((s) => s.sort)
  const groupOrder = useTabArrangeStore((s) => s.groupOrder)
  const setGroupBy = useTabArrangeStore((s) => s.setGroupBy)
  const setSort = useTabArrangeStore((s) => s.setSort)
  const setFolderOrder = useTabArrangeStore((s) => s.setFolderOrder)
  const setBandOrder = useTabArrangeStore((s) => s.setBandOrder)
  const setSortHold = useTabArrangeStore((s) => s.setSortHold)
  const shownSort = effectiveSort({ groupBy, sort })
  const sortIsManual = shownSort === "manual"
  // Recent activity drags too: a dropped tab is held where it was dropped
  // until its session shows new activity (see `TabSortHold`).
  const sortDrags = sortAllowsDrag(shownSort)
  const sortIsRecent = shownSort === "recent"
  const grouped = groupBy !== "none"
  // A group or band can be folded to its label (click the label). The tab in
  // use stays visible next to a folded label, so it never vanishes.
  const collapsedRuns = useTabArrangeStore((s) => s.collapsedRuns)
  const toggleRunCollapsed = useTabArrangeStore((s) => s.toggleRunCollapsed)
  const {
    arranged,
    shown: displayTabs,
    activity,
    holds,
  } = useArrangedTabs(groupTabs, displayActiveId)
  // Pinned tabs lead the strip under every view. They keep the manual order,
  // so they always drag — but only among themselves: the pinned run and the
  // rest are separate drag lanes (like groups), and pinning is done from the
  // tab menu, not by dragging across.
  const hasAnchored = arranged.anchored.length > 0
  const dragLanes = grouped || hasAnchored
  const switchToManualOrder = useSwitchToManualOrder()
  const attentionByConversationId = useConversationAttentionStore(
    (s) => s.byConversationId
  )
  const isTileMode = !!tileByGroup[stripGroupId]
  const handleToggleTile = useCallback(
    () => toggleGroupTile(stripGroupId),
    [toggleGroupTile, stripGroupId]
  )

  // Split-group context-menu wiring, shared by every tab in this strip: the
  // groups on screen are the split targets. While tabs follow the folder that
  // is the folder's own layout, which the visible one narrows to its tabs
  // before the tab set is known.
  const visibleLayout = useVisibleConversationLayout()
  const orderedLeaves = useMemo(() => leafIds(visibleLayout), [visibleLayout])
  const isSplit = orderedLeaves.length > 1
  const canSplitMove = groupTabs.length >= 2
  const moveTargets = useMemo<TabMoveTarget[]>(() => {
    if (!isSplit) return []
    return orderedLeaves
      .map((leafId, index) => ({
        groupId: leafId,
        index: index + 1,
        title:
          tabs.find((tab) => tab.id === groupSelection[leafId])?.title ?? null,
      }))
      .filter((target) => target.groupId !== stripGroupId)
  }, [isSplit, orderedLeaves, tabs, groupSelection, stripGroupId])
  const handleSplit = useCallback(
    (tabId: string, direction: SplitDirection, move: boolean) =>
      splitTab(tabId, direction, { move }),
    [splitTab]
  )
  const handleToggleSplitOrientation = useCallback(
    () => toggleGroupOrientation(stripGroupId),
    [toggleGroupOrientation, stripGroupId]
  )
  const handleUnsplit = useCallback(
    () => dissolveGroup(stripGroupId),
    [dissolveGroup, stripGroupId]
  )

  // ── Cross-group drag & drop (split-group strips only) ────────────────────
  // The dragged tab itself is axis-locked to its own strip (Reorder drag="x" +
  // overflow clipping), so crossing groups is pointer-based: hit-test the
  // element under the cursor for another group's strip or shell, highlight it,
  // and commit the move on release. Same-group hits resolve to null — a drop
  // there is just the ordinary within-strip reorder.
  const isDropTarget = useTabStore(
    (s) => groupId != null && s.tabDrag?.overGroupId === groupId
  )
  const resolveDropTarget = useCallback(
    (
      clientX: number,
      clientY: number
    ): { gid: string; el: Element; strip: boolean } | null => {
      if (groupId == null) return null
      const el = document.elementFromPoint(clientX, clientY)
      if (!el) return null
      const strip = el.closest("[data-conv-group-strip]")
      if (strip) {
        const gid = strip.getAttribute("data-conv-group-strip")
        return gid && gid !== groupId ? { gid, el: strip, strip: true } : null
      }
      const shell = el.closest("[data-conv-group-shell]")
      if (shell) {
        const gid = shell.getAttribute("data-conv-group-shell")
        return gid && gid !== groupId ? { gid, el: shell, strip: false } : null
      }
      return null
    },
    [groupId]
  )
  const handleTabDrag = useCallback(
    (
      tab: TabItemData,
      event: MouseEvent | TouchEvent | PointerEvent,
      info: PanInfo
    ) => {
      const { x, y } = clientPointFromDrag(event, info)
      const target = resolveDropTarget(x, y)
      updateTabDrag({
        tabId: tab.id,
        title: tab.title,
        x,
        y,
        overGroupId: target?.gid ?? null,
      })
    },
    [resolveDropTarget, updateTabDrag]
  )
  const handleTabDragEnd = useCallback(
    (
      tab: TabItemData,
      event: MouseEvent | TouchEvent | PointerEvent,
      info: PanInfo
    ) => {
      const { x, y } = clientPointFromDrag(event, info)
      const target = resolveDropTarget(x, y)
      endTabDrag()
      if (!target) return
      // Strip drop: land at the cursor position (midpoint count). Shell-body
      // drop: append (the store clamps the oversized index to the tail).
      const index = target.strip
        ? dropIndexFromMidpoints(
            x,
            Array.from(target.el.querySelectorAll("[data-tab-id]")).map(
              (tabEl) => {
                const rect = tabEl.getBoundingClientRect()
                return rect.left + rect.width / 2
              }
            )
          )
        : Number.MAX_SAFE_INTEGER
      moveTabToGroup(tab.id, target.gid, { index })
    },
    [resolveDropTarget, endTabDrag, moveTabToGroup]
  )
  // Moving a tab to another split group by dragging: only in the plain view
  // (no grouping, manual sort). Grouped, a tab is held inside its own group;
  // sorted, the order is derived (a recent-activity drag only holds a tab in
  // its own strip). A pinned tab is held among the pinned ones (its menu still
  // moves it).
  const crossDragEnabled =
    groupId != null && isSplit && !grouped && sortIsManual

  // New-conversation affordance at the end of the tab strip. Mirrors the
  // sidebar's "New chat": return to the conversation workspace, then open a
  // draft — or a folderless chat when no context resolves, so the button is
  // never a dead end. Group strips seed from the GROUP's own selection (its
  // folder / chat mode) rather than the globally-active folder: each group is
  // its own workspace slice, and the focused group may be a different one.
  const handleNewConversation = useCallback(() => {
    openConversations()
    const groupOptions = groupId != null ? { targetGroup: groupId } : undefined
    if (groupId != null) {
      const selTab =
        groupTabs.find((tab) => tab.id === displayActiveId) ?? groupTabs[0]
      const selFolder = selTab
        ? allFolders.find((f) => f.id === selTab.folderId)
        : undefined
      if (selTab?.isChat === true || selFolder?.kind === "chat") {
        openChatModeTab(groupOptions)
        return
      }
      if (selTab && selFolder) {
        openNewConversationTab(
          selFolder.id,
          selTab.workingDir ?? selFolder.path,
          groupOptions
        )
        return
      }
      // Group context unresolvable (folder deleted) — fall through to the
      // active-folder default.
    }
    if (!activeFolder) {
      openChatModeTab(groupOptions)
      return
    }
    openNewConversationTab(activeFolder.id, activeFolder.path, groupOptions)
  }, [
    activeFolder,
    allFolders,
    displayActiveId,
    groupId,
    groupTabs,
    openChatModeTab,
    openConversations,
    openNewConversationTab,
  ])

  const folderIndex = useMemo(() => {
    const map = new Map<
      number,
      { name: string; alias: string | null; color: string; isChat: boolean }
    >()
    for (const f of allFolders) {
      map.set(f.id, {
        name: f.name,
        alias: f.alias,
        color: f.color,
        isChat: f.kind === "chat",
      })
    }
    return map
  }, [allFolders])

  // Label + stable tint per group run (folder color, or the status band's), and
  // each tab's run — its drag lane, which for the pinned tabs (and for the rest
  // of an ungrouped strip that has some) is a lane without a group. Stable
  // objects: TabItem is memoized on `accentStyle`.
  const runVisuals = useMemo(() => {
    const byRun = new Map<
      string,
      { label: string; style: CSSProperties | undefined }
    >()
    const runOfTab = new Map<string, string>()
    for (const tab of arranged.anchored) runOfTab.set(tab.id, ANCHORED_RUN_KEY)
    for (const run of arranged.runs ?? []) {
      byRun.set(run.key, runVisual(run))
      for (const tab of run.tabs) runOfTab.set(tab.id, run.key)
    }
    if (!arranged.runs && arranged.anchored.length > 0) {
      for (const tab of arranged.ordered) {
        if (!runOfTab.has(tab.id)) runOfTab.set(tab.id, UNGROUPED_RUN_KEY)
      }
    }
    return { byRun, runOfTab }

    function runVisual(run: TabRun<TabItemData>) {
      if (run.kind === "status") {
        const color = STATUS_BAND_COLOR[run.band]
        return {
          label: tTabs(STATUS_BAND_LABEL[run.band]),
          style: color ? folderTitleTintVars(color) : undefined,
        }
      }
      const folder = folderIndex.get(run.folderId)
      return {
        label: folder?.isChat
          ? tTabs("chatGroup")
          : folder?.alias || folder?.name || String(run.folderId),
        style: folderTitleTintVars(
          folderAccentColor(run.folderId, folder?.color)
        ),
      }
    }
  }, [arranged, folderIndex, tTabs])

  // "Close to the Right" follows the strip as displayed (folded groups
  // included). Read through a ref so the menu callback stays stable: every tab
  // is memoized, and the order changes with any title or status update.
  const closableRight = useMemo(
    () => tabsWithClosableRight(arranged.ordered),
    [arranged.ordered]
  )
  const orderedRef = useRef(arranged.ordered)
  useEffect(() => {
    orderedRef.current = arranged.ordered
  }, [arranged.ordered])
  const handleCloseToRight = useCallback(
    (tabId: string) =>
      closeTabsToRight(
        tabId,
        orderedRef.current.map((tab) => tab.id)
      ),
    [closeTabsToRight]
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarsePointer = useIsCoarsePointer()
  const [touchSortingTabId, setTouchSortingTabId] = useState<string | null>(
    null
  )

  // Keep the active tab in view: when it changes, and when the arrangement
  // moves it (switching to grouped / sorted, a status change, a group folding)
  // while its id stays the same.
  const shownOrderKey = displayTabs.map((tab) => tab.id).join("|")
  useEffect(() => {
    if (!displayActiveId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-tab-id="${displayActiveId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [displayActiveId, shownOrderKey])

  // The strip scrolls sideways once its tabs reach their minimum width; a
  // plain (vertical) mouse wheel scrolls it too.
  const handleStripWheel = useCallback((e: React.WheelEvent) => {
    const el = scrollRef.current
    if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    el.scrollLeft += e.deltaY
  }, [])

  // The tab under the pointer when a drag begins. Motion reports a drag's
  // start only after its first move — too late for the first reorder — so the
  // press itself is recorded.
  const pressedTabIdRef = useRef<string | null>(null)
  // Where a primary-button press on a tab began, while the strip is sorted:
  // its tabs don't drag, and a press that starts moving sideways is told why
  // (once per press) with a way out.
  const dragAttemptRef = useRef<{ tabId: string; x: number } | null>(null)
  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as Element | null
      const tabId =
        target?.closest?.("[data-tab-id]")?.getAttribute("data-tab-id") ?? null
      pressedTabIdRef.current = tabId
      dragAttemptRef.current =
        tabId != null && event.button === 0 && !sortDrags && !isCoarsePointer
          ? { tabId, x: event.clientX }
          : null
    },
    [isCoarsePointer, sortDrags]
  )
  const handleStripPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const attempt = dragAttemptRef.current
      if (!attempt) return
      if ((event.buttons & 1) === 0) {
        dragAttemptRef.current = null
        return
      }
      if (Math.abs(event.clientX - attempt.x) < DRAG_ATTEMPT_SLOP_PX) return
      dragAttemptRef.current = null
      // Pinned tabs keep the manual order under any sort: they do drag.
      if (runVisuals.runOfTab.get(attempt.tabId) === ANCHORED_RUN_KEY) return
      toast(tTabs("dragSortedTitle"), {
        id: DRAG_NEEDS_MANUAL_TOAST_ID,
        description: tTabs("dragSortedDescription"),
        action: {
          label: tTabs("switchToManualOrder"),
          onClick: switchToManualOrder,
        },
      })
    },
    [runVisuals, switchToManualOrder, tTabs]
  )
  const handleStripPointerUp = useCallback(() => {
    dragAttemptRef.current = null
  }, [])
  // A reorder that is turned down must still re-render the strip: the reorder
  // list stays locked from one reorder until the next render.
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  const handleReorder = useCallback(
    (nextTabs: TabItemData[]) => {
      const runOfTab = runVisuals.runOfTab
      const movedId = touchSortingTabId ?? pressedTabIdRef.current
      const runKey = movedId != null ? runOfTab.get(movedId) : undefined
      // Sorted by status or name, only the pinned tabs drag: they keep the
      // manual order.
      if (!sortDrags && runKey !== ANCHORED_RUN_KEY) return
      if (isCoarsePointer && !touchSortingTabId) return
      // Sorted by recent activity: the moved tab is held where it now sits
      // among its lane-mates (its group, or the whole strip), between its new
      // neighbours' activity; the manual order stays as it is.
      if (sortIsRecent && runKey !== ANCHORED_RUN_KEY) {
        const sameLanes =
          nextTabs.length === displayTabs.length &&
          nextTabs.every(
            (tab, i) => runOfTab.get(tab.id) === runOfTab.get(displayTabs[i].id)
          )
        const hold =
          movedId != null && sameLanes
            ? holdForRecentDrop(
                nextTabs.filter((tab) => runOfTab.get(tab.id) === runKey),
                movedId,
                activity,
                holds
              )
            : undefined
        const before = movedId != null ? holds.get(movedId) : undefined
        const unchanged =
          hold === undefined ||
          (hold === null
            ? before == null
            : before?.key === hold.key && before?.heldAt === hold.heldAt)
        // A reorder that changes nothing must still re-render: the list stays
        // locked until the next render.
        if (movedId == null || unchanged) {
          rerender()
          return
        }
        setSortHold(movedId, hold)
        return
      }
      let written: TabItemData[] = nextTabs
      if (dragLanes) {
        // Within one lane only (a group, or the pinned tabs): every slot must
        // keep a tab of the same lane (the lane clamp in TabItem makes that the
        // only possible outcome; this is the guard). The moved tab is then
        // re-inserted among its lane-mates in the manual order, leaving every
        // other tab where it was.
        const sameGroups =
          nextTabs.length === displayTabs.length &&
          nextTabs.every(
            (tab, i) => runOfTab.get(tab.id) === runOfTab.get(displayTabs[i].id)
          )
        const result =
          movedId != null && runKey != null && sameGroups
            ? reinsertInGroupOrder(
                groupTabs,
                nextTabs
                  .filter((tab) => runOfTab.get(tab.id) === runKey)
                  .map((tab) => tab.id),
                movedId
              )
            : null
        if (!result) {
          rerender()
          return
        }
        written = result
      }
      if (groupId == null) {
        reorderTabs(written)
      } else {
        reorderGroupTabs(groupId, written)
      }
    },
    [
      activity,
      displayTabs,
      dragLanes,
      groupId,
      groupTabs,
      holds,
      isCoarsePointer,
      reorderGroupTabs,
      reorderTabs,
      runVisuals,
      setSortHold,
      sortDrags,
      sortIsRecent,
      touchSortingTabId,
    ]
  )

  // While grouped, or with pinned tabs: a tab drags only within its own lane's
  // span (see TabItem's lane clamp). Measured from layout boxes (`offsetLeft`,
  // which a drag's transform doesn't move) at every step, so it follows the
  // swaps.
  const dragLane = useCallback((tabId: string) => {
    // Over another split group's strip, the tab is on its way there: no lane.
    if (useTabStore.getState().tabDrag?.overGroupId != null) return null
    const strip = scrollRef.current
    const self = strip?.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)
    const runKey = self?.getAttribute("data-tab-run")
    if (!strip || !self || !runKey) return null
    let left = Infinity
    let right = -Infinity
    strip
      .querySelectorAll<HTMLElement>(`[data-tab-run="${runKey}"]`)
      .forEach((el) => {
        left = Math.min(left, el.offsetLeft)
        right = Math.max(right, el.offsetLeft + el.offsetWidth)
      })
    if (!Number.isFinite(left)) return null
    const min = left - self.offsetLeft
    const max = right - (self.offsetLeft + self.offsetWidth)
    // The rest of an ungrouped strip borders only the pinned tabs, at its
    // start: past its end lies the drop onto another split group.
    if (runKey === UNGROUPED_RUN_KEY) {
      return document.documentElement.dir === "rtl"
        ? { min: -Infinity, max }
        : { min, max: Infinity }
    }
    return { min, max }
  }, [])

  // ── Moving whole groups (drag a group's label) ───────────────────────────
  // Works under every sort: it orders the groups, not the tabs. The landing
  // spot is counted against the other groups' midpoints; the order is saved
  // per grouping (folder ids / bands) for every strip.
  const runKeys = useMemo(
    () => (arranged.runs ?? []).map((run) => run.key),
    [arranged.runs]
  )
  const [groupDrag, setGroupDrag] = useState<{
    runKey: string
    dropIndex: number
  } | null>(null)
  const groupDropIndex = useCallback(
    (draggedKey: string, clientX: number): number | null => {
      const strip = scrollRef.current
      const from = runKeys.indexOf(draggedKey)
      if (!strip || from < 0) return null
      const midpoints = runKeys
        .filter((key) => key !== draggedKey)
        .map((key) => {
          let left = Infinity
          let right = -Infinity
          strip
            .querySelectorAll(
              `[data-tab-group-label="${key}"], [data-tab-run="${key}"]`
            )
            .forEach((el) => {
              const rect = el.getBoundingClientRect()
              left = Math.min(left, rect.left)
              right = Math.max(right, rect.right)
            })
          return (left + right) / 2
        })
      const among = dropIndexFromMidpoints(clientX, midpoints)
      // Back to an insertion point on the full order (dragged one included).
      return among < from ? among : among + 1
    },
    [runKeys]
  )
  const handleGroupDrag = useCallback(
    (runKey: string, clientX: number) => {
      const dropIndex = groupDropIndex(runKey, clientX)
      if (dropIndex == null) return
      setGroupDrag((prev) =>
        prev?.runKey === runKey && prev.dropIndex === dropIndex
          ? prev
          : { runKey, dropIndex }
      )
    },
    [groupDropIndex]
  )
  const handleGroupDragEnd = useCallback(
    (runKey: string, clientX: number) => {
      setGroupDrag(null)
      const dropIndex = groupDropIndex(runKey, clientX)
      const next =
        dropIndex == null ? null : moveGroupKey(runKeys, runKey, dropIndex)
      if (!next || !arranged.runs) return
      const runByKey = new Map(arranged.runs.map((run) => [run.key, run]))
      const nextRuns = next.flatMap((key) => {
        const run = runByKey.get(key)
        return run ? [run] : []
      })
      if (groupBy === "folder") {
        const folders = nextRuns.flatMap((run) =>
          run.kind === "folder" ? [run.folderId] : []
        )
        setFolderOrder(mergeGroupOrder(groupOrder.folder, folders))
      } else if (groupBy === "status") {
        const bands = nextRuns.flatMap((run) =>
          run.kind === "status" ? [run.band] : []
        )
        setBandOrder(mergeGroupOrder(bandOrder(groupOrder.status), bands))
      }
    },
    [
      arranged.runs,
      groupBy,
      groupDropIndex,
      groupOrder,
      runKeys,
      setBandOrder,
      setFolderOrder,
    ]
  )
  // The marker only shows where the group would actually move to.
  const dropMarkerAt =
    groupDrag == null
      ? null
      : (() => {
          const from = runKeys.indexOf(groupDrag.runKey)
          const to = groupDrag.dropIndex
          return from < 0 || to === from || to === from + 1 ? null : to
        })()

  const handleTouchSortingEnd = useCallback(
    () => setTouchSortingTabId(null),
    []
  )

  // While tabs follow the folder, the unsplit strip stays up for a folder with
  // nothing open: its "+" is how that folder gets its first conversation.
  if (groupTabs.length === 0 && (groupId != null || !tabsFollowFolder)) {
    return null
  }

  // The strip as displayed: the pinned tabs, then the rest, with a group label
  // ahead of each run while grouped. Adjacency to the active tab is computed
  // over THIS sequence, so a label flanking the active tab gets the same
  // baseline inset a neighbouring tab would (`data-adjacent-active`,
  // globals.css).
  type StripEntry =
    | {
        kind: "label"
        runKey: string
        count: number
        attentionCount: number
        collapsed: boolean
      }
    | { kind: "tab"; tab: TabItemData }
    | { kind: "fork-placeholder"; id: string }
  const arrangedEntries: StripEntry[] = arranged.runs
    ? [
        ...arranged.anchored.map((tab) => ({ kind: "tab" as const, tab })),
        ...arranged.runs.flatMap((run): StripEntry[] => {
          const collapsed = collapsedRuns.has(run.key)
          const visible = collapsed
            ? run.tabs.filter((tab) => tab.id === displayActiveId)
            : run.tabs
          // Waiting on the user, so a folded group still says so.
          const attentionCount = run.tabs.filter(
            (tab) =>
              tab.conversationId != null &&
              attentionByConversationId.has(tab.conversationId)
          ).length
          return [
            {
              kind: "label",
              runKey: run.key,
              count: run.tabs.length,
              attentionCount,
              collapsed,
            },
            ...visible.map((tab) => ({ kind: "tab" as const, tab })),
          ]
        }),
      ]
    : displayTabs.map((tab) => ({ kind: "tab" as const, tab }))
  // A fork on its way into a new tab stands right after the tab it was taken
  // from (see `stores/fork-placeholder-store`) — in the sequence, so the
  // active-tab adjacency below treats it as the neighbour it is.
  const entries: StripEntry[] =
    forkPlaceholders.length === 0
      ? arrangedEntries
      : arrangedEntries.flatMap((entry): StripEntry[] =>
          entry.kind === "tab"
            ? [
                entry,
                ...forkPlaceholders
                  .filter((p) => p.sourceTabId === entry.tab.id)
                  .map((p) => ({
                    kind: "fork-placeholder" as const,
                    id: p.id,
                  })),
              ]
            : [entry]
        )
  const activePos = entries.findIndex(
    (e) => e.kind === "tab" && e.tab.id === displayActiveId
  )
  const adjacencyAt = (pos: number): "before" | "after" | undefined =>
    activePos < 0
      ? undefined
      : pos === activePos - 1
        ? "before"
        : pos === activePos + 1
          ? "after"
          : undefined
  // When the LAST entry is the active tab, the trailing new-conversation
  // wrapper is its right neighbour — it needs the same baseline inset a tab
  // neighbour gets, so the active tab's right reverse-corner foot doesn't leave
  // a stray line poking out from under it (globals.css).
  const lastTabActive = activePos >= 0 && activePos === entries.length - 1

  return (
    <Reorder.Group
      as="div"
      ref={scrollRef}
      role="tablist"
      axis="x"
      values={displayTabs as TabItemData[]}
      onReorder={handleReorder}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMove={handleStripPointerMove}
      onPointerUp={handleStripPointerUp}
      // Cross-group drop target: group strips advertise their group id for the
      // drag hit-test and tint while a foreign tab hovers.
      data-conv-group-strip={groupId ?? undefined}
      // Scrolls sideways once the tabs reach their minimum width (TabItem):
      // `layoutScroll` keeps drag reordering measured against the scrolled
      // position, and `scroll-pr-32` keeps a tab scrolled into view clear of
      // the sticky new-conversation / arrange buttons at the right edge.
      layoutScroll
      onWheel={handleStripWheel}
      // Fills the title-bar strip and shrinks browser-style to share the row (see
      // TabItem): flush (`gap-0`) so hairline separators read as dividers, no
      // scrollbar (`overflow-hidden` still scrolls programmatically), and no
      // bottom border so the active (white) tab merges into the detail header
      // below. It hosts the trailing new-conversation button + drag spacer as its
      // own last children so the tabs, button, and spacer size in ONE flex line:
      // the tabs keep their equal `basis-48` width until the row fills, then
      // shrink together, and the button always hugs the last tab. `pl-2` only
      // (NOT `px-2`): the first tab keeps its left gutter for the first-child
      // seam-patch, but there's NO right padding so the trailing wrapper's
      // `ws-strip-line` reaches the group's right edge and the bottom hairline
      // stays continuous into the right reserve.
      className={cn(
        "pt-1.5 flex h-full min-w-0 flex-1 items-stretch gap-0 overflow-x-auto overflow-y-hidden pl-2 scroll-pr-32 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        isDropTarget && "bg-primary/8"
      )}
    >
      {entries.map((entry, pos) => {
        if (entry.kind === "fork-placeholder") {
          return (
            <ForkPlaceholderTab
              key={entry.id}
              adjacentActive={adjacencyAt(pos)}
            />
          )
        }
        if (entry.kind === "label") {
          const visual = runVisuals.byRun.get(entry.runKey)
          return (
            <TabGroupLabel
              key={`group-label-${entry.runKey}`}
              runKey={entry.runKey}
              label={visual?.label ?? ""}
              count={entry.count}
              attentionCount={entry.attentionCount}
              collapsed={entry.collapsed}
              accentStyle={visual?.style}
              adjacentActive={adjacencyAt(pos)}
              movable={runKeys.length > 1}
              dropBefore={
                dropMarkerAt != null && runKeys[dropMarkerAt] === entry.runKey
              }
              dragging={groupDrag?.runKey === entry.runKey}
              isCoarsePointer={isCoarsePointer}
              onToggle={toggleRunCollapsed}
              onGroupDrag={handleGroupDrag}
              onGroupDragEnd={handleGroupDragEnd}
            />
          )
        }
        const tab = entry.tab
        const folderInfo = folderIndex.get(tab.folderId)
        // Drafts are group-bound: no cross-group drag, no move / split-and-move
        // menu items. Within-group sorting (the Reorder.Group itself) is
        // untouched. See `moveTabToGroup` for why. A sub-agent's tab has no
        // conversation either, and is no draft: it moves like a session's.
        const isDraft = tab.conversationId == null && tab.kind !== "subagent"
        // Neighbours of the active tab inset their workspace-bg baseline so the
        // active tab's transparent reverse-corner foot (which flares over them)
        // doesn't leave a stray line under it (globals.css `data-adjacent-active`).
        const adjacentActive = adjacencyAt(pos)
        const runKey = runVisuals.runOfTab.get(tab.id)
        const anchored = tab.isAnchored === true
        const reorderable = sortDrags || anchored
        return (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === displayActiveId}
            isTileMode={isTileMode}
            embedded
            adjacentActive={adjacentActive}
            folderName={folderInfo?.name ?? null}
            folderBranch={branches.get(tab.folderId) ?? null}
            isSplit={isSplit}
            canSplitMove={canSplitMove && !isDraft}
            canMoveToGroup={!isDraft}
            moveTargets={moveTargets}
            onTabDrag={
              crossDragEnabled && !isDraft && !anchored
                ? handleTabDrag
                : undefined
            }
            onTabDragEnd={
              crossDragEnabled && !isDraft && !anchored
                ? handleTabDragEnd
                : undefined
            }
            onSwitch={switchTab}
            onClose={closeTab}
            onCloseOthers={closeOtherTabs}
            canCloseToRight={closableRight.has(tab.id)}
            onCloseToRight={handleCloseToRight}
            onCloseAll={closeAllTabs}
            onPin={pinTab}
            anchored={anchored}
            onSetAnchored={setTabAnchored}
            onSwitchToManualOrder={
              sortIsManual ? undefined : switchToManualOrder
            }
            onToggleTile={handleToggleTile}
            onSplit={handleSplit}
            onMoveToGroup={moveTabToGroup}
            onToggleSplitOrientation={handleToggleSplitOrientation}
            onUnsplit={handleUnsplit}
            onUnsplitAll={unsplitAll}
            isCoarsePointer={isCoarsePointer}
            isTouchSorting={touchSortingTabId === tab.id}
            onTouchSortingStart={setTouchSortingTabId}
            onTouchSortingEnd={handleTouchSortingEnd}
            reorderable={reorderable}
            dragDisabledHint={
              reorderable ? undefined : tTabs("dragNeedsManualSort")
            }
            runKey={runKey}
            dragLane={dragLanes && reorderable ? dragLane : undefined}
            dimmed={runKey != null && groupDrag?.runKey === runKey}
            accentStyle={
              runKey ? runVisuals.byRun.get(runKey)?.style : undefined
            }
          />
        )
      })}
      {/* The new-conversation button + drag spacer (+ the maximize/restore
          button, flush right, while a file column sits beside this one) are the
          Reorder.Group's own trailing children, so they share the tabs' flex
          line — the new-conversation button hugs the last tab and the spacer
          fills the leftover row as a window-drag region. They are not
          Reorder.Items, so dragging a tab only ever permutes the tabs. Wrapped
          in one `flex-1` `ws-strip-line` box so the workspace-bg bottom hairline
          runs unbroken under all of them — the short `self-start h-7` buttons
          can't carry the line themselves. NO `min-w-0`: its min-content (the
          shrink-0 buttons + the spacer's `min-w-10`) is its floor, so under
          many-tab overflow the tabs shrink to reserve it instead of it
          collapsing to 0 and clipping the buttons. */}
      <div
        // `relative` anchors two decorative pseudo-elements: the
        // `data-adjacent-active` inset baseline (globals.css `.ws-strip-line`
        // `::after`) used when the last tab is active, and the `tab-strip-tail`
        // `::before` vertical separator shown between the last NON-active tab and
        // the new-conversation button. Inter-tab separators sit on each tab's
        // LEFT edge (`.browser-tab-item::before`), so the last tab's RIGHT edge —
        // where this flush-pinned button begins — otherwise has none. Only the
        // conversation strip carries `tab-strip-tail`: the file strip pins an
        // add-tab button in the same place but stays divider-free, so its "+"
        // reads as belonging to the empty run of strip rather than to the tabs.
        data-adjacent-active={lastTabActive ? "after" : undefined}
        // Sticky: once the tabs overflow and the strip scrolls, the buttons
        // stay pinned at its right edge on the strip's own background.
        className="tab-strip-tail sticky right-0 z-20 flex h-full flex-1 items-stretch bg-muted ws-transparent-bg ws-strip-line"
      >
        {dropMarkerAt != null && dropMarkerAt === runKeys.length && (
          <GroupDropMarker />
        )}
        <button
          type="button"
          onClick={handleNewConversation}
          // Ghost-style CIRCULAR icon button (STRIP_ICON_BTN: the shape, the
          // midline seating and the frosted adaptive hover), evenly inset from
          // the strip's three visible edges so its round hover fill never
          // touches the last tab: seated against the group's `pt-1.5` top it
          // has 6px above and below, and `ml-1.5` adds a matching 6px LEFT gap
          // from the last tab's edge.
          className={cn(STRIP_ICON_BTN, "ml-1.5 mr-0.5")}
          aria-label={t("newConversation")}
          title={t("newConversation")}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </button>
        {/* The strip's view: how tabs are grouped and how they are sorted,
            two independent choices. Same ghost-circle style as the
            new-conversation button; tinted while anything but the plain view
            is on, so a strip that won't drag never looks like a bug. The menu
            stays open on a pick, so both can be set in one go. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-tab-arrange-trigger
              className={cn(
                STRIP_ICON_BTN,
                "mr-0.5",
                (grouped || !sortIsManual) && "text-primary"
              )}
              aria-label={tTabs("arrangeTabs")}
              title={tTabs("arrangeTabs")}
            >
              <ArrowDownWideNarrow className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{tTabs("groupBy")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={groupBy}
              onValueChange={(value) => setGroupBy(value as TabGroupBy)}
            >
              {TAB_GROUP_BYS.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  data-tab-group-by={option}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex flex-col gap-0.5">
                    <span>{tTabs(GROUP_BY_LABEL[option].label)}</span>
                    <span className="text-xs text-muted-foreground">
                      {tTabs(GROUP_BY_LABEL[option].hint)}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{tTabs("sortBy")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={shownSort}
              onValueChange={(value) => setSort(value as TabSort)}
            >
              {TAB_SORTS.map((option) => {
                // Status bands already are one status each.
                const redundant = option === "status" && groupBy === "status"
                return (
                  <DropdownMenuRadioItem
                    key={option}
                    value={option}
                    data-tab-sort={option}
                    disabled={redundant}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="flex flex-col gap-0.5">
                      <span>{tTabs(SORT_LABEL[option].label)}</span>
                      <span className="text-xs text-muted-foreground">
                        {redundant
                          ? tTabs("sortStatusRedundant")
                          : tTabs(SORT_LABEL[option].hint)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
            {/* "Manual" above brings back the order last dragged; this keeps
                the one on screen instead, so nothing moves. */}
            {!sortIsManual && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-tab-keep-order
                  onSelect={switchToManualOrder}
                >
                  <span className="flex flex-col gap-0.5">
                    <span>{tTabs("switchToManualOrder")}</span>
                    <span className="text-xs text-muted-foreground">
                      {tTabs("switchToManualOrderHint")}
                    </span>
                  </span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Drag spacer, floored at `min-w-10` (40px) instead of `min-w-0`: even
            when many tabs overflow and squeeze this region, a grabbable
            window-drag gap always remains to the RIGHT of the new-conversation
            button, so the button never reaches the strip's right edge (or the
            maximize button) and the packed strip stays draggable. Group strips
            keep the drag region too: while split there is NO dedicated
            title-bar row above the shells (the workspace layout drops it), so
            each strip's tail is that group's slice of the window-drag surface —
            for the top row it IS the title bar, and lower rows offer the same
            grab area, mirroring the unsplit strip. */}
        <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
        {/* Maximize/restore, flush right like the file strip's own: the
            conversation column over the whole middle area with the file column
            hidden under it, and back. `mr-1.5` gives it the 6px inset from the
            strip's right edge it has above and below. */}
        {showMaximize && groupTabs.length > 0 && (
          <button
            type="button"
            onClick={toggleConversationMaximized}
            className={cn(
              STRIP_ICON_BTN,
              "mr-1.5",
              conversationMaximized && "text-primary"
            )}
            aria-label={conversationMaximized ? t("restore") : t("maximize")}
            aria-pressed={conversationMaximized}
            title={conversationMaximized ? t("restore") : t("maximize")}
          >
            {conversationMaximized ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </Reorder.Group>
  )
}
