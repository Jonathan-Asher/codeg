// Uncaught frontend errors, sent to the backend's log.
//
// When a window's React tree throws, the user gets Next's "Application error:
// a client-side exception has occurred" and the stack goes to the webview's
// console — which nobody has open on a desktop app, so the crash could not be
// diagnosed afterwards. This forwards `error` / `unhandledrejection` events
// and error-boundary catches to `log_client_error`, which writes one WARN
// line per report (`src-tauri/src/logging/client_report.rs`).
//
// What is sent is the shape of the failure only — message, stack frames,
// component stack, the route's path — trimmed here and again on the backend.
// A rejection with a non-Error reason (the transports reject with plain
// `{code, message, detail}` objects) sends its code and message, never its
// detail, which can carry a server's response body. Reports are rate-limited
// and de-duplicated, and reporting never throws or rejects: it runs exactly
// when things are already going wrong.
//
// Where they go: the window's own backend (`getShellTransport`). For a
// remote-workspace window that is the desktop it runs on, which still
// answers while the remote server is down. In a browser it is the server the
// page came from; reports that cannot be delivered (the server is the thing
// that is down) wait in a small queue and go out once it answers again.

import { getShellTransport } from "@/lib/transport"

export type ClientErrorKind = "error" | "unhandledrejection" | "boundary"

export interface ClientErrorReport {
  kind: ClientErrorKind
  scope?: string
  message: string
  stack?: string
  componentStack?: string
  route?: string
}

const MAX_MESSAGE_CHARS = 300
const MAX_STACK_LINES = 15
const MAX_LINE_CHARS = 200
/** Reports per window per minute; identical ones within a minute count once. */
const MAX_REPORTS_PER_WINDOW = 10
const REPORT_WINDOW_MS = 60_000
/** Undelivered reports kept for a retry, and how often to retry. */
const MAX_QUEUED = 20
const RETRY_MS = 15_000
const MAX_RETRIES = 40

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
}

