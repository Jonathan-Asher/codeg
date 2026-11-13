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
  modelFamilyOf,
  poolGrantFit,
  poolLimitsReached,
  poolOffersRecheck,
  poolPicksGrant,
  poolRecommendedGrant,
  poolRefillsKey,
  poolRenewsAt,
  poolRenewsSoon,
  poolResetErrorKey,
  poolResetForPause,
  poolResetGroupKey,
  poolResetGroups,
  poolResetOutcomeKey,
  poolResetRecommendations,
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
  LimitResetKind,
  LimitResetOutcome,
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolAccountState,
  PlanUsagePoolResetGrant,
  PlanUsageWindow,
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
    const kinds: LimitResetKind[] = [
      "session",
      "weekly",
      "model_weekly",
      "full",
      "other",
    ]
    for (const kind of kinds) {
      expect(typeof message(poolResetGroupKey(kind))).toBe("string")
    }
    // One model's own reset is not a Codex kind: Codex rows read it as other.
    expect(resetKindKey("model_weekly")).toBe("resets.kind.other")
    for (const key of [
      "pool.resets.expires",
      "pool.resets.wontHelp.weekly",
      "pool.resets.wontHelp.session",
      "pool.resets.givesBackOnly",
      "pool.resets.givesBackOnlyNote",
      "pool.resets.confirmBodyModel",
      "pool.resets.recommended",
      "pool.resets.renewsSoon",
      "pool.resets.renewsSoonUnknown",
      "pool.resets.renewsSoonConfirm",
      "pool.resets.renewsSoonConfirmUnknown",
      "pool.resets.renewsSoonGuard",
      "pool.resets.useAnyway",
      "pool.resets.error.renewsSoonAt",
    ]) {
      expect(typeof message(key)).toBe("string")
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
    expect(poolResetErrorKey("pool.resets.error.renewsSoon")).toBe(
      "pool.resets.error.renewsSoon"
    )
    expect(typeof message("pool.resets.error.renewsSoon")).toBe("string")
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
    model: null,
    refills: ["seven_day"],
    count: 1,
    expires_at: NOW + 5 * DAY,
    usable_now: true,
    requires_limit: false,
    gives_back_weekly: false,
    ...over,
  }
}

/** One of the November launch's Fable resets, as the pool lists it. */
function fableGrant(
  over: Partial<PlanUsagePoolResetGrant> = {}
): PlanUsagePoolResetGrant {
  return grant({
    id: "launch-2610-fable",
    label:
      "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
    kind: "model_weekly",
    model: "Fable",
    refills: ["seven_day_fable"],
    expires_at: NOW + 117 * DAY,
    gives_back_weekly: true,
    ...over,
  })
}

function window(
  id: string,
  used: number,
  resetsIn: number = 3 * DAY
): PlanUsageWindow {
  return {
    id,
    kind:
      id === "five_hour"
        ? "session"
        : id === "seven_day"
          ? "weekly"
          : "weekly_model",
    label: id,
    used_percent: used,
    resets_at: NOW + resetsIn,
    window_minutes: null,
    observed_at: NOW,
  }
}

