"use client"

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import {
  interruptedSendFailure,
  retryNow,
  type SendFailure,
} from "@/lib/send-failure"
import {
  loadOutbox,
  removeOutbox,
  saveOutbox,
  type InFlightMessage,
} from "@/lib/outbox-storage"

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
   * The id every send of this message carries (`client_message_id`, and the
   * client id of an insert into the running turn). The server answers a
   * repeat with the same id as a duplicate instead of delivering it again, so
   * a resend after a lost answer is safe. Kept across bounces and failures;
   * an edit makes it a new message with a new id.
   */
  clientMessageId: string
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
  /**
   * Set when a send of this message failed: the row shows "Not sent" with the
   * reason. One that `autoRetry`s goes out again by itself once the
   * connection is back; one that does not waits for Retry (and holds the
   * messages behind it, keeping their order).
   */
  failure?: SendFailure
}

/** What a message re-entering the queue keeps from its earlier life. */
export interface RequeueOptions {
  clientMessageId?: string
  failure?: SendFailure
  adoptSendTimeMode?: boolean
  holdUntilTurnEnd?: boolean
}

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: RequeueOptions
  ) => void
  /** Mark a queued message to wait for the end of the turn (see
   *  {@link QueuedMessage.holdUntilTurnEnd}). */
  holdUntilTurnEnd: (id: string) => void
  /**
   * Put a draft back at the FRONT of the queue. Used when an auto-flushed item
   * was dequeued, sent, and bounced (TurnBusyError) or failed: it must return
   * to the head so it retries before items that were already behind it (FIFO
   * preserved).
   */
  requeueFront: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: RequeueOptions
  ) => void
  dequeue: () => QueuedMessage | undefined
  remove: (id: string) => void
  reorder: (items: QueuedMessage[]) => void
  updateItem: (id: string, draft: PromptDraft) => void
  /** Mark a queued message as not sent (see {@link QueuedMessage.failure}). */
  markFailed: (id: string, failure: SendFailure) => void
  /** Retry a "Not sent" message now. */
  retry: (id: string) => void
  /**
   * Record a message that is on its way to the server, until
   * {@link settleSend} is called for it. Stored with the queue, so a message
   * whose send outlives the page comes back at the front of the queue.
   */
  trackSend: (entry: Omit<InFlightMessage, "startedAt">) => void
  /** The server answered (or the send was handed back to the queue). */
  settleSend: (clientMessageId: string) => void
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

/** A new client message id, in the namespace the optimistic turns use. */
export function newClientMessageId(): string {
  return `optimistic-${randomUUID()}`
}

/** The queue a stored outbox restores to: what was queued, behind every
 *  message that was still on its way (oldest first), those marked as
 *  interrupted so they go out again with their ids. */
function restoreQueue(storageKey: string | null | undefined): OutboxState {
  const empty: OutboxState = { queue: [], inflight: new Map() }
  if (!storageKey) return empty
  const stored = loadOutbox(storageKey)
  if (!stored) return empty
  const queued = new Set(stored.queue.map((item) => item.clientMessageId))
  const interrupted: QueuedMessage[] = [...stored.inflight]
    .sort((a, b) => a.startedAt - b.startedAt)
    .filter((entry) => !queued.has(entry.clientMessageId))
    .map((entry) => ({
      id: randomUUID(),
      draft: entry.draft,
      modeId: entry.modeId,
      clientMessageId: entry.clientMessageId,
      failure: interruptedSendFailure(),
    }))
  return { queue: [...interrupted, ...stored.queue], inflight: new Map() }
}

interface OutboxState {
  queue: QueuedMessage[]
  inflight: Map<string, InFlightMessage>
}

/**
 * One outbox: the queue and the messages in flight, written through to
 * storage when it has a key. Shared by every component using the same key in
 * this page (a canvas draft card and the card that replaces it once its
 * conversation exists), so a send that settles after a hand-off lands where
 * the user can see it, and a component that remounts mid-send does not mistake
 * its own in-flight message for one interrupted by a reload.
 */
class OutboxStore {
  state: OutboxState
  private listeners = new Set<() => void>()

  constructor(readonly key: string | null) {
    this.state = restoreQueue(key)
    // Restored interrupted messages are stored as queued at once, so a
    // second reload before they go out still has them.
    this.persist()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      this.disposeIfIdle()
    }
  }

  getQueue = () => this.state.queue

  setQueue(queue: QueuedMessage[]) {
    this.state = { ...this.state, queue }
    this.persist()
    this.emit()
  }

  persist() {
    if (!this.key) return
    saveOutbox(this.key, {
      queue: this.state.queue.map((item) => ({ ...item })),
      inflight: [...this.state.inflight.values()],
    })
  }

  emit() {
    for (const listener of [...this.listeners]) listener()
  }

  private disposeIfIdle() {
    if (!this.key || this.listeners.size > 0) return
    if (this.state.queue.length > 0 || this.state.inflight.size > 0) return
    if (keyedStores.get(this.key) === this) keyedStores.delete(this.key)
  }
}

const keyedStores = new Map<string, OutboxStore>()

function storeFor(key: string): OutboxStore {
  let store = keyedStores.get(key)
  if (!store) {
    store = new OutboxStore(key)
    keyedStores.set(key, store)
  }
  return store
}

