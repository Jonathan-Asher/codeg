import { describe, expect, it } from "vitest"
import {
  activePool,
  exhaustedAccountCount,
  findSnapshot,
  formatAbsoluteTime,
  formatCompactDuration,
  hasWindowReset,
  isPoolStale,
  isSnapshotStale,
  mergeFetchedReport,
  PLAN_USAGE_POOL_STALE_AFTER_SECONDS,
  PLAN_USAGE_STALE_AFTER_SECONDS,
  planUsagePreview,
  poolAccountProbeWarning,
  poolAccountState,
  poolExhaustion,
  poolNextReset,
  poolUsageLevel,
  replacePool,
  replaceSnapshot,
  servingAccount,
  splitPercent,
  tightestPreviewEntry,
  tightestWindow,
  unansweredPool,
  usageLevel,
  windowLagSince,
  windowName,
} from "./plan-usage"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
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

describe("status-bar preview", () => {
  const now = 10_000
  const fresh = now - 5 * 60
  const stale = now - PLAN_USAGE_STALE_AFTER_SECONDS - 60

  function claude(
    windows: Partial<PlanUsageWindow>[],
    overrides: Partial<PlanUsageSnapshot> = {}
  ): PlanUsageSnapshot {
    return makeSnapshot({
      windows: windows.map((w) => makeWindow(w)),
      observed_at: fresh,
      ...overrides,
    })
  }

  function codex(
    windows: Partial<PlanUsageWindow>[],
    overrides: Partial<PlanUsageSnapshot> = {}
  ): PlanUsageSnapshot {
    return claude(windows, {
      agent: "codex",
      source: "transcript",
      ...overrides,
    })
  }

  it("picks the window with the highest used percentage", () => {
    const snapshot = claude([
      { id: "five_hour", used_percent: 35 },
      { id: "seven_day", kind: "weekly", used_percent: 61.5 },
      { id: "seven_day_opus", kind: "weekly_model", used_percent: 12 },
    ])
    expect(tightestWindow(snapshot, now)?.id).toBe("seven_day")
  })

  it("skips windows that rolled over since their reading", () => {
    const snapshot = claude([
      { id: "five_hour", used_percent: 98, resets_at: now - 60 },
      { id: "seven_day", kind: "weekly", used_percent: 40, resets_at: null },
    ])
    expect(tightestWindow(snapshot, now)?.id).toBe("seven_day")
    expect(
      tightestWindow(claude([{ used_percent: 98, resets_at: now - 60 }]), now)
    ).toBeNull()
  })

  it("gives one entry per provider with a reading, in card order", () => {
    const entries = planUsagePreview(
      makeReport([
        codex([{ id: "primary", used_percent: 99.4 }]),
        claude([{ used_percent: 34.6 }]),
      ]),
      now
    )
    expect(entries.map((e) => [e.agent, e.percent])).toEqual([
      ["claude_code", 35],
      ["codex", 99],
    ])
  })

  it("tints by level: normal below 75, amber from 75, red from 90", () => {
    const level = (used_percent: number) =>
      planUsagePreview(makeReport([claude([{ used_percent }])]), now)[0].level
    expect(level(74.9)).toBe("normal")
    expect(level(75)).toBe("high")
    expect(level(89.9)).toBe("high")
    expect(level(90)).toBe("critical")
    expect(level(100)).toBe("critical")
  })

  it("reads a fresh limit-reached status as red whatever the percentage", () => {
    const [entry] = planUsagePreview(
      makeReport([codex([{ used_percent: 40 }], { status: "limited" })]),
      now
    )
    expect(entry.level).toBe("critical")
    expect(entry.stale).toBe(false)
  })

  it("marks an old reading stale and keeps only its numbers", () => {
    const [entry] = planUsagePreview(
      makeReport([
        codex([{ used_percent: 40 }], {
          status: "limited",
          observed_at: stale,
        }),
      ]),
      now
    )
    expect(entry.stale).toBe(true)
    expect(entry.level).toBe("normal")
  })

  it("leaves out providers with no reading, or only rolled-over windows", () => {
    expect(planUsagePreview(null, now)).toEqual([])
    expect(planUsagePreview(makeReport([]), now)).toEqual([])
    expect(planUsagePreview(makeReport([claude([]), codex([])]), now)).toEqual(
      []
    )
    const entries = planUsagePreview(
      makeReport([
        claude([{ used_percent: 80, resets_at: now - 1 }]),
        codex([{ used_percent: 20 }]),
      ]),
      now
    )
    expect(entries.map((e) => e.agent)).toEqual(["codex"])
  })

  it("picks the single tightest entry for the compact bar", () => {
    const entries = planUsagePreview(
      makeReport([
        claude([{ used_percent: 35 }]),
        codex([{ used_percent: 99 }]),
      ]),
      now
    )
    expect(tightestPreviewEntry(entries)?.agent).toBe("codex")
    expect(tightestPreviewEntry([])).toBeNull()

    // Same percentage: the one that says it is blocked wins; else card order.
    const tied = planUsagePreview(
      makeReport([
        claude([{ used_percent: 50 }]),
        codex([{ used_percent: 50 }], { status: "limited" }),
      ]),
      now
    )
    expect(tightestPreviewEntry(tied)?.agent).toBe("codex")
    const even = planUsagePreview(
      makeReport([
        claude([{ used_percent: 50 }]),
        codex([{ used_percent: 50 }]),
      ]),
      now
    )
    expect(tightestPreviewEntry(even)?.agent).toBe("claude_code")
  })
})

