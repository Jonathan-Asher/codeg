import { NOT_A_GIT_REPO_PATTERNS } from "@/i18n/git-error-patterns"
import type { AppCommandError } from "@/lib/types"

type ObjectLike = Record<string, unknown>

function asObject(value: unknown): ObjectLike | null {
  return value !== null && typeof value === "object"
    ? (value as ObjectLike)
    : null
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseI18nParams(value: unknown): Record<string, string> | null {
  const obj = asObject(value)
  if (!obj) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw === "string") {
      out[key] = raw
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function parseErrorObject(value: unknown): AppCommandError | null {
  const obj = asObject(value)
  if (!obj) return null

  const code = normalizeString(obj.code)
  const message = normalizeString(obj.message)
  const detailRaw = normalizeString(obj.detail)
  const detail = detailRaw ?? null
  const i18nKey = normalizeString(obj.i18n_key)
  const i18nParams = parseI18nParams(obj.i18n_params)

  if (!code || !message) return null

  return {
    code,
    message,
    detail,
    i18n_key: i18nKey,
    i18n_params: i18nParams,
  }
}

export function extractAppCommandError(error: unknown): AppCommandError | null {
  const direct = parseErrorObject(error)
  if (direct) return direct

  const errorObject = asObject(error)
  const message = normalizeString(errorObject?.message)
  if (!message) return null

  try {
    const parsed = JSON.parse(message)
    return parseErrorObject(parsed)
  } catch {
    return null
  }
}

// Must mirror `AppErrorCode::NotAGitRepository` in src-tauri/src/app_error.rs.
// If the backend enum ever renames, both sides must change together.
export const NOT_A_GIT_REPO_CODE = "not_a_git_repository"

export function isNotAGitRepoError(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  if (appError?.code === NOT_A_GIT_REPO_CODE) return true

  const candidates = [appError?.detail, appError?.message]
  return candidates.some(
    (text) =>
      typeof text === "string" &&
      NOT_A_GIT_REPO_PATTERNS.some((pattern) => pattern.test(text))
  )
}

export function toErrorMessage(error: unknown): string {
  const appError = extractAppCommandError(error)
  if (appError) {
    return appError.detail?.trim() || appError.message
  }

  if (error instanceof Error) {
    return error.message.trim()
  }

  if (typeof error === "string") {
    return error.trim()
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized ? serialized.trim() : String(error)
  } catch {
    return String(error)
  }
}

const MAX_DESCRIBED_ERROR_CHARS = 500

function clip(text: string): string {
  return text.length > MAX_DESCRIBED_ERROR_CHARS
    ? `${text.slice(0, MAX_DESCRIBED_ERROR_CHARS)}…`
    : text
}

/** A short, human line out of a JSON-RPC style `data` payload, if it has one. */
function describeErrorData(data: unknown): string | null {
  if (typeof data === "string") return normalizeString(data)
  const obj = asObject(data)
  if (!obj) return null
  return (
    normalizeString(obj.message) ??
    normalizeString(obj.details) ??
    normalizeString(obj.detail) ??
    normalizeString(obj.reason)
  )
}

/**
 * One readable line for any thrown value, for places that show a connect or
 * transport failure to the user. Never returns "[object Object]":
 *
 * - codeg's own `{ code, message, detail }` (web and remote-workspace
 *   transports reject with it as a plain object) → the message, plus the
 *   detail when it adds something;
 * - a JSON-RPC / ACP error `{ code: -32603, message, data }` → the message,
 *   the data's own message, and the numeric code;
 * - an `Error` → its message (and its cause's, when there is one);
 * - any other object with a `message` or nested `error` → that;
 * - anything else → a bounded JSON rendering.
 */
export function describeError(error: unknown, depth = 0): string {
  if (error == null) return "Unknown error"
  if (typeof error === "string") return clip(error.trim() || "Unknown error")

  const appError = extractAppCommandError(error)
  if (appError) {
    const detail = appError.detail?.trim()
    if (detail && !appError.message.includes(detail)) {
      return clip(
        detail.includes(appError.message)
          ? detail
          : `${appError.message}: ${detail}`
      )
    }
    return clip(appError.message)
  }

  if (error instanceof Error) {
    const message = error.message.trim() || error.name
    const cause = (error as { cause?: unknown }).cause
    if (cause != null && depth < 2) {
      const causeText = describeError(cause, depth + 1)
      if (causeText && !message.includes(causeText)) {
        return clip(`${message} (${causeText})`)
      }
    }
    return clip(message)
  }

  const obj = asObject(error)
  if (obj) {
    const message = normalizeString(obj.message)
    const numericCode = typeof obj.code === "number" ? obj.code : null
    if (message) {
      const data = describeErrorData(obj.data)
      const withData =
        data && !message.includes(data) ? `${message}: ${data}` : message
      return clip(
        numericCode != null ? `${withData} (code ${numericCode})` : withData
      )
    }
    if (obj.error != null && depth < 2) {
      return describeError(obj.error, depth + 1)
    }
  }

  try {
    const serialized = JSON.stringify(error)
    if (serialized && serialized !== "{}") return clip(serialized)
  } catch {
    // fall through
  }
  return "Unknown error"
}

/** Translator callable shape compatible with next-intl's scoped translator. */
export type AppErrorTranslator = (
  key: string,
  params?: Record<string, string | number>
) => string

/**
 * Like `toErrorMessage`, but prefers the backend-provided i18n hint when
 * present. The translator should be scoped to the namespace whose keys the
 * backend emits (e.g. for MCP errors, a translator scoped to `McpSettings`).
 *
 * Falls back to the English `message` when the key is missing OR the
 * translator throws (e.g. unknown key in a different translator's namespace).
 */
export function toLocalizedErrorMessage(
  error: unknown,
  translate: AppErrorTranslator
): string {
  const appError = extractAppCommandError(error)
  if (appError?.i18n_key) {
    try {
      const params = appError.i18n_params ?? undefined
      const localized = translate(appError.i18n_key, params)
      const trimmed = localized.trim()
      if (trimmed && trimmed !== appError.i18n_key) {
        return trimmed
      }
    } catch {
      // fall through to non-localized path
    }
  }
  return toErrorMessage(error)
}
