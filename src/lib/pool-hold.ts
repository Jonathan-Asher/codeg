/**
 * Messages held back while every Claude subscription behind the local account
 * pool is at its limit.
 *
 * Sent anyway, a prompt would sit in the agent's own 429 retry backoff with
 * nothing said, so the backend refuses it before it reaches the agent
 * (`AcpError::PoolExhausted`, code `pool_exhausted`). Its message ends in a
 * marker carrying when the first account frees up —
 * `[pool_exhausted resumes_at=<epoch seconds>]` — because Tauri hands a
 * command's error over as its message alone. The composer keeps the message
 * queued with that status and sends it once the pool has room again.
 *
 * Dependency-free so the recognition is unit-testable without the API client.
 */

const POOL_EXHAUSTED_MARKER = /\[pool_exhausted(?: resumes_at=(\d+))?\]/
const POOL_EXHAUSTED_CODE = "pool_exhausted"

/** What the pool said: when its first held-back account frees up. */
export interface PoolHold {
  /** Epoch seconds, or `null` when the pool does not know. */
  resumesAt: number | null
}

/** Thrown by `acpPrompt` when the backend held the prompt back for the pool. */
export class PoolExhaustedError extends Error {
  readonly resumesAt: number | null

  constructor(resumesAt: number | null) {
    super("all Claude subscriptions are at their limit")
    this.name = "PoolExhaustedError"
    this.resumesAt = resumesAt
  }
}

/**
 * The pool hold a backend error stands for, or `null` for any other error.
 * Accepts every transport shape: a bare string (Tauri), or an object with a
 * `message` carrying the marker and/or the stable `code` (web).
 */
export function poolHoldFromError(err: unknown): PoolHold | null {
  let message: unknown = err
  let code: unknown
  if (err && typeof err === "object") {
    message = (err as { message?: unknown }).message
    code = (err as { code?: unknown }).code
  }
  if (typeof message === "string") {
    const match = POOL_EXHAUSTED_MARKER.exec(message)
    if (match) return { resumesAt: match[1] ? Number(match[1]) : null }
  }
  return code === POOL_EXHAUSTED_CODE ? { resumesAt: null } : null
}

/** The message without its machine-readable marker, for a log or a detail. */
export function stripPoolMarker(message: string): string {
  return message.replace(POOL_EXHAUSTED_MARKER, "").trim()
}

/**
 * "17:40" — when the pool frees up, in the user's clock — or `null` when it
 * is not known (or already past).
 */
export function formatPoolResumeTime(
  resumesAt: number | null | undefined,
  locale?: string,
  now: number = Date.now()
): string | null {
  if (resumesAt == null || !Number.isFinite(resumesAt)) return null
  const at = resumesAt * 1000
  if (at <= now) return null
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at))
}

/** Margin after the reset before a held message is tried again. */
export const POOL_RETRY_MARGIN_MS = 3_000

/**
 * Longest a held message waits without news before it is tried again. The
 * pool's readings are pushed every minute, so this only matters when they
 * stop arriving; a retry that is still refused is held again.
 */
export const POOL_RETRY_FALLBACK_MS = 60_000

/** How long until a held message is tried again without other news. */
export function poolRetryDelayMs(
  hold: PoolHold,
  now: number = Date.now()
): number {
  if (hold.resumesAt == null) return POOL_RETRY_FALLBACK_MS
  const until = hold.resumesAt * 1000 - now + POOL_RETRY_MARGIN_MS
  return Math.max(POOL_RETRY_MARGIN_MS, until)
}

/**
 * Whether a pushed pool reading lets held messages go: the pool is gone, its
 * reading can't tell (the backend then lets prompts through too), or some
 * account has headroom again.
 */
export function poolReadingReleases(
  pool: { exhausted: boolean; stale: boolean } | null
): boolean {
  return !pool || pool.stale || !pool.exhausted
}
