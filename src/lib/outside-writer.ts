/**
 * A session another process runs.
 *
 * Claude Code keeps no lock on a session: two processes that both resume one
 * append to its transcript from their own contexts, and its history splits.
 * So the backend will not resume a session a process codeg did not start is
 * running — an orchestrating session's `claude --resume <id> -p` worker, a
 * terminal (`AcpError::SessionRunningElsewhere`, code
 * `session_running_elsewhere`). Its message ends in a marker naming that
 * process, `[running_elsewhere pid=<pid> started_at=<epoch ms>]`, because
 * Tauri hands a command's error over as its message alone. The session view
 * then shows the transcript as it grows, waits for the process to finish and
 * connects once it has — unless the user connects anyway.
 *
 * Dependency-free so the recognition is unit-testable without the API client.
 */

const RUNNING_ELSEWHERE_MARKER =
  /\[running_elsewhere pid=(\d+)(?: started_at=(\d+))?\]/

/** The process running a session, as the backend names it. */
export interface OutsideWriter {
  pid: number
  /** When it registered, in milliseconds since the epoch, if it said. */
  startedAt: number | null
  /** What it last said it was doing (`busy`, `idle`, …), if it said. */
  status?: string | null
}

/**
 * The process a refused connect names, or `null` for any other error.
 * Accepts every transport shape: a bare string (Tauri), or an object whose
 * `message` carries the marker (web, and an `Error`).
 */
export function outsideWriterFromError(err: unknown): OutsideWriter | null {
  const message =
    err && typeof err === "object"
      ? (err as { message?: unknown }).message
      : err
  if (typeof message !== "string") return null
  const match = RUNNING_ELSEWHERE_MARKER.exec(message)
  if (!match) return null
  return {
    pid: Number(match[1]),
    startedAt: match[2] ? Number(match[2]) : null,
  }
}

/**
 * When the process started, in the user's clock: "14:05" today, "Nov 2,
 * 14:05" another day — or `null` when it did not say.
 */
export function formatOutsideWriterStart(
  startedAt: number | null | undefined,
  locale?: string,
  now: number = Date.now()
): string | null {
  if (startedAt == null || !Number.isFinite(startedAt)) return null
  const at = new Date(startedAt)
  const today = new Date(now)
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(at)
}

/** How often a view waiting on another process asks whether it is done. */
export const OUTSIDE_WRITER_POLL_MS = 2_000
/** The longest it waits between asks after the asks start failing. */
export const OUTSIDE_WRITER_POLL_MAX_MS = 15_000
