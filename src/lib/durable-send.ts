/**
 * The outcome handlers for one send of a user message, shared by the
 * composers that own a message queue (the conversation tab and the canvas
 * card). Whatever happens to the send, the message is kept until the server
 * has it:
 *
 * - accepted: it leaves the outbox. A `duplicate` answer means the server
 *   already had it from an earlier attempt whose answer was lost; the caller
 *   drops its optimistic copy and reloads the transcript.
 * - busy turn / account pool out: back into the queue, unmarked (it is
 *   waiting, not failed), as before.
 * - any other failure: back at the FRONT of the queue, marked "Not sent" with
 *   the reason (see `lib/send-failure.ts`). Front, because it was sent before
 *   anything queued since. Reachability failures resend by themselves once
 *   the connection is back; those return `true`, so the lifecycle hook raises
 *   no toast for them (the row says it). Others toast and wait for Retry.
 *
 * Every attempt carries the same `clientMessageId`, so a resend of a message
 * that did arrive is answered as a duplicate rather than delivered twice.
 */

import type { PromptAccepted } from "@/lib/api"
import type { PoolHold } from "@/lib/pool-hold"
import type { PromptDraft } from "@/lib/types"
import { nextSendFailure, type SendFailure } from "@/lib/send-failure"
import type { RequeueOptions } from "@/hooks/use-message-queue"

export interface DurableSendQueue {
  enqueue: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: RequeueOptions
  ) => void
  requeueFront: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: RequeueOptions
  ) => void
  settleSend: (clientMessageId: string) => void
}

export interface DurableSendArgs {
  queue: DurableSendQueue
  draft: PromptDraft
  modeId: string | null
  clientMessageId: string
  /** The failure of the previous attempt, when this is a resend. */
  previousFailure?: SendFailure
  /** The message was the queue's head (the auto-flush sent it). */
  fromQueueFlush: boolean
  /** Undo what the send put on screen (the optimistic turn, the sync state). */
  rollback: () => void
  /** A busy bounce happened (the flush backs off). */
  onBounce?: () => void
  /** The account pool held it back. */
  onPoolHold?: (hold: PoolHold) => void
  /** The server already had it. */
  onDuplicate?: () => void
  /** After a failure was recorded on the queued message. */
  onFailed?: (failure: SendFailure) => void
}

export interface DurableSendCallbacks {
  onAccepted: (accepted: PromptAccepted) => void
  onTurnInProgress: () => void
  onPoolExhausted: (hold: PoolHold) => void
  onSendFailed: (error: unknown) => boolean
}

export function durableSendCallbacks(
  args: DurableSendArgs
): DurableSendCallbacks {
  const {
    queue,
    draft,
    modeId,
    clientMessageId,
    previousFailure,
    fromQueueFlush,
    rollback,
  } = args
  const backToQueue = (opts?: RequeueOptions) => {
    queue.settleSend(clientMessageId)
    rollback()
    const keep: RequeueOptions = { clientMessageId, ...opts }
    // FIFO: the auto-flush draft WAS the queue head → back to the front; a
    // direct send (the queue was empty when it left) → tail.
    if (fromQueueFlush) queue.requeueFront(draft, modeId, keep)
    else queue.enqueue(draft, modeId, keep)
  }
  return {
    onAccepted: (accepted) => {
      queue.settleSend(clientMessageId)
      if (accepted.duplicate) args.onDuplicate?.()
    },
    onTurnInProgress: () => {
      args.onBounce?.()
      backToQueue()
    },
    onPoolExhausted: (hold) => {
      args.onBounce?.()
      backToQueue()
      args.onPoolHold?.(hold)
    },
    onSendFailed: (error) => {
      const failure = nextSendFailure(error, previousFailure)
      queue.settleSend(clientMessageId)
      rollback()
      queue.requeueFront(draft, modeId, { clientMessageId, failure })
      args.onFailed?.(failure)
      return failure.autoRetry
    },
  }
}

/**
 * Whether the queue's head may be sent now, and if not when to look again:
 * a "Not sent" head that waits for Retry holds the queue (`null`); one that
 * resends by itself waits out its backoff.
 */
export function headSendDelayMs(
  head: { failure?: SendFailure } | undefined,
  now: number = Date.now()
): number | null {
  const failure = head?.failure
  if (!failure) return 0
  if (!failure.autoRetry) return null
  return Math.max(0, failure.nextAttemptAt - now)
}

/**
 * Delay before reconnecting a failed session by itself, for the
 * `attempts + 1`-th time, while a message waits on it as "Not sent" for a
 * reason that goes again by itself: 5 s, 10 s, 20 s, then every 30 s.
 */
export function autoReconnectDelayMs(attempts: number): number {
  return Math.min(30_000, 5_000 * 2 ** Math.max(0, attempts))
}
