import { liveAsyncTasks } from "@/lib/async-tasks"
import type { AsyncTaskRecord, ConnectionStatus } from "@/lib/types"

/**
 * Turns held open for background work.
 *
 * claude-agent-acp keeps a turn's `session/prompt` pending while background
 * sub-agents that turn spawned are still running, so their task-notification
 * follow-ups land inside it. The agent answered long ago and is idle, but the
 * connection still reads `prompting` — for as long as the sub-agents run,
 * which can be an hour and more. The backend tells that state apart
 * (`awaiting_background`, see `claude_main_agent_pulse` in `connection.rs`);
 * this module turns it into the composer's and the status surfaces' decisions:
 *
 * - The session reads as idle with background work running, not "responding".
 * - Enter delivers the message into the held turn right away — through
 *   `_session/steering`, which claude-agent-acp routes into the idle agent at
 *   once (the adapter moves the held turn's outcome into its steer lane and
 *   re-holds it for the sub-agents afterwards) — instead of parking it in the
 *   local queue until the turn finally ends.
 * - The local queue drains into the held turn too, one message per idle
 *   stretch, except messages the user explicitly queued for the turn's end.
 */

/** The connection fields the held-turn decisions read. */
export interface HeldTurnConnection {
  status: ConnectionStatus | null | undefined
  awaitingBackground: boolean
  nativeSteering: boolean
}

/** Whether the connection is prompting only because background work holds
 *  the turn open — the agent itself is idle. */
export function isAwaitingBackground(
  conn: Pick<HeldTurnConnection, "status" | "awaitingBackground">
): boolean {
  return conn.status === "prompting" && conn.awaitingBackground
}

/** Whether a message can be delivered into the held turn right now: the turn
 *  is held for background work AND the session has the native steering
 *  channel that reaches the idle agent immediately. Without that channel the
 *  message has no way in until the turn ends, so it queues as before. */
export function canDeliverIntoHeldTurn(conn: HeldTurnConnection): boolean {
  return isAwaitingBackground(conn) && conn.nativeSteering
}

/**
 * How many background tasks to report as running. The transcript watcher's
 * count (async sub-agents + background shells) and the adapter's AIR task
 * table (shells, workflows, monitors) see overlapping work through different
 * channels, so the larger of the two is shown rather than their sum, which
 * would count the same shell twice. `0` means "running, count unknown".
 */
export function backgroundTaskCount(
  backgroundOutstanding: number,
  asyncTasks: AsyncTaskRecord[] | null | undefined
): number {
  const live = asyncTasks ? liveAsyncTasks(asyncTasks).length : 0
  return Math.max(backgroundOutstanding, live, 0)
}

/** Where a plain send from the composer goes. */
export type ComposerSendRoute =
  /** An ordinary prompt: the session is idle. */
  | "send"
  /** Into the turn held open for background work, right away. */
  | "deliver"
  /** The local queue, sent when the session is next ready. */
  | "enqueue"

export interface ComposerSendRouteInputs {
  /** The connection is `prompting` (held turns included). */
  isPrompting: boolean
  /** The session is still opening: plain sends wait in the queue. */
  queueSends: boolean
  /** A message can be delivered into a held turn now
   *  ({@link canDeliverIntoHeldTurn}). */
  canDeliverNow: boolean
  hasEnqueue: boolean
  hasDeliver: boolean
}

/**
 * Route a plain send (Enter / the primary button). While the agent is really
 * replying it queues, as it always has — the explicit "insert into current
 * turn" stays a separate action. While the turn is only held for background
 * work, the agent is idle and the message is delivered at once.
 */
export function routeComposerSend({
  isPrompting,
  queueSends,
  canDeliverNow,
  hasEnqueue,
  hasDeliver,
}: ComposerSendRouteInputs): ComposerSendRoute {
  if (queueSends && hasEnqueue) return "enqueue"
  if (!isPrompting) return "send"
  if (canDeliverNow && hasDeliver) return "deliver"
  return hasEnqueue ? "enqueue" : "send"
}

/** A queued message as far as the held-turn drain cares. */
export interface DrainCandidate {
  id: string
  /** Queued explicitly for the END of the turn (the composer's "Queue" while
   *  the turn was held): waits for the turn to finish, not for the agent to
   *  go idle. */
  holdUntilTurnEnd?: boolean
}

export interface HeldTurnDrainInputs {
  canDeliverNow: boolean
  /** The queue's head, if any. */
  head: DrainCandidate | undefined
  /** A delivery, a queued row's insert or an edit is already in flight. */
  busy: boolean
  /** The queue item open in the composer's editor, if any. */
  editingItemId: string | null
}

/**
 * Whether the queue's head should be delivered into the held turn now. FIFO:
 * a head that waits for the turn's end holds everything behind it, so the
 * user's order is kept. One message per idle stretch — delivering it wakes the
 * agent, which clears the held state until its reply is done.
 */
export function shouldDrainIntoHeldTurn({
  canDeliverNow,
  head,
  busy,
  editingItemId,
}: HeldTurnDrainInputs): boolean {
  if (!canDeliverNow || busy || !head) return false
  if (head.holdUntilTurnEnd) return false
  return head.id !== editingItemId
}
