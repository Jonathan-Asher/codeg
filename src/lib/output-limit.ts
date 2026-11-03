/**
 * A reply the model cut off because it ran out of output tokens: the agent
 * ended the turn with the ACP stop reason `max_tokens` (pi's `length`,
 * Claude's `max_tokens`, …) — at max thinking a model can spend the whole
 * budget on reasoning and write no answer at all. The transcript reads as a
 * finished reply, so the thread says it hit the limit under it, with a
 * Continue that asks the agent to keep going (`CONTINUE_PROMPT`, the same
 * "continue" the composer's Continue sends).
 *
 * The stop reason reaches the client on `turn_complete` and, for a client
 * that attached after the turn ended, on the snapshot's `last_stop_reason`
 * (`ConnectionState.lastStopReason`); the next prompt clears it.
 */
export const OUTPUT_LIMIT_STOP_REASON = "max_tokens"

export function hitOutputLimit(stopReason: string | null | undefined): boolean {
  return stopReason === OUTPUT_LIMIT_STOP_REASON
}
