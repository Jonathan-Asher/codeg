import type { AutoResumeItemState, AutoResumeStatus } from "@/lib/types"

/**
 * Resume after restart: when codeg quits, crashes or restarts for an update,
 * the backend picks the turns that exit cut off back up on the next start,
 * by sending {@link RESUME_AFTER_RESTART_PROMPT} into each session through the
 * normal prompt path (`src-tauri/src/acp/auto_resume.rs`).
 *
 * The prompt is the backend's `RESUME_AFTER_RESTART_PROMPT`, verbatim — a Rust
 * test reads this file and fails if the two drift apart. Like Continue (see
 * `lib/continue-turn`), the transcript recognizes the turn by its exact text
 * alone, because that is all a reload keeps, and draws it as a slim
 * "Resumed after restart" divider instead of a user bubble.
 */
export const RESUME_AFTER_RESTART_PROMPT =
  "codeg restarted while you were working, so your last turn was cut off. Anything that was running in the background (sub-agents, background shells, monitors) was stopped. Continue where you left off, re-launching anything that still needs to run."

/** Broadcast with the full {@link AutoResumeStatus} whenever the batch
 *  changes (mirrors the backend's `AUTO_RESUME_STATUS_EVENT`). */
export const AUTO_RESUME_STATUS_EVENT = "app://auto-resume-status"

/** Whether a user turn's text is exactly the resume-after-restart prompt. */
export function isResumeAfterRestartPrompt(text: string): boolean {
  return text.trim() === RESUME_AFTER_RESTART_PROMPT
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

/** Items that have not reached their outcome yet. */
export function unsettledAutoResumes(status: AutoResumeStatus): number {
  return status.items.filter(
    (item) => item.state === "pending" || item.state === "resuming"
  ).length
}

/** Items Stop would still cancel. */
export function pendingAutoResumes(status: AutoResumeStatus): number {
  return status.items.filter((item) => item.state === "pending").length
}
