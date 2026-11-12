import type { AutoResumeItemState, AutoResumeStatus } from "@/lib/types"

/**
 * Resume after restart: when codeg quits, crashes or restarts for an update,
 * the backend picks the turns that exit cut off back up on the next start,
 * by sending {@link RESUME_AFTER_RESTART_PROMPT} into each session through the
 * normal prompt path (`src-tauri/crates/codeg-lib/src/acp/auto_resume.rs`).
 * A session whose turn had ended but whose background work the exit stopped
 * gets {@link RESUME_BACKGROUND_PROMPT_HEAD} and the list of that work.
 *
 * The texts are the backend's constants, verbatim — a Rust test reads this
 * file and fails if they drift apart. Like Continue (see `lib/continue-turn`),
 * the transcript recognizes the turn by its text alone, because that is all a
 * reload keeps, and draws it as a slim "Resumed after restart" divider instead
 * of a user bubble.
 */
export const RESUME_AFTER_RESTART_PROMPT =
  "codeg restarted while you were working, so your last turn was cut off. Anything that was running in the background (sub-agents, background shells, monitors) was stopped. Continue where you left off, re-launching anything that still needs to run."

/**
 * Heads the list {@link RESUME_AFTER_RESTART_PROMPT} carries when background
 * work was running too (backend `RESUME_TURN_BACKGROUND_HEADER`): the prompt,
 * a blank line, this line, then one `- ` line per item.
 */
export const RESUME_TURN_BACKGROUND_HEADER =
  "What was running in the background when codeg stopped:"

/**
 * The first line of the prompt that resumes a session whose turn had ended
 * but whose background work the restart stopped (backend
 * `RESUME_BACKGROUND_PROMPT_HEAD`). One `- ` line per stopped item follows,
 * then {@link RESUME_BACKGROUND_PROMPT_TAIL}. Recognized by this line.
 */
export const RESUME_BACKGROUND_PROMPT_HEAD =
  "codeg restarted. Your last turn had finished, but background work you started was still running and was stopped:"

/** The line after the background prompt's list (backend
 *  `RESUME_BACKGROUND_PROMPT_TAIL`). */
export const RESUME_BACKGROUND_PROMPT_TAIL =
  "Re-launch whatever still needs to run, then carry on."

/** Broadcast with the full {@link AutoResumeStatus} whenever the batch
 *  changes (mirrors the backend's `AUTO_RESUME_STATUS_EVENT`). */
export const AUTO_RESUME_STATUS_EVENT = "app://auto-resume-status"

/**
 * Which resume a user turn's text is, if any: `turn` — a cut-off turn picked
 * back up ({@link RESUME_AFTER_RESTART_PROMPT}, alone or followed by the list
 * of what ran in the background); `background` — a finished turn whose
 * background work was stopped ({@link RESUME_BACKGROUND_PROMPT_HEAD} and its
 * list). The lists vary, so both are recognized by how they start; the
 * prompt with anything else after it is a message the user wrote.
 */
export function resumeAfterRestartKind(
  text: string
): "turn" | "background" | null {
  const trimmed = text.trim()
  if (trimmed === RESUME_AFTER_RESTART_PROMPT) return "turn"
  if (
    trimmed.startsWith(
      `${RESUME_AFTER_RESTART_PROMPT}\n\n${RESUME_TURN_BACKGROUND_HEADER}\n`
    )
  ) {
    return "turn"
  }
  if (trimmed.startsWith(`${RESUME_BACKGROUND_PROMPT_HEAD}\n`)) {
    return "background"
  }
  return null
}

/** Whether a user turn's text is a prompt codeg sent to resume a session
 *  after a restart, of either kind ({@link resumeAfterRestartKind}). */
export function isResumeAfterRestartPrompt(text: string): boolean {
  return resumeAfterRestartKind(text) !== null
}

/** The stopped work a resume prompt lists, one `- ` line each (without the
 *  dash), for the divider's tooltip. Empty for a prompt without a list. */
export function resumeAfterRestartItems(text: string): string[] {
  if (resumeAfterRestartKind(text) === null) return []
  return text
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
}

/** The i18n key (under `AutoResume`) naming each item state. Literal on
 *  purpose: next-intl keys are typed. */
export const AUTO_RESUME_STATE_LABEL_KEYS = {
  pending: "statePending",
  resuming: "stateResuming",
  resumed: "stateResumed",
  failed: "stateFailed",
  stopped: "stateStopped",
  skipped: "stateSkipped",
} as const satisfies Record<AutoResumeItemState, string>

/** Items that have not reached their outcome yet — the ones Stop still
 *  cancels (a session being reopened is abandoned before its prompt). */
export function unsettledAutoResumes(status: AutoResumeStatus): number {
  return status.items.filter(
    (item) => item.state === "pending" || item.state === "resuming"
  ).length
}