/** Move every message of `from` into `to` (behind what `to` holds). */
function moveOutboxMessages(from: OutboxStore, to: OutboxStore): void {
  if (from.state.queue.length === 0 && from.state.inflight.size === 0) return
  const have = new Set(to.state.queue.map((item) => item.clientMessageId))
  to.state = {
    queue: [
      ...to.state.queue,
      ...from.state.queue.filter((item) => !have.has(item.clientMessageId)),
    ],
    inflight: new Map([...to.state.inflight, ...from.state.inflight]),
  }
  from.state = { queue: [], inflight: new Map() }
  if (from.key) removeOutbox(from.key)
  from.emit()
  to.persist()
  to.emit()
}

/** Forget the in-memory outboxes, as a reload does (tests). */
export function resetOutboxStoresForTests(): void {
  keyedStores.clear()
}

/**
 * A conversation's message queue. With a `storageKey` it is also the
 * conversation's local outbox: the queue and the messages in flight are
 * stored on every change (see `lib/outbox-storage.ts`) and restored when the
 * page loads, so no message the user sent is lost before the server has it.
 * A changed key (a draft tab that became a conversation) carries the messages
 * over.
 */
export function useMessageQueue(
  storageKey?: string | null
): UseMessageQueueReturn {
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  // The store this instance works on. Mutations go through it synchronously,
  // so `getQueueLength` reflects the same-tick result of an
  // enqueue/requeue/dequeue before React commits the next render (the
  // direct-send routing depends on that: a bounce that re-queues a draft must
  // never leave a window where a caller still sees an empty queue).
  const [privateStore] = useState(() => new OutboxStore(null))
  const store = storageKey ? storeFor(storageKey) : privateStore
  // The store mutations go to, read when they run rather than when they were
  // created: a send that settles after the key changed (a new tab's first
  // message, answered once its conversation exists) lands in the store the
  // queue lives in now. Moved over in the layout effect below, before any
  // event can run against the new render.
  const storeRef = useRef<OutboxStore>(store)
  const queue = useSyncExternalStore(
    store.subscribe,
    store.getQueue,
    store.getQueue
  )

  // A key change carries the messages along (a draft tab's unsent messages
  // become its conversation's), joined by any the new key already held.
  useLayoutEffect(() => {
    const from = storeRef.current
    if (from === store) return
    moveOutboxMessages(from, store)
    storeRef.current = store
  }, [store])

  const commit = useCallback((next: QueuedMessage[]) => {
    storeRef.current.setQueue(next)
  }, [])

  const buildItem = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      opts?: RequeueOptions
    ): QueuedMessage => ({
      id: randomUUID(),
      draft,
      modeId,
      clientMessageId: opts?.clientMessageId ?? newClientMessageId(),
      ...(opts?.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
      ...(opts?.holdUntilTurnEnd ? { holdUntilTurnEnd: true } : {}),
      ...(opts?.failure ? { failure: opts.failure } : {}),
    }),
    []
  )

  const enqueue = useCallback(
    (draft: PromptDraft, modeId: string | null, opts?: RequeueOptions) => {
      commit([...storeRef.current.state.queue, buildItem(draft, modeId, opts)])
    },
    [buildItem, commit]
  )

  const holdUntilTurnEnd = useCallback(
    (id: string) => {
      const current = storeRef.current.state.queue
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
    (draft: PromptDraft, modeId: string | null, opts?: RequeueOptions) => {
      commit([buildItem(draft, modeId, opts), ...storeRef.current.state.queue])
    },
    [buildItem, commit]
  )

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = storeRef.current.state.queue
    if (current.length === 0) return undefined
    commit(current.slice(1))
    return current[0]
  }, [commit])

  const remove = useCallback(
    (id: string) => {
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      commit(storeRef.current.state.queue.filter((item) => item.id !== id))
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
      const current = storeRef.current.state.queue
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
      // An edited message is a new message: a fresh id (so a delivered copy
      // of the old text cannot swallow it as a duplicate) and no failure.
      commit(
        storeRef.current.state.queue.map((item) =>
          item.id === id
            ? {
                id: item.id,
                draft,
                modeId: item.modeId,
                clientMessageId: newClientMessageId(),
                ...(item.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
                ...(item.holdUntilTurnEnd ? { holdUntilTurnEnd: true } : {}),
              }
            : item
        )
      )
      setEditingItemId(null)
    },
    [commit]
  )

  const markFailed = useCallback(
    (id: string, failure: SendFailure) => {
      if (!storeRef.current.state.queue.some((item) => item.id === id)) return
      commit(
        storeRef.current.state.queue.map((item) =>
          item.id === id ? { ...item, failure } : item
        )
      )
    },
    [commit]
  )

  const retry = useCallback(
    (id: string) => {
      const target = storeRef.current.state.queue.find((item) => item.id === id)
      if (!target?.failure) return
      const failure = retryNow(target.failure)
      commit(
        storeRef.current.state.queue.map((item) =>
          item.id === id ? { ...item, failure } : item
        )
      )
    },
    [commit]
  )

  const trackSend = useCallback((entry: Omit<InFlightMessage, "startedAt">) => {
    const target = storeRef.current
    target.state.inflight.set(entry.clientMessageId, {
      ...entry,
      startedAt: Date.now(),
    })
    target.persist()
  }, [])

  const settleSend = useCallback((clientMessageId: string) => {
    const target = storeRef.current
    if (!target.state.inflight.delete(clientMessageId)) return
    target.persist()
  }, [])

  const getQueueLength = useCallback(
    () => storeRef.current.state.queue.length,
    []
  )

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
    markFailed,
    retry,
    trackSend,
    settleSend,
    getQueueLength,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
