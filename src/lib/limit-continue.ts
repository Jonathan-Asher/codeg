import type { DbConversationSummary, LimitPause } from "@/lib/types"

/**
 * Continue after the usage limit resets: when a turn stops because the
 * account hit its usage limit ("You've hit your weekly limit · resets 10pm"),
 * the backend pauses the conversation until the limit resets, then sends
 * {@link LIMIT_CONTINUE_PROMPT} into it through the normal prompt path
 * (`src-tauri/src/acp/limit_continue.rs`) — with no window open, and across
 * restarts.
 *
 * The prompt is the backend's `LIMIT_CONTINUE_PROMPT`, verbatim — a Rust test
 * reads this file and fails if the two drift apart. Like Continue and the
 * resume after a restart, the transcript recognizes the turn by its exact
 * text alone and draws it as a slim "Continued after limit reset" divider.
 */
export const LIMIT_CONTINUE_PROMPT =
  "Your usage limit has reset. Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete."

/** Whether a user turn's text is exactly the continuation prompt. */
export function isLimitContinuePrompt(text: string): boolean {
  return text.trim() === LIMIT_CONTINUE_PROMPT
}

/**
 * The conversation's usage-limit pause while it waits for the reset — the
 * continuation not sent yet (`scheduled`) or being sent (`claimed`). `null`
 * once its turn runs (`continuing` reads as working) or with no pause.
 */
export function waitingLimitPause(
  summary: Pick<DbConversationSummary, "limit_pause"> | null | undefined
): LimitPause | null {
  const pause = summary?.limit_pause
  if (!pause) return null
  return pause.state === "scheduled" || pause.state === "claimed" ? pause : null
}

/** The words a paused session shows: when the limit resets, as a clock time
 *  (with the day when it is not within the next 24 hours), and how long that
 *  is from now ("3h 12m", "2d 4h", "12m", "<1m"). */
export interface LimitResetParts {
  time: string
  remaining: string
}

export function limitResetParts(
  resetsAt: string,
  now: number = Date.now(),
  locale?: string
): LimitResetParts {
  const at = new Date(resetsAt)
  const ms = at.getTime() - now
  const sameDayish = ms < 24 * 60 * 60 * 1000
  const time = new Intl.DateTimeFormat(locale, {
    ...(sameDayish ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at)
  return { time, remaining: formatRemaining(ms) }
}

/** A compact, language-neutral span: `2d 4h`, `3h 12m`, `12m`, `<1m`. */
export function formatRemaining(ms: number): string {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "<1m"
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}