/** An account at the limits `reached`, with its windows reading so. */
function heldAt(
  name: string,
  grants: PlanUsagePoolResetGrant[],
  reached: string[],
  windows: PlanUsageWindow[] = reached.map((id) => window(id, 100))
): PlanUsagePoolAccount {
  const a = account(name, grants, { state: "exhausted", windows })
  a.resets!.limits_reached = reached
  return a
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
      limits_reached: [],
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
    // What it refills isn't known: shown, never used from here.
    const unknown = account("u", [grant({ kind: "other", refills: [] })])
    expect(
      poolResetToUse(pool([unknown]), unknown, "exhausted", NOW)
    ).toBeNull()
  })

  it("puts an account's grants in one row per kind, each with its soonest expiry", () => {
    const a = account("a", [
      fableGrant({ id: "f1", expires_at: NOW + 2 * DAY }),
      grant({ id: "w1", count: 2, expires_at: NOW + 3 * DAY }),
      fableGrant({ id: "f2", expires_at: NOW + 4 * DAY }),
      fableGrant({ id: "f3", expires_at: NOW + DAY }),
      grant({ id: "u1", kind: "other", refills: [] }),
      grant({ id: "spent", count: 0 }),
    ])
    const groups = poolResetGroups(a)
    expect(groups.map((g) => [g.kind, g.model, g.count, g.expires_at])).toEqual(
      [
        ["model_weekly", "Fable", 3, NOW + DAY],
        ["weekly", null, 2, NOW + 3 * DAY],
        ["other", null, 1, NOW + 5 * DAY],
      ]
    )
    expect(groups[0].grants.map((g) => g.id)).toEqual(["f1", "f2", "f3"])
    // A row's button takes the provider's next grant when it is in that
    // row, else the row's first usable one.
    const p = pool([a])
    a.resets!.next_grant_id = "f2"
    expect(poolResetToUse(p, a, "available", NOW, groups[0].grants)?.id).toBe(
      "f2"
    )
    expect(poolResetToUse(p, a, "available", NOW, groups[1].grants)?.id).toBe(
      "w1"
    )
    expect(poolResetToUse(p, a, "available", NOW, groups[2].grants)).toBeNull()
  })

  it("reads the limits an account is at, less a window that has reset since", () => {
    const a = heldAt(
      "a",
      [],
      ["five_hour", "seven_day"],
      [window("five_hour", 100, -60), window("seven_day", 100)]
    )
    expect(poolLimitsReached(a, NOW)).toEqual(["seven_day"])
    expect(poolLimitsReached(account("b", []), NOW)).toEqual([])
  })

  it("says a Fable reset won't help an account at a general limit, unless it gives back Fable's own use", () => {
    const fable = fableGrant()
    // The general weekly limit spent, Fable's own not in effect (the pool's
    // listing of jonathanashur's resets, 2026-11-12): nothing to give back.
    expect(
      poolGrantFit(heldAt("a", [fable], ["seven_day"]), fable, NOW)
    ).toEqual({ kind: "wont_help", model: "Fable", limit: "weekly" })
    // Fable's weekly window in effect, unused this week.
    expect(
      poolGrantFit(
        heldAt(
          "a",
          [fable],
          ["seven_day"],
          [window("seven_day", 100), window("seven_day_fable", 0)]
        ),
        fable,
        NOW
      )
    ).toMatchObject({ kind: "wont_help", limit: "weekly" })
    // Fable used some of it this week: that much comes back, no more.
    const fableUsed = [window("seven_day", 100), window("seven_day_fable", 40)]
    expect(
      poolGrantFit(heldAt("a", [fable], ["seven_day"], fableUsed), fable, NOW)
    ).toEqual({ kind: "gives_back_only", model: "Fable" })
    // ...but not for a grant that gives nothing back, nor while the 5-hour
    // limit holds the account too.
    const noGiveBack = fableGrant({ gives_back_weekly: false })
    expect(
      poolGrantFit(
        heldAt("a", [noGiveBack], ["seven_day"], fableUsed),
        noGiveBack,
        NOW
      ).kind
    ).toBe("wont_help")
    expect(
      poolGrantFit(
        heldAt(
          "a",
          [fable],
          ["five_hour", "seven_day"],
          [window("five_hour", 100), ...fableUsed]
        ),
        fable,
        NOW
      ).kind
    ).toBe("wont_help")
    expect(
      poolGrantFit(heldAt("a", [fable], ["five_hour"]), fable, NOW)
    ).toEqual({ kind: "wont_help", model: "Fable", limit: "session" })

    // At Fable's own weekly limit, or at none, it does what it says.
    expect(
      poolGrantFit(heldAt("a", [fable], ["seven_day_fable"]), fable, NOW).kind
    ).toBe("fits")
    expect(poolGrantFit(account("a", [fable]), fable, NOW).kind).toBe("fits")
    // A limit whose window has reset since holds nothing.
    expect(
      poolGrantFit(
        heldAt("a", [fable], ["seven_day"], [window("seven_day", 100, -60)]),
        fable,
        NOW
      ).kind
    ).toBe("fits")
    // The general resets refill what they say; an unknown one is unknown.
    const weekly = grant()
    expect(
      poolGrantFit(heldAt("a", [weekly], ["seven_day"]), weekly, NOW).kind
    ).toBe("fits")
    const unknown = grant({ kind: "other", refills: [] })
    expect(poolGrantFit(account("a", [unknown]), unknown, NOW).kind).toBe(
      "unknown"
    )
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

  it("offers a paused session only a reset that clears what holds an account", () => {
    const free = account("free", [grant({ id: "f", expires_at: NOW + DAY })])
    const heldLate = heldAt(
      "held-late",
      [grant({ id: "hl", expires_at: NOW + 8 * DAY })],
      ["seven_day"]
    )
    const heldSoon = heldAt(
      "held-soon",
      [grant({ id: "hs", expires_at: NOW + 3 * DAY })],
      ["seven_day"]
    )
    const pick = poolResetForPause(pool([free, heldLate, heldSoon]), NOW)
    expect(pick?.account.name).toBe("held-soon")
    expect(pick?.grant.id).toBe("hs")
    // An account at no limit has nothing a reset clears.
    expect(poolResetForPause(pool([free]), NOW)).toBeNull()
    expect(poolResetForPause(pool([heldSoon], { stale: true }), NOW)).toBeNull()
    expect(poolResetForPause(null, NOW)).toBeNull()
    expect(
      poolResetForPause(pool([heldAt("none", [], ["seven_day"])]), NOW)
    ).toBeNull()
  })

  it("never offers a Fable reset for the general weekly limit", () => {
    // What spent a Fable reset for nothing: the accounts at their general
    // weekly limit hold only Fable resets, another has headroom.
    const walled = heldAt("walled", [fableGrant()], ["seven_day"])
    const spare = account("spare", [fableGrant({ id: "spare-fable" })])
    expect(poolResetForPause(pool([walled, spare]), NOW)).toBeNull()
    expect(poolResetForPause(pool([walled, spare]), NOW, "fable")).toBeNull()
    // A weekly reset there clears it.
    const weekly = heldAt(
      "weekly",
      [fableGrant(), grant({ id: "w" })],
      ["seven_day"]
    )
    expect(poolResetForPause(pool([walled, weekly]), NOW)?.grant.id).toBe("w")
  })

  it("offers a Fable reset only to a Fable session held by Fable's own limit", () => {
    const fableWalled = heldAt("fw", [fableGrant()], ["seven_day_fable"])
    expect(poolResetForPause(pool([fableWalled]), NOW, "fable")?.grant.id).toBe(
      "launch-2610-fable"
    )
    // Another model's session isn't held by it; an unknown model can't say.
    expect(poolResetForPause(pool([fableWalled]), NOW, "opus")).toBeNull()
    expect(poolResetForPause(pool([fableWalled]), NOW)).toBeNull()
    // At the general weekly limit too, a Fable reset alone doesn't free it.
    const both = heldAt(
      "both",
      [fableGrant()],
      ["seven_day", "seven_day_fable"]
    )
    expect(poolResetForPause(pool([both]), NOW, "fable")).toBeNull()
  })

  it("prefers the reset that refills least beyond the limits reached", () => {
    const sessionAndWeekly = heldAt(
      "both",
      [
        grant({ id: "weekly", expires_at: NOW + DAY }),
        grant({
          id: "full",
          kind: "full",
          refills: ["five_hour", "seven_day"],
          expires_at: NOW + 2 * DAY,
        }),
      ],
      ["five_hour", "seven_day"]
    )
    // The weekly reset alone leaves the 5-hour limit holding it.
    expect(poolResetForPause(pool([sessionAndWeekly]), NOW)?.grant.id).toBe(
      "full"
    )
    const weeklyOnly = heldAt(
      "weekly",
      [
        grant({
          id: "full",
          kind: "full",
          refills: ["five_hour", "seven_day"],
          expires_at: NOW + DAY,
        }),
        grant({ id: "weekly", expires_at: NOW + 9 * DAY }),
      ],
      ["seven_day"]
    )
    expect(poolResetForPause(pool([weeklyOnly]), NOW)?.grant.id).toBe("weekly")
  })

  it("reads a session's model family the way the pool reads a request's", () => {
    expect(modelFamilyOf("claude-fable-5-1")).toBe("fable")
    expect(modelFamilyOf("claude-opus-5-5")).toBe("opus")
    expect(modelFamilyOf("claude-sonnet-5-5")).toBe("sonnet")
    expect(modelFamilyOf("claude-haiku-5-5")).toBe("haiku")
    expect(modelFamilyOf("gpt-5.5")).toBeNull()
    expect(modelFamilyOf(null)).toBeNull()
  })
})

