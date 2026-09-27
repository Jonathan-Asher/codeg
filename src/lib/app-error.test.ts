import { describe, expect, it } from "vitest"
import { describeError } from "@/lib/app-error"

describe("describeError", () => {
  it("never renders a plain object as [object Object]", () => {
    const text = describeError({ foo: 1 })
    expect(text).not.toContain("[object Object]")
    expect(text).toBe('{"foo":1}')
  })

  it("reads codeg's own transport error, detail included", () => {
    // What a remote-workspace call rejects with when the HTTP request fails.
    expect(
      describeError({
        code: "network",
        message: "Remote HTTP request failed",
        detail: "operation timed out",
      })
    ).toBe("Remote HTTP request failed: operation timed out")
    // A task_execution_failed carries the whole backend reason as its message.
    expect(
      describeError({
        code: "task_execution_failed",
        message: "agent process exited unexpectedly",
      })
    ).toBe("agent process exited unexpectedly")
  })

  it("reads a JSON-RPC / ACP error, with its numeric code", () => {
    expect(
      describeError({
        code: -32603,
        message: "Internal error",
        data: { details: "Query closed before response received" },
      })
    ).toBe(
      "Internal error: Query closed before response received (code -32603)"
    )
    expect(describeError({ code: -32002, message: "Resource not found" })).toBe(
      "Resource not found (code -32002)"
    )
  })

  it("unwraps a nested error field", () => {
    expect(
      describeError({ error: { code: -32000, message: "Auth required" } })
    ).toBe("Auth required (code -32000)")
  })

  it("keeps Error messages and adds their cause", () => {
    expect(describeError(new Error("Request timed out"))).toBe(
      "Request timed out"
    )
    expect(
      describeError(
        Object.assign(new Error("connect failed"), {
          cause: new Error("ECONNREFUSED"),
        })
      )
    ).toBe("connect failed (ECONNREFUSED)")
  })

  it("passes strings through and names the empty cases", () => {
    expect(describeError("  spawn failed  ")).toBe("spawn failed")
    expect(describeError(null)).toBe("Unknown error")
    expect(describeError(undefined)).toBe("Unknown error")
    expect(describeError({})).toBe("Unknown error")
  })

  it("bounds a runaway message", () => {
    const text = describeError("x".repeat(2_000))
    expect(text.length).toBeLessThan(600)
    expect(text.endsWith("…")).toBe(true)
  })
})
