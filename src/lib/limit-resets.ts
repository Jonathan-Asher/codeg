import type {
  LimitResetError,
  LimitResetItem,
  LimitResetKind,
  LimitResetOutcome,
  LimitResetsReport,
  PlanUsageAgent,
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolAccountState,
  PlanUsagePoolResetGrant,
  PlanUsagePoolResetOutcome,
  ProviderLimitResets,
} from "@/lib/types"

/**
 * Usage-limit resets as the screens show them: Codex's own
 * (`commands/limit_resets.rs`) grouped into rows, a pool account's
 * (`commands/usage_pool/resets.rs`), and the i18n keys (under `PlanUsage`)
 * for every kind, outcome and error. Claude Code offers its own resets only
 * in its terminal app and on claude.ai: codeg points there.
 */

/** Where Claude's own usage page is, with its resets. */
export const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage"

/** One row: identical resets (same kind and name — e.g. Codex's "Full
 *  reset" credits) folded together. A click uses the one that expires
 *  first. */
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
    const key = [item.kind, item.label ?? ""].join("|")
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

/** The reset a one-click "Use a reset" takes: the first one left, which is
 *  the one that expires soonest. */
export function defaultUsableReset(
  resets: ProviderLimitResets | null
): LimitResetItem | null {
  return resets?.items.find((i) => i.count > 0) ?? null
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
  not_eligible: "resets.error.notEligible",
  unsupported_version: "resets.error.unsupportedVersion",
  network: "resets.error.network",
  busy: "resets.error.busy",
  failed: "resets.error.failed",
} as const satisfies Record<LimitResetError["code"], string>

export type LimitResetErrorKey =
  | (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS]
  | "resets.claude.elsewhere"

/** The `PlanUsage` key for an error. */
export function resetErrorKey(error: LimitResetError): LimitResetErrorKey {
  return ERROR_KEYS[error.code] ?? ERROR_KEYS.failed
}

/** The same key from a failed `use_limit_reset` call, whose error carries
 *  it as `i18n_key` (and the provider's reason as a param). Claude Code's
 *  refusal (reason `claude_app`) says where its resets are. `null` for an
 *  error that isn't one of these. */
