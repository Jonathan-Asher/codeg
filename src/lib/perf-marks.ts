/**
 * Client timing marks for measuring how the link and the views recover after
 * a drop. Off unless the browser profile opted in with
 * `localStorage.codeg_perf = "1"`; when off, a mark costs one cached flag
 * check.
 *
 * Each mark goes to the Performance timeline as `codeg:<name>` (visible in
 * the browser's profiler) and to a bounded in-page buffer,
 * `window.__codegPerf`, that a test harness reads back. Marks never carry
 * conversation content: names, ids, states and durations only.
 */

export interface PerfMarkEntry {
  name: string
  /** Wall clock, epoch ms: lines marks up with an outside timeline. */
  at: number
  /** `performance.now()`: precise intervals between marks. */
  t: number
  detail?: Record<string, unknown>
}

const MAX_ENTRIES = 5_000
const STORAGE_KEY = "codeg_perf"

let enabled: boolean | null = null

export function perfMarksEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled =
        typeof window !== "undefined" &&
        window.localStorage?.getItem(STORAGE_KEY) === "1"
    } catch {
      enabled = false
    }
  }
  return enabled
}

export function perfMark(name: string, detail?: Record<string, unknown>): void {
  if (!perfMarksEnabled()) return
  const entry: PerfMarkEntry = {
    name,
    at: Date.now(),
    t: performance.now(),
    ...(detail ? { detail } : {}),
  }
  const host = window as unknown as { __codegPerf?: PerfMarkEntry[] }
  const buffer = (host.__codegPerf ??= [])
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES)
  }
  try {
    performance.mark(`codeg:${name}`, detail ? { detail } : undefined)
  } catch {
    // An engine without mark details still has the buffer.
  }
}

/** Test-only: forget the cached opt-in so a test can flip it. */
export function __resetPerfMarksForTests(): void {
  enabled = null
}
