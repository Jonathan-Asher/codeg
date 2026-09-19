"use client"

import { useEffect, useRef } from "react"
import { getTransport } from "@/lib/transport"

/**
 * Debounce window: macOS fires `focus`/`visibilitychange` in bursts when a
 * lid is opened (webview re-activation, Tailscale re-route, WKWebView
 * internals). Without this, one wake can trigger a burst of refetches —
 * exactly the "polling catches the main thread" failure mode the fork
 * avoids. 2s matches the cadence of repeated lid bounces without delaying
 * a genuine stale view meaningfully.
 */
const RESYNC_DEBOUNCE_MS = 2000

/**
 * Re-fetch the conversation transcript when the machine wakes or the
 * transport reconnects.
 *
 * The WebSocket event stream dies during sleep; on wake the client
 * reconnects but nothing re-fetches what the server streamed to the dead
 * socket, so replies stay invisible until the workspace is reopened. This
 * hook closes that gap by triggering the canonical `refetchDetail` path on:
 *
 * - `visibilitychange` → visible (lid open / tab re-activation)
 * - window `focus`
 * - transport reconnect (WS re-established after a drop)
 *
 * Guards:
 * - never refetches while the agent is streaming (a refetch would clobber
 *   the live stream) — the trigger is DROPPED, not queued; the next focus
 *   or reconnect after the stream settles catches up;
 * - debounced to one resync per RESYNC_DEBOUNCE_MS;
 * - inert unless the panel is the active tab bound to a persisted
 *   conversation (background tabs never refetch — each panel owns its
 *   own listener set and gates itself).
 *
 * Listeners re-bind when the gating inputs change (cheap: three DOM
 * listeners) so the callback always reads current truth — no refs captured
 * at bind time that the React Compiler would flag.
 */
export function useWakeResync(options: {
  /** Panel is the active tab AND bound to a persisted conversation. */
  enabled: boolean
  /**
   * The runtime conversation key. May be a virtual (negative) id for
   * new-chat drafts — `refetchDetail` resolves those to the bound DB row
   * itself, so the raw runtime key is the right thing to pass.
   */
  conversationId: number | null
  /** True while the agent is streaming (connStatus === "prompting"). */
  isStreaming: boolean
  /** The store's `refetchDetail`. */
  refetch: (conversationId: number) => void
}): void {
  const { enabled, conversationId, isStreaming, refetch } = options

  // Survives listener re-binds: one resync per debounce window.
  const lastResyncAt = useRef(0)

  useEffect(() => {
    if (!enabled || conversationId == null) return

    const resync = () => {
      if (isStreaming) return
      const now = Date.now()
      if (now - lastResyncAt.current < RESYNC_DEBOUNCE_MS) return
      lastResyncAt.current = now
      refetch(conversationId)
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") resync()
    }
    const onFocus = () => resync()

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onFocus)
    // Optional in the Transport interface: the desktop-local transport has no
    // reconnect lifecycle (nothing sleeps server-side in desktop mode).
    const offReconnect = getTransport().onReconnect?.(resync)

    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onFocus)
      offReconnect?.()
    }
  }, [enabled, conversationId, isStreaming, refetch])
}