export function resetErrorKeyFromApp(
  i18nKey: string | null | undefined,
  reason: string | null | undefined
): LimitResetErrorKey | null {
  if (reason === "claude_app") return "resets.claude.elsewhere"
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
  outcome: LimitResetOutcome | PlanUsagePoolResetOutcome
): "success" | "info" | "warning" {
  if (outcome === "reset") return "success"
  if (outcome === "unconfirmed") return "warning"
  return "info"
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

// ─── A pool account's resets ────────────────────────────────────────────

/** States in which a pool account's own limit holds it back, so a reset can
 *  free it (and "Recheck now" can find it freed). */
const HELD_BY_LIMIT: ReadonlySet<PlanUsagePoolAccountState> = new Set([
  "exhausted",
  "reserved",
  "at_threshold",
  "cooling_down",
])

/** States next to which "Recheck now" is offered: the pool may be holding
 *  the account on a reading a reset or a rollover has made old. */
const RECHECK_STATES: ReadonlySet<PlanUsagePoolAccountState> = new Set([
  "cooling_down",
  "reserved",
  "at_threshold",
])

export function poolOffersRecheck(
  pool: PlanUsagePool,
  state: PlanUsagePoolAccountState
): boolean {
  return pool.resets_supported === true && RECHECK_STATES.has(state)
}

/** The grant a "Use reset" takes on a pool account: the provider's next
 *  one when it can be used, else the usable one that expires first. A grant
 *  that only works at a limit is skipped while the account isn't held by
 *  one. `null` when none can be used now. */
export function poolResetToUse(
  pool: PlanUsagePool,
  account: PlanUsagePoolAccount,
  state: PlanUsagePoolAccountState,
  now: number
): PlanUsagePoolResetGrant | null {
  const resets = account.resets
  if (!pool.resets_supported || !resets || !account.enabled) return null
  if (account.provider || resets.eligible === false) return null
  if (resets.cooldown_until != null && resets.cooldown_until > now) return null
  const atLimit = HELD_BY_LIMIT.has(state)
  const usable = resets.grants.filter(
    (g) =>
      g.usable_now &&
      g.count > 0 &&
      (g.expires_at == null || g.expires_at > now) &&
      (!g.requires_limit || atLimit)
  )
  return usable.find((g) => g.id === resets.next_grant_id) ?? usable[0] ?? null
}

/** The soonest expiry among a pool account's grants left. */
export function poolResetsExpiry(account: PlanUsagePoolAccount): number | null {
  let soonest: number | null = null
  for (const g of account.resets?.grants ?? []) {
    if (g.count <= 0 || g.expires_at == null) continue
    if (soonest == null || g.expires_at < soonest) soonest = g.expires_at
  }
  return soonest
}

/** For a session paused at the pool's limit: the account (and grant) whose
 *  reset frees the most, i.e. an account held by its limit whose grant
 *  expires first; else any account with a usable grant. `null` when the
 *  pool has none. `stateOf` gives each account's state at `now`. */
export function poolResetForPause(
  pool: PlanUsagePool | null,
  now: number,
  stateOf: (account: PlanUsagePoolAccount) => PlanUsagePoolAccountState
): { account: PlanUsagePoolAccount; grant: PlanUsagePoolResetGrant } | null {
  if (!pool || pool.stale || !pool.resets_supported) return null
  const candidates: {
    account: PlanUsagePoolAccount
    grant: PlanUsagePoolResetGrant
    held: boolean
  }[] = []
  for (const account of pool.accounts) {
    if (account.provider || !account.enabled) continue
    const state = stateOf(account)
    const grant = poolResetToUse(pool, account, state, now)
    if (grant)
      candidates.push({ account, grant, held: HELD_BY_LIMIT.has(state) })
  }
  candidates.sort((a, b) => {
    if (a.held !== b.held) return a.held ? -1 : 1
    return (
      (a.grant.expires_at ?? Number.MAX_SAFE_INTEGER) -
      (b.grant.expires_at ?? Number.MAX_SAFE_INTEGER)
    )
  })
  const first = candidates[0]
  return first ? { account: first.account, grant: first.grant } : null
}

const POOL_REFILLS_KEYS = {
  session: "pool.resets.refills.session",
  weekly: "pool.resets.refills.weekly",
  full: "pool.resets.refills.full",
  other: "pool.resets.refills.other",
} as const satisfies Record<LimitResetKind, string>

/** What a pool account's grant refills, for its confirmation ("the weekly
 *  limit"). */
export function poolRefillsKey(
  kind: LimitResetKind
): (typeof POOL_REFILLS_KEYS)[LimitResetKind] {
  return POOL_REFILLS_KEYS[kind] ?? POOL_REFILLS_KEYS.other
}

const POOL_OUTCOME_KEYS = {
  reset: "pool.resets.outcome.reset",
  already_used: "pool.resets.outcome.alreadyUsed",
  unconfirmed: "pool.resets.outcome.unconfirmed",
} as const satisfies Record<PlanUsagePoolResetOutcome, string>

export function poolResetOutcomeKey(
  outcome: PlanUsagePoolResetOutcome
): (typeof POOL_OUTCOME_KEYS)[PlanUsagePoolResetOutcome] {
  return POOL_OUTCOME_KEYS[outcome]
}

const POOL_ERROR_KEYS = [
  "pool.resets.error.recentlyUsed",
  "pool.resets.error.inProgress",
  "pool.resets.error.cooldown",
  "pool.resets.error.noUsableReset",
  "pool.resets.error.notEligible",
  "pool.resets.error.disabled",
  "pool.resets.error.needsLogin",
  "pool.resets.error.noAccount",
  "pool.resets.error.tooSoon",
  "pool.resets.error.failed",
  "pool.resets.error.unsupported",
  "pool.resets.error.unreachable",
] as const

export type PoolResetErrorKey = (typeof POOL_ERROR_KEYS)[number]

/** The `PlanUsage` key a failed pool redeem or recheck carries, if it is one
 *  of these. */
export function poolResetErrorKey(
  i18nKey: string | null | undefined
): PoolResetErrorKey | null {
  const known: readonly string[] = POOL_ERROR_KEYS
  return i18nKey != null && known.includes(i18nKey)
    ? (i18nKey as PoolResetErrorKey)
    : null
}
