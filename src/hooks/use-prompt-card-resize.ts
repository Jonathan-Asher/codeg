"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"

/**
 * A user-chosen height for the cards the agent waits on (question, plan,
 * permission request), dragged from a handle on the card's edge and
 * remembered per kind across restarts.
 *
 * Only the card's scrolling body changes height; its header, tabs and footer
 * keep their natural size. A body comes in one of two shapes:
 *
 *  - `fixed` (the multi-question tabs): one height for every tab, so switching
 *    tabs never resizes the card. The chosen height IS the height.
 *  - `content` (one question, the plan prose, the permission body): as tall as
 *    its content up to a cap. The chosen height is the cap, so a short request
 *    stays short and a long one opens at the height last chosen. Dragging
 *    shows less of a body at once; it shows more only while there is more to
 *    show.
 *
 * The room a card grows into comes from the conversation it is docked in: the
 * host passes a {@link PromptCardDock} naming its transcript. A card without
 * one (Quick Ask, where it scrolls with the thread), a read-only record and a
 * collapsed card get no handle and keep their automatic height, exactly as
 * before.
 */

export type PromptCardKind = "question" | "plan" | "permission"

/** The card edge the handle sits on: the one facing the transcript. */
export type PromptCardEdge = "top" | "bottom"

export interface PromptCardDock {
  /** The transcript region beside the docked cards. It is the flexible part
   *  of the layout, so its height is the room a taller card takes. */
  roomRef: RefObject<HTMLElement | null>
  /** `top` when the cards sit below the transcript (over the composer): the
   *  card grows upwards. `bottom` when they sit above it (the live drawer). */
  edge: PromptCardEdge
}

const STORAGE_PREFIX = "workspace:prompt-card-height:"
const CHANGE_EVENT = "codeg:prompt-card-height-changed"

/** Transcript a taller card always leaves showing above (or below) it. */
const ROOM_RESERVE_PX = 48
/** The question card's own cap (`max-h-[88svh]`), held for every kind. */
const VIEWPORT_SHARE = 0.88
/** The smallest body a drag or key makes, in the card's ems: about two
 *  option rows (128px at 100%), following the chat text size. */
const MIN_EMS = 8
const KEY_STEP_PX = 24
const KEY_STEP_LARGE_PX = 96
/** Pointer travel before a press on the handle counts as a drag, so a click
 *  (or the first half of a double-click) never moves the card. */
const DRAG_THRESHOLD_PX = 3

export function promptCardHeightKey(kind: PromptCardKind): string {
  return `${STORAGE_PREFIX}${kind}`
}

/** The stored height of a kind, or null for the automatic height. */
export function readPromptCardHeight(kind: PromptCardKind): number | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(promptCardHeightKey(kind))
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  } catch {
    return null
  }
}

/** Store a kind's height (null clears it) and tell every card of the kind. */
export function writePromptCardHeight(
  kind: PromptCardKind,
  height: number | null
): void {
  if (typeof window === "undefined") return
  try {
    const key = promptCardHeightKey(kind)
    if (height === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(Math.round(height)))
  } catch {
    // Quota exceeded or storage disabled — the height lasts this session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

// This window's writes come as the custom event, other windows' as `storage`.
function subscribeHeights(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) onChange()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

const subscribeNothing = () => () => {}

export function clampPromptCardHeight(
  value: number,
  min: number,
  max: number
): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)))
}

/** The style a body takes for a chosen height: its height when it is fixed,
 *  its cap when it follows its content. Undefined keeps the automatic one. */
export function promptCardBodyStyle(
  height: number | null,
  sizing: "fixed" | "content"
): CSSProperties | undefined {
  if (height === null) return undefined
  return sizing === "fixed" ? { height } : { maxHeight: height }
}

interface Bounds {
  /** Least height a drag or key makes. */
  min: number
  /** Most height that fits. */
  max: number
  /** The body's rendered height. */
  current: number
}

const UNMEASURED: Bounds = { min: MIN_EMS * 16, max: Infinity, current: 0 }

/** Where a drag or key starts from. */
interface Start {
  /** The body's rendered height. */
  visible: number
  /** The minimum proper (Home). */
  least: number
  /** A content body hiding part of its content (it scrolls), so it has more
   *  to show if it grows. */
  overflowing: boolean
  /** Least and most it may reach. */
  min: number
  max: number
}

interface Drag extends Start {
  pointerId: number
  startY: number
  /** Screen pixels per layout pixel: a canvas card is drawn scaled. */
  scale: number
  /** The height the drag has reached; null until it moves. */
  value: number | null
}

