import type { AttachPhase, ConnectionStatus } from "@/lib/types"

/**
 * The attach phases that mean "still on the way to a usable session". `ready`
 * and `failed` are terminal; `null`/`undefined` means the server never said
 * (an older server, which only handed out connections whose session was open)
 * and is treated as ready.
 */
export type AttachingPhase = Exclude<AttachPhase, "ready" | "failed">

export function isAttachingPhase(
  phase: AttachPhase | null | undefined
): phase is AttachingPhase {
  return (
    phase === "queued" ||
    phase === "starting" ||
    phase === "resuming" ||
    phase === "loading" ||
    phase === "creating" ||
    phase === "configuring"
  )
}

/**
 * The status to keep in the store for a `status_changed` / snapshot status,
 * given the connection's attach phase. The backend reports `connected` as soon
 * as the agent answers `initialize` — for a resumed session that is long
 * before it can take a prompt — so while the session is still opening the
 * connection reads as `connecting`. Every surface that gates on `connected`
 * (send, queue flush, selectors) then waits for the session itself.
 */
export function statusWhileAttaching(
  status: ConnectionStatus,
  phase: AttachPhase | null | undefined
): ConnectionStatus {
  return status === "connected" && isAttachingPhase(phase)
    ? "connecting"
    : status
}

/** i18n key (under `Folder.chat.attachPhase`) naming each attaching phase. */
export const ATTACH_PHASE_LABEL_KEYS = {
  queued: "queued",
  starting: "starting",
  resuming: "resuming",
  loading: "loading",
  creating: "creating",
  configuring: "configuring",
} as const satisfies Record<AttachingPhase, string>

/**
 * Past this, the UI adds a line saying the wait is the agent's own startup.
 * A healthy Claude Code resume takes 2–15 s; beyond ~20 s it is almost always
 * a SessionStart hook or a busy machine, and the user should know it is not
 * codeg that is stuck.
 */
export const SLOW_ATTACH_MS = 20_000

/** Whole seconds and minutes for an elapsed-time label. */
export function splitElapsed(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(ms / 1000))
  return { minutes: Math.floor(total / 60), seconds: total % 60 }
}
