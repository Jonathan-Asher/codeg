import type {
  PlanUsageAgent,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
} from "@/lib/types"

/** A reading older than this is flagged stale: usage on other machines (or
 *  the provider's own apps) since then is not in it. */
export const PLAN_USAGE_STALE_AFTER_SECONDS = 60 * 60

/** The providers the screen shows, in card order. */
export const PLAN_USAGE_AGENTS = [
  "claude_code",
  "codex",
] as const satisfies readonly PlanUsageAgent[]

/** How far a window's own report time may trail the snapshot's before the
 *  window says so — a Claude update touches one window and leaves the rest. */
const WINDOW_LAG_NOTE_SECONDS = 60

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function findSnapshot(
  report: PlanUsageReport | null,
  agent: PlanUsageAgent
): PlanUsageSnapshot | null {
  return report?.snapshots.find((s) => s.agent === agent) ?? null
}

/** Fold a pushed snapshot into the report, replacing that agent's entry. */
export function replaceSnapshot(
  report: PlanUsageReport | null,
  snapshot: PlanUsageSnapshot
): PlanUsageReport {
  const base: PlanUsageReport = report ?? {
    snapshots: [],
    codex_sessions_dir: null,
    codex_rollouts_found: false,
  }
  return {
    ...base,
    snapshots: [
      ...base.snapshots.filter((s) => s.agent !== snapshot.agent),
      snapshot,
    ],
  }
}

/**
 * Take a fetched report without losing a live push that overtook it: a
 * Claude snapshot pushed while the request was in flight is newer than the
 * one the response carries (or the response has none yet), so it stays.
 * Everything else comes from the response as-is.
 */
export function mergeFetchedReport(
  current: PlanUsageReport | null,
  fetched: PlanUsageReport
): PlanUsageReport {
  const pushed = findSnapshot(current, "claude_code")
  if (!pushed || pushed.source !== "live") return fetched
  const answered = findSnapshot(fetched, "claude_code")
  if (answered && answered.observed_at >= pushed.observed_at) return fetched
  return replaceSnapshot(fetched, pushed)
}

export function isSnapshotStale(
  snapshot: PlanUsageSnapshot,
  now: number
): boolean {
  return now - snapshot.observed_at > PLAN_USAGE_STALE_AFTER_SECONDS
}

/** The window rolled over after its reading was taken, so the number no
 *  longer describes it. */
export function hasWindowReset(window: PlanUsageWindow, now: number): boolean {
  return window.resets_at != null && window.resets_at <= now
}

/** When this window was reported, if meaningfully earlier than the snapshot
 *  it sits in; `null` when it is as fresh as the rest. */
export function windowLagSince(
  window: PlanUsageWindow,
  snapshot: PlanUsageSnapshot
): number | null {
  const at = window.observed_at
  if (at == null) return null
  return snapshot.observed_at - at > WINDOW_LAG_NOTE_SECONDS ? at : null
}

/**
 * Whole-number used / left percentages that always add up to 100. A window
 * reads "100% used" only once it is actually full and "0% used" only while
 * nothing is used, so rounding never claims a limit was hit (or untouched)
 * when it wasn't.
 */
export function splitPercent(usedPercent: number): {
  used: number
  left: number
} {
  const raw = Number.isFinite(usedPercent)
    ? Math.min(100, Math.max(0, usedPercent))
    : 0
  let used = Math.round(raw)
  if (raw > 0 && used === 0) used = 1
  if (raw < 100 && used === 100) used = 99
  return { used, left: 100 - used }
}

export type PlanUsageLevel = "normal" | "high" | "critical"

export function usageLevel(usedPercent: number): PlanUsageLevel {
  if (usedPercent >= 90) return "critical"
  if (usedPercent >= 75) return "high"
  return "normal"
}

/**
 * The window closest to its limit — the one that stops the agent first.
 * Windows that rolled over since their reading are skipped: their number no
 * longer describes them. `null` when no window is left.
 */
export function tightestWindow(
  snapshot: PlanUsageSnapshot,
  now: number
): PlanUsageWindow | null {
  let tightest: PlanUsageWindow | null = null
  for (const window of snapshot.windows) {
    if (hasWindowReset(window, now)) continue
    if (tightest == null || window.used_percent > tightest.used_percent) {
      tightest = window
    }
  }
  return tightest
}

