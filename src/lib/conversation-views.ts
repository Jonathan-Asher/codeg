import { markConversationsViewed } from "@/lib/api"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"

/**
 * Views are reported this long after the last one, so a burst of switches
 * (cycling through tabs, the switcher pressed twice) is one call.
 */
export const VIEW_REPORT_DELAY_MS = 1_000

/** Views not reported yet: conversation id → when (ms, this client's clock). */
const pending = new Map<number, number>()
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * The user opened `conversationId`. This client's lists re-sort at once (the
 * row's `last_viewed_at` moves locally, never its `updated_at`); the server
 * hears about it a beat later, batched with any switch in between, and tells
 * every other client.
 */
export function noteConversationViewed(
  conversationId: number,
  now: number = Date.now()
): void {
  useAppWorkspaceStore.getState().updateConversationLocal(conversationId, {
    last_viewed_at: new Date(now).toISOString(),
  })
  pending.set(conversationId, now)
  if (timer != null) clearTimeout(timer)
  timer = setTimeout(() => void flushConversationViews(), VIEW_REPORT_DELAY_MS)
}

/** Report the queued views now. Each goes as an age, so the server places it
 *  by its own clock. Best effort: a failed report leaves the local order as
 *  it is, and the next view or refresh reconciles it. */
export async function flushConversationViews(
  now: number = Date.now()
): Promise<void> {
  if (timer != null) {
    clearTimeout(timer)
    timer = null
  }
  if (pending.size === 0) return
  const views = Array.from(pending, ([conversationId, at]) => ({
    conversationId,
    ageMs: Math.max(0, now - at),
  }))
  pending.clear()
  try {
    await markConversationsViewed(views)
  } catch (err) {
    console.warn("[conversation-views] reporting views failed:", err)
  }
}

function activeConversationId(): number | null {
  const { activeTabId, tabs } = useTabStore.getState()
  return tabs.find((tab) => tab.id === activeTabId)?.conversationId ?? null
}

/** Runs `fn` once the frame being drawn has painted: the switch itself
 *  shows first, the lists re-sort right after. */
function afterNextPaint(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(fn, 0))
  } else {
    setTimeout(fn, 0)
  }
}

export interface ViewTrackingOptions {
  /** Schedules the local re-sort after a switch (default: after the next
   *  paint, so the lists never slow the switch down). */
  defer?: (fn: () => void) => void
}

function pageVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  )
}

/**
 * Record a view each time a conversation BECOMES the active tab: picked in
 * the switcher, clicked in the sidebar, opened from a link or a
 * notification, switched to among the tabs. Moving through the switcher's
 * rows or hovering a session changes no tab, so it records nothing. Neither
 * does the tab restored when the tabs load: that is where the user left off,
 * not something just opened. A switch made while the page is hidden (another
 * window drove it) counts once the page is shown with it still active.
 *
 * Returns the stop function; stopping reports whatever is still queued.
 */
export function startConversationViewTracking({
  defer = afterNextPaint,
}: ViewTrackingOptions = {}): () => void {
  let hydrated = false
  let current: number | null = null
  let hidden: number | null = null

  const check = () => {
    if (!useTabStore.getState().tabsHydrated) {
      // Before the first load, or after a backend switch reset the tabs: the
      // next load restores tabs, it does not open them.
      hydrated = false
      return
    }
    const id = activeConversationId()
    if (!hydrated) {
      hydrated = true
      current = id
      return
    }
    if (id === current) return
    current = id
    hidden = null
    if (id == null) return
    if (!pageVisible()) {
      hidden = id
      return
    }
    const at = Date.now()
    defer(() => noteConversationViewed(id, at))
  }
  const onVisibilityChange = () => {
    if (!pageVisible()) {
      void flushConversationViews()
      return
    }
    if (hidden != null && hidden === current) noteConversationViewed(hidden)
    hidden = null
  }

  check()
  const unsubscribe = useTabStore.subscribe(check)
  document.addEventListener("visibilitychange", onVisibilityChange)
  return () => {
    unsubscribe()
    document.removeEventListener("visibilitychange", onVisibilityChange)
    void flushConversationViews()
  }
}
