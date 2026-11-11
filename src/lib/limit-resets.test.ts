import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  defaultUsableReset,
  findProviderResets,
  formatResetDate,
  groupLimitResets,
  hasUsableReset,
  isQuietResetError,
  resetErrorKey,
  resetErrorKeyFromApp,
  resetHeldKey,
  resetKindKey,
  resetOutcomeKey,
  resetOutcomeTone,
  resetRefillsKey,
  soonestResetExpiry,
} from "@/lib/limit-resets"
import type {
  LimitResetItem,
  LimitResetOutcome,
  ProviderLimitResets,
} from "@/lib/types"

function item(over: Partial<LimitResetItem> = {}): LimitResetItem {
  return {
    id: "c1",
    kind: "full",
    label: "Full reset",
    description: null,
    count: 1,
    expires_at: 1_796_070_038,
    usable_now: true,
    requires_limit: false,
    clears: [],
    unavailable_reason: null,
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
    fetched_at: 1_794_506_400,
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

  it("keeps a held reset apart from a usable one and skips spent ones", () => {
    const groups = groupLimitResets([
      item({ id: "now" }),
      item({ id: "later", usable_now: false, unavailable_reason: "paused" }),
      item({ id: "spent", count: 0 }),
    ])
    expect(groups.map((g) => g.id)).toEqual(["now", "later"])
    expect(groups[1].usable_now).toBe(false)
  })

  it("adds up a grant that holds several resets", () => {
    const [group] = groupLimitResets([
      item({ id: null, count: 3, expires_at: null }),
    ])
    expect(group).toMatchObject({ id: null, count: 3, expires_at: null })
  })
})

describe("picking a reset", () => {
  it("takes the first usable reset and knows when there is none", () => {
    expect(defaultUsableReset(provider())?.id).toBe("c1")
    const held = provider({
      items: [item({ usable_now: false }), item({ id: "c2" })],
    })
    expect(defaultUsableReset(held)?.id).toBe("c2")
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
    for (const kind of [
      "session",
      "weekly",
      "full",
      "fable",
      "other",
    ] as const) {
      expect(typeof message(resetKindKey(kind))).toBe("string")
      expect(typeof message(resetRefillsKey(kind))).toBe("string")
    }
    const outcomes: LimitResetOutcome[] = [
      "reset",
      "nothing_to_reset",
      "no_reset",
      "already_used",
      "cooldown",
      "unconfirmed",
    ]
    for (const outcome of outcomes) {
      expect(typeof message(resetOutcomeKey(outcome))).toBe("string")
    }
    for (const code of [
      "not_installed",
      "not_logged_in",
      "login_expired",
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

  it("says where Claude's resets work when this app is not offered them", () => {
    expect(
      resetErrorKey({ code: "not_eligible", message: "x", reason: "surface" })
    ).toBe("resets.error.surface")
    expect(
      resetErrorKey({ code: "not_eligible", message: "x", reason: "tier" })
    ).toBe("resets.error.notEligible")
    expect(message("resets.error.surface")).toMatch(/\/limit-reset/)
  })

  it("reads the key a failed use carries, and nothing else", () => {
    expect(resetErrorKeyFromApp("resets.error.busy", undefined)).toBe(
      "resets.error.busy"
    )
    expect(resetErrorKeyFromApp("resets.error.notEligible", "surface")).toBe(
      "resets.error.surface"
    )
    expect(resetErrorKeyFromApp("mcp.errors.other", undefined)).toBeNull()
    expect(resetErrorKeyFromApp(null, null)).toBeNull()
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

  it("says why a row can't be used", () => {
    const [usable, paused, saved, other] = groupLimitResets([
      item({ id: "a" }),
      item({
        id: "b",
        label: "b",
        usable_now: false,
        unavailable_reason: "paused",
        requires_limit: true,
      }),
      item({ id: "c", label: "c", usable_now: false, requires_limit: true }),
      item({
        id: "d",
        label: "d",
        usable_now: false,
        unavailable_reason: "cooldown",
      }),
    ])
    expect(resetHeldKey(usable)).toBeNull()
    expect(resetHeldKey(paused)).toBe("resets.paused")
    expect(resetHeldKey(saved)).toBe("resets.needsLimit")
    expect(resetHeldKey(other)).toBe("resets.notUsableNow")
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
