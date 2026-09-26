import { describe, expect, it } from "vitest"
import {
  findSnapshot,
  formatAbsoluteTime,
  formatCompactDuration,
  hasWindowReset,
  isSnapshotStale,
  mergeFetchedReport,
  PLAN_USAGE_STALE_AFTER_SECONDS,
  replaceSnapshot,
  splitPercent,
  usageLevel,
  windowLagSince,
  windowName,
} from "./plan-usage"
import type {
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
} from "./types"

function makeWindow(overrides: Partial<PlanUsageWindow> = {}): PlanUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "5h",
    used_percent: 42,
    resets_at: null,
    window_minutes: 300,
    observed_at: 1_000,
    ...overrides,
  }
}

function makeSnapshot(
  overrides: Partial<PlanUsageSnapshot> = {}
): PlanUsageSnapshot {
  return {
    agent: "claude_code",
    windows: [makeWindow()],
    plan_label: null,
    status: null,
    observed_at: 1_000,
    source: "live",
    ...overrides,
  }
}

function makeReport(snapshots: PlanUsageSnapshot[]): PlanUsageReport {
  return {
    snapshots,
    codex_sessions_dir: "/home/u/.codex/sessions",
    codex_rollouts_found: true,
  }
}

describe("splitPercent", () => {
  it("rounds and keeps used + left at 100", () => {
    expect(splitPercent(42.4)).toEqual({ used: 42, left: 58 })
    expect(splitPercent(42.6)).toEqual({ used: 43, left: 57 })
  })

  it("never rounds a partly used window down to empty or up to full", () => {
    expect(splitPercent(0.2)).toEqual({ used: 1, left: 99 })
    expect(splitPercent(99.7)).toEqual({ used: 99, left: 1 })
    expect(splitPercent(0)).toEqual({ used: 0, left: 100 })
    expect(splitPercent(100)).toEqual({ used: 100, left: 0 })
  })

  it("clamps out-of-range and non-finite input", () => {
    expect(splitPercent(140)).toEqual({ used: 100, left: 0 })
    expect(splitPercent(-5)).toEqual({ used: 0, left: 100 })
    expect(splitPercent(Number.NaN)).toEqual({ used: 0, left: 100 })
  })
})

describe("usageLevel", () => {
  it("tints only tight windows", () => {
    expect(usageLevel(10)).toBe("normal")
    expect(usageLevel(74.9)).toBe("normal")
    expect(usageLevel(75)).toBe("high")
    expect(usageLevel(90)).toBe("critical")
  })
})

describe("windowName", () => {
  it("names the standard windows", () => {
    expect(windowName(makeWindow())).toEqual({ key: "session5h" })
    expect(
      windowName(makeWindow({ window_minutes: 120, label: "2h" }))
    ).toEqual({ key: "sessionSpan", values: { span: "2h" } })
    expect(
      windowName(
        makeWindow({ id: "seven_day", kind: "weekly", window_minutes: 10080 })
      )
    ).toEqual({ key: "weekly" })
  })

  it("names per-model and extra-usage windows", () => {
    expect(
      windowName(
        makeWindow({
          id: "seven_day_opus",
          kind: "weekly_model",
          label: "Opus",
        })
      )
    ).toEqual({ key: "weeklyModel", values: { model: "Opus" } })
    expect(windowName(makeWindow({ id: "overage", kind: "other" }))).toEqual({
      key: "extraUsage",
    })
    expect(
      windowName(
        makeWindow({ id: "seven_day_overage_included", kind: "other" })
      )
    ).toEqual({ key: "weeklyWithExtra" })
    expect(
      windowName(makeWindow({ id: "primary", kind: "other", label: "30d" }))
    ).toEqual({ key: "other", values: { label: "30d" } })
  })
})

describe("formatCompactDuration", () => {
  it("uses at most two units", () => {
    expect(formatCompactDuration(2 * 3600 + 14 * 60 + 59, "en")).toBe("2h 14m")
    expect(formatCompactDuration(3 * 86_400 + 4 * 3600 + 30 * 60, "en")).toBe(
      "3d 4h"
    )
    expect(formatCompactDuration(14 * 60, "en")).toBe("14m")
    expect(formatCompactDuration(2 * 86_400, "en")).toBe("2d")
    expect(formatCompactDuration(5 * 3600, "en")).toBe("5h")
  })

  it("says under a minute rather than zero", () => {
    expect(formatCompactDuration(30, "en")).toBe("<1m")
    expect(formatCompactDuration(-10, "en")).toBe("<1m")
  })

  it("localizes the unit names", () => {
    expect(formatCompactDuration(2 * 3600 + 5 * 60, "ko")).toBe("2시간 5분")
    expect(formatCompactDuration(2 * 3600 + 5 * 60, "zh-CN")).toBe(
      "2小时 5分钟"
    )
  })
})

