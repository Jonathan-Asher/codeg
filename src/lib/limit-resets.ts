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

/** The kinds a Codex reset comes in; one model's own weekly limit is a
 *  pool grant's alone, and reads as `other` here. */
type CodexResetKind = Exclude<LimitResetKind, "model_weekly">

const KIND_KEYS = {
  session: "resets.kind.session",
  weekly: "resets.kind.weekly",
  full: "resets.kind.full",
  other: "resets.kind.other",
} as const satisfies Record<CodexResetKind, string>

/** A reset's name when the provider gives none. */
export function resetKindKey(
  kind: LimitResetKind
): (typeof KIND_KEYS)[CodexResetKind] {
  return kind === "model_weekly"
    ? KIND_KEYS.other
    : (KIND_KEYS[kind] ?? KIND_KEYS.other)
}

const REFILLS_KEYS = {
  session: "resets.refills.session",
  weekly: "resets.refills.weekly",
  full: "resets.refills.full",
  other: "resets.refills.other",
} as const satisfies Record<CodexResetKind, string>

/** What a reset refills, for the confirmation ("your weekly limit"). */
export function resetRefillsKey(
  kind: LimitResetKind
): (typeof REFILLS_KEYS)[CodexResetKind] {
  return kind === "model_weekly"
    ? REFILLS_KEYS.other
    : (REFILLS_KEYS[kind] ?? REFILLS_KEYS.other)
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

/** An account's limits that hold every request back, whatever its model:
 *  the 5-hour window and the general weekly one. A model's own weekly
 *  window (`seven_day_<family>`) holds back only that model's requests. */
const GENERAL_WINDOWS: ReadonlySet<string> = new Set(["five_hour", "seven_day"])

/** The window a model family's own weekly limit has in a pool reading. */
export function modelWindowId(family: string): string {
  return `seven_day_${family}`
}

/** The model family a session's model belongs to, for the limits that hold
 *  back only that model's requests — read the way the pool reads a
 *  request's model (`claude-fable-5-1` is `fable`). `null` for a model it
 *  names no family for, or none. */
export function modelFamilyOf(model: string | null | undefined): string | null {
  const id = (model ?? "").toLowerCase()
  if (id.includes("fable") || id.includes("mythos")) return "fable"
  if (id.includes("opus")) return "opus"
  if (id.includes("sonnet")) return "sonnet"
  if (id.includes("haiku")) return "haiku"
  return null
}

/** The windows a pool account is at its limit in now (ids in its
 *  `windows`): what its last reading found, less any window that has reset
 *  since. */
export function poolLimitsReached(
  account: PlanUsagePoolAccount,
  now: number
): string[] {
  return (account.resets?.limits_reached ?? []).filter((id) => {
    const resetsAt = account.windows.find((w) => w.id === id)?.resets_at
    return resetsAt == null || resetsAt > now
  })
}

/** Whether a grant can go to the pool now: the pool lists resets, the
 *  account takes them (enabled, offered resets, no cooldown), the grant is
 *  usable, in date and known to refill something — and, for one that only
 *  works at a limit, the account is at one (`atLimit`). */
function poolGrantUsable(
  pool: PlanUsagePool,
  account: PlanUsagePoolAccount,
  grant: PlanUsagePoolResetGrant,
  now: number,
  atLimit: boolean
): boolean {
  const resets = account.resets
  if (!pool.resets_supported || !resets || !account.enabled) return false
  if (account.provider || resets.eligible === false) return false
  if (resets.cooldown_until != null && resets.cooldown_until > now) return false
  return (
    grant.usable_now &&
    grant.count > 0 &&
    grant.refills.length > 0 &&
    (grant.expires_at == null || grant.expires_at > now) &&
    (!grant.requires_limit || atLimit)
  )
}

/** The grant a "Use reset" takes on a pool account, from `grants` (all of
 *  the account's by default): the provider's next one when it can be used,
 *  else the usable one that expires first. A grant that only works at a
 *  limit is skipped while the account isn't held by one, and one whose
 *  refill isn't known is never taken. `null` when none can be used now. */
export function poolResetToUse(
  pool: PlanUsagePool,
  account: PlanUsagePoolAccount,
  state: PlanUsagePoolAccountState,
  now: number,
  grants?: PlanUsagePoolResetGrant[]
): PlanUsagePoolResetGrant | null {
  const resets = account.resets
  if (!resets) return null
  const atLimit = HELD_BY_LIMIT.has(state)
  const usable = (grants ?? resets.grants).filter((g) =>
    poolGrantUsable(pool, account, g, now, atLimit)
  )
  return usable.find((g) => g.id === resets.next_grant_id) ?? usable[0] ?? null
}

/** How a grant stands against the limits its account is at now. */
export type PoolGrantFit =
  /** Nothing against using it. */
  | { kind: "fits" }
  /** What it refills isn't known: it is shown, never used from here. */
  | { kind: "unknown" }
  /** It refills only one model's own weekly limit while the account is at a
   *  limit every request meets — its general weekly limit, else its 5-hour
   *  one (`limit`): using it gains nothing now. */
  | { kind: "wont_help"; model: string; limit: "weekly" | "session" }
  /** The same at the general weekly limit alone, for a grant that also gives
   *  back what the model used of it this week: it frees up that much, and
   *  no more. */
  | { kind: "gives_back_only"; model: string }

export function poolGrantFit(
  account: PlanUsagePoolAccount,
  grant: PlanUsagePoolResetGrant,
  now: number
): PoolGrantFit {
  if (grant.refills.length === 0) return { kind: "unknown" }
  if (grant.kind !== "model_weekly") return { kind: "fits" }
  const general = poolLimitsReached(account, now).filter((id) =>
    GENERAL_WINDOWS.has(id)
  )
  if (general.length === 0) return { kind: "fits" }
  const model = grant.model ?? ""
  // What the model used this week, as its own weekly window reads it; a
  // model without one (its limit not in effect) has nothing measured.
  const modelUsed = grant.refills.some(
    (id) => (account.windows.find((w) => w.id === id)?.used_percent ?? 0) > 0
  )
  if (
    grant.gives_back_weekly &&
    modelUsed &&
    general.length === 1 &&
    general[0] === "seven_day"
  ) {
    return { kind: "gives_back_only", model }
  }
  return {
    kind: "wont_help",
    model,
    limit: general.includes("seven_day") ? "weekly" : "session",
  }
}

/** A pool account's grants of one kind (and model), shown as one row. */
export interface PoolResetGroup {
  key: string
  kind: LimitResetKind
  /** The model family of a `model_weekly` row ("Fable"). */
  model: string | null
  /** Resets left over its grants. */
  count: number
  /** The soonest expiry among them (epoch seconds). */
  expires_at: number | null
  /** Its grants, soonest to expire first. */
  grants: PlanUsagePoolResetGrant[]
}

/** A pool account's grants by what they refill, in the order the first of
 *  each kind appears (the pool lists them soonest to expire first). */
export function poolResetGroups(
  account: PlanUsagePoolAccount
): PoolResetGroup[] {
  const groups: PoolResetGroup[] = []
  for (const grant of account.resets?.grants ?? []) {
    if (grant.count <= 0) continue
    const model = grant.kind === "model_weekly" ? (grant.model ?? null) : null
    const key = `${grant.kind}|${model ?? ""}`
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = {
        key,
        kind: grant.kind,
        model,
        count: 0,
        expires_at: null,
        grants: [],
      }
      groups.push(group)
    }
    group.count += grant.count
    group.grants.push(grant)
    if (
      grant.expires_at != null &&
      (group.expires_at == null || grant.expires_at < group.expires_at)
    ) {
      group.expires_at = grant.expires_at
    }
  }
  return groups
}

