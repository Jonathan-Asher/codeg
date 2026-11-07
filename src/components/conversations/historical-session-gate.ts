import type { AgentType } from "@/lib/types"

/**
 * Whether a conversation view must hold its auto-connect until it knows which
 * agent session the conversation's row holds.
 *
 * Connecting without a session id makes the backend open a brand-new session
 * (`session/new`). For a conversation that already has one, the tab then runs
 * a session that is not the conversation's: the transcript on screen is the
 * row's, but a fork taken from it asks the agent for a reply its session never
 * had ("Session … not found"), and the next prompt goes to an agent with none
 * of the history — the row follows that session and the history moves to a
 * row of its own (codeg#500). Once connected, the tab stays on that session:
 * a later connect for the same agent and folder keeps the connection it has.
 *
 * So the view waits while:
 * - the detail is loading, or is a kept copy whose session id the server has
 *   not confirmed yet;
 * - or nothing has said yet which session the row holds: no detail, not even
 *   a kept copy, and no session id from anywhere else. Loading alone cannot
 *   say this. A session read back from the history cache waits for its disk
 *   read before the server is asked, and that wait is no loading state; the
 *   view's own mount has created the session's runtime entry by then, so the
 *   detail hook reports "not loading" with nothing loaded.
 *
 * A detail that came back says it outright, a row with no session included
 * (that one connects to a new session, as it should). A failed load does not
 * wait here: it is on screen with a retry, and connecting is held by the
 * failure itself. A draft's view, keyed by a virtual id, never fetches a
 * detail; its session id comes from its own connection. cline cannot resume a
 * session at all, so it never waits.
 */
export function awaitsHistoricalSessionId(view: {
  /** The tab shows a conversation that has a row. */
  hasPersistedConversation: boolean
  agentType: AgentType
  /** The view's runtime session is keyed by the row itself (opened from the
   *  sidebar, a fork, a link), not by a draft's virtual id. */
  opensRow: boolean
  detailLoading: boolean
  detailUnverified: boolean
  /** A detail, or a kept copy of one, is in the runtime store. */
  hasDetail: boolean
  detailFailed: boolean
  /** The session id the view would connect with, when it knows one. */
  sessionId: string | undefined
}): boolean {
  if (!view.hasPersistedConversation || view.agentType === "cline") {
    return false
  }
  if (view.detailLoading || view.detailUnverified) return true
  return (
    view.opensRow &&
    !view.hasDetail &&
    !view.detailFailed &&
    view.sessionId === undefined
  )
}
