/**
 * Timing marks for the session switcher (⌘K, then Enter), on the opt-in
 * Performance timeline of `perf-marks` (`localStorage.codeg_perf = "1"`):
 *
 *   qs:key       the shortcut was pressed
 *   qs:shown     the switcher is painted, its rows listed and the first
 *                selected — `ms` since the key
 *   qs:pick      a session was picked
 *   qs:switched  that session is in front with its transcript painted —
 *                `ms` since the pick
 *
 * Off, each call is one cached flag check.
 */

import { perfMark, perfMarksEnabled } from "@/lib/perf-marks"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

/** Give up on a switch that never shows its transcript. */
const SWITCH_WATCH_MS = 15_000

let keyAt: number | null = null

/** After the next frame has been painted. */
function afterNextPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0))
}

function since(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10
}

export function markQuickSwitchKey(): void {
  if (!perfMarksEnabled()) return
  keyAt = performance.now()
  perfMark("qs:key")
}

export function markQuickSwitchShown(rows: number): void {
  if (!perfMarksEnabled()) return
  const start = keyAt
  keyAt = null
  afterNextPaint(() =>
    perfMark("qs:shown", {
      rows,
      ...(start != null ? { ms: since(start) } : {}),
    })
  )
}

/**
 * A session was picked: mark it, then mark the first frame painted once its
 * transcript is there (at once for an open tab, after the fetch for one that
 * was closed).
 */
export function markQuickSwitchPick(conversationId: number): void {
  if (!perfMarksEnabled()) return
  const start = performance.now()
  perfMark("qs:pick", { conversationId })
  const ready = () => {
    const session = useConversationRuntimeStore
      .getState()
      .byConversationId.get(conversationId)
    return session?.detail != null || session?.detailError != null
  }
  const done = () =>
    afterNextPaint(() =>
      perfMark("qs:switched", { conversationId, ms: since(start) })
    )
  // The tab opens in the same task as the pick; read the store after it.
  queueMicrotask(() => {
    if (ready()) {
      done()
      return
    }
    const unsubscribe = useConversationRuntimeStore.subscribe(() => {
      if (!ready()) return
      unsubscribe()
      clearTimeout(timer)
      done()
    })
    const timer = setTimeout(unsubscribe, SWITCH_WATCH_MS)
  })
}
