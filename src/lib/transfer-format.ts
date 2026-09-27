/**
 * Formatting and rate estimation for the transfer progress UI (remote
 * workspace downloads). Pure functions, so the numbers the user reads are
 * unit-tested rather than eyeballed.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/** `1536` → `"1.5 KB"`; binary multiples, one decimal above bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} B`
  // `1023.96` would print as "1024.0 KB"; carry it into the next unit.
  if (value.toFixed(1) === "1024.0" && unit < UNITS.length - 1) {
    return `1.0 ${UNITS[unit + 1]}`
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}

/** `"8.4 MB/s"`; null for a rate not worth showing yet. */
export function formatRate(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return null
  if (bytesPerSecond <= 0) return null
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Whole-number percentage, floored so "100%" only ever means done, or null
 * when the total is unknown (a streamed ZIP has no Content-Length).
 */
export function transferPercent(
  loaded: number,
  total: number | null | undefined
): number | null {
  if (total == null || !Number.isFinite(total) || total <= 0) return null
  const ratio = Math.max(0, Math.min(1, loaded / total))
  return Math.floor(ratio * 100)
}

/** Seconds left at the current rate, or null when it can't be estimated. */
export function secondsRemaining(
  loaded: number,
  total: number | null | undefined,
  bytesPerSecond: number | null
): number | null {
  if (total == null || total <= 0 || loaded >= total) return null
  if (bytesPerSecond == null || bytesPerSecond <= 0) return null
  const seconds = (total - loaded) / bytesPerSecond
  return Number.isFinite(seconds) ? Math.ceil(seconds) : null
}

function formatUnit(
  value: number,
  unit: "second" | "minute" | "hour",
  locale: string
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(value)
  } catch {
    const suffix = unit === "second" ? "s" : unit === "minute" ? "min" : "h"
    return `${value} ${suffix}`
  }
}

/**
 * A localized, coarse duration for "time left": seconds under a minute,
 * minutes under an hour, then hours and minutes. Precision past that is
 * noise — the estimate itself moves by more than a minute.
 */
export function formatDuration(seconds: number, locale = "en"): string {
  const total = Math.max(0, Math.ceil(seconds))
  if (total < 60) return formatUnit(total, "second", locale)
  const minutes = Math.ceil(total / 60)
  if (minutes < 60) return formatUnit(minutes, "minute", locale)
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (restMinutes === 0) return formatUnit(hours, "hour", locale)
  return `${formatUnit(hours, "hour", locale)} ${formatUnit(restMinutes, "minute", locale)}`
}

interface RateSample {
  at: number
  loaded: number
}

/**
 * Transfer rate over a sliding window. A window (rather than bytes / elapsed
 * since start) makes the speed and the time-left follow the network as it is
 * now — a download that stalled for a minute and resumed shouldn't report
 * the average of the stall.
 */
export class RateMeter {
  private samples: RateSample[] = []
  private readonly windowMs: number

  constructor(windowMs = 4000) {
    this.windowMs = windowMs
  }

  push(at: number, loaded: number): void {
    const last = this.samples[this.samples.length - 1]
    // A progress counter only grows; a lower value means a new transfer
    // reused the meter, so start over.
    if (last && loaded < last.loaded) this.samples = []
    this.samples.push({ at, loaded })
    const cutoff = at - this.windowMs
    while (this.samples.length > 2 && this.samples[1].at <= cutoff) {
      this.samples.shift()
    }
  }

  /** Bytes per second across the window, or null until it spans ~0.5 s. */
  rate(): number | null {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedMs = last.at - first.at
    if (elapsedMs < 500) return null
    return ((last.loaded - first.loaded) * 1000) / elapsedMs
  }
}
