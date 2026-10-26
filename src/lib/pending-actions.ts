/**
 * Conversation actions taken before the session is ready.
 *
 * Fork from here, Edit message, Continue and Retry all need the agent's
 * connection, and opening a session takes a few seconds. The transcript
 * offers them from the first frame anyway (see `lib/agent-capabilities`): a
 * click before the session is ready queues the action here, its button spins
 * and says it is waiting, and the queue runs it the moment the session can
 * take it. A second click, or Esc, takes it back.
 *
 * It follows the message queue's rules (`useMessageQueue`) rather than
 * inventing its own: actions wait for the same readiness the queue flush waits
 * for (connected to this agent and working directory, the session set up),
 * run one at a time in the order they were taken, run after any message that
 * was already waiting when they were taken, and hold back messages queued
 * after them. What differs is the failure: a message is the user's words and
 * stays queued as "Not sent", while an action is a click — when the session
 * cannot be reached, or turns out not to support it, it is dropped and a
 * notice says which.
 */

import type { AgentCapabilities } from "@/lib/agent-capabilities"
import { supportsMessageEdit } from "@/lib/edit-message"
import { supportsForkWhileRunning } from "@/lib/fork-from-turn"
import type { AgentType } from "@/lib/types"

export type PendingActionKind = "fork" | "edit" | "continue" | "retry"

export interface PendingAction<P = unknown> {
  id: string
  kind: PendingActionKind
  /** The control the action belongs to: one waiting action per control, and
   *  how a control finds out it is waiting (see the `*ActionTarget`s). */
  target: string
  payload: P
  /** Messages already in the message queue when this was taken: it runs after
   *  them, the way a typed message would. */
  after: readonly string[]
  /** When it was queued (epoch ms), for the double-click guard. */
  queuedAt: number
}

/** The "Fork from here" button of the reply `turnId` names. */
export function forkActionTarget(turnId: string): string {
  return `fork:${turnId}`
}

/** The editor of the user message `messageId` names. */
export function editActionTarget(messageId: string): string {
  return `edit:${messageId}`
}

/** The composer's Continue. */
export const CONTINUE_ACTION_TARGET = "continue"

/** The Retry under an unanswered last message. */
export const RETRY_ACTION_TARGET = "retry"

/**
 * A second click on a waiting control within this long of the first is the
 * same double click, not a request to take the action back.
 */
export const TOGGLE_GUARD_MS = 400

/** Whether the agent can do this kind of action at all. */
export function actionSupported(
  kind: PendingActionKind,
  agentType: AgentType,
  capabilities: AgentCapabilities
): boolean {
  switch (kind) {
    case "fork":
      return capabilities.supportsFork
    case "edit":
      return (
        capabilities.supportsFork &&
        supportsMessageEdit(agentType, capabilities.forkStrictPoint)
      )
    case "continue":
    case "retry":
      return true
  }
}

/** What the session looks like to the head of the queue right now. */
export interface ActionGateInputs {
  /** The session can take an action: connected to this tab's agent and
   *  working directory, and set up (`selectors_ready`). */
  ready: boolean
  /** What the CONNECTION said it can do, once it has — `null` while the
   *  buttons still run on the remembered answer. */
  capabilities: AgentCapabilities | null
  agentType: AgentType
  /** A turn is in flight on the session. */
  turnRunning: boolean
  /** Ids of the messages waiting in the message queue. */
  waitingMessageIds: ReadonlySet<string>
  /** Something that must finish first is under way: a fork or an edit, a
   *  message on its way to becoming a turn, a queued row being delivered. */
  busy: boolean
}

/**
 * - `run`: take it off the queue and run it now.
 * - `wait`: leave it (and everything behind it) where it is.
 * - `unsupported`: the connection says the agent cannot do it — drop it.
 */
export type ActionGate = "run" | "wait" | "unsupported"

/** Whether the head of the queue can run now (see {@link ActionGate}). */
export function actionGate(
  action: Pick<PendingAction, "kind" | "after">,
  {
    ready,
    capabilities,
    agentType,
    turnRunning,
    waitingMessageIds,
    busy,
  }: ActionGateInputs
): ActionGate {
  if (!ready || capabilities === null) return "wait"
  if (!actionSupported(action.kind, agentType, capabilities)) {
    return "unsupported"
  }
  if (action.after.some((id) => waitingMessageIds.has(id))) return "wait"
  if (busy) return "wait"
  switch (action.kind) {
    case "fork":
      // Between turns it forks in place; mid-turn only an agent that forks
      // while running can (into a new tab), the rest wait for the turn.
      return turnRunning &&
        !supportsForkWhileRunning(agentType, capabilities.forkWhileRunning)
        ? "wait"
        : "run"
    case "edit":
    case "retry":
      return turnRunning ? "wait" : "run"
    case "continue":
      // It joins the message queue, which waits for the turn by itself.
      return "run"
  }
}
