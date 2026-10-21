/**
 * A model provider's refusal or error, recognized in the text an agent handed
 * back — so it can be shown as what it is (a compact "stopped: …" state with
 * the provider's own message behind "Details") instead of as a reply.
 *
 * Presentation only: nothing here changes, retries or hides what the provider
 * said. The raw text is kept verbatim for "Details".
 *
 * Where these come from. Claude Code turns a failed API request into a
 * synthetic assistant message, `API Error: <status> <the provider's message>`
 * (or the raw JSON error body when it cannot read a message out of it), capped
 * at about a thousand characters. A sub-agent that fails that way ends with
 * that message, and it becomes the Agent/Task tool's result — as the result
 * text, or as an error result. A policy block reads, for example, "API Error:
 * 400 This request was blocked as it seems to violate … To learn more, visit
 * https://…". The main agent's own failure reaches codeg as a typed session
 * failure (titled with the same text) or, on clients that don't take those,
 * as that line in the transcript.
 *
 * Recognition is deliberately narrow, because a false match would hide a real
 * reply: the text must BE the error — start with Claude Code's `API Error`
 * prefix (optionally after a short "Error:" lead-in), with a policy block's
 * own opening sentence, or be a provider's JSON error body — and be short.
 * Prose that merely mentions an error, or quotes one mid-paragraph, is left
 * alone.
 */

export type ProviderErrorKind =
  /** Blocked by the provider's usage policy or terms. */
  | "policy_block"
  | "rate_limit"
  | "overloaded"
  /** The provider refused the request as malformed or not allowed. */
  | "invalid_request"
  /** Any other provider/API failure. */
  | "api_error"

export interface ProviderError {
  kind: ProviderErrorKind
  /** The text as received, trimmed, minus the agent-id / usage lines Claude
   *  Code appends to a sub-agent's result. Shown verbatim under "Details". */
  raw: string
  /** The provider's own message: a JSON body's `error.message`, else the
   *  text after the client's `API Error: <status>` lead-in. */
  message: string
  /** The HTTP status the client reported, when it reported one. */
  status: number | null
  /** The first web link in the message — the provider's "learn more" page. */
  link: string | null
}

/** Claude Code caps its API error text at 1000 characters; leave headroom. */
const MAX_PREFIXED_LENGTH = 1500
/** A provider's JSON error body (or a bare policy notice) is short too. */
const MAX_BARE_LENGTH = 4000

/** Lead-ins a reporting layer puts before the client's own text. */
const LEAD_IN = /^(?:error|internal error|turn failed|prompt failed)\s*:\s*/i
const API_ERROR_PREFIX = /^API Error\b[\s:–—-]*/
const STATUS_PREFIX = /^(\d{3})\b[\s:–—-]*/
/** The opening of a policy block when it arrives without the prefix. */
const BARE_POLICY_OPENING =
  /^(?:this request was blocked\b|(?:claude(?: code)? is )?unable to respond to this request, which appears to violate\b)/i
/** What a usage-policy or terms block says, wherever in the message: that it
 *  was blocked or violates, and what — a policy or the terms. */
const POLICY_BLOCK =
  /\b(?:blocked|violat\w*)\b[\s\S]{0,200}?\b(?:usage polic(?:y|ies)|terms of service|acceptable use|commercial terms)\b/i
