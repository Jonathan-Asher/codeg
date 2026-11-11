import type {
  LimitResetError,
  LimitResetItem,
  LimitResetKind,
  LimitResetOutcome,
  LimitResetsReport,
  PlanUsageAgent,
  ProviderLimitResets,
} from "@/lib/types"

/**
 * Usage-limit resets as the screens show them (`commands/limit_resets.rs`):
 * which provider has what, grouped into rows, and the i18n keys (under
 * `PlanUsage`) for every kind, outcome and error.
 */

/** One row: identical resets (same kind, name and state — e.g. Codex's
 *  "Full reset" credits) folded together. A click uses the one that
 *  expires first. */
export interface LimitResetGroup {
  key: string
  kind: LimitResetKind
  label: string | null
  description: string | null
  count: number
  /** The soonest expiry in the group (epoch seconds). */
  expires_at: number | null
  /** What a click uses: the reset that expires first. */
  id: string | null
  usable_now: boolean
  requires_limit: boolean
  unavailable_reason: string | null
}

export function findProviderResets(
  report: LimitResetsReport | null,
  agent: PlanUsageAgent
): ProviderLimitResets | null {
  return report?.providers.find((p) => p.provider === agent) ?? null
}

/** Rows in order of first appearance; the backend sends the items soonest
 *  to expire first, so each row keeps that order. */
export function groupLimitResets(items: LimitResetItem[]): LimitResetGroup[] {
  const groups: LimitResetGroup[] = []
  for (const item of items) {
    if (item.count <= 0) continue
    const key = [
      item.kind,
      item.label ?? "",
      item.usable_now ? "usable" : (item.unavailable_reason ?? "held"),
    ].join("|")
    const group = groups.find((g) => g.key === key)
    if (!group) {
      groups.push({
        key,
        kind: item.kind,
        label: item.label,
        description: item.description,
        count: item.count,
        expires_at: item.expires_at,
        id: item.id,
        usable_now: item.usable_now,
        requires_limit: item.requires_limit,
        unavailable_reason: item.unavailable_reason,
      })
      continue
    }
    group.count += item.count
    const sooner =
      item.expires_at != null &&
      (group.expires_at == null || item.expires_at < group.expires_at)
    if (sooner) {
      group.expires_at = item.expires_at
      group.id = item.id
    }
  }
  return groups
}

/** The reset a one-click "Use a reset" takes: the first usable one, which
 *  is the one that expires soonest. */
export function defaultUsableReset(
  resets: ProviderLimitResets | null
): LimitResetItem | null {
  return resets?.items.find((i) => i.usable_now && i.count > 0) ?? null
}

export function hasUsableReset(resets: ProviderLimitResets | null): boolean {
  return defaultUsableReset(resets) != null
}

/** An error the screens leave out: the agent isn't set up on this machine,
 *  so there is nothing to say about its resets. */
export function isQuietResetError(error: LimitResetError | null): boolean {
  return error?.code === "not_installed"
}

const ERROR_KEYS = {
  not_installed: "resets.error.notInstalled",
  not_logged_in: "resets.error.notLoggedIn",
  login_expired: "resets.error.loginExpired",
  not_eligible: "resets.error.notEligible",
  unsupported_version: "resets.error.unsupportedVersion",
  network: "resets.error.network",
  busy: "resets.error.busy",
  failed: "resets.error.failed",
} as const satisfies Record<LimitResetError["code"], string>

export type LimitResetErrorKey =
  | (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS]
  | "resets.error.surface"

/** The `PlanUsage` key for an error. Claude's "not offered to this app"
 *  (reason `surface`) gets its own words: it says where resets do work. */
export function resetErrorKey(error: LimitResetError): LimitResetErrorKey {
  if (error.code === "not_eligible" && error.reason === "surface") {
    return "resets.error.surface"
  }
  return ERROR_KEYS[error.code] ?? ERROR_KEYS.failed
}

/** The same key from a failed `use_limit_reset` call, whose error carries
 *  it as `i18n_key` (and the provider's reason as a param). `null` for an
 *  error that isn't one of these. */
export function resetErrorKeyFromApp(
  i18nKey: string | null | undefined,
  reason: string | null | undefined
): LimitResetErrorKey | null {
  if (reason === "surface") return "resets.error.surface"
  const known: readonly string[] = Object.values(ERROR_KEYS)
  return i18nKey != null && known.includes(i18nKey)
    ? (i18nKey as LimitResetErrorKey)
    : null
}

const OUTCOME_KEYS = {
  reset: "resets.outcome.reset",
  nothing_to_reset: "resets.outcome.nothingToReset",
  no_reset: "resets.outcome.noReset",
  already_used: "resets.outcome.alreadyUsed",
  cooldown: "resets.outcome.cooldown",
  unconfirmed: "resets.outcome.unconfirmed",
} as const satisfies Record<LimitResetOutcome, string>

export function resetOutcomeKey(
  outcome: LimitResetOutcome
): (typeof OUTCOME_KEYS)[LimitResetOutcome] {
  return OUTCOME_KEYS[outcome]
}

const KIND_KEYS = {
  session: "resets.kind.session",
  weekly: "resets.kind.weekly",
  full: "resets.kind.full",
  fable: "resets.kind.fable",
  other: "resets.kind.other",
} as const satisfies Record<LimitResetKind, string>

/** A reset's name when the provider gives none. */
export function resetKindKey(
  kind: LimitResetKind
): (typeof KIND_KEYS)[LimitResetKind] {
  return KIND_KEYS[kind] ?? KIND_KEYS.other
}

const REFILLS_KEYS = {
  session: "resets.refills.session",
  weekly: "resets.refills.weekly",
  full: "resets.refills.full",
  fable: "resets.refills.fable",
  other: "resets.refills.other",
} as const satisfies Record<LimitResetKind, string>

/** What a reset refills, for the confirmation ("your weekly limit"). */
export function resetRefillsKey(
  kind: LimitResetKind
): (typeof REFILLS_KEYS)[LimitResetKind] {
  return REFILLS_KEYS[kind] ?? REFILLS_KEYS.other
}

/** How an outcome is shown: it went through, nothing happened, or nobody
 *  knows yet. */
export function resetOutcomeTone(
  outcome: LimitResetOutcome
): "success" | "info" | "warning" {
  if (outcome === "reset") return "success"
  if (outcome === "unconfirmed") return "warning"
  return "info"
}

/** Why a row's button is off, as a `PlanUsage` key; `null` when usable. */
export function resetHeldKey(
  group: LimitResetGroup
):
  | "resets.needsLimit"
  | "resets.paused"
  | "resets.notStarted"
  | "resets.notUsableNow"
  | null {
  if (group.usable_now) return null
  if (group.unavailable_reason === "paused") return "resets.paused"
  if (group.unavailable_reason === "not_started") return "resets.notStarted"
  if (group.unavailable_reason === "needs_limit" || group.requires_limit) {
    return "resets.needsLimit"
  }
  return "resets.notUsableNow"
}

/** An expiry as a date ("Dec 10", with the year when it isn't this one's). */
export function formatResetDate(
  epochSeconds: number,
  locale: string,
  now: number
): string {
  const date = new Date(epochSeconds * 1000)
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date)
}

/** The soonest expiry among the resets that are left. */
export function soonestResetExpiry(
  resets: ProviderLimitResets | null
): number | null {
  let soonest: number | null = null
  for (const item of resets?.items ?? []) {
    if (item.count <= 0 || item.expires_at == null) continue
    if (soonest == null || item.expires_at < soonest) soonest = item.expires_at
  }
  return soonest
}