/** One provider's entry in the status-bar preview. */
export interface PlanUsagePreviewEntry {
  agent: PlanUsageAgent
  /** Its tightest window. */
  window: PlanUsageWindow
  /** Whole-number percent used, as `splitPercent` shows it. */
  percent: number
  level: PlanUsageLevel
  stale: boolean
}

const LEVEL_RANK: Record<PlanUsageLevel, number> = {
  normal: 0,
  high: 1,
  critical: 2,
}

/**
 * One entry per provider with a current reading, in card order: its tightest
 * window, tinted by how close it is. A fresh reading that says the limit was
 * reached is critical whatever its percentage; a stale one keeps only its
 * numbers, the same way the page drops its status badge. Providers with no
 * reading, or whose every window has rolled over since, are left out.
 */
export function planUsagePreview(
  report: PlanUsageReport | null,
  now: number
): PlanUsagePreviewEntry[] {
  const entries: PlanUsagePreviewEntry[] = []
  for (const agent of PLAN_USAGE_AGENTS) {
    const snapshot = findSnapshot(report, agent)
    if (!snapshot) continue
    const window = tightestWindow(snapshot, now)
    if (!window) continue
    const stale = isSnapshotStale(snapshot, now)
    const limited = !stale && snapshot.status === "limited"
    entries.push({
      agent,
      window,
      percent: splitPercent(window.used_percent).used,
      level: limited ? "critical" : usageLevel(window.used_percent),
      stale,
    })
  }
  return entries
}

/** The single tightest entry, for the compact bar: highest percentage first,
 *  then the more severe level; ties keep card order. */
export function tightestPreviewEntry(
  entries: readonly PlanUsagePreviewEntry[]
): PlanUsagePreviewEntry | null {
  let tightest: PlanUsagePreviewEntry | null = null
  for (const entry of entries) {
    if (
      tightest == null ||
      entry.window.used_percent > tightest.window.used_percent ||
      (entry.window.used_percent === tightest.window.used_percent &&
        LEVEL_RANK[entry.level] > LEVEL_RANK[tightest.level])
    ) {
      tightest = entry
    }
  }
  return tightest
}

/** A window's display name as a message key (under `PlanUsage.window`) plus
 *  its values. Keys are literal so next-intl can type-check them. */
export type PlanUsageWindowName =
  | { key: "session5h" }
  | { key: "sessionSpan"; values: { span: string } }
  | { key: "weekly" }
  | { key: "weeklyModel"; values: { model: string } }
  | { key: "weeklyWithExtra" }
  | { key: "extraUsage" }
  | { key: "other"; values: { label: string } }

export function windowName(window: PlanUsageWindow): PlanUsageWindowName {
  switch (window.kind) {
    case "session":
      return window.window_minutes === 300
        ? { key: "session5h" }
        : { key: "sessionSpan", values: { span: window.label } }
    case "weekly":
      return { key: "weekly" }
    case "weekly_model":
      return { key: "weeklyModel", values: { model: window.label } }
    default:
      if (window.id === "overage") return { key: "extraUsage" }
      if (window.id === "seven_day_overage_included") {
        return { key: "weeklyWithExtra" }
      }
      return { key: "other", values: { label: window.label } }
  }
}

function unitFormatter(
  locale: string,
  unit: "day" | "hour" | "minute"
): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  })
}

/**
 * A short span of time — `2d 4h`, `2h 14m`, `14m`, `<1m` — with the unit
 * names localized. Two units at most: reset times are read at a glance.
 */
export function formatCompactDuration(seconds: number, locale: string): string {
  const total = Math.max(0, Math.floor(seconds))
  const minute = unitFormatter(locale, "minute")
  if (total < 60) return `<${minute.format(1)}`
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const parts: string[] = []
  if (days > 0) {
    parts.push(unitFormatter(locale, "day").format(days))
    if (hours > 0) parts.push(unitFormatter(locale, "hour").format(hours))
  } else if (hours > 0) {
    parts.push(unitFormatter(locale, "hour").format(hours))
    if (minutes > 0) parts.push(minute.format(minutes))
  } else {
    parts.push(minute.format(minutes))
  }
  return parts.join(" ")
}

/** A wall-clock time with its day, e.g. `Fri, Sep 26, 6:00 PM`; the year only
 *  when it isn't this one. */
export function formatAbsoluteTime(
  epochSeconds: number,
  locale: string,
  now: number
): string {
  const date = new Date(epochSeconds * 1000)
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}
