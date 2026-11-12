import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  CLAUDE_USAGE_URL,
  defaultUsableReset,
  findProviderResets,
  formatResetDate,
  groupLimitResets,
  hasUsableReset,
  isQuietResetError,
  poolOffersRecheck,
  poolRefillsKey,
  poolResetErrorKey,
  poolResetForPause,
  poolResetOutcomeKey,
  poolResetsExpiry,
  poolResetToUse,
  resetErrorKey,
  resetErrorKeyFromApp,
  resetKindKey,
  resetOutcomeKey,
  resetOutcomeTone,
  resetRefillsKey,
  soonestResetExpiry,
} from "@/lib/limit-resets"
import type {
  LimitResetItem,
  LimitResetOutcome,
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolAccountState,
  PlanUsagePoolResetGrant,
  ProviderLimitResets,
} from "@/lib/types"

const NOW = 1_794_506_400
const DAY = 86_400

function item(over: Partial<LimitResetItem> = {}): LimitResetItem {
  return {
    id: "c1",
    kind: "full",
    label: "Full reset",
    description: null,
    count: 1,
    expires_at: 1_796_070_038,
    ...over,
  }
}

function provider(
  over: Partial<ProviderLimitResets> = {}
): ProviderLimitResets {
  return {
    provider: "codex",
    available: 2,
    items: [item(), item({ id: "c2", expires_at: 1_796_165_330 })],
    source: "codex_app_server",
    account: "me@example.com",
    error: null,
    fetched_at: NOW,
    ...over,
  }
}

/** A dotted key resolved in `PlanUsage`, the namespace these keys live in. */
function message(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      enMessages.PlanUsage
    )
}

