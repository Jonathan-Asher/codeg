"use client"

import { useEffect, useRef, type RefObject } from "react"
import type { VirtualizerHandle } from "virtua"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { isShortcutRecorderArmed } from "@/lib/keyboard-shortcuts"
import type { DbConversationSummary } from "@/lib/types"
import { holdSessionConnect } from "@/stores/session-connect-hold-store"
import type { SidebarRow } from "./sidebar-conversation-grouping"
import {
  findAnchorRow,
  isSessionNavBlocked,
  sessionNavDirection,
  sessionRowScroll,
  stepSession,
  type SessionNavAnchor,
  type SessionNavSelection,
} from "./sidebar-session-nav"

/** Fallback for a sticky folder header virtua has not measured yet. */
const STICKY_HEADER_FALLBACK_PX = 32

interface UseSidebarSessionNavOptions {
  /** The rows on screen, refreshed every render. */
  rowsRef: RefObject<readonly SidebarRow[]>
  /** The session the active tab shows, refreshed every render. */
  selectionRef: RefObject<SessionNavSelection | null>
  /** Each row's folder header (-1 for none), parallel to `rowsRef`. */
  ownerHeaderIndexRef: RefObject<Int32Array>
  virtualizerRef: RefObject<VirtualizerHandle | null>
  /** An element inside the sidebar, to tell its own drawer from a dialog. */
  sidebarRef: RefObject<HTMLElement | null>
  /** True while the list is busy with something a step would disturb (a
   *  folder being dragged). */
  isSuspended: () => boolean
  /** Open a session exactly as clicking its row does. */
  onOpen: (conversation: DbConversationSummary) => void
}

/**
 * The next/previous-session chords (⌘⇧↓ / ⌘⇧↑ by default): open the session
 * below or above the active one in the sidebar, and bring its row into view.
 *
 * The listener is on the window in the capture phase so it runs before the
 * focused element sees the key — the composer included, where the chord would
 * otherwise extend the selection to the start or end of the text. It stays out
 * of the terminal (the chord is the shell's there) and out of open dialogs and
 * menus. Mounted with the sidebar list, so it is inactive while the sidebar is
 * closed and there is no list to step through.
 *
 * Each step opens its session at once but holds the agent connection back
 * (see `holdSessionConnect`), so running down the list starts one agent — for
 * the session the steps stop on — instead of one per session passed.
 */
export function useSidebarSessionNav({
  rowsRef,
  selectionRef,
  ownerHeaderIndexRef,
  virtualizerRef,
  sidebarRef,
  isSuspended,
  onOpen,
}: UseSidebarSessionNavOptions): void {
  const { shortcuts } = useShortcutSettings()
  const anchorRef = useRef<SessionNavAnchor | null>(null)
  const isSuspendedRef = useRef(isSuspended)
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    isSuspendedRef.current = isSuspended
    onOpenRef.current = onOpen
  }, [isSuspended, onOpen])

  useEffect(() => {
    let revealFrame: number | null = null

    // Rows can shift once the selection changes (a limited folder lists its
    // selected session even past the limit), so the row is found again by
    // identity after the re-render rather than trusted by index.
    const reveal = (anchor: SessionNavAnchor) => {
      const handle = virtualizerRef.current
      if (!handle) return
      const index = findAnchorRow(rowsRef.current, anchor)
      if (index < 0) return
      const header = ownerHeaderIndexRef.current[index] ?? -1
      const topInset =
        header >= 0
          ? handle.getItemSize(header) || STICKY_HEADER_FALLBACK_PX
          : 0
      const scroll = sessionRowScroll({
        itemOffset: handle.getItemOffset(index),
        itemSize: handle.getItemSize(index),
        scrollOffset: handle.scrollOffset,
        viewportSize: handle.viewportSize,
        topInset,
      })
      if (scroll) handle.scrollToIndex(index, { ...scroll, smooth: false })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const direction = sessionNavDirection(event, shortcuts)
      if (direction === null) return
      if (isShortcutRecorderArmed()) return
      if (isSessionNavBlocked(event.target, document, sidebarRef.current)) {
        return
      }
      if (isSuspendedRef.current()) return

      // The chord is ours from here, even with no session left to step to:
      // falling through at the end of the list would let the composer select
      // to its edge on one press and switch sessions on the next.
      event.preventDefault()
      event.stopPropagation()

      const step = stepSession(
        rowsRef.current,
        selectionRef.current,
        direction,
        anchorRef.current
      )
      if (!step) return
      anchorRef.current = step.anchor
      holdSessionConnect()
      onOpenRef.current(step.conversation)

      if (revealFrame !== null) cancelAnimationFrame(revealFrame)
      revealFrame = requestAnimationFrame(() => {
        revealFrame = null
        reveal(step.anchor)
      })
    }

    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      if (revealFrame !== null) cancelAnimationFrame(revealFrame)
    }
  }, [
    shortcuts,
    rowsRef,
    selectionRef,
    ownerHeaderIndexRef,
    virtualizerRef,
    sidebarRef,
  ])
}