export interface PromptCardResizeHandleProps {
  kind: PromptCardKind
  edge: PromptCardEdge
  dragging: boolean
  valueMin: number
  valueMax: number | undefined
  valueNow: number
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void
  onDoubleClick: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

export interface PromptCardResize {
  /** Docked, live and expanded: render the handle and apply `height`. */
  active: boolean
  /** The chosen body height clamped to what fits now, or null for the
   *  card's automatic height. Apply with {@link promptCardBodyStyle}. */
  height: number | null
  /** For the scrolling body — in a tabbed card, the active tab's panel. */
  bodyRef: (element: HTMLElement | null) => void
  handleProps: PromptCardResizeHandleProps
}

interface UsePromptCardResizeOptions {
  kind: PromptCardKind
  /** Where the card is docked; none, and it is never resizable. */
  dock: PromptCardDock | null | undefined
  /** The card's root, measured for its chrome. */
  cardRef: RefObject<HTMLElement | null>
  sizing: "fixed" | "content"
  /** False where the card has nothing to resize: read-only, collapsed, or no
   *  body. */
  enabled: boolean
}

/**
 * What fits, from the layout as it is: the transcript keeps a strip, the card
 * stays inside the viewport cap. Null while nothing is laid out (a test DOM,
 * a body not mounted yet) — the last bounds stand.
 */
function measureBounds(
  card: HTMLElement | null,
  body: HTMLElement | null,
  room: HTMLElement | null
): Bounds | null {
  const frame = room?.parentElement
  if (!card || !body || !room || !frame || frame.clientHeight === 0) {
    return null
  }
  const bodyHeight = body.offsetHeight
  // The transcript gives way first; once it is gone, anything taller pushes
  // the composer out of the frame, which the frame's scroll height shows.
  const overflow =
    room.clientHeight > 0
      ? 0
      : Math.max(0, frame.scrollHeight - frame.clientHeight)
  const byRoom = bodyHeight + room.clientHeight - overflow - ROOM_RESERVE_PX
  const byViewport =
    bodyHeight + window.innerHeight * VIEWPORT_SHARE - card.offsetHeight
  const em = parseFloat(getComputedStyle(card).fontSize)
  const min = Math.round(MIN_EMS * (em > 0 ? em : 16))
  return {
    min,
    max: Math.max(min, Math.floor(Math.min(byRoom, byViewport))),
    current: Math.round(bodyHeight),
  }
}

/** Lock the page to the drag: no text selection, the resize cursor
 *  everywhere. Returns the undo. */
function holdDragCursor(): () => void {
  const style = document.body.style
  const saved = [
    style.userSelect,
    style.getPropertyValue("-webkit-user-select"),
    style.cursor,
  ] as const
  style.userSelect = "none"
  style.setProperty("-webkit-user-select", "none")
  style.cursor = "row-resize"
  return () => {
    style.userSelect = saved[0]
    style.setProperty("-webkit-user-select", saved[1])
    style.cursor = saved[2]
  }
}

export function usePromptCardResize({
  kind,
  dock,
  cardRef,
  sizing,
  enabled,
}: UsePromptCardResizeOptions): PromptCardResize {
  const active = enabled && dock != null
  const edge = dock?.edge ?? "top"
  const stored = useSyncExternalStore(
    active ? subscribeHeights : subscribeNothing,
    () => (active ? readPromptCardHeight(kind) : null),
    () => null
  )
  // The height an unfinished drag has reached; stored on release.
  const [live, setLive] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [bounds, setBounds] = useState<Bounds>(UNMEASURED)
  const bodyEl = useRef<HTMLElement | null>(null)
  const drag = useRef<Drag | null>(null)
  const frame = useRef(0)
  const releaseCursor = useRef<(() => void) | null>(null)

  const bodyRef = useCallback((element: HTMLElement | null) => {
    bodyEl.current = element
  }, [])

  // A card that stops being resizable (answered, collapsed) mid-drag comes
  // back without the drag's height.
  if (!active && (live !== null || dragging)) {
    setLive(null)
    setDragging(false)
  }

  // Only ever clamped down, to what fits: a height under the minimum was
  // chosen from a body already that short, and stays as chosen.
  const chosen = live ?? stored
  const height = active && chosen !== null ? Math.min(chosen, bounds.max) : null

  // The bounds follow the window, the composer, banners and other cards:
  // anything that resizes the transcript or the card itself.
  useLayoutEffect(() => {
    if (!active || !dock) return
    const measure = () => {
      const next = measureBounds(
        cardRef.current,
        bodyEl.current,
        dock.roomRef.current
      )
      if (!next) return
      setBounds((prev) =>
        prev.min === next.min &&
        // A pixel either way is layout rounding, not a change.
        Math.abs(prev.max - next.max) <= 1 &&
        prev.current === next.current
          ? prev
          : next
      )
    }
    // Measured before paint, so a remembered height that no longer fits never
    // shows at its old size first.
    measure()
    const room = dock.roomRef.current
    const card = cardRef.current
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure())
    if (room) observer?.observe(room)
    if (card) observer?.observe(card)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [active, cardRef, dock])

  const stopFrame = () => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
  }