/** Stack frames, trimmed, with query strings and fragments dropped. */
export function trimStack(
  stack: string | undefined | null,
  maxLines = MAX_STACK_LINES
): string | undefined {
  if (!stack) return undefined
  const lines = stack
    .split("\n")
    .map((line) => oneLine(line).replace(/[?#][^\s:)]*/g, ""))
    .filter((line) => line.length > 0)
    .map((line) => cut(line, MAX_LINE_CHARS))
  if (lines.length === 0) return undefined
  const kept = lines.slice(0, maxLines)
  if (lines.length > maxLines) {
    kept.push(`… ${lines.length - maxLines} more frame(s)`)
  }
  return kept.join("\n")
}

/** Message and stack of whatever was thrown, without its payload. */
export function describeThrown(value: unknown): {
  message: string
  stack?: string
} {
  if (value instanceof Error) {
    const name = value.name && value.name !== "Error" ? `${value.name}: ` : ""
    return {
      message: cut(oneLine(`${name}${value.message}`), MAX_MESSAGE_CHARS),
      stack: trimStack(value.stack),
    }
  }
  if (typeof value === "string") {
    return { message: cut(oneLine(value), MAX_MESSAGE_CHARS) }
  }
  if (value && typeof value === "object") {
    const { code, message } = value as { code?: unknown; message?: unknown }
    const parts = [
      typeof code === "string" ? code : null,
      typeof message === "string" ? message : null,
    ].filter(Boolean)
    if (parts.length > 0) {
      return { message: cut(oneLine(parts.join(": ")), MAX_MESSAGE_CHARS) }
    }
    return { message: "non-Error object thrown" }
  }
  return { message: `non-Error value thrown (${typeof value})` }
}

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined
  return window.location.pathname
}

type Send = (report: ClientErrorReport) => Promise<void>

const defaultSend: Send = async (report) => {
  await getShellTransport().call("log_client_error", { report })
}

/**
 * Rate limit, de-duplication and the retry queue. A class so tests get a
 * fresh one with their own clock and sender; the app uses the module's.
 */
export class ClientErrorReporter {
  private windowStart = 0
  private sentInWindow = 0
  private recent = new Map<string, number>()
  private queue: ClientErrorReport[] = []
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private flushing = false

  constructor(
    private readonly send: Send = defaultSend,
    private readonly now: () => number = Date.now
  ) {}

  /** Report one error. Never throws. Returns whether it was accepted. */
  report(
    kind: ClientErrorKind,
    error: unknown,
    extra: { scope?: string; componentStack?: string | null } = {}
  ): boolean {
    try {
      const { message, stack } = describeThrown(error)
      const report: ClientErrorReport = {
        kind,
        message,
        ...(stack ? { stack } : {}),
        ...(extra.scope ? { scope: extra.scope } : {}),
        ...(extra.componentStack
          ? { componentStack: trimStack(extra.componentStack, 10) }
          : {}),
        ...(currentRoute() ? { route: currentRoute() } : {}),
      }
      if (!this.admit(`${kind}|${extra.scope ?? ""}|${message}`)) return false
      this.enqueue(report)
      void this.flush()
      return true
    } catch {
      return false
    }
  }

  private admit(key: string): boolean {
    const now = this.now()
    for (const [k, at] of this.recent) {
      if (now - at >= REPORT_WINDOW_MS) this.recent.delete(k)
    }
    if (this.recent.has(key)) return false
    if (now - this.windowStart >= REPORT_WINDOW_MS) {
      this.windowStart = now
      this.sentInWindow = 0
    }
    if (this.sentInWindow >= MAX_REPORTS_PER_WINDOW) return false
    this.sentInWindow++
    this.recent.set(key, now)
    return true
  }

  private enqueue(report: ClientErrorReport) {
    this.queue.push(report)
    if (this.queue.length > MAX_QUEUED) this.queue.shift()
  }

  /** Send what is queued; on failure, keep it and try again later. */
  async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0]
        try {
          await this.send(next)
        } catch {
          this.scheduleRetry()
          return
        }
        this.queue.shift()
        this.retries = 0
      }
    } finally {
      this.flushing = false
    }
  }

  private scheduleRetry() {
    if (this.retryTimer !== null || this.retries >= MAX_RETRIES) return
    this.retries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, RETRY_MS)
  }

  /** Reports waiting to be delivered (tests). */
  get pending(): number {
    return this.queue.length
  }

  dispose() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.queue = []
  }
}

let reporter: ClientErrorReporter | null = null

function sharedReporter(): ClientErrorReporter {
  reporter ??= new ClientErrorReporter()
  return reporter
}

/** Report an error caught by an error boundary. */
export function reportBoundaryError(
  scope: string,
  error: unknown,
  componentStack?: string | null
): void {
  sharedReporter().report("boundary", error, { scope, componentStack })
}

/** Benign noise the root layout's inline script already swallows. */
function isIgnorable(message: string): boolean {
  return message.includes("ResizeObserver")
}

/**
 * Forward the window's uncaught errors and unhandled rejections. Returns the
 * uninstaller. Leaves the browser's own handling (the console) as it was.
 */
export function installGlobalErrorReporting(
  target: Window = window,
  instance: ClientErrorReporter = sharedReporter()
): () => void {
  const onError = (event: ErrorEvent) => {
    const thrown = event.error ?? event.message
    const { message } = describeThrown(thrown)
    if (isIgnorable(message)) return
    instance.report("error", thrown)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    const { message } = describeThrown(event.reason)
    if (isIgnorable(message)) return
    instance.report("unhandledrejection", event.reason)
  }
  target.addEventListener("error", onError)
  target.addEventListener("unhandledrejection", onRejection)
  return () => {
    target.removeEventListener("error", onError)
    target.removeEventListener("unhandledrejection", onRejection)
  }
}

/** Test-only: drop the shared reporter. @internal */
export function __resetClientErrorReporterForTests(): void {
  if (process.env.NODE_ENV !== "test") return
  reporter?.dispose()
  reporter = null
}
