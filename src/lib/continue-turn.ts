import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { isResumeAfterRestartPrompt } from "@/lib/auto-resume"
import { isLimitContinuePrompt } from "@/lib/limit-continue"
import { CONTINUE_PROMPT, type SessionActivity } from "@/lib/session-activity"
import type { PromptDraft, TurnRole } from "@/lib/types"

/**
 * Continue: let the agent keep going without writing a message.
 *
 * One click (or ⌘/Ctrl+Enter on an empty composer) sends
 * {@link CONTINUE_PROMPT} as an ordinary turn, through the same path a typed
 * message takes — so it works for every agent — and the transcript shows that
 * turn as a slim "Continued" divider rather than as a user bubble.
 *
 * How a continuation is recognised: by its text alone. A turn read back from
 * the agent's own session file (every reload) carries the parser's positional
 * id and nothing codeg attached when it sent the prompt, so no client id or
 * other mark survives. The rule is therefore exact: a user message whose whole
 * text is `continue` — no other words, no image, no attached file — is the
 * divider, live and after a reload alike. That includes one the user typed by
 * hand, which asks the agent for exactly the same thing. "continue with the
 * tests", or "continue" with a screenshot, stays a normal message.
 */

/** The keyboard shortcut for Continue in the chat composer, as a
 *  `matchShortcutEvent` binding. Only acts on an empty composer, and only while
 *  neither the send nor the newline binding has been set to it. */
export const CONTINUE_SHORTCUT = "mod+enter"

/** The draft Continue sends: the plain {@link CONTINUE_PROMPT}. */
export function continuePromptDraft(): PromptDraft {
  return {
    blocks: [{ type: "text", text: CONTINUE_PROMPT }],
    displayText: CONTINUE_PROMPT,
  }
}

/** Whether a user turn's text is exactly the Continue prompt. */
export function isContinuePrompt(text: string): boolean {
  return text.trim() === CONTINUE_PROMPT
}

/** The parts of a rendered message group the divider decision reads. */
export interface ContinuationGroupLike {
  role: TurnRole
  parts: ReadonlyArray<AdaptedContentPart>
  images: ReadonlyArray<unknown>
  resources: ReadonlyArray<unknown>
}

/**
 * The kinds of "keep going" turn the transcript draws as a divider:
 * `continued` — the Continue prompt ({@link CONTINUE_PROMPT}), sent by the
 * user; `resumed` — the prompt codeg sent itself to pick a turn back up after
 * a restart cut it off (`lib/auto-resume`); `limit` — the prompt codeg sent
 * itself once the account's usage limit reset (`lib/limit-continue`).
 */
export type ContinuationVariant = "continued" | "resumed" | "limit"

/**
 * Which divider a transcript message group reads as, if any: a user message
 * made of text only, whose text is exactly {@link CONTINUE_PROMPT}, the
 * resume-after-restart prompt or the continue-after-limit-reset prompt. Anything attached to it (an image, a file,
 * a non-text part) makes it a message the user wrote, which stays a bubble.
 */
export function continuationVariant(
  group: ContinuationGroupLike
): ContinuationVariant | null {
  if (group.role !== "user") return null
  if (group.images.length > 0 || group.resources.length > 0) return null
  if (group.parts.length === 0) return null
  let text = ""
  for (const part of group.parts) {
    if (part.type !== "text") return null
    text += part.text
  }
  if (isContinuePrompt(text)) return "continued"
  if (isResumeAfterRestartPrompt(text)) return "resumed"
  if (isLimitContinuePrompt(text)) return "limit"
  return null
}

/** Whether a transcript message group is drawn as a divider (a Continue turn
 *  or a resume after restart) rather than as a user bubble. */
export function isContinuationGroup(group: ContinuationGroupLike): boolean {
  return continuationVariant(group) !== null
}

/**
 * Whether the thread's newest message is the agent's: the last turn that is
 * not a system notice is an assistant turn. False for an empty thread and for
 * one that ends on a user message (still unanswered, or cut off before the
 * agent said anything — Retry covers that one).
 */
export function threadEndsWithAgentReply(
  timeline: ReadonlyArray<{ turn: { role: TurnRole } }>
): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const role = timeline[i].turn.role
    if (role === "system") continue
    return role === "assistant"
  }
  return false
}

export interface ContinueGateInputs {
  /** The session's activity for this tab (`deriveSessionActivity`, fed with
   *  this tab's own live connection). */
  activity: SessionActivity
  /** The thread ends on an agent reply ({@link threadEndsWithAgentReply}). */
  endsWithAgentReply: boolean
  /** A permission, question or plan approval is waiting on the user. */
  pendingInteraction: boolean
  /** Messages already waiting in the composer's queue. */
  queuedCount: number
  /** This tab's connection can take a prompt right now: connected, bound to
   *  this tab's agent and working directory, selectors loaded. */
  connectionReady: boolean
  /** The docked composer is shown (not the welcome screen, not replaced by a
   *  load-error banner). */
  composerAvailable: boolean
}

/**
 * Whether the conversation can offer Continue. The composer adds its own
 * half — an empty box, no attachment, no queue item open for editing.
 *
 * - `idle` (connected, nothing running): Continue sends a normal turn.
 * - `background` (the turn is held open only for background work and the
 *   agent is idle): Continue goes where Enter would — into the held turn, or
 *   the queue when the session has no way in until the turn ends.
 *
 * Never while a turn runs, while the session waits on the user, while it is
 * connecting or unreachable, for an interrupted turn (its banner carries its
 * own Continue), before the agent has replied, or while something is queued
 * (that message starts the next turn on its own).
 */
export function canOfferContinue({
  activity,
  endsWithAgentReply,
  pendingInteraction,
  queuedCount,
  connectionReady,
  composerAvailable,
}: ContinueGateInputs): boolean {
  if (!composerAvailable || !endsWithAgentReply) return false
  if (pendingInteraction || queuedCount > 0) return false
  if (activity === "idle") return connectionReady
  return activity === "background"
}