const POOL_GROUP_KEYS = {
  session: "pool.resets.group.session",
  weekly: "pool.resets.group.weekly",
  model_weekly: "pool.resets.group.modelWeekly",
  full: "pool.resets.group.full",
  other: "pool.resets.group.other",
} as const satisfies Record<LimitResetKind, string>

/** A row of a pool account's resets: how many, and what each refills ("1
 *  Fable reset · refills only your Fable weekly limit"). Takes `count` and,
 *  for a model's own reset, `model`. */
export function poolResetGroupKey(
  kind: LimitResetKind
): (typeof POOL_GROUP_KEYS)[LimitResetKind] {
  return POOL_GROUP_KEYS[kind] ?? POOL_GROUP_KEYS.other
}

/** For a session paused at its usage limit: the account and grant whose
 *  reset clears what stopped it — an account held back by its limits, and a
 *  grant that refills every one of them. A model's own weekly limit counts
 *  only for a session on that model (`modelFamily`); a grant that refills
 *  only some of the limits, or none (one model's limit while the general
 *  weekly one holds the account), is never offered, nor one on an account
 *  whose limit renews by itself soon (the pool holds those back). Of those
 *  that clear it, the pool's own pick goes first ({@link
 *  poolPicksGrant}), then the grant that refills the least beyond what
 *  holds the account, then the one that expires first. `null` when no reset
 *  clears it. */
export function poolResetForPause(
  pool: PlanUsagePool | null,
  now: number,
  modelFamily: string | null = null
): { account: PlanUsagePoolAccount; grant: PlanUsagePoolResetGrant } | null {
  if (!pool || pool.stale || !pool.resets_supported) return null
  const modelWindow = modelFamily ? modelWindowId(modelFamily) : null
  const candidates: {
    account: PlanUsagePoolAccount
    grant: PlanUsagePoolResetGrant
    picked: boolean
    beyond: number
  }[] = []
  for (const account of pool.accounts) {
    if (account.provider || !account.enabled) continue
    if (account.resets?.renews_soon) continue
    const holding = poolLimitsReached(account, now).filter(
      (id) => GENERAL_WINDOWS.has(id) || id === modelWindow
    )
    if (holding.length === 0) continue
    for (const grant of account.resets?.grants ?? []) {
      if (!poolGrantUsable(pool, account, grant, now, true)) continue
      if (!holding.every((id) => grant.refills.includes(id))) continue
      candidates.push({
        account,
        grant,
        picked: poolPicksGrant(account, grant),
        beyond: grant.refills.length - holding.length,
      })
    }
  }
  candidates.sort(
    (a, b) =>
      Number(b.picked) - Number(a.picked) ||
      a.beyond - b.beyond ||
      (a.grant.expires_at ?? Number.MAX_SAFE_INTEGER) -
        (b.grant.expires_at ?? Number.MAX_SAFE_INTEGER)
  )
  const first = candidates[0]
  return first ? { account: first.account, grant: first.grant } : null
}