  // Answered, collapsed or unmounted mid-drag: let go of the page.
  useEffect(() => {
    if (!active) return
    return () => {
      drag.current = null
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
      releaseCursor.current?.()
      releaseCursor.current = null
    }
  }, [active])

  // Where a drag or key starts from and what it may reach. Down to the
  // minimum, or not at all for a body already below it, and up to what fits.
  const startFrom = (): Start => {
    const body = bodyEl.current
    const now =
      measureBounds(cardRef.current, body, dock?.roomRef.current ?? null) ??
      bounds
    const visible = body?.offsetHeight || height || now.min
    return {
      visible,
      least: now.min,
      overflowing:
        sizing === "content" &&
        body !== null &&
        body.scrollHeight > body.clientHeight + 1,
      min: Math.min(now.min, visible),
      max: now.max,
    }
  }

  // Whether a height changes what the card shows — the only change worth
  // remembering. A content body grows only while it has more to show, so a
  // short request dragged taller leaves the stored height alone rather than
  // capping the next, longer one at its own size.
  const changes = (from: Start, value: number) =>
    value < from.visible ||
    (value > from.visible && (sizing === "fixed" || from.overflowing))

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !active || !bodyEl.current) return
    const card = cardRef.current
    if (!card) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = card.getBoundingClientRect()
    const scale = card.offsetHeight > 0 ? rect.height / card.offsetHeight : 1
    drag.current = {
      ...startFrom(),
      pointerId: event.pointerId,
      startY: event.clientY,
      scale: scale > 0 ? scale : 1,
      value: null,
    }
    releaseCursor.current?.()
    releaseCursor.current = holdDragCursor()
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const dy = (event.clientY - current.startY) / current.scale
    if (current.value === null && Math.abs(dy) < DRAG_THRESHOLD_PX) return
    current.value = clampPromptCardHeight(
      current.visible + (edge === "top" ? -dy : dy),
      current.min,
      current.max
    )
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const reached = drag.current
      if (!reached || reached.value === null) return
      setLive(changes(reached, reached.value) ? reached.value : null)
    })
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    stopFrame()
    releaseCursor.current?.()
    releaseCursor.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    setLive(null)
    if (current.value !== null && changes(current, current.value)) {
      writePromptCardHeight(kind, current.value)
    }
  }

  // Back to the automatic height, for every card of the kind.
  const onDoubleClick = () => {
    stopFrame()
    setLive(null)
    writePromptCardHeight(kind, null)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return
    if (event.altKey) return
    // The arrows move the edge the handle is on.
    const grow = edge === "top" ? "ArrowUp" : "ArrowDown"
    const shrink = edge === "top" ? "ArrowDown" : "ArrowUp"
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX
    const { key } = event
    if (key !== grow && key !== shrink && key !== "Home" && key !== "End") {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const from = startFrom()
    const next =
      key === "Home"
        ? clampPromptCardHeight(from.least, from.min, from.max)
        : key === "End"
          ? from.max
          : clampPromptCardHeight(
              from.visible + (key === grow ? step : -step),
              from.min,
              from.max
            )
    if (Number.isFinite(next) && changes(from, next)) {
      writePromptCardHeight(kind, next)
    }
  }

  // A content body below its cap reads as its content's height.
  const valueNow =
    sizing === "fixed" && height !== null
      ? height
      : bounds.current > 0
        ? bounds.current
        : (height ?? bounds.min)
  const finiteMax = Number.isFinite(bounds.max) ? bounds.max : undefined

  return {
    active,
    height,
    bodyRef,
    handleProps: {
      kind,
      edge,
      dragging,
      valueMin: Math.min(bounds.min, valueNow),
      valueMax:
        finiteMax === undefined ? undefined : Math.max(finiteMax, valueNow),
      valueNow,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onDoubleClick,
      onKeyDown,
    },
  }
}
