import { describe, expect, it } from "vitest"

import {
  formatOutsideWriterStart,
  outsideWriterFromError,
} from "./outside-writer"

const BACKEND =
  "This session is running in another process (pid 4242); codeg connects once it finishes. [running_elsewhere pid=4242 started_at=1793616490351]"

describe("outsideWriterFromError", () => {
  it("reads the process from the Tauri string", () => {
    expect(outsideWriterFromError(BACKEND)).toEqual({
      pid: 4242,
      startedAt: 1_793_616_490_351,
    })
  })

  it("reads it from the web error body and from an Error", () => {
    expect(
      outsideWriterFromError({
        code: "session_running_elsewhere",
        message: BACKEND,
      })
    ).toEqual({ pid: 4242, startedAt: 1_793_616_490_351 })
    expect(outsideWriterFromError(new Error(BACKEND))?.pid).toBe(4242)
  })

  it("knows a process that did not say when it started", () => {
    expect(
      outsideWriterFromError("… finishes. [running_elsewhere pid=77]")
    ).toEqual({ pid: 77, startedAt: null })
  })

  it("is not fooled by other errors", () => {
    expect(outsideWriterFromError("turn already in progress")).toBeNull()
    expect(
      outsideWriterFromError("… [pool_exhausted resumes_at=1800000000]")
    ).toBeNull()
    expect(outsideWriterFromError({ code: "turn_in_progress" })).toBeNull()
    expect(outsideWriterFromError(new Error("boom"))).toBeNull()
    expect(outsideWriterFromError(null)).toBeNull()
    expect(outsideWriterFromError(undefined)).toBeNull()
  })
})

describe("formatOutsideWriterStart", () => {
  const now = new Date(2026, 10, 3, 15, 30).getTime()

  it("gives the time alone for a process started today", () => {
    const at = new Date(2026, 10, 3, 9, 5).getTime()
    expect(formatOutsideWriterStart(at, "en-GB", now)).toBe("09:05")
  })

  it("adds the day for one started on another", () => {
    const at = new Date(2026, 10, 2, 22, 40).getTime()
    const text = formatOutsideWriterStart(at, "en-US", now)
    expect(text).toContain("Nov")
    expect(text).toContain("2")
    expect(text).toMatch(/10:40|22:40/)
  })

  it("has nothing to say without a start", () => {
    expect(formatOutsideWriterStart(null, "en-US", now)).toBeNull()
    expect(formatOutsideWriterStart(undefined, "en-US", now)).toBeNull()
    expect(formatOutsideWriterStart(Number.NaN, "en-US", now)).toBeNull()
  })
})