describe("the pool's advice on a pool account's resets", () => {
  /** An account at its general weekly limit with what the pool says of it. */
  function advised(
    name: string,
    grants: PlanUsagePoolResetGrant[],
    advice: Partial<NonNullable<PlanUsagePoolAccount["resets"]>>,
    windows?: PlanUsageWindow[]
  ): PlanUsagePoolAccount {
    const a = heldAt(name, grants, ["seven_day"], windows)
    a.resets = { ...a.resets!, at_wall: true, wall: ["general"], ...advice }
    return a
  }

  it("finds the grant the pool recommends, only one it can use now and that helps", () => {
    const named = advised("named", [grant({ id: "a" }), grant({ id: "b" })], {
      recommended: true,
      recommended_grant_id: "b",
    })
    const next = advised("next", [grant({ id: "a" }), grant({ id: "b" })], {
      recommended: true,
    })
    next.resets!.next_grant_id = "b"
    const p = pool([named, next])
    expect(poolRecommendedGrant(p, named, NOW)?.id).toBe("b")
    expect(poolRecommendedGrant(p, next, NOW)?.id).toBe("b")
    expect(
      poolResetRecommendations(p, NOW).map((r) => [r.account.name, r.grant.id])
    ).toEqual([
      ["named", "b"],
      ["next", "b"],
    ])

    // A grant this reading doesn't hold, one paused, one that won't help,
    // an account whose limit renews by itself soon, or one not recommended.
    const gone = advised("gone", [grant()], {
      recommended: true,
      recommended_grant_id: "elsewhere",
    })
    const paused = advised("paused", [grant({ usable_now: false })], {
      recommended: true,
    })
    const fableOnly = advised("fable", [fableGrant()], { recommended: true })
    const renewing = advised("renewing", [grant()], {
      recommended: true,
      renews_soon: true,
    })
    const plain = advised("plain", [grant()], {})
    const none = pool([gone, paused, fableOnly, renewing, plain])
    expect(poolResetRecommendations(none, NOW)).toEqual([])
    // Nor from a pool that isn't answering or doesn't list resets.
    expect(
      poolResetRecommendations(pool([named], { stale: true }), NOW)
    ).toEqual([])
    expect(
      poolResetRecommendations(pool([named], { resets_supported: false }), NOW)
    ).toEqual([])
    expect(poolResetRecommendations(null, NOW)).toEqual([])
  })

  it("knows which grant is the pool's pick", () => {
    const named = advised("a", [], {
      recommended: true,
      recommended_grant_id: "b",
    })
    expect(poolPicksGrant(named, grant({ id: "b" }))).toBe(true)
    expect(poolPicksGrant(named, grant({ id: "c" }))).toBe(false)
    const any = advised("a", [], { recommended: true })
    expect(poolPicksGrant(any, grant({ id: "c" }))).toBe(true)
    expect(
      poolPicksGrant(
        advised("a", [], { recommended: true, renews_soon: true }),
        grant()
      )
    ).toBe(false)
    expect(poolPicksGrant(account("a", []), grant())).toBe(false)
  })

  it("says when the limits an account is at renew by themselves", () => {
    // The general weekly limit as the pool says, else as the reading has it.
    const weekly = advised("w", [], {
      renews_soon: true,
      weekly_renews_at: NOW + 3 * 3600,
    })
    expect(poolRenewsSoon(weekly)).toBe(true)
    expect(poolRenewsAt(weekly, NOW)).toBe(NOW + 3 * 3600)
    const fromReading = advised("r", [], { renews_soon: true })
    expect(poolRenewsAt(fromReading, NOW)).toBe(NOW + 3 * DAY)

    // The 5-hour and a model's own limits from the reading; the last of them.
    const both = advised("b", [], { wall: ["session", "fable"] }, [
      window("five_hour", 100, 3600),
      window("seven_day_fable", 100, 7200),
    ])
    expect(poolRenewsAt(both, NOW)).toBe(NOW + 7200)

    // Without the pool's words, the limits the reading finds reached.
    const older = heldAt(
      "o",
      [],
      ["five_hour"],
      [window("five_hour", 100, 900)]
    )
    expect(poolRenewsSoon(older)).toBe(false)
    expect(poolRenewsAt(older, NOW)).toBe(NOW + 900)

    // Nothing known, or only times already past.
    const unknown = advised("u", [], { wall: ["opus"] })
    expect(poolRenewsAt(unknown, NOW)).toBeNull()
    expect(
      poolRenewsAt(
        heldAt("p", [], ["five_hour"], [window("five_hour", 100, -60)]),
        NOW
      )
    ).toBeNull()
    expect(poolRenewsAt(account("n", []), NOW)).toBeNull()
  })

  it("offers a paused session the pool's pick first, and never an account whose limit renews soon", () => {
    const early = heldAt(
      "early",
      [grant({ id: "e", expires_at: NOW + DAY })],
      ["seven_day"]
    )
    const picked = advised(
      "picked",
      [grant({ id: "p1", expires_at: NOW + 2 * DAY }), grant({ id: "p2" })],
      { recommended: true, recommended_grant_id: "p2" }
    )
    const pick = poolResetForPause(pool([early, picked]), NOW)
    expect(pick?.account.name).toBe("picked")
    expect(pick?.grant.id).toBe("p2")

    // The pool's pick must still clear what stopped the session: a Fable
    // reset is never offered for the general weekly limit.
    const fablePick = advised("fable", [fableGrant()], { recommended: true })
    expect(poolResetForPause(pool([early, fablePick]), NOW)?.grant.id).toBe("e")

    // An account whose limit renews by itself soon is left to it.
    const renewing = advised("renewing", [grant({ id: "r" })], {
      renews_soon: true,
      recommended: true,
    })
    expect(poolResetForPause(pool([renewing]), NOW)).toBeNull()
    expect(poolResetForPause(pool([renewing, early]), NOW)?.grant.id).toBe("e")
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
