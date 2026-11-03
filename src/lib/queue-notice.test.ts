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

describe("queueNoticeFor — a brand-new chat", () => {
  it("says the first message goes once the session is connected", () => {
    expect(
      queueNoticeFor({ ...base, status: "connecting", newChat: true })
    ).toEqual({ kind: "sends_when_connected" })
  })

  it("keeps the louder notices ahead of it", () => {
    expect(
      queueNoticeFor({
        ...base,
        status: "connecting",
        newChat: true,
        held: { resumesAt: 5 },
      })
    ).toEqual({ kind: "pool", resumesAt: 5 })
    // A failed connect is "Not sent" with Retry, never a promise to send.
    expect(queueNoticeFor({ ...base, status: "error", newChat: true })).toEqual(
      { kind: "not_sent" }
    )
  })

  it("says nothing for an empty queue or an existing conversation", () => {
    expect(
      queueNoticeFor({
        ...base,
        queueLength: 0,
        status: "connecting",
        newChat: true,
      })
    ).toBeNull()
    expect(queueNoticeFor({ ...base, status: "connecting" })).toBeNull()
  })
})

describe("queueNoticeFor with another process running the session", () => {
  it("says the queue waits for that process while codeg does", () => {
    expect(
      queueNoticeFor({
        ...base,
        status: "connecting",
        outsideWriter: "waiting",
      })
    ).toEqual({ kind: "outside_writer", stopped: false })
  })

  it("says nothing goes out once the user stopped waiting", () => {
    expect(
      queueNoticeFor({ ...base, status: null, outsideWriter: "stopped" })
    ).toEqual({ kind: "outside_writer", stopped: true })
  })

  it("comes before every other reason, and needs a queue", () => {
    expect(
      queueNoticeFor({
        ...base,
        status: "error",
        held: { resumesAt: 5 },
        limitPause: { resets_at: "2026-11-03T12:00:00Z" },
        outsideWriter: "waiting",
      })
    ).toEqual({ kind: "outside_writer", stopped: false })
    expect(
      queueNoticeFor({ ...base, queueLength: 0, outsideWriter: "waiting" })
    ).toBeNull()
    expect(queueNoticeFor({ ...base, outsideWriter: null })).toBeNull()
  })
})
