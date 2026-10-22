import { describe, expect, it } from "vitest"

import { queueNoticeFor } from "./queue-notice"

const base = {
  queueLength: 2,
  held: null,
  connPoolWait: null,
  status: "connected" as const,
}

describe("queueNoticeFor", () => {
  it("says nothing for an empty queue, whatever the state", () => {
    expect(
      queueNoticeFor({
        ...base,
        queueLength: 0,
        held: { resumesAt: 1 },
        status: "error",
      })
    ).toBeNull()
  })

  it("says nothing while the queue just waits its turn", () => {
    expect(queueNoticeFor({ ...base, status: "prompting" })).toBeNull()
    expect(queueNoticeFor({ ...base, status: "connecting" })).toBeNull()
    expect(queueNoticeFor(base)).toBeNull()
  })

  it("names the pool when a send was held back for it", () => {
    expect(queueNoticeFor({ ...base, held: { resumesAt: 1234 } })).toEqual({
      kind: "pool",
      resumesAt: 1234,
    })
  })

  it("names the pool while the session itself waits for it", () => {
    expect(
      queueNoticeFor({
        ...base,
        status: "connecting",
        connPoolWait: { resumesAt: null },
      })
    ).toEqual({ kind: "pool", resumesAt: null })
  })

  it("prefers the pool over a failed connection that retries by itself", () => {
    expect(
      queueNoticeFor({
        ...base,
        status: "error",
        connPoolWait: { resumesAt: 99 },
      })
    ).toEqual({ kind: "pool", resumesAt: 99 })
  })

  it("names the usage-limit pause the queue waits behind", () => {
    const limitPause = { resets_at: "2026-10-22T17:40:00.000Z" }
    expect(queueNoticeFor({ ...base, limitPause })).toEqual({
      kind: "limit",
      resetsAt: "2026-10-22T17:40:00.000Z",
    })
    // It says when the session goes on, ahead of the pool's own wait.
    expect(
      queueNoticeFor({ ...base, limitPause, held: { resumesAt: 99 } })
    ).toEqual({ kind: "limit", resetsAt: "2026-10-22T17:40:00.000Z" })
    // Nothing queued, nothing to say.
    expect(queueNoticeFor({ ...base, queueLength: 0, limitPause })).toBeNull()
  })

  it("marks the queue not sent when the connection failed or is gone", () => {
    for (const status of ["error", "disconnected", null] as const) {
      expect(queueNoticeFor({ ...base, status })).toEqual({
        kind: "not_sent",
      })
    }
  })
})
