"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { dropIndexFromMidpoints } from "@/lib/tab-drag-drop"

/**
 * Drag-to-reorder for the sidebar's Pinned section, on POINTER events.
 *
 * Not HTML5 drag-and-drop: in the desktop app, Tauri's native drag-drop handler
 * (which lets files be dropped from Finder into the composer) reports every
 * drag over the webview as handled, and on macOS wry then never forwards the
 * drag to WebKit — the page gets `dragstart` but never `dragover`/`drop`, so
 * an HTML5 reorder silently does nothing there (it only worked in a browser).
 * Pointer events are the webview's own and are never intercepted; the tab
 * strip and the folder reorder rely on them for the same reason.
 *
 * A press becomes a drag only after the pointer travels
 * {@link DRAG_THRESHOLD_PX}, so a plain click still opens the conversation;
 * the click that follows a real drag is swallowed. Escape cancels.
 */
const DRAG_THRESHOLD_PX = 4

/** Rows opt in with this attribute; its value is the conversation id. */
export const PINNED_ROW_ATTR = "data-pinned-row-id"

/**
 * The pinned order after dropping `draggedId` at `dropIndex` (an insertion
 * index into the CURRENT order, 0 = before the first row). Null when the drop
 * changes nothing.
 */
export function reorderedPinIds(
  ids: readonly number[],
  draggedId: number,
  dropIndex: number
): number[] | null {
  const from = ids.indexOf(draggedId)
  if (from === -1) return null
  const next = ids.filter((id) => id !== draggedId)
  const to = Math.max(
    0,
    Math.min(dropIndex > from ? dropIndex - 1 : dropIndex, next.length)
  )
  next.splice(to, 0, draggedId)
  return next.every((id, i) => id === ids[i]) ? null : next
}

/** Insertion index for a pointer at `clientY`, from the rendered pinned rows. */
function dropIndexAt(clientY: number): number {
  const mids = Array.from(
    document.querySelectorAll<HTMLElement>(`[${PINNED_ROW_ATTR}]`)
  )
    .map((row) => {
      const box = row.getBoundingClientRect()
      return box.top + box.height / 2
    })
    .sort((a, b) => a - b)
  return dropIndexFromMidpoints(clientY, mids)
}

interface PressState {
  id: number
  pointerId: number
  startY: number
  started: boolean
}

export function usePinnedPointerReorder({
  pinnedIds,
  onCommit,
}: {
  /** The Pinned section's current display order, top to bottom. */
  pinnedIds: readonly number[]
  onCommit: (orderedIds: number[]) => void
}) {
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  // Read at event time, so the window listeners never go stale.
  const pinnedIdsRef = useRef(pinnedIds)
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    pinnedIdsRef.current = pinnedIds
    onCommitRef.current = onCommit
  }, [pinnedIds, onCommit])

  const pressRef = useRef<PressState | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const finish = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
    pressRef.current = null
    setDraggingId(null)
    setDropIndex(null)
  }, [])
  useEffect(() => finish, [finish])

  const beginPinDrag = useCallback(
    (id: number, event: React.PointerEvent) => {
      // Mouse / pen, primary button only: on touch the same gesture scrolls.
      if (event.button !== 0 || event.pointerType === "touch") return
      if (pressRef.current) return
      // The row's small action buttons (unpin, mark done) stay plain
      // buttons. The row itself is also a <button> — the one carrying
      // `data-conversation-id` — and that one IS the drag handle.
      const control = (event.target as Element).closest(
        "button, a, input, textarea"
      )
      if (control && !control.hasAttribute("data-conversation-id")) return
      pressRef.current = {
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        started: false,
      }
      const prevUserSelect = document.body.style.userSelect

      const onMove = (e: PointerEvent) => {
        const press = pressRef.current
        if (!press || e.pointerId !== press.pointerId) return
        if (!press.started) {
          if (Math.abs(e.clientY - press.startY) < DRAG_THRESHOLD_PX) return
          press.started = true
          document.body.style.userSelect = "none"
          setDraggingId(press.id)
        }
        e.preventDefault()
        setDropIndex(dropIndexAt(e.clientY))
      }
      const onUp = (e: PointerEvent) => {
        const press = pressRef.current
        if (!press || e.pointerId !== press.pointerId) return
        if (press.started) {
          // The click that ends a drag must not also open the conversation.
          const swallow = (ce: MouseEvent) => {
            ce.stopPropagation()
            ce.preventDefault()
          }
          window.addEventListener("click", swallow, {
            capture: true,
            once: true,
          })
          setTimeout(
            () =>
              window.removeEventListener("click", swallow, { capture: true }),
            0
          )
          const next = reorderedPinIds(
            pinnedIdsRef.current,
            press.id,
            dropIndexAt(e.clientY)
          )
          if (next) onCommitRef.current(next)
        }
        finish()
      }
      const onCancel = (e: PointerEvent) => {
        if (pressRef.current && e.pointerId === pressRef.current.pointerId) {
          finish()
        }
      }
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape" && pressRef.current?.started) finish()
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      window.addEventListener("keydown", onKey)
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        window.removeEventListener("keydown", onKey)
        document.body.style.userSelect = prevUserSelect
      }
    },
    [finish]
  )

  return { draggingId, dropIndex, beginPinDrag }
}