describe("account pool", () => {
  const now = 100_000

  function account(
    overrides: Partial<PlanUsagePoolAccount> = {}
  ): PlanUsagePoolAccount {
    return {
      name: "alpha",
      enabled: true,
      status: "active",
      state: "available",
      blocked_until: null,
      serving: false,
      preferred: false,
      windows: [
        makeWindow({ used_percent: 40, resets_at: now + 3_600 }),
        makeWindow({
          id: "seven_day",
          kind: "weekly",
          label: "7d",
          window_minutes: 10_080,
          used_percent: 20,
          resets_at: now + 3 * 86_400,
        }),
      ],
      limit_status: "allowed",
      weekly_state: "normal",
      cooling_until: null,
      in_flight: 0,
      probe_failures: 0,
      probe_error_status: null,
      refresh_failed: false,
      observed_at: now - 60,
      ...overrides,
    }
  }

  function pool(overrides: Partial<PlanUsagePool> = {}): PlanUsagePool {
    return {
      kind: "maxpool",
      agent: "claude_code",
      version: "9.9.9",
      accounts: [
        account({
          name: "alpha",
          preferred: true,
          state: "exhausted",
          blocked_until: now + 2 * 3_600,
          windows: [
            makeWindow({ used_percent: 100, resets_at: now + 2 * 3_600 }),
          ],
        }),
        account({ name: "beta", serving: true }),
      ],
      current_account: "beta",
      preferred_account: "alpha",
      routing_mode: "preferred",
      switch_threshold: 90,
      exhausted: false,
      resumes_at: null,
      observed_at: now - 60,
      checked_at: now - 30,
      stale: false,
      error: null,
      error_status: null,
      ...overrides,
    }
  }

  function withPool(
    p: PlanUsagePool | null,
    snapshots: PlanUsageSnapshot[] = []
  ): PlanUsageReport {
    return { ...makeReport(snapshots), pool: p }
  }

  it("folds a pushed pool into the report, or drops it with null", () => {
    const report = makeReport([makeSnapshot()])
    const next = replacePool(report, pool())
    expect(next.pool?.accounts).toHaveLength(2)
    expect(next.snapshots).toBe(report.snapshots)
    expect(replacePool(next, null).pool).toBeNull()
    expect(replacePool(null, pool()).snapshots).toEqual([])
  })

  it("keeps a pool push newer than the fetched one", () => {
    const pushed = pool({ checked_at: now })
    const older = pool({ checked_at: now - 60 })
    expect(mergeFetchedReport(withPool(pushed), withPool(older)).pool).toBe(
      pushed
    )
    const newer = pool({ checked_at: now + 60 })
    expect(mergeFetchedReport(withPool(pushed), withPool(newer)).pool).toBe(
      newer
    )
    // The fetch says the pool is gone: it is.
    expect(
      mergeFetchedReport(withPool(pushed), makeReport([])).pool
    ).toBeUndefined()
  })

  it("only treats a pool with accounts as active", () => {
    expect(activePool(withPool(pool()))?.kind).toBe("maxpool")
    const unanswered = pool({ accounts: [], stale: true, error: "timeout" })
    expect(activePool(withPool(unanswered))).toBeNull()
    expect(unansweredPool(withPool(unanswered))).toBe(unanswered)
    expect(unansweredPool(withPool(pool()))).toBeNull()
    expect(activePool(makeReport([]))).toBeNull()
    expect(activePool(null)).toBeNull()
  })

  it("tints from the switch threshold and turns red when full", () => {
    expect(poolUsageLevel(56, 90)).toBe("normal")
    expect(poolUsageLevel(89.9, 90)).toBe("normal")
    expect(poolUsageLevel(90, 90)).toBe("high")
    expect(poolUsageLevel(99, 90)).toBe("high")
    expect(poolUsageLevel(100, 90)).toBe("critical")
    expect(poolUsageLevel(80, 75)).toBe("high")
  })

  it("lets a hold run out", () => {
    const held = account({ state: "exhausted", blocked_until: now + 60 })
    expect(poolAccountState(held, now)).toBe("exhausted")
    expect(poolAccountState(held, now + 60)).toBe("available")
    // No known end, or not a timed hold: as reported.
    expect(
      poolAccountState(account({ state: "exhausted" }), now + 86_400)
    ).toBe("exhausted")
    expect(
      poolAccountState(
        account({ state: "failing", blocked_until: now - 1 }),
        now
      )
    ).toBe("failing")
  })

  it("finds the serving account, the next reset and the exhausted count", () => {
    const p = pool()
    expect(servingAccount(p)?.name).toBe("beta")
    expect(
      servingAccount(
        pool({ accounts: p.accounts.map((a) => ({ ...a, serving: false })) })
      )?.name
    ).toBe("alpha")
    expect(poolNextReset(p, now)).toBe(now + 3_600)
    expect(exhaustedAccountCount(p, now)).toBe(1)
    expect(exhaustedAccountCount(p, now + 2 * 3_600)).toBe(0)
    // A disabled account's windows don't count.
    const disabled = pool({
      accounts: [account({ enabled: false, state: "disabled" })],
    })
    expect(poolNextReset(disabled, now)).toBeNull()
    expect(exhaustedAccountCount(disabled, now)).toBe(0)
  })

  it("is exhausted only until it resumes", () => {
    const out = pool({ exhausted: true, resumes_at: now + 600 })
    expect(poolExhaustion(out, now)).toEqual({
      exhausted: true,
      resumesAt: now + 600,
    })
    expect(poolExhaustion(out, now + 600).exhausted).toBe(false)
    expect(poolExhaustion(pool({ exhausted: true }), now)).toEqual({
      exhausted: true,
      resumesAt: null,
    })
    expect(poolExhaustion(pool(), now).exhausted).toBe(false)
  })

  it("goes stale on a failed ask or when the pushes stop", () => {
    expect(isPoolStale(pool(), now)).toBe(false)
    expect(isPoolStale(pool({ stale: true }), now)).toBe(true)
    expect(
      isPoolStale(
        pool({ checked_at: now - PLAN_USAGE_POOL_STALE_AFTER_SECONDS - 1 }),
        now
      )
    ).toBe(true)
  })

  it("warns of a failing usage check only once the numbers are stale", () => {
    const failing = (overrides: Partial<PlanUsagePoolAccount>) =>
      account({ probe_failures: 1, probe_error_status: 429, ...overrides })
    // Routine: the newest reading is still fresh.
    expect(poolAccountProbeWarning(failing({}), now)).toBeNull()
    expect(
      poolAccountProbeWarning(
        failing({ observed_at: now - PLAN_USAGE_POOL_STALE_AFTER_SECONDS }),
        now
      )
    ).toBeNull()
    // Gone stale while failing: with its age.
    expect(
      poolAccountProbeWarning(failing({ observed_at: now - 14 * 60 }), now)
    ).toEqual({ age: 14 * 60 })
    // Failing with no reading at all.
    expect(
      poolAccountProbeWarning(failing({ observed_at: null }), now)
    ).toEqual({ age: null })
    // Stale but not failing: the pool-level notice covers that.
    expect(
      poolAccountProbeWarning(
        account({ observed_at: now - 3_600, probe_failures: 0 }),
        now
      )
    ).toBeNull()
  })

  it("previews the serving account's 5-hour window", () => {
    const entries = planUsagePreview(
      withPool(pool(), [
        makeSnapshot({
          windows: [makeWindow({ used_percent: 100 })],
          observed_at: now,
          status: "limited",
        }),
      ]),
      now
    )
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.agent).toBe("claude_code")
    expect(entry.percent).toBe(40)
    expect(entry.level).toBe("normal")
    expect(entry.pool).toEqual({ account: "beta", exhausted: 1 })
    expect(entry.stale).toBe(false)
  })

  it("tints the preview from the threshold, red when every account is out", () => {
    const near = pool({
      accounts: [
        account({
          name: "beta",
          serving: true,
          windows: [makeWindow({ used_percent: 92, resets_at: now + 600 })],
        }),
      ],
    })
    expect(planUsagePreview(withPool(near), now)[0].level).toBe("high")
    const out = pool({ exhausted: true, resumes_at: now + 600 })
    expect(planUsagePreview(withPool(out), now)[0].level).toBe("critical")
    const stale = pool({ stale: true })
    expect(planUsagePreview(withPool(stale), now)[0].stale).toBe(true)
  })

  it("falls back to the agent's reading when no account has numbers", () => {
    const empty = pool({
      accounts: [account({ name: "beta", serving: true, windows: [] })],
    })
    const entries = planUsagePreview(
      withPool(empty, [makeSnapshot({ observed_at: now })]),
      now
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].pool).toBeUndefined()
    expect(entries[0].percent).toBe(42)
  })
})
