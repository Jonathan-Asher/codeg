"use client"

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { motion, useMotionValue } from "motion/react"
import type { PanInfo } from "motion/react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { clientPointFromDrag } from "@/lib/tab-drag-drop"
import {
  acquireDragSelectionGuard,
  releaseDragSelectionGuard,
} from "@/lib/drag-selection-guard"
import { useLongPressDrag } from "@/hooks/use-long-press-drag"

interface TabGroupLabelProps {
  runKey: string
  label: string
  count: number
  collapsed: boolean
  /** Tint vars for the group color; undefined = neutral chip. Stable. */
  accentStyle: CSSProperties | undefined
  adjacentActive?: "before" | "after"
  /** More than one group is shown, so moving this one means something. */
  movable: boolean
  /** Another group is being dragged and would land right before this one. */
  dropBefore: boolean
  /** This group is the one being dragged. */
  dragging: boolean
  isCoarsePointer: boolean
  onToggle: (runKey: string) => void
  onGroupDrag: (runKey: string, clientX: number) => void
  onGroupDragEnd: (runKey: string, clientX: number) => void
}

const NO_OP = () => {}

/**
 * A group's label in the tab strip. A click folds the group to its label (and
 * back); dragging the label moves the whole group, collapsed or not. The label
 * follows the pointer while the strip shows where the group would land; the
 * strip commits the new group order on release and the label settles into
 * its new place.
 */
export const TabGroupLabel = memo(function TabGroupLabel({
  runKey,
  label,
  count,
  collapsed,
  accentStyle,
  adjacentActive,
  movable,
  dropBefore,
  dragging,
  isCoarsePointer,
  onToggle,
  onGroupDrag,
  onGroupDragEnd,
}: TabGroupLabelProps) {
  const t = useTranslations("Folder.tabs")
  const x = useMotionValue(0)
  const [held, setHeld] = useState(false)

  const { dragControls, gestureHandlers } = useLongPressDrag({
    enabled: isCoarsePointer && movable,
    onStart: NO_OP,
    onEnd: NO_OP,
  })
  const {
    onDragStart: longPressDragStart,
    onDragEnd: longPressDragEnd,
    ...restGestureHandlers
  } = gestureHandlers

  // Text selection is off document-wide while the label is held; released on
  // drop and on unmount (the group's last tab closed mid-drag).
  const guardHeldRef = useRef(false)
  const releaseGuard = useCallback(() => {
    if (!guardHeldRef.current) return
    guardHeldRef.current = false
    releaseDragSelectionGuard()
  }, [])
  useEffect(() => releaseGuard, [releaseGuard])

  const handleDragStart = useCallback(() => {
    setHeld(true)
    if (!guardHeldRef.current) {
      guardHeldRef.current = true
      acquireDragSelectionGuard()
    }
    longPressDragStart()
  }, [longPressDragStart])

  const handleDrag = useCallback(
    (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      onGroupDrag(runKey, clientPointFromDrag(event, info).x)
    },
    [onGroupDrag, runKey]
  )

  const handleDragEnd = useCallback(
    (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      setHeld(false)
      releaseGuard()
      longPressDragEnd()
      // Settle in place at once: the strip re-renders the groups in their new
      // order, and an animated snap back would first fly the label to its
      // old spot.
      x.jump(0)
      onGroupDragEnd(runKey, clientPointFromDrag(event, info).x)
    },
    [longPressDragEnd, onGroupDragEnd, releaseGuard, runKey, x]
  )

  const name = t(collapsed ? "expandGroup" : "collapseGroup", {
    name: label,
    count,
  })
  const title = movable
    ? `${label} · ${count}\n${t("dragGroupHint")}`
    : `${label} · ${count}`

  return (
    <motion.div
      data-tab-group-label={runKey}
      data-adjacent-active={adjacentActive}
      data-group-dragging={dragging ? "true" : undefined}
      drag={movable ? "x" : false}
      dragControls={dragControls}
      dragListener={!isCoarsePointer && movable}
      dragMomentum={false}
      style={{ x }}
      {...restGestureHandlers}
      onDragStart={handleDragStart}
      onDrag={handleDrag}
      onDragEnd={handleDragEnd}
      // Sits in the tabs' flex line and carries the strip's bottom hairline
      // like they do; `relative` anchors the inset-baseline pseudo-element
      // used next to the active tab, and the drop marker.
      className={cn(
        "relative flex h-full shrink-0 items-center pl-1.5 pr-1 pb-1.5 ws-strip-line",
        movable && "cursor-grab active:cursor-grabbing",
        held && "z-30"
      )}
    >
      {dropBefore && <GroupDropMarker />}
      <button
        type="button"
        data-tab-group-toggle={runKey}
        aria-expanded={!collapsed}
        aria-label={name}
        onClick={() => onToggle(runKey)}
        className={cn(
          "flex max-w-[9rem] items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium transition-opacity hover:opacity-80",
          movable && "cursor-[inherit]",
          accentStyle
            ? "folder-title-tint bg-current/10"
            : "bg-muted text-muted-foreground",
          held && "shadow-md ring-1 ring-primary/40"
        )}
        style={accentStyle}
        title={title}
      >
        {collapsed ? (
          <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        <span className="tabular-nums opacity-60">{count}</span>
      </button>
    </motion.div>
  )
})

/** Where a dragged group would land: a bar on the left edge of the group it
 *  would precede (or of the strip's tail, for the end). */
export function GroupDropMarker() {
  return (
    <span
      aria-hidden
      data-group-drop-marker
      className="pointer-events-none absolute top-1.5 bottom-1.5 left-0 z-30 w-0.5 -translate-x-1/2 rounded-full bg-primary"
    />
  )
}
