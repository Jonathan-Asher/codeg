import type { ConnectionStatus } from "@/lib/types"

/**
 * Rate-limiting for the conversation message-queue auto-flush.
 *
 * When a queued message is sent but the backend rejects it because a turn is
 * already in flight (TurnBusyError), the draft is re-queued. The queue's
 * level-triggered flush would otherwise re-send it immediately — and if the
 * backend stays busy while the client still believes it is idle (the
 * "prompting" broadcast is delayed or missed), that becomes a retry storm of
 * one bounced send per round-trip. This backoff bounds the retry RATE.
 */

/** Minimum gap between auto-flush retries after a bounced (busy) send. */
export const QUEUE_FLUSH_RETRY_BACKOFF_MS = 1000

/**
 * Milliseconds to wait before the next queue-flush attempt, given `now` and the
 * timestamp of the last bounce (`lastBounceAt`, 0 if none). Returns 0 when no
 * bounce has happened recently — a normal queued message flushes promptly; only
 * a just-bounced retry is delayed.
 */
export function flushRetryDelayMs(
  now: number,
  lastBounceAt: number,
  backoffMs: number = QUEUE_FLUSH_RETRY_BACKOFF_MS
): number {
  // Clamp elapsed at 0 so a skewed/future bounce timestamp is treated as
  // just-bounced (full backoff) rather than yielding an unbounded delay. The
  // result is always within [0, backoffMs].
  const elapsed = Math.max(0, now - lastBounceAt)
  if (elapsed >= backoffMs) return 0
  return backoffMs - elapsed
}

/**
 * Whether a send should be routed to the TAIL of the message queue instead of
 * being sent immediately, to preserve FIFO order.
 *
 * The shared send handler serves two callers: the queue auto-flush (which
 * dequeued the head and must send it now — `fromQueueFlush`), and direct input
 * sends. A direct send issued while the queue is non-empty must NOT jump ahead
 * of already-queued items — it belongs at the tail. The auto-flush always sends
 * (it IS draining the queue), so it never tail-routes.
 */
export function shouldQueueDirectSend(
  fromQueueFlush: boolean,
  queueLength: number
): boolean {
  return !fromQueueFlush && queueLength > 0
}

/**
 * Whether the live connection is ready to accept a send for THIS tab: connected,
 * its established cwd matches the tab's intended working dir, AND it belongs to
 * the agent the tab currently has selected.
 *
 * Bare `connStatus === "connected"` is insufficient. A chat draft that just
 * retargeted into folderless mode (or any tab mid-reconnect) can read a stale
 * "connected" belonging to the PREVIOUS cwd for a render or two before the
 * reconnect lands. Sending then would deliver the prompt to the wrong
 * agent/workspace.
 *
 * The agent check covers the same hazard on the other axis: switching a draft's
 * agent leaves the OLD agent's connection live — at the same cwd — until the
 * lifecycle's reconnect lands, and for a not-installed target it never lands at
 * all. All three terms belong together because the queue auto-flush DEQUEUES
 * before handing the message to the send path: if the flush gate were weaker
 * than the send's own check, the message would be taken off the queue and then
 * silently dropped.
 *
 * Nullish cwds are normalized so `null`/`undefined` compare equal (both mean "no
 * cwd yet"). A nullish `connectedAgentType` means no agent has been recorded for
 * the connection yet, which is not a mismatch.
 */
export function isConnectionReady(
  connStatus: string | null | undefined,
  connectedWorkingDir: string | null | undefined,
  intendedWorkingDir: string | null | undefined,
  connectedAgentType: string | null | undefined,
  selectedAgentType: string | null | undefined
): boolean {
  return (
    connStatus === "connected" &&
    (connectedWorkingDir ?? null) === (intendedWorkingDir ?? null) &&
    (connectedAgentType == null || connectedAgentType === selectedAgentType)
  )
}

/**
 * Whether a direct submit must be rejected because an unbound new-tab create is
 * already in flight (single-flight the create).
 *
 * A second submit fired before the first create resolves (double Enter / double
 * click) would otherwise append an optimistic turn it can never deliver: the
 * create-pending guard that actually stops the duplicate returns only AFTER the
 * optimistic append. `hasPersistedId` is true once the tab is bound to a real
 * conversation row, so only the unbound path is single-flighted — persisted
 * conversations keep their legitimate concurrent queued-send behavior.
 */
export function shouldRejectDuplicateCreate(
  hasPersistedId: boolean,
  createPending: boolean
): boolean {
  return !hasPersistedId && createPending
}

/**
 * What a brand-new chat's composer reads, given its connection `status` as
 * already reconciled for the agent the chat has selected (a connection still
 * bound to the previous agent reads "connecting" — or "disconnected" when the
 * selected one is not installed).
 *
 * A new chat takes its first message whatever state its session is in on the
 * way up: not started yet, opening, or connected but still setting itself up
 * (`settingUp`: its selectors not reported yet, or picks made before it was
 * ready still on their way to it). All of them read "connecting", which is
 * what lets the composer queue a send — the queue sends it as soon as the
 * session is ready. Only while a session is expected at all (`canConnect`):
 * with no usable agent, or one that is not installed, there is nothing to
 * wait for.
 *
 * A connect that failed outright leaves no connection behind, so its status
 * reads `null`, as for one never started; `connectFailed` makes that read as
 * the failure it is — the queue then says "Not sent" and offers Retry instead
 * of promising to send.
 */
export function newChatComposerStatus({
  status,
  canConnect,
  settingUp,
  connectFailed,
}: {
  status: ConnectionStatus | null
  canConnect: boolean
  settingUp: boolean
  connectFailed: boolean
}): ConnectionStatus | null {
  if (status == null && connectFailed) return "error"
  if (!canConnect) return status
  if (status == null || status === "connecting") return "connecting"
  if (status === "connected" && settingUp) return "connecting"
  return status
}
