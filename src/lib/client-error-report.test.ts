import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: vi.fn() }),
}))

import {
  ClientErrorReporter,
  describeThrown,
  installGlobalErrorReporting,
  trimStack,
  type ClientErrorReport,
} from "./client-error-report"

describe("describeThrown", () => {
  it("keeps an Error's name, message and trimmed stack", () => {
    const err = new TypeError("Cannot read properties of undefined")
    err.stack =
      "TypeError: Cannot read properties of undefined\n" +
      "    at AutoResumeToasts (http://box:3080/_next/static/chunks/app.js?v=1:2:345)\n" +
      "    at renderWithHooks (http://box:3080/_next/static/chunks/react.js#x:9:10)"
    expect(describeThrown(err)).toEqual({
      message: "TypeError: Cannot read properties of undefined",
      stack:
        "TypeError: Cannot read properties of undefined\n" +
        "at AutoResumeToasts (http://box:3080/_next/static/chunks/app.js:2:345)\n" +
        "at renderWithHooks (http://box:3080/_next/static/chunks/react.js:9:10)",
    })
  })

  it("takes a transport error's code and message, never its detail", () => {
    const rejection = {
      code: "network_error",
      message: "Remote HTTP request failed",
      detail: "secret response body",
    }
    const described = describeThrown(rejection)
    expect(described.message).toBe("network_error: Remote HTTP request failed")
    expect(JSON.stringify(described)).not.toContain("secret")
  })

  it("never echoes an arbitrary object or a long string whole", () => {
    expect(describeThrown({ prompt: "my private prompt" }).message).toBe(
      "non-Error object thrown"
    )
    expect(describeThrown(42).message).toBe("non-Error value thrown (number)")
    const long = describeThrown("x".repeat(1_000) + "\nmore")
    expect(long.message.length).toBeLessThanOrEqual(301)
    expect(long.message).not.toContain("\n")
  })
})

describe("trimStack", () => {
  it("caps the number of frames", () => {
    const stack = Array.from({ length: 40 }, (_, i) => `at f${i} (a.js:1:${i})`)
    const trimmed = trimStack(stack.join("\n"))!.split("\n")
    expect(trimmed).toHaveLength(16)
    expect(trimmed[15]).toBe("… 25 more frame(s)")
  })

  it("returns nothing for an empty stack", () => {
    expect(trimStack("")).toBeUndefined()
    expect(trimStack(undefined)).toBeUndefined()
  })
})

describe("ClientErrorReporter", () => {
  let sent: ClientErrorReport[]
  let clock: number

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    clock = 1_000_000
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function reporter(send = async (r: ClientErrorReport) => void sent.push(r)) {
    return new ClientErrorReporter(send, () => clock)
  }

  it("sends a report with the route's path only", async () => {
    window.history.replaceState(null, "", "/workspace?folder=/secret#x")
    const r = reporter()
    r.report("boundary", new Error("boom"), {
      scope: "conversation",
      componentStack: "\n    at Conversation\n    at Workspace",
    })
    await vi.runAllTimersAsync()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: "boundary",
      scope: "conversation",
      message: "boom",
      route: "/workspace",
      componentStack: "at Conversation\nat Workspace",
    })
  })

  it("counts an identical error once a minute and caps the rest", async () => {
    const r = reporter()
    for (let i = 0; i < 50; i++) r.report("error", new Error("same"))
    for (let i = 0; i < 50; i++) r.report("error", new Error(`different ${i}`))
    await vi.runAllTimersAsync()
    // One "same", then distinct ones up to the per-minute cap.
    expect(sent).toHaveLength(10)
    expect(sent.filter((x) => x.message === "same")).toHaveLength(1)

    clock += 60_000
    r.report("error", new Error("same"))
    await vi.runAllTimersAsync()
    expect(sent).toHaveLength(11)
  })

  it("keeps undelivered reports and sends them once the backend answers", async () => {
    let up = false
    const r = reporter(async (report) => {
      if (!up) throw new Error("Failed to fetch")
      sent.push(report)
    })
    r.report("unhandledrejection", new Error("first"))
    r.report("unhandledrejection", new Error("second"))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(0)
    expect(r.pending).toBe(2)

    up = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sent.map((x) => x.message)).toEqual(["first", "second"])
    expect(r.pending).toBe(0)
  })

  it("never throws, whatever the sender does", async () => {
    const r = reporter(() => {
      throw new Error("sync failure")
    })
    expect(() => r.report("error", new Error("x"))).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
  })
})

describe("installGlobalErrorReporting", () => {
  it("forwards uncaught errors and unhandled rejections, skipping ResizeObserver noise", async () => {
    vi.useFakeTimers()
    const sent: ClientErrorReport[] = []
    const r = new ClientErrorReporter(async (x) => void sent.push(x))
    const target = new EventTarget() as unknown as Window
    const uninstall = installGlobalErrorReporting(target, r)

    target.dispatchEvent(
      new ErrorEvent("error", { error: new Error("render blew up") })
    )
    target.dispatchEvent(
      new ErrorEvent("error", {
        message:
          "ResizeObserver loop completed with undelivered notifications.",
      })
    )
    const rejection = new Event("unhandledrejection") as Event & {
      reason: unknown
    }
    rejection.reason = { code: "network_error", message: "Failed to fetch" }
    target.dispatchEvent(rejection)
    await vi.runAllTimersAsync()

    expect(sent.map((x) => [x.kind, x.message])).toEqual([
      ["error", "render blew up"],
      ["unhandledrejection", "network_error: Failed to fetch"],
    ])

    uninstall()
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("later") }))
    await vi.runAllTimersAsync()
    expect(sent).toHaveLength(2)
    vi.useRealTimers()
  })
})
