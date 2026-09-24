/**
 * What the chat's Retry button sends.
 *
 * Retry is offered on a trailing user turn the agent recorded but never
 * answered (it died, the turn was cut off, the connection dropped). The
 * message is already in the agent's session, so re-sending its text would put
 * it there twice — and on screen twice. Instead this short instruction asks
 * the agent to answer the message it already has, and the transcript renders
 * it as a slim "Retried" marker rather than a second user bubble (see
 * {@link isRetryNudge}). Because the marker is recognised by its text, it
 * survives a reload: the agent's own transcript carries the same words.
 */
export const RETRY_NUDGE_TEXT =
  "Your previous response didn't come through. Please answer my last message."

/** Whether a user turn's text is a Retry instruction (render it as a marker). */
export function isRetryNudge(text: string): boolean {
  return text.trim() === RETRY_NUDGE_TEXT
}