describe("formatAbsoluteTime", () => {
  it("shows the year only when it differs from now", () => {
    const now = Date.UTC(2026, 8, 26, 12) / 1000
    const sameYear = formatAbsoluteTime(now + 6 * 3600, "en", now)
    expect(sameYear).not.toContain("2026")
    const nextYear = formatAbsoluteTime(
      Date.UTC(2027, 0, 5, 12) / 1000,
      "en",
      now
    )
    expect(nextYear).toContain("2027")
  })
})

describe("staleness and resets", () => {
  it("flags a reading older than the threshold", () => {
    const snapshot = makeSnapshot({ observed_at: 10_000 })
    expect(
      isSnapshotStale(snapshot, 10_000 + PLAN_USAGE_STALE_AFTER_SECONDS)
    ).toBe(false)
    expect(
      isSnapshotStale(snapshot, 10_001 + PLAN_USAGE_STALE_AFTER_SECONDS)
    ).toBe(true)
  })

  it("knows when a window rolled over after its reading", () => {
    expect(hasWindowReset(makeWindow({ resets_at: 500 }), 499)).toBe(false)
    expect(hasWindowReset(makeWindow({ resets_at: 500 }), 500)).toBe(true)
    expect(hasWindowReset(makeWindow({ resets_at: null }), 10_000)).toBe(false)
  })

  it("notes a window reported well before the rest of its snapshot", () => {
    const snapshot = makeSnapshot({ observed_at: 10_000 })
    expect(
      windowLagSince(makeWindow({ observed_at: 10_000 }), snapshot)
    ).toBeNull()
    expect(windowLagSince(makeWindow({ observed_at: 9_970 }), snapshot)).toBe(
      null
    )
    expect(windowLagSince(makeWindow({ observed_at: 6_000 }), snapshot)).toBe(
      6_000
    )
    expect(windowLagSince(makeWindow({ observed_at: null }), snapshot)).toBe(
      null
    )
  })
})

describe("report merging", () => {
  const codex = makeSnapshot({ agent: "codex", source: "transcript" })

  it("replaces one agent's snapshot in place", () => {
    const report = makeReport([makeSnapshot({ observed_at: 1 }), codex])
    const next = replaceSnapshot(report, makeSnapshot({ observed_at: 2 }))
    expect(next.snapshots).toHaveLength(2)
    expect(findSnapshot(next, "claude_code")?.observed_at).toBe(2)
    expect(findSnapshot(next, "codex")).toBe(codex)
    expect(next.codex_rollouts_found).toBe(true)
  })

  it("starts a report when a push lands before the first fetch", () => {
    const next = replaceSnapshot(null, makeSnapshot())
    expect(next.snapshots).toHaveLength(1)
    expect(next.codex_rollouts_found).toBe(false)
  })

  it("keeps a live push that overtook an in-flight fetch", () => {
    const pushed = makeSnapshot({ observed_at: 50 })
    const fetched = makeReport([makeSnapshot({ observed_at: 40 }), codex])
    const merged = mergeFetchedReport(makeReport([pushed]), fetched)
    expect(findSnapshot(merged, "claude_code")).toBe(pushed)
    expect(findSnapshot(merged, "codex")).toBe(codex)

    const withoutClaude = mergeFetchedReport(
      makeReport([pushed]),
      makeReport([codex])
    )
    expect(findSnapshot(withoutClaude, "claude_code")).toBe(pushed)
  })

  it("takes the fetched snapshot when it is as new or newer", () => {
    const fetchedClaude = makeSnapshot({ observed_at: 60 })
    const merged = mergeFetchedReport(
      makeReport([makeSnapshot({ observed_at: 50 })]),
      makeReport([fetchedClaude])
    )
    expect(findSnapshot(merged, "claude_code")).toBe(fetchedClaude)
    // A saved reading was never pushed, so the fetch owns it.
    const fromSaved = mergeFetchedReport(
      makeReport([makeSnapshot({ observed_at: 99, source: "saved" })]),
      makeReport([])
    )
    expect(findSnapshot(fromSaved, "claude_code")).toBeNull()
  })
})
