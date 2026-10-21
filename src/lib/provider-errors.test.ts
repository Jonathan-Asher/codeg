import { describe, expect, it } from "vitest"

import { detectProviderError, subagentProviderError } from "./provider-errors"

// Synthesized in the shapes Claude Code writes; not copied from any session.
const POLICY_MESSAGE =
  "This request was blocked as it seems to violate the provider's terms of service on example misuse. To learn more, visit https://example.com/legal/terms."
const POLICY_LINK = "https://example.com/legal/terms"

describe("detectProviderError: a usage-policy block", () => {
  it("reads the client's `API Error: <status> <message>` line", () => {
    const error = detectProviderError(`API Error: 400 ${POLICY_MESSAGE}`)
    expect(error).toMatchObject({
      kind: "policy_block",
      status: 400,
      message: POLICY_MESSAGE,
      link: POLICY_LINK,
    })
    expect(error?.raw).toBe(`API Error: 400 ${POLICY_MESSAGE}`)
  })

  it("reads the message out of a JSON error body", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: POLICY_MESSAGE },
      request_id: "req_test",
    })
    expect(detectProviderError(`API Error: 400 ${body}`)).toMatchObject({
      kind: "policy_block",
      message: POLICY_MESSAGE,
      link: POLICY_LINK,
    })
  })

  it("reads a truncated JSON body field by field", () => {
    const body = `{"type":"error","error":{"type":"permission_error","message":"${POLICY_MESSAGE}`
    expect(detectProviderError(`API Error: 403 ${body}`)).toMatchObject({
      kind: "policy_block",
      status: 403,
      link: POLICY_LINK,
    })
  })

  it("takes the notice when it arrives bare, as the result text", () => {
    expect(detectProviderError(POLICY_MESSAGE)).toMatchObject({
      kind: "policy_block",
      status: null,
      link: POLICY_LINK,
    })
  })

  it("sees through a sub-agent result's trailers and an error lead-in", () => {
    const text = [
      `Error: API Error: 400 ${POLICY_MESSAGE}`,
      "agentId: a1b2c3 (for resuming to continue this agent's work if needed)",
      "<usage>total_tokens: 12\ntool_uses: 0\nduration_ms: 900</usage>",
    ].join("\n")
    const error = detectProviderError(text)
    expect(error?.kind).toBe("policy_block")
    expect(error?.raw).toBe(`Error: API Error: 400 ${POLICY_MESSAGE}`)
  })

  it("unwraps a tool_use_error", () => {
    expect(
      detectProviderError(
        `<tool_use_error>API Error: 400 ${POLICY_MESSAGE}</tool_use_error>`
      )?.kind
    ).toBe("policy_block")
  })

  it("recognizes the client's own usage-policy refusal", () => {
    expect(
      detectProviderError(
        "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://example.com/aup). Please double press esc to edit your last message."
      )
    ).toMatchObject({ kind: "policy_block", link: "https://example.com/aup" })
  })
})

describe("detectProviderError: other provider errors", () => {
  it("tells a rate limit by its status, type or wording", () => {
    expect(detectProviderError("API Error: 429 Too many requests")?.kind).toBe(
      "rate_limit"
    )
    expect(
      detectProviderError(
        'API Error: {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}'
      )?.kind
    ).toBe("rate_limit")
    expect(
      detectProviderError(
        "API Error: Request rejected (429) · this may be a temporary capacity issue."
      )?.kind
    ).toBe("rate_limit")
  })

  it("tells an overloaded provider", () => {
    expect(
      detectProviderError(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
      )
    ).toMatchObject({ kind: "overloaded", status: 529, message: "Overloaded" })
    expect(
      detectProviderError("API Error: Repeated 529 Overloaded errors")?.kind
    ).toBe("overloaded")
  })

  it("tells a rejected request from a policy block", () => {
    expect(
      detectProviderError(
        "API Error: 400 messages: text content blocks must be non-empty"
      )
    ).toMatchObject({ kind: "invalid_request", status: 400, link: null })
  })

  it("calls anything else an API error", () => {
    expect(
      detectProviderError("API Error: 500 Internal server error")?.kind
    ).toBe("api_error")
  })

  it("takes a bare provider JSON error body", () => {
    expect(
      detectProviderError(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
      )?.kind
    ).toBe("overloaded")
  })
})

describe("detectProviderError: what is not one", () => {
  it("leaves prose that talks about an error alone", () => {
    expect(
      detectProviderError(
        "I hit an API Error: 400 while calling the endpoint, so I retried."
      )
    ).toBeNull()
    expect(
      detectProviderError(
        `The log says: ${POLICY_MESSAGE} I could not reproduce it.`
      )
    ).toBeNull()
  })

  it("leaves a bare 'request was blocked' sentence about something else alone", () => {
    expect(
      detectProviderError("This request was blocked by the firewall rule.")
    ).toBeNull()
  })

  it("leaves a JSON result that merely has a message field alone", () => {
    expect(detectProviderError('{"message":"done","files":3}')).toBeNull()
  })

  it("leaves a long report that starts with the prefix alone", () => {
    expect(
      detectProviderError(
        `API Error: 400 ${"explained at length. ".repeat(100)}`
      )
    ).toBeNull()
  })

  it("is null for nothing", () => {
    expect(detectProviderError(null)).toBeNull()
    expect(detectProviderError(undefined)).toBeNull()
    expect(detectProviderError("")).toBeNull()
    expect(detectProviderError("   ")).toBeNull()
  })
})

describe("subagentProviderError", () => {
  const blocked = `API Error: 400 ${POLICY_MESSAGE}`

  it("reads a settled Agent or legacy Task call's result or error result", () => {
    for (const toolName of ["Agent", "agent", "Task", "task"]) {
      expect(
        subagentProviderError({
          toolName,
          state: "output-available",
          output: blocked,
        })?.kind
      ).toBe("policy_block")
    }
    expect(
      subagentProviderError({
        toolName: "Agent",
        state: "output-error",
        errorText: blocked,
      })?.kind
    ).toBe("policy_block")
  })

  it("ignores other tools, a call still running and an ordinary result", () => {
    expect(
      subagentProviderError({
        toolName: "Bash",
        state: "output-error",
        errorText: blocked,
      })
    ).toBeNull()
    expect(
      subagentProviderError({
        toolName: "Agent",
        state: "input-available",
        output: blocked,
      })
    ).toBeNull()
    expect(
      subagentProviderError({
        toolName: "Agent",
        state: "output-available",
        output: "Mapped 12 files.",
      })
    ).toBeNull()
  })
})