describe("groupLimitResets", () => {
  it("folds identical resets into one row that uses the soonest to expire", () => {
    const groups = groupLimitResets([
      item({ id: "late", expires_at: 2_000 }),
      item({ id: "soon", expires_at: 1_000 }),
      item({
        id: "weekly",
        kind: "weekly",
        label: "Weekly reset",
        expires_at: 1_500,
      }),
      item({ id: "spent", count: 0 }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      kind: "full",
      count: 2,
      expires_at: 1_000,
      id: "soon",
    })
    expect(groups[1]).toMatchObject({ kind: "weekly", count: 1, id: "weekly" })
  })

  it("adds up a credit count without details", () => {
    const [group] = groupLimitResets([
      item({ id: null, count: 3, expires_at: null }),
    ])
    expect(group).toMatchObject({ id: null, count: 3, expires_at: null })
  })
})

describe("picking a Codex reset", () => {
  it("takes the first one left and knows when there is none", () => {
    expect(defaultUsableReset(provider())?.id).toBe("c1")
    expect(hasUsableReset(provider({ items: [], available: 0 }))).toBe(false)
    expect(hasUsableReset(null)).toBe(false)
    expect(
      findProviderResets({ providers: [provider()] }, "codex")?.account
    ).toBe("me@example.com")
    expect(
      findProviderResets({ providers: [provider()] }, "claude_code")
    ).toBeNull()
    expect(findProviderResets(null, "codex")).toBeNull()
  })

  it("finds the soonest expiry among the resets left", () => {
    expect(soonestResetExpiry(provider())).toBe(1_796_070_038)
    expect(
      soonestResetExpiry(provider({ items: [item({ expires_at: null })] }))
    ).toBeNull()
    expect(soonestResetExpiry(null)).toBeNull()
  })
})

describe("words for kinds, outcomes and errors", () => {
  it("has a message for every kind, refill, outcome and error key", () => {
    for (const kind of ["session", "weekly", "full", "other"] as const) {
      expect(typeof message(resetKindKey(kind))).toBe("string")
      expect(typeof message(resetRefillsKey(kind))).toBe("string")
      expect(typeof message(poolRefillsKey(kind))).toBe("string")
    }
    const outcomes: LimitResetOutcome[] = [
      "reset",
      "nothing_to_reset",
      "no_reset",
      "already_used",
      "unconfirmed",
    ]
    for (const outcome of outcomes) {
      expect(typeof message(resetOutcomeKey(outcome))).toBe("string")
    }
    for (const outcome of ["reset", "already_used", "unconfirmed"] as const) {
      expect(typeof message(poolResetOutcomeKey(outcome))).toBe("string")
    }
    for (const code of [
      "not_installed",
      "not_logged_in",
      "not_eligible",
      "unsupported_version",
      "network",
      "busy",
      "failed",
    ] as const) {
      expect(typeof message(resetErrorKey({ code, message: "x" }))).toBe(
        "string"
      )
    }
  })

  it("points Claude's own resets to its apps", () => {
    expect(resetErrorKeyFromApp("resets.error.notEligible", "claude_app")).toBe(
      "resets.claude.elsewhere"
    )
    expect(message("resets.claude.elsewhere")).toMatch(/claude\.ai/)
    expect(message("resets.claude.hint")).toMatch(/\/limit-reset/)
    expect(CLAUDE_USAGE_URL).toBe("https://claude.ai/settings/usage")
  })

  it("reads the key a failed use carries, and nothing else", () => {
    expect(resetErrorKeyFromApp("resets.error.busy", undefined)).toBe(
      "resets.error.busy"
    )
    expect(resetErrorKeyFromApp("mcp.errors.other", undefined)).toBeNull()
    expect(resetErrorKeyFromApp(null, null)).toBeNull()
    expect(poolResetErrorKey("pool.resets.error.recentlyUsed")).toBe(
      "pool.resets.error.recentlyUsed"
    )
    expect(typeof message("pool.resets.error.recentlyUsed")).toBe("string")
    expect(poolResetErrorKey("pool.resets.error.other")).toBeNull()
    expect(poolResetErrorKey(undefined)).toBeNull()
  })

  it("tones outcomes and leaves an uninstalled agent out", () => {
    expect(resetOutcomeTone("reset")).toBe("success")
    expect(resetOutcomeTone("unconfirmed")).toBe("warning")
    expect(resetOutcomeTone("already_used")).toBe("info")
    expect(isQuietResetError({ code: "not_installed", message: "x" })).toBe(
      true
    )
    expect(isQuietResetError({ code: "network", message: "x" })).toBe(false)
    expect(isQuietResetError(null)).toBe(false)
  })
})

// ─── A pool account's resets ────────────────────────────────────────────

function grant(
  over: Partial<PlanUsagePoolResetGrant> = {}
): PlanUsagePoolResetGrant {
  return {
    id: "g1",
    label: null,
    kind: "weekly",
    count: 1,
    expires_at: NOW + 5 * DAY,
    usable_now: true,
    requires_limit: false,
    ...over,
  }
}

function account(
  name: string,
  grants: PlanUsagePoolResetGrant[],
  over: Partial<PlanUsagePoolAccount> = {}
): PlanUsagePoolAccount {
  return {
    name,
    enabled: true,
    status: "active",
    state: "available",
    blocked_until: null,
    serving: false,
    preferred: false,
    windows: [],
    limit_status: null,
    weekly_state: null,
    cooling_until: null,
    in_flight: 0,
    probe_failures: 0,
    probe_error_status: null,
    refresh_failed: false,
    observed_at: NOW,
    resets: {
      available: grants.reduce((n, g) => n + g.count, 0),
      grants,
      next_grant_id: null,
      cooldown_until: null,
      eligible: true,
      auto_redeem: false,
      checked_at: NOW,
    },
    ...over,
  }
}

function pool(
  accounts: PlanUsagePoolAccount[],
  over: Partial<PlanUsagePool> = {}
): PlanUsagePool {
  return {
    kind: "maxpool",
    agent: "claude_code",
    version: "1.24.5",
    accounts,
    current_account: null,
    preferred_account: null,
    routing_mode: "automatic",
    switch_threshold: 99,
    exhausted: false,
    resumes_at: null,
    observed_at: NOW,
    checked_at: NOW,
    stale: false,
    error: null,
    error_status: null,
    resets_supported: true,
    ...over,
  }
}

describe("a pool account's resets", () => {
  it("uses the provider's next grant, else the usable one expiring first", () => {
    const a = account("a", [
      grant({ id: "soon", expires_at: NOW + DAY }),
      grant({ id: "late", expires_at: NOW + 9 * DAY }),
    ])
    const p = pool([a])
    expect(poolResetToUse(p, a, "available", NOW)?.id).toBe("soon")
    a.resets!.next_grant_id = "late"
    expect(poolResetToUse(p, a, "available", NOW)?.id).toBe("late")
    expect(poolResetsExpiry(a)).toBe(NOW + DAY)
  })

  it("holds back what the pool or the provider can't use now", () => {
    const paused = account("p", [grant({ usable_now: false })])
    const atLimitOnly = account("l", [grant({ requires_limit: true })])
    const cooling = account("c", [grant()])
    cooling.resets!.cooldown_until = NOW + 600
    const expired = account("e", [grant({ expires_at: NOW - 1 })])
    const off = account("o", [grant()], { enabled: false })
    const p = pool([paused, atLimitOnly, cooling, expired, off])
    expect(poolResetToUse(p, paused, "exhausted", NOW)).toBeNull()
    expect(poolResetToUse(p, atLimitOnly, "available", NOW)).toBeNull()
    expect(poolResetToUse(p, atLimitOnly, "exhausted", NOW)?.id).toBe("g1")
    expect(poolResetToUse(p, cooling, "exhausted", NOW)).toBeNull()
    expect(poolResetToUse(p, expired, "exhausted", NOW)).toBeNull()
    expect(poolResetToUse(p, off, "exhausted", NOW)).toBeNull()
    const older = pool([atLimitOnly], { resets_supported: false })
    expect(poolResetToUse(older, atLimitOnly, "exhausted", NOW)).toBeNull()
  })

  it("offers Recheck beside a hold a reset or a rollover may have made old", () => {
    const p = pool([])
    const states: PlanUsagePoolAccountState[] = [
      "cooling_down",
      "reserved",
      "at_threshold",
    ]
    for (const state of states) expect(poolOffersRecheck(p, state)).toBe(true)
    expect(poolOffersRecheck(p, "available")).toBe(false)
    expect(poolOffersRecheck(p, "exhausted")).toBe(false)
    expect(
      poolOffersRecheck(pool([], { resets_supported: false }), "cooling_down")
    ).toBe(false)
  })

  it("picks, for a paused session, an account held by its limit first", () => {
    const free = account("free", [grant({ id: "f", expires_at: NOW + DAY })])
    const heldLate = account("held-late", [
      grant({ id: "hl", expires_at: NOW + 8 * DAY }),
    ])
    const heldSoon = account("held-soon", [
      grant({ id: "hs", expires_at: NOW + 3 * DAY }),
    ])
    const stateOf = (a: PlanUsagePoolAccount): PlanUsagePoolAccountState =>
      a.name.startsWith("held") ? "exhausted" : "available"
    const pick = poolResetForPause(
      pool([free, heldLate, heldSoon]),
      NOW,
      stateOf
    )
    expect(pick?.account.name).toBe("held-soon")
    expect(pick?.grant.id).toBe("hs")
    expect(
      poolResetForPause(pool([free]), NOW, () => "available")?.account.name
    ).toBe("free")
    expect(
      poolResetForPause(pool([free], { stale: true }), NOW, stateOf)
    ).toBeNull()
    expect(poolResetForPause(null, NOW, stateOf)).toBeNull()
    expect(
      poolResetForPause(pool([account("none", [])]), NOW, stateOf)
    ).toBeNull()
  })
})

describe("formatResetDate", () => {
  it("shows a date, with the year only when it isn't this year's", () => {
    const now = Date.UTC(2026, 10, 12) / 1000
    const thisYear = Date.UTC(2026, 11, 10, 12) / 1000
    const nextYear = Date.UTC(2027, 2, 9, 12) / 1000
    expect(formatResetDate(thisYear, "en-US", now)).toBe("Dec 10")
    expect(formatResetDate(nextYear, "en-US", now)).toBe("Mar 9, 2027")
  })
})
