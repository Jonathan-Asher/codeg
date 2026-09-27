"use client"

import { useCallback, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

export interface QueuedMessage {
  id: string
  draft: PromptDraft
  /**
   * The mode this message will be sent under. `null` means "leave the agent's
   * mode alone" — an explicit choice for the answer / plan-notes retry paths,
   * which must not switch mode on their way out.
   *
   * That is why {@link QueuedMessage.adoptSendTimeMode} exists as a separate
   * flag rather than being spelled `modeId === null`: "unknown yet" and
   * "deliberately none" are different intents.
   */
  modeId: string | null
  /**
   * Resolve the mode when this message actually SENDS, ignoring `modeId`.
   *
   * For messages queued before their tab could know its modes — a prompt parked
   * on a brand-new draft by "ask about this selection", which is enqueued while
   * the connection is still coming up. Without it the agent would run in
   * whatever mode it happened to start in while the composer above displayed the
   * user's saved mode.
   */
  adoptSendTimeMode?: boolean
  /**
   * Wait for the END of the turn, not merely for the agent to go idle.
   *
   * While a turn is held open only for background work the agent is idle, and
   * the queue drains into that turn one message at a time (see
   * `lib/background-idle.ts`). A message the user queued on purpose during
   * such a turn — the composer's "Queue" instead of a plain send — asked to
   * wait until the whole turn, background work included, has finished; so did
   * one whose delivery into the held turn failed outright. Those stay put (and
   * hold everything behind them, keeping FIFO) until the turn completes.
   */
  holdUntilTurnEnd?: boolean
}

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: { adoptSendTimeMode?: boolean; holdUntilTurnEnd?: boolean }
  ) => void
  /** Mark a queued message to wait for the end of the turn (see
   *  {@link QueuedMessage.holdUntilTurnEnd}). */
  holdUntilTurnEnd: (id: string) => void
  /**
   * Put a draft back at the FRONT of the queue. Used when an auto-flushed item
   * was dequeued, sent, and bounced (TurnBusyError): it must return to the head
   * so it retries before items that were already behind it (FIFO preserved).
   */
  requeueFront: (draft: PromptDraft, modeId: string | null) => void
  dequeue: () => QueuedMessage | undefined
  remove: (id: string) => void
  reorder: (items: QueuedMessage[]) => void
  updateItem: (id: string, draft: PromptDraft) => void
  /**
   * The queue length, read SYNCHRONOUSLY from the authoritative ref — it
   * reflects the same-tick result of an enqueue/requeue/dequeue, before React
   * commits the next render. Callers gating on "is the queue non-empty right
   * now" — the direct-send routing — must use this rather than `queue.length`
   * (which lags a render).
   */
  getQueueLength: () => number
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  // Authoritative copy of the queue, updated SYNCHRONOUSLY by every mutation
  // (before the React state commit). Reads that must observe the same-tick
  // result of a mutation — the direct-send queue routing — go through this
  // ref / `getQueueLength`, NOT the `queue` state (which lags until React
  // commits) and NOT a passive-effect-synced mirror (which lags a full
  // render). Without this, a bounce that re-queues a draft leaves a window
  // where a caller still sees an empty queue.
  const queueRef = useRef<QueuedMessage[]>(queue)

  // Update the authoritative ref first, then schedule the render. A plain value
  // (not a functional updater) is correct because `queueRef.current` is always
  // the latest committed value.
  const commit = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  const enqueue = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      opts?: { adoptSendTimeMode?: boolean; holdUntilTurnEnd?: boolean }
    ) => {
      commit([
        ...queueRef.current,
        {
          id: randomUUID(),
          draft,
          modeId,
          ...(opts?.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
          ...(opts?.holdUntilTurnEnd ? { holdUntilTurnEnd: true } : {}),
        },
      ])
    },
    [commit]
  )

  const holdUntilTurnEnd = useCallback(
    (id: string) => {
      const current = queueRef.current
      if (!current.some((item) => item.id === id && !item.holdUntilTurnEnd)) {
        return
      }
      commit(
        current.map((item) =>
          item.id === id ? { ...item, holdUntilTurnEnd: true } : item
        )
      )
    },
    [commit]
  )

  const requeueFront = useCallback(
    (draft: PromptDraft, modeId: string | null) => {
      commit([{ id: randomUUID(), draft, modeId }, ...queueRef.current])
    },
    [commit]
  )

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current
    if (current.length === 0) return undefined
    commit(current.slice(1))
    return current[0]
  }, [commit])

  const remove = useCallback(
    (id: string) => {
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      commit(queueRef.current.filter((item) => item.id !== id))
    },
    [commit, editingItemId]
  )

  const reorder = useCallback(
    (items: QueuedMessage[]) => {
      // Apply a reorder ONLY if it is a true permutation of the live queue, and
      // rebuild it from the AUTHORITATIVE items rather than the caller's
      // (possibly stale) objects. A drag emission carries the queue order from
      // the render it began in; if the live queue changed since (dequeue /
      // requeue / remove / updateItem), the dragged array is stale. Reject any
      // length mismatch, unknown id, or repeated id (e.g. `[A, A]` would
      // otherwise drop `B` and duplicate `A`); commit the current item objects
      // in the requested order so a concurrent `updateItem` isn't clobbered.
      const current = queueRef.current
      if (items.length !== current.length) return
      const byId = new Map(current.map((item) => [item.id, item]))
      const seen = new Set<string>()
      const next: QueuedMessage[] = []
      for (const item of items) {
        const authoritative = byId.get(item.id)
        if (!authoritative || seen.has(item.id)) return
        seen.add(item.id)
        next.push(authoritative)
      }
      commit(next)
    },
    [commit]
  )

  const updateItem = useCallback(
    (id: string, draft: PromptDraft) => {
      commit(
        queueRef.current.map((item) =>
          item.id === id ? { ...item, draft } : item
        )
      )
      setEditingItemId(null)
    },
    [commit]
  )

  const getQueueLength = useCallback(() => queueRef.current.length, [])

  const startEditing = useCallback((id: string) => {
    setEditingItemId(id)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [])

  return {
    queue,
    enqueue,
    holdUntilTurnEnd,
    requeueFront,
    dequeue,
    remove,
    reorder,
    updateItem,
    getQueueLength,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
