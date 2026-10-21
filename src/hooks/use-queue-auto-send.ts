"use client"

import { useEffect, useRef, useState, type RefObject } from "react"

import type { QueuedMessage } from "@/hooks/use-message-queue"
import { shouldDrainIntoHeldTurn } from "@/lib/background-idle"
import { buildSteerPayload } from "@/lib/prompt-draft"
import { flushRetryDelayMs } from "@/lib/queue-flush"
import { headSendDelayMs } from "@/lib/durable-send"
import { isNoActiveTurnRejection } from "@/lib/turn-busy"
import type { PromptInputBlock } from "@/lib/types"

export interface UseQueueAutoSendArgs {
  /** The queue as rendered: its length and head drive the two engines. */
  queue: QueuedMessage[]
  /** Take the head off the queue, synchronously (`useMessageQueue.dequeue`). */
  dequeue: () => QueuedMessage | undefined
  remove: (id: string) => void
  holdUntilTurnEnd: (id: string) => void
  /** The queue item open in the composer's editor, if any. */
  editingItemId: string | null
  /**
   * This surface can send an ordinary prompt right now: its connection is
   * idle and nothing it sent is still waiting to persist. Holding on the
   * latter is what sends one message at a time — the send that just went out
   * releases it when its turn completes (or when it bounces and rolls back).
   */
  canSendNow: boolean
  /** The connection half of `canSendNow`, read when a deferred send fires. */
  isConnectionReady: () => boolean
  /** Something else in flight that both engines wait for. */
  busy?: boolean
  /** The turn is held open only for background work and a message can be
   *  delivered into it now (`canDeliverIntoHeldTurn`). */
  heldTurnReady: boolean
  /** Stamped by the surface's send when the backend bounces it as busy; the
   *  next attempt waits out `flushRetryDelayMs` from there. */
  lastBounceAtRef: RefObject<number>
  /** Send a dequeued head as an ordinary prompt. A bounce must put it back at
   *  the FRONT (`requeueFront`) — it was the head. */
  sendHead: (item: QueuedMessage) => void
  /** Deliver into the held turn. Rejects with the backend's "no active turn"
   *  once that turn has ended. */
  deliverIntoHeldTurn: (
    text: string,
    blocks?: PromptInputBlock[],
    clientId?: string
  ) => Promise<unknown>
  /** A held-turn delivery failed for another reason; the message now waits
   *  for the end of the turn. */
  onHeldDeliveryFailed?: (error: unknown) => void
}

/**
 * The message queue's send engine for a composer surface that is not the
 * workspace tab — the same two engines `ConversationTabView` runs inline
 * (conversation-detail-panel.tsx), with the same gates:
 *
 * - **Turn-end flush**, level-triggered: whenever the surface can send and a
 *   message waits, the head goes out. It does not wait for a prompting → idle
 *   edge, so a message that lands in the queue after the edge passed (a send
 *   bounced by another surface that started a turn first) still goes out. A
 *   bounce backs off for `flushRetryDelayMs` before the retry.
 * - **Held-turn drain**: while a turn is held open only for background work
 *   the agent is idle, so the head is delivered into that turn
 *   (`shouldDrainIntoHeldTurn`), one message per idle stretch. A message
 *   queued for the turn's end — or whose delivery failed outright — holds
 *   everything behind it.
 *
 * The head stays queued for the whole held-turn round trip and the flush
 * waits for it, so the same message can never go out both ways.
 */
export function useQueueAutoSend(args: UseQueueAutoSendArgs): void {
  const {
    queue,
    editingItemId,
    canSendNow,
    busy = false,
    heldTurnReady,
    lastBounceAtRef,
  } = args
  // Latest callbacks for the deferred send and the delivery's settle: both
  // run after the render that scheduled them.
  const argsRef = useRef(args)
  useEffect(() => {
    argsRef.current = args
  })

  // Whether the held-turn drain is delivering the head (which stays queued
  // until the delivery is confirmed). The flush holds for the round trip; the
  // settle count re-runs both engines once it is over.
  const heldDrainInFlightRef = useRef(false)
  const [heldDrainsSettled, setHeldDrainsSettled] = useState(0)

  // Bumped after every send attempt, so the flush looks again even when the
  // attempt left every other input as it found it — a head that bounced
  // straight back to the front leaves the queue length where it was.
  const [flushAttempts, setFlushAttempts] = useState(0)
  const queueLength = queue.length
  const head = queue[0]
  useEffect(() => {
    if (!canSendNow || busy || heldDrainInFlightRef.current) return
    if (queueLength === 0) return
    // A "Not sent" head that waits for Retry holds the queue; one that
    // resends by itself waits out its backoff.
    const headDelay = headSendDelayMs(head)
    if (headDelay == null) return
    // A timer, not a microtask: the commit that completed the previous turn
    // settles first, and a just-bounced retry waits out its backoff.
    const wait = Math.max(
      headDelay,
      flushRetryDelayMs(Date.now(), lastBounceAtRef.current ?? 0)
    )
    const timer = setTimeout(() => {
      const current = argsRef.current
      if (heldDrainInFlightRef.current || !current.isConnectionReady()) return
      const next = current.dequeue()
      if (!next) return
      current.sendHead(next)
      setFlushAttempts((n) => n + 1)
    }, wait)
    return () => clearTimeout(timer)
  }, [
    canSendNow,
    busy,
    heldDrainsSettled,
    queueLength,
    head,
    lastBounceAtRef,
    flushAttempts,
  ])

  useEffect(() => {
    if (
      !shouldDrainIntoHeldTurn({
        canDeliverNow: heldTurnReady,
        head,
        busy: heldDrainInFlightRef.current || busy,
        editingItemId,
      })
    ) {
      return
    }
    if (!head) return
    const current = argsRef.current
    const payload = buildSteerPayload(head.draft)
    if (!payload) {
      // Nothing deliverable (attachments with no text stand-in): the flush
      // sends it as an ordinary prompt when the turn ends.
      current.holdUntilTurnEnd(head.id)
      return
    }
    heldDrainInFlightRef.current = true
    void current
      .deliverIntoHeldTurn(payload.text, payload.blocks, head.clientMessageId)
      .then(() => argsRef.current.remove(head.id))
      .catch((error: unknown) => {
        // Either way it now goes out as an ordinary prompt once the turn is
        // over, and is not delivered again in the meantime: the backend said
        // the turn already ended (the flush sends it as soon as this side
        // sees that too), or the delivery would fail the same way again.
        argsRef.current.holdUntilTurnEnd(head.id)
        if (isNoActiveTurnRejection(error)) return
        argsRef.current.onHeldDeliveryFailed?.(error)
      })
      .finally(() => {
        heldDrainInFlightRef.current = false
        setHeldDrainsSettled((n) => n + 1)
      })
  }, [busy, editingItemId, head, heldDrainsSettled, heldTurnReady])
}
