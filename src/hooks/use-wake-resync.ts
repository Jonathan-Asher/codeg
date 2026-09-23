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
 *   the live stream) — the trigger is DEFERRED, not dropped: it fires as
 *   soon as the stream settles. This is what makes sleep recovery work: a
 *   turn that finished server-side while the socket was dead leaves the
 *   client believing it is still `prompting`, because the events that
 *   would have ended it never arrived. Every wake/reconnect trigger lands
 *   in that stale state. The reconnect's snapshot then flips the status,
 *   and that flip releases the deferred refetch — there is no later focus
 *   or reconnect to catch up on, so a dropped trigger would mean a stale
 *   view until the workspace is reopened;
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
  // A trigger that arrived mid-stream, owed to the next settle. Survives the
  // re-binds too — the settle itself is a re-bind (isStreaming flips).
  const pendingRef = useRef(false)

  // A deferred trigger belongs to the conversation it fired for. Declared
  // before the main effect so a conversation switch clears it in the same
  // commit, before the main effect could release it against the new one.
  useEffect(() => {
    pendingRef.current = false
  }, [conversationId])

  useEffect(() => {
    if (!enabled || conversationId == null) return

    const runResync = () => {
      const now = Date.now()
      if (now - lastResyncAt.current < RESYNC_DEBOUNCE_MS) return
      lastResyncAt.current = now
      refetch(conversationId)
    }

    const resync = () => {
      if (isStreaming) {
        pendingRef.current = true
        return
      }
      runResync()
    }

    // Stream settled with a wake still owed: release it now.
    if (!isStreaming && pendingRef.current) {
      pendingRef.current = false
      runResync()
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
