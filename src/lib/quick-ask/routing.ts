import type { ConnectionStatus } from "@/lib/types"
import type { QuickAskTargetKind } from "./prefs"

/**
 * Where a question goes once the session exists:
 *
 * - `send`  — the agent is idle: a normal prompt.
 * - `steer` — the agent is mid-reply and the session can take a message into
 *   the running turn: delivered right away over the same live-feedback channel
 *   (native `_session/steering`, or the pull tool) the composer's mid-turn send
 *   uses — and, like the composer, only while that feature is switched on.
 * - `queue` — the agent is mid-reply and cannot take it now: held and sent the
 *   moment the reply ends, like the composer's message queue. Also where an
 *   idle session's question goes while earlier ones are still waiting, so it
 *   cannot overtake them.
 *
 * A turn held open only for background work (`lib/background-idle.ts`) counts
 * as steerable whenever the session has the native steering channel, whether
 * or not live feedback is switched on: the agent is idle, and the composer's
 * plain send delivers into such a turn the same way.
 *
 * A private question is never steered: steering records a feedback note on the
 * session, and a private question must go through the unrecorded prompt path.
 */
export type QuickAskSendRoute = "send" | "steer" | "queue"

export function routeQuickAskSend(args: {
  target: QuickAskTargetKind
  status: ConnectionStatus | null
  /** Live feedback is enabled AND this session has a delivery channel. */
  steerable: boolean
  /** The turn is held open only for background work and the native steering
   *  channel reaches the idle agent (`canDeliverIntoHeldTurn`). */
  heldTurnReady?: boolean
  /** Earlier questions are still waiting in the queue. */
  queued?: boolean
}): QuickAskSendRoute {
  if (args.status !== "prompting") return args.queued ? "queue" : "send"
  if (args.target !== "private" && (args.steerable || args.heldTurnReady)) {
    return "steer"
  }
  return "queue"
}

/** How the prompt itself is sent for each target. */
export type QuickAskPromptTarget =
  | { kind: "linked"; folderId: number; conversationId: number }
  | { kind: "unlinked" }

export function promptOptionsFor(target: QuickAskPromptTarget): {
  folderId?: number
  conversationId?: number
  unlinked?: boolean
} {
  return target.kind === "unlinked"
    ? { unlinked: true }
    : { folderId: target.folderId, conversationId: target.conversationId }
}