// ─── The pool's advice on using them ────────────────────────────────────

/** Whether the pool would use this grant on the account now: it recommends
 *  the account (and its limit doesn't renew by itself soon), and names this
 *  grant or none. */
export function poolPicksGrant(
  account: PlanUsagePoolAccount,
  grant: PlanUsagePoolResetGrant
): boolean {
  const resets = account.resets
  if (!resets?.recommended || resets.renews_soon) return false
  const id = resets.recommended_grant_id ?? null
  return id == null || id === grant.id
}

/** The grant the pool would use on an account now, for "Reset available":
 *  the one it names, else the provider's next, else the usable one that
 *  expires first — only one that can be used now and helps. `null` when
 *  the pool doesn't recommend the account, or recommends a grant this
 *  reading can't use. */
export function poolRecommendedGrant(
  pool: PlanUsagePool,
  account: PlanUsagePoolAccount,
  now: number
): PlanUsagePoolResetGrant | null {
  const resets = account.resets
  if (!resets?.recommended || resets.renews_soon) return null
  // The pool recommends only an account at its limit.
  const usable = resets.grants.filter(
    (g) =>
      poolGrantUsable(pool, account, g, now, true) &&
      poolGrantFit(account, g, now).kind !== "wont_help"
  )
  const id = resets.recommended_grant_id ?? null
  if (id != null) return usable.find((g) => g.id === id) ?? null
  return usable.find((g) => g.id === resets.next_grant_id) ?? usable[0] ?? null
}

/** Each account the pool would use a reset on now, with the grant, in the
 *  pool's order. Empty for a pool that doesn't list resets or isn't
 *  answering. */
export function poolResetRecommendations(
  pool: PlanUsagePool | null,
  now: number
): { account: PlanUsagePoolAccount; grant: PlanUsagePoolResetGrant }[] {
  if (!pool || pool.stale || !pool.resets_supported) return []
  const out: {
    account: PlanUsagePoolAccount
    grant: PlanUsagePoolResetGrant
  }[] = []
  for (const account of pool.accounts) {
    if (account.provider || !account.enabled) continue
    const grant = poolRecommendedGrant(pool, account, now)
    if (grant) out.push({ account, grant })
  }
  return out
}

/** The pool says the limit the account is at renews by itself within its
 *  claim guard: it holds a reset back unless asked to go ahead. */
export function poolRenewsSoon(account: PlanUsagePoolAccount): boolean {
  return account.resets?.renews_soon === true
}

/** A limit as the pool names it (`general`, `session`, a model family), as
 *  the window it is in the account's reading. */
function wallWindowId(wall: string): string {
  if (wall === "general") return "seven_day"
  if (wall === "session") return "five_hour"
  return modelWindowId(wall)
}

/** When the limits an account is at renew by themselves (epoch seconds):
 *  the last of them, as its reading has them — the general weekly one as
 *  the pool says, when it does. The limits are the pool's (`wall`), else
 *  those the reading finds reached. `null` when not known. */
export function poolRenewsAt(
  account: PlanUsagePoolAccount,
  now: number
): number | null {
  const resets = account.resets
  if (!resets) return null
  const ids = resets.wall?.length
    ? resets.wall.map(wallWindowId)
    : poolLimitsReached(account, now)
  let latest: number | null = null
  for (const id of ids) {
    const fromReading = account.windows.find((w) => w.id === id)?.resets_at
    const at =
      id === "seven_day"
        ? (resets.weekly_renews_at ?? fromReading)
        : fromReading
    if (at != null && at > now && (latest == null || at > latest)) latest = at
  }
  return latest
}

const POOL_REFILLS_KEYS = {
  session: "pool.resets.refills.session",
  weekly: "pool.resets.refills.weekly",
  full: "pool.resets.refills.full",
  other: "pool.resets.refills.other",
} as const satisfies Record<Exclude<LimitResetKind, "model_weekly">, string>

/** What a pool account's grant refills, for its confirmation ("the weekly
 *  limit"). A model's own reset has a sentence of its own. */
export function poolRefillsKey(
  kind: Exclude<LimitResetKind, "model_weekly">
): (typeof POOL_REFILLS_KEYS)[Exclude<LimitResetKind, "model_weekly">] {
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
  "pool.resets.error.renewsSoon",
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
