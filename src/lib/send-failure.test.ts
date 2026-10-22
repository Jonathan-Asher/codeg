import { describe, expect, it } from "vitest"

import {
  classifySendError,
  interruptedSendFailure,
  MAX_AUTO_ATTEMPTS_UNEXPECTED,
  nextSendFailure,
  retryNow,
  sendFailureLabelKey,
  sendRetryDelayMs,
} from "./send-failure"

describe("classifySendError", () => {
  it.each([
    // The web transport: fetch rejects with a TypeError when nothing answers.
    [
      "a fetch that got no answer (WebKit)",
      new TypeError("Load failed"),
      "network",
    ],
    [
      "a fetch that got no answer (Chromium)",
      new TypeError("Failed to fetch"),
      "network",
    ],
    [
      "the web transport's own timeout",
      new Error("Request timed out"),
      "timeout",
    ],
    [
      "a proxy's 502 (non-JSON body)",
      { code: "network_error", message: "HTTP 502" },
      "server",
    ],
    [
      "a 503 while the server restarts",
      { code: "network_error", message: "HTTP 503" },
      "server",
    ],
    [
      "a server error from the handler",
      { code: "task_execution_failed", message: "database is locked" },
      "server",
    ],
    [
      "the connection gone after a restart",
      { code: "task_execution_failed", message: "connection not found: c-1" },
      "connection",
    ],
    [
      "the desktop app's own agent exiting",
      "agent process exited unexpectedly",
      "connection",
    ],
    [
      "the remote workspace proxy unable to reach the server",
      {
        code: "network_error",
        message: "Remote HTTP request failed",
        detail: "error sending request: connection refused",
      },
      "network",
    ],
    [
      "the remote workspace proxy's 401",
      { code: "authentication_failed", message: "token is invalid" },
      "unauthorized",
    ],
    ["the web transport's 401", new Error("Unauthorized"), "unauthorized"],
    [
      "a body over the server's limit",
      { code: "network_error", message: "HTTP 413" },
      "rejected",
    ],
    [
      "a message the server refuses",
      { code: "invalid_input", message: "note exceeds 4000 characters" },
      "rejected",
    ],
  ])("%s → %s", (_name, error, reason) => {
    expect(classifySendError(error).reason).toBe(reason)
  })
})

describe("nextSendFailure", () => {
  it("resends reachability failures by themselves, backing off", () => {
    const first = nextSendFailure(new TypeError("Load failed"), undefined, 1000)
    expect(first).toMatchObject({
      reason: "network",
      autoRetry: true,
      attempts: 1,
    })
    expect(first.nextAttemptAt).toBe(1000 + sendRetryDelayMs(1))
    const later = nextSendFailure(new TypeError("Load failed"), first, 5000)
    expect(later.attempts).toBe(2)
    expect(later.nextAttemptAt).toBe(5000 + sendRetryDelayMs(2))
    expect(later.autoRetry).toBe(true)
  })

  it("keeps resending a lost connection however long it takes", () => {
    let failure = nextSendFailure(new TypeError("Load failed"), undefined)
    for (let i = 0; i < 20; i++) {
      failure = nextSendFailure(new TypeError("Load failed"), failure)
    }
    expect(failure.autoRetry).toBe(true)
    expect(sendRetryDelayMs(failure.attempts)).toBe(30_000)
  })

  it("gives an unexpected server error a few tries, then waits for Retry", () => {
    const error = { code: "task_execution_failed", message: "boom" }
    let failure = nextSendFailure(error, undefined)
    for (let i = 1; i < MAX_AUTO_ATTEMPTS_UNEXPECTED; i++) {
      expect(failure.autoRetry).toBe(true)
      failure = nextSendFailure(error, failure)
    }
    expect(failure.attempts).toBe(MAX_AUTO_ATTEMPTS_UNEXPECTED)
    expect(failure.autoRetry).toBe(false)
    expect(sendFailureLabelKey(failure)).toBe("notSentGaveUp")
  })

  it("never resends a refused message by itself", () => {
    const failure = nextSendFailure(
      { code: "network_error", message: "HTTP 413" },
      undefined
    )
    expect(failure.autoRetry).toBe(false)
    expect(sendFailureLabelKey(failure)).toBe("notSentRejected")
  })
})

describe("retry and restore", () => {
  it("Retry sends at once and resends by itself afterwards", () => {
    const refused = nextSendFailure(
      { code: "invalid_input", message: "no" },
      undefined
    )
    const retried = retryNow(refused)
    expect(retried.autoRetry).toBe(true)
    expect(retried.nextAttemptAt).toBe(0)
  })

  it("a message restored from storage is resent at once", () => {
    const failure = interruptedSendFailure()
    expect(failure).toMatchObject({ reason: "interrupted", autoRetry: true })
    expect(failure.nextAttemptAt).toBe(0)
    expect(sendFailureLabelKey(failure)).toBe("notSentInterrupted")
  })

  it("names the reason a row shows", () => {
    const lost = nextSendFailure(new TypeError("Load failed"), undefined)
    expect(sendFailureLabelKey(lost)).toBe("notSentConnectionLost")
    const timeout = nextSendFailure(new Error("Request timed out"), undefined)
    expect(sendFailureLabelKey(timeout)).toBe("notSentTimeout")
  })
})
