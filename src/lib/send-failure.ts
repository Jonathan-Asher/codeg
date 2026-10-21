/**
 * Why a message the user sent did not reach the server, and whether it may be
 * sent again on its own.
 *
 * A failed send is never dropped: the message waits in the queue above the
 * composer, marked "Not sent" with the reason below. Failures that only mean
 * "the server could not be reached" (`autoRetry`) are resent by themselves
 * once the connection is back. The rest wait for the user's Retry, so a
 * message the server refuses is not sent into the same refusal forever.
 *
 * Every resend carries the message's `client_message_id`, so a send that did
 * reach the server before its answer was lost is recognised there and not
 * delivered twice.
 */

import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { isConnectionGoneError } from "@/lib/connection-teardown"

export type SendFailureReason =
  /** No answer: the network or the server's port is down. */
  | "network"
  /** The request was sent but nothing came back in time. */
  | "timeout"
  /** The server answered with an error of its own (5xx). */
  | "server"
  /** The agent's connection is gone (the server restarted, the agent exited). */
  | "connection"
  /** The server no longer accepts this client's sign-in. */
  | "unauthorized"
  /** The server refused the message itself (too large, invalid). */
  | "rejected"
  /** The page or app went away before the server answered. */
  | "interrupted"

export interface SendFailure {
  reason: SendFailureReason
  /** The error text, for the row's tooltip. */
  detail?: string
  /** Resent by itself once the connection is back. */
  autoRetry: boolean
  /** Failed attempts so far. */
  attempts: number
  /** Earliest time (ms) the next automatic attempt may go out. */
  nextAttemptAt: number
}

/** Automatic attempts for a failure that is not about reachability (an
 *  unexpected server error): it may be passing, but must not loop. */
export const MAX_AUTO_ATTEMPTS_UNEXPECTED = 3

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/** Delay before automatic attempt number `attempts + 1`. */
export function sendRetryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1))
}

const FETCH_FAILURE_MESSAGES = [
  "failed to fetch", // Chromium
  "load failed", // WebKit
  "networkerror when attempting to fetch resource", // Firefox
  "network request failed",
  "the network connection was lost",
  "the internet connection appears to be offline",
]

function httpStatusOf(message: string): number | null {
  const match = /\bHTTP (\d{3})\b/.exec(message)
  return match ? Number(match[1]) : null
}

/** Sort an error from `acp_prompt` / `submit_session_feedback` into a reason.
 *  `turn_in_progress` and `pool_exhausted` are not failures and are handled
 *  before this is consulted. */
export function classifySendError(error: unknown): {
  reason: SendFailureReason
  detail: string
} {
  const detail = toErrorMessage(error)
  const lower = detail.toLowerCase()
  if (isConnectionGoneError(error) || lower.includes("process exited")) {
    return { reason: "connection", detail }
  }
  const appError = extractAppCommandError(error)
  const status = httpStatusOf(appError?.message ?? detail)
  if (status != null) {
    if (status >= 500) return { reason: "server", detail }
    if (status === 401 || status === 403) {
      return { reason: "unauthorized", detail }
    }
    if (status === 408) return { reason: "timeout", detail }
    return { reason: "rejected", detail }
  }
  switch (appError?.code) {
    case "authentication_failed":
      return { reason: "unauthorized", detail }
    case "network_error":
      return lower.includes("timed out")
        ? { reason: "timeout", detail }
        : { reason: "network", detail }
    case "invalid_input":
    case "already_exists":
    case "permission_denied":
    case "configuration_invalid":
    case "configuration_missing":
    case "not_found":
      return { reason: "rejected", detail }
    case undefined:
      break
    default:
      return { reason: "server", detail }
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { reason: "timeout", detail }
  }
  if (lower === "unauthorized") return { reason: "unauthorized", detail }
  if (
    error instanceof TypeError ||
    FETCH_FAILURE_MESSAGES.some((m) => lower.includes(m))
  ) {
    return { reason: "network", detail }
  }
  return { reason: "server", detail }
}

/** Whether a failure for `reason` is resent without the user. */
function autoRetries(reason: SendFailureReason, attempts: number): boolean {
  switch (reason) {
    case "network":
    case "timeout":
    case "connection":
    case "unauthorized":
    case "interrupted":
      return true
    case "server":
      return attempts < MAX_AUTO_ATTEMPTS_UNEXPECTED
    case "rejected":
      return false
  }
}

/**
 * The failure to record after a send of a message that had already failed
 * `previous` (or never, when undefined) failed again with `error`.
 */
export function nextSendFailure(
  error: unknown,
  previous: SendFailure | undefined,
  now: number = Date.now()
): SendFailure {
  const { reason, detail } = classifySendError(error)
  const attempts = (previous?.attempts ?? 0) + 1
  return {
    reason,
    detail,
    autoRetry: autoRetries(reason, attempts),
    attempts,
    nextAttemptAt: now + sendRetryDelayMs(attempts),
  }
}

/** The failure a message restored from storage starts with: it was on its
 *  way when the page went away, so whether it arrived is unknown. The resend
 *  carries the same id, so the server sorts that out. */
export function interruptedSendFailure(): SendFailure {
  return {
    reason: "interrupted",
    autoRetry: true,
    attempts: 0,
    nextAttemptAt: 0,
  }
}

/** What Retry does: send it again now, and let it resend by itself after
 *  that as if it had just failed for the first time. */
export function retryNow(failure: SendFailure): SendFailure {
  return {
    ...failure,
    autoRetry: true,
    attempts: Math.min(failure.attempts, 1),
    nextAttemptAt: 0,
  }
}

/** i18n keys (under `Folder.chat.messageQueue`) of the reasons a "Not sent"
 *  row shows. */
export type SendFailureLabelKey =
  | "notSentConnectionLost"
  | "notSentTimeout"
  | "notSentServer"
  | "notSentUnauthorized"
  | "notSentInterrupted"
  | "notSentRejected"
  | "notSentGaveUp"

/** The reason a "Not sent" row shows for `failure`. */
export function sendFailureLabelKey(failure: SendFailure): SendFailureLabelKey {
  if (!failure.autoRetry) {
    return failure.reason === "rejected" ? "notSentRejected" : "notSentGaveUp"
  }
  switch (failure.reason) {
    case "network":
    case "connection":
      return "notSentConnectionLost"
    case "timeout":
      return "notSentTimeout"
    case "server":
      return "notSentServer"
    case "unauthorized":
      return "notSentUnauthorized"
    case "interrupted":
      return "notSentInterrupted"
    case "rejected":
      return "notSentRejected"
  }
}