/** A provider's JSON error envelope: `{"type":"error",…}` or `{"error":{…}}`. */
const ERROR_ENVELOPE = /^\{\s*"(?:type"\s*:\s*"error"|error"\s*:\s*\{)/
const LINK = /https?:\/\/[^\s<>"'`)\]]+/
/** Agent-result trailers Claude Code appends after the sub-agent's text. */
const USAGE_TRAILER = /\s*<usage>[\s\S]*?<\/usage>\s*$/
const AGENT_ID_TRAILER = /(?:^|\n)\s*agentId:[^\n]*\s*$/
const TOOL_USE_ERROR = /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/

interface ErrorBody {
  type: string | null
  message: string | null
}

/** Strip the trailers Claude Code adds to an Agent/Task result. */
function stripTrailers(text: string): string {
  let out = text.trim()
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(USAGE_TRAILER, "")
      .replace(AGENT_ID_TRAILER, "")
      .trim()
    if (next === out) break
    out = next
  }
  return out
}

/** A provider JSON error body: `{"type":"error","error":{"type","message"}}`,
 *  `{"error":{…}}` or `{"message":…}`. Truncated bodies (the client caps the
 *  text) are read field by field instead. `null` when it is no such body. */
function readErrorBody(text: string): ErrorBody | null {
  if (!text.startsWith("{")) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>
      const inner =
        root.error && typeof root.error === "object"
          ? (root.error as Record<string, unknown>)
          : root
      const type = typeof inner.type === "string" ? inner.type : null
      const message = typeof inner.message === "string" ? inner.message : null
      if (type === null && message === null) return null
      return { type: type === "error" ? null : type, message }
    }
  } catch {
    // Truncated or not JSON at all — try the fields below.
  }
  const type = text.match(/"error"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)"/)?.[1]
  const quoted = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1]
  if (type === undefined && quoted === undefined) return null
  let message: string | null = null
  if (quoted !== undefined) {
    try {
      message = JSON.parse(`"${quoted}"`) as string
    } catch {
      message = quoted
    }
  }
  return { type: type ?? null, message }
}

function kindOf(
  message: string,
  type: string | null,
  status: number | null
): ProviderErrorKind {
  if (POLICY_BLOCK.test(message)) return "policy_block"
  switch (type) {
    case "rate_limit_error":
      return "rate_limit"
    case "overloaded_error":
      return "overloaded"
    case "invalid_request_error":
    case "request_too_large":
      return "invalid_request"
  }
  if (status === 429) return "rate_limit"
  if (status === 529) return "overloaded"
  if (/\brate[ -]?limit|\brequest rejected \(429\)/i.test(message)) {
    return "rate_limit"
  }
  if (/\boverloaded\b/i.test(message)) return "overloaded"
  if (status === 400 || status === 413 || status === 422) {
    return "invalid_request"
  }
  return "api_error"
}

function firstLink(text: string): string | null {
  const match = text.match(LINK)
  if (!match) return null
  return match[0].replace(/[.,;:!?]+$/, "")
}

/**
 * The provider error `text` is, or `null` when it is anything else — a reply,
 * a result, or prose that only talks about an error.
 */
export function detectProviderError(
  text: string | null | undefined
): ProviderError | null {
  if (typeof text !== "string" || text.length === 0) return null
  if (text.length > MAX_BARE_LENGTH * 2) return null
  const raw = stripTrailers(text)
  if (raw.length === 0 || raw.length > MAX_BARE_LENGTH) return null

  let body = raw
  const wrapped = body.match(TOOL_USE_ERROR)
  if (wrapped) body = wrapped[1].trim()
  body = body.replace(LEAD_IN, "")

  let status: number | null = null
  let rest: string
  const prefix = body.match(API_ERROR_PREFIX)
  if (prefix) {
    if (raw.length > MAX_PREFIXED_LENGTH) return null
    rest = body.slice(prefix[0].length)
    const code = rest.match(STATUS_PREFIX)
    if (code) {
      status = Number(code[1])
      rest = rest.slice(code[0].length)
    }
    rest = rest.trim()
  } else if (BARE_POLICY_OPENING.test(body)) {
    if (!POLICY_BLOCK.test(body)) return null
    rest = body
  } else if (ERROR_ENVELOPE.test(body)) {
    // Unprefixed, only a provider's error envelope counts: a JSON result that
    // merely has a `message` field is a result.
    rest = body
  } else {
    return null
  }

  const errorBody = readErrorBody(rest)
  const message = (errorBody?.message ?? rest).trim() || raw
  return {
    kind: kindOf(message, errorBody?.type ?? null, status),
    raw,
    message,
    status,
    link: firstLink(message) ?? firstLink(raw),
  }
}
