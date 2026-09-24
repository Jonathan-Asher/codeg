"use client"

import { useEffect, useRef } from "react"
import { onTransportReconnect } from "@/lib/platform"

/**
 * One resync per window. A wake shows the page again and, once the dead
 * socket is replaced, reconnects the transport within seconds; either alone
 * is reason enough to resync, so the pair collapses into one refetch.
 */
const RESYNC_DEBOUNCE_MS = 2_000

/**
 * A page shown again counts as a wake only after being hidden this long.
 * Switching tabs or windows loses nothing (the socket stays up), and every
 * resync is a full transcript refetch that the status bar reports while it
 * runs; the sleep this trigger is for hides the page far longer.
 */
const RESYNC_MIN_HIDDEN_MS = 30_000

/**
 * How long a trigger that landed mid-stream stays owed (see the guards
 * below). Comfortably longer than a re-attach round trip, which is what
 * settles a status that went stale while the socket was down; a turn still
 * streaming past this is being delivered live.
 */
const RESYNC_HOLD_MS = 10_000

/**
 * Quiet period after a stream settles. A reply that streamed in live may
 * still be flushing to the agent's transcript (seconds, for some agents; see
 * the sync backoffs in the runtime store), so a refetch this soon could only
 * replace it with a truncated read.
 */
const RESYNC_AFTER_SETTLE_MS = 10_000

/**
 * Re-fetch the open conversation's transcript when the client wakes from
 * sleep or its event stream reconnects.
 *
 * Whatever the server broadcast while this client's WebSocket was down is
 * gone for good. The re-attach that follows restores the LIVE state (replay
 * or snapshot), but a turn that finished inside the gap has left the live
 * state: its reply now exists only in the persisted transcript, while the
 * view keeps whatever it had streamed before the drop — until the
 * conversation is reopened. This hook runs the canonical `refetchDetail` path
 * on:
 *
 * - transport reconnect (the socket was replaced after a drop);
 * - the page becoming visible after RESYNC_MIN_HIDDEN_MS or more hidden, i.e.
 *   a wake. This also covers a socket that survived the sleep but fell
 *   behind: its lagged re-attach settles a turn exactly like a reconnect's,
 *   with no reconnect to announce it.
 *
 * Guards:
 * - inert on transports with no reconnect lifecycle (the local desktop app):
 *   its IPC loses nothing across sleep, and a refetch just after a turn ends
 *   races the agent's transcript flush (see `completeTurn` in the runtime
 *   store) for no benefit;
 * - never refetches under a live stream. A trigger that lands while the
 *   client believes a turn is streaming is HELD until the stream settles:
 *   after sleep that belief is stale by construction (the events that ended
 *   the turn died with the socket), the re-attach snapshot is what flips the
 *   status, and no later trigger is coming to catch up on. A hold lapses
 *   after RESYNC_HOLD_MS — a turn still streaming by then reaches the view
 *   live, and refetching at its natural end would race the transcript flush;
 * - for the same reason, a trigger within RESYNC_AFTER_SETTLE_MS of a stream
 *   settling (say, the user returning on the turn's completion
 *   notification) is skipped;
 * - debounced to one resync per RESYNC_DEBOUNCE_MS;
 * - inert unless the panel is the active tab bound to a persisted
 *   conversation (each panel owns its own listener set and gates itself).
 *
 * Listeners re-bind when the gating inputs change (cheap) so every callback
 * reads current truth rather than refs captured at bind time.
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
  // When the page was hidden, while it still is. Survives the re-binds too:
  // a turn can settle while the page is away.
  const hiddenAt = useRef<number | null>(null)
  // When the trigger held for the stream to settle arrived; null when none
  // is held. Survives the re-binds too — the settle itself is one.
  const heldSince = useRef<number | null>(null)
  // When the stream last went from streaming to settled.
  const settledAt = useRef(0)
  const wasStreaming = useRef(isStreaming)

  // A held trigger belongs to the conversation it fired for. Declared before
  // the main effect so a conversation switch clears it in the same commit,
  // before the main effect could release it against the new one.
  useEffect(() => {
    heldSince.current = null
  }, [conversationId])

  // Tracked apart from the gated effect below so a settle is on record even
  // if it happened while the panel was in the background.
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) settledAt.current = Date.now()
    wasStreaming.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    if (!enabled || conversationId == null) return

    const runResync = () => {
      const now = Date.now()
      if (now - lastResyncAt.current < RESYNC_DEBOUNCE_MS) return
      lastResyncAt.current = now
      refetch(conversationId)
    }

    // The stream settled with a trigger held: release it if the settle came
    // promptly (the re-attach correcting a stale status), drop it otherwise.
    if (!isStreaming && heldSince.current !== null) {
      const settledPromptly = Date.now() - heldSince.current <= RESYNC_HOLD_MS
      heldSince.current = null
      if (settledPromptly) runResync()
    }

    const resync = () => {
      if (isStreaming) {
        heldSince.current = Date.now()
        return
      }
      if (Date.now() - settledAt.current < RESYNC_AFTER_SETTLE_MS) return
      runResync()
    }

    // Null on a transport with no reconnect lifecycle: nothing to recover.
    const offReconnect = onTransportReconnect(resync)
    if (!offReconnect) return

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt.current = Date.now()
        return
      }
      const since = hiddenAt.current
      hiddenAt.current = null
      if (since !== null && Date.now() - since >= RESYNC_MIN_HIDDEN_MS) {
        resync()
      }
    }

    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      offReconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, conversationId, isStreaming, refetch])
}
