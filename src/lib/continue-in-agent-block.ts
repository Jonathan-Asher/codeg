import { summaryActivity } from "@/lib/session-activity"
import type {
  AttentionKind,
  ConversationBackground,
  DbConversationSummary,
} from "@/lib/types"

/**
 * When "Continue in another agent…" can run on a session (see
 * `lib/continue-in-agent.ts`). Its own module, with nothing heavier than the
 * session-activity rules behind it, so every menu that offers the item can
 * ask without loading the tab store.
 */

/** Why "Continue in another agent…" can't run on a session right now. */
export type ContinueInAgentBlock =
  /** No agent session yet: nothing to hand off. */
  | "no_session"
  /** A delegation sub-session, driven by its parent. */
  | "subsession"
  /** A turn is running. */
  | "turn_running"
  /** A permission, question or plan waits for the user. */
  | "needs_you"
  /** A handoff of it is already being written. */
  | "in_progress"

export type ContinuableConversation = Pick<
  DbConversationSummary,
  "id" | "external_id" | "turn_state" | "status" | "parent_id"
>

/** Sessions whose handoff is being written, so a second click waits. */
const inProgress = new Set<number>()

/** Mark (or clear) a session's handoff as being written. */
export function setContinuationInProgress(
  conversationId: number,
  active: boolean
): void {
  if (active) inProgress.add(conversationId)
  else inProgress.delete(conversationId)
}

/**
 * Why the item is disabled for `conversation`, or `null` when it can run.
 * The handoff is a new turn on the session, so it waits for the running one
 * and for anything the session asks of the user; the backend refuses a turn
 * that started meanwhile too.
 */
export function continueInAgentBlock(
  conversation: ContinuableConversation | null | undefined,
  attention?: AttentionKind | null,
  background?: ConversationBackground | null
): ContinueInAgentBlock | null {
  if (!conversation) return "no_session"
  if (conversation.parent_id != null) return "subsession"
  if (inProgress.has(conversation.id)) return "in_progress"
  if (attention) return "needs_you"
  if (summaryActivity(conversation, null, background) === "working")
    return "turn_running"
  if (!conversation.external_id) return "no_session"
  return null
}
