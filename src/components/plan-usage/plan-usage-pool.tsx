"use client"

import { useLocale, useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import {
  formatCompactDuration,
  hasWindowReset,
  isPoolStale,
  poolAccountProbeWarning,
  poolAccountState,
  poolExhaustion,
  poolNextReset,
  poolUsageLevel,
  servingAccount,
  splitPercent,
} from "@/lib/plan-usage"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolAccountState,
  PlanUsageWindow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  LEVEL_TEXT,
  useWindowTitle,
  WindowResetText,
  WindowUsageBar,
} from "./plan-usage-parts"

/**
 * The account pool's reading — every account the agent's requests are spread
 * over, with its windows, whether it is the one serving, and why it may be
 * held back. Shared by the Subscription usage page and the status-bar
 * preview; `compact` is the preview's denser layout.
 */

/** States worth a badge; `available` gets none. */
type HeldState = Exclude<PlanUsagePoolAccountState, "available">

const STATE_BADGE: Record<HeldState, string> = {
  disabled: "text-muted-foreground",
  failing: "border-destructive/50 text-destructive",
  exhausted: "border-destructive/50 text-destructive",
  at_threshold: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  cooling_down: "border-amber-500/40 text-amber-700 dark:text-amber-400",
}

/** Why the pool can't be read, in a few words. */
export function usePoolErrorText(pool: PlanUsagePool): string {
  const t = useTranslations("PlanUsage.pool.error")
  switch (pool.error) {
    case "timeout":
      return t("timeout")
    case "unauthorized":
      return t("unauthorized")
    case "http_status":
      return t("http_status", { status: String(pool.error_status ?? "?") })
    case "invalid_response":
      return t("invalid_response")
    case "config_unreadable":
      return t("config_unreadable")
    default:
      return t("unreachable")
  }
}

/** "2 accounts · backup serving · next reset in 1h 12m". */
export function PoolSummaryLine({
  pool,
  now,
  className,
}: {
  pool: PlanUsagePool
  now: number
  className?: string
}) {
  const t = useTranslations("PlanUsage.pool")
  const locale = useLocale()
  const serving = servingAccount(pool)
  const nextReset = poolNextReset(pool, now)
  const parts = [
    <span key="count">{t("accounts", { count: pool.accounts.length })}</span>,
    serving?.serving ? (
      <span key="serving">
        {t.rich("serving", {
          name: serving.name,
          b: (chunks) => <bdi className="font-medium">{chunks}</bdi>,
        })}
      </span>
    ) : (
      <span key="serving">{t("noneServing")}</span>
    ),
  ]
  if (nextReset != null) {
    parts.push(
      <span key="reset">
        {t("nextReset", {
          duration: formatCompactDuration(nextReset - now, locale),
        })}
      </span>
    )
  }
  return (
    <p
      data-slot="pool-summary"
      className={cn("text-xs text-muted-foreground", className)}
    >
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <span aria-hidden="true">{" · "}</span>}
          {part}
        </span>
      ))}
    </p>
  )
}

/** Every account held back, or the pool not answering. */
export function PoolNotices({
  pool,
  now,
  compact = false,
}: {
  pool: PlanUsagePool
  now: number
  compact?: boolean
}) {
  const t = useTranslations("PlanUsage.pool")
  const locale = useLocale()
  const errorText = usePoolErrorText(pool)
  const { exhausted, resumesAt } = poolExhaustion(pool, now)
  const box = compact
    ? "text-[0.6875rem]"
    : "rounded-lg border px-3 py-2 text-xs leading-relaxed"
  return (
    <>
      {exhausted && (
        <p
          role="status"
          data-slot="pool-exhausted"
          className={cn(
            box,
            "text-destructive",
            !compact && "border-destructive/40 bg-destructive/5"
          )}
        >
          {resumesAt != null
            ? t("allExhausted", {
                duration: formatCompactDuration(resumesAt - now, locale),
              })
            : t("allExhaustedUnknown")}
        </p>
      )}
      {pool.stale && (
        <p
          data-slot="pool-stale"
          className={cn(
            box,
            "text-muted-foreground",
            !compact && "border-border bg-muted/30"
          )}
        >
          {t("staleNotice", {
            error: errorText,
            duration: formatCompactDuration(
              Math.max(0, now - (pool.observed_at ?? pool.checked_at)),
              locale
            ),
          })}
        </p>
      )}
    </>
  )
}

/** A configured pool that never answered: said beside the agent's own
 *  reading, which stands in for it. */
export function UnansweredPoolNotice({
  pool,
  compact = false,
}: {
  pool: PlanUsagePool
  compact?: boolean
}) {
  const t = useTranslations("PlanUsage.pool")
  const errorText = usePoolErrorText(pool)
  return (
    <p
      data-slot="pool-unanswered"
      className={cn(
        "text-muted-foreground",
        compact
          ? "mt-1 text-[0.6875rem]"
          : "mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed"
      )}
    >
      {t("unansweredNotice", { error: errorText })}
    </p>
  )
}

export function PoolAccountList({
  pool,
  now,
  compact = false,
}: {
  pool: PlanUsagePool
  now: number
  compact?: boolean
}) {
  const stale = isPoolStale(pool, now)
  return (
    <ul
      data-slot="pool-accounts"
      className={cn(
        compact ? "space-y-2.5" : "space-y-3",
        stale && "opacity-70"
      )}
    >
      {pool.accounts.map((account) => (
        <PoolAccountRow
          key={account.name}
          account={account}
          pool={pool}
          now={now}
          compact={compact}
        />
      ))}
    </ul>
  )
}

function PoolAccountRow({
  account,
  pool,
  now,
  compact,
}: {
  account: PlanUsagePoolAccount
  pool: PlanUsagePool
  now: number
  compact: boolean
}) {
  const t = useTranslations("PlanUsage.pool")
  const locale = useLocale()
  const state = poolAccountState(account, now)
  const held = state !== "available" ? state : null
  const backIn =
    held != null &&
    held !== "disabled" &&
    account.blocked_until != null &&
    account.blocked_until > now
      ? account.blocked_until - now
      : null
  const stateHint =
    held === "at_threshold"
      ? t("stateHint.at_threshold", {
          threshold: Math.round(pool.switch_threshold),
        })
      : held
        ? t(`stateHint.${held}`)
        : undefined
  const badge = compact ? "h-4 px-1.5 text-[0.625rem]" : undefined
  const muted = state === "disabled"
  const probeText = useProbeWarningText(account, now)

  return (
    <li
      data-account={account.name}
      data-state={state}
      data-serving={account.serving ? "true" : undefined}
      className={cn(
        !compact && "rounded-lg border border-border px-3 py-2.5",
        !compact && account.serving && "border-primary/40 bg-primary/[0.03]"
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <bdi
          className={cn(
            "min-w-0 truncate font-medium",
            compact ? "text-xs" : "text-sm",
            muted && "text-muted-foreground"
          )}
        >
          {account.name}
        </bdi>
        {account.serving && (
          <Badge variant="default" className={badge}>
            {t("servingBadge")}
          </Badge>
        )}
        {account.preferred && (
          <Badge variant="secondary" className={badge}>
            {t("preferredBadge")}
          </Badge>
        )}
        {held && (
          <Badge
            variant="outline"
            title={stateHint}
            className={cn(badge, STATE_BADGE[held])}
          >
            {t(`state.${held}`)}
          </Badge>
        )}
        {backIn != null && (
          <span className="ms-auto text-[0.6875rem] text-muted-foreground tabular-nums">
            {t("backIn", { duration: formatCompactDuration(backIn, locale) })}
          </span>
        )}
      </div>
      {account.refresh_failed && (
        <p className="mt-1 text-[0.6875rem] text-destructive">
          {t("signInFailed")}
        </p>
      )}
      {probeText && (
        <p
          data-slot="probe-failing"
          className="mt-1 text-[0.6875rem] text-amber-700 dark:text-amber-400"
        >
          {probeText}
        </p>
      )}
      {account.windows.length > 0 ? (
        <ul
          className={cn(
            compact ? "mt-1 space-y-1.5" : "mt-2 space-y-2.5",
            muted && "opacity-60"
          )}
        >
          {account.windows.map((limit) => (
            <PoolWindowRow
              key={limit.id}
              limit={limit}
              threshold={pool.switch_threshold}
              now={now}
              compact={compact}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[0.6875rem] text-muted-foreground">
          {t("noWindows")}
        </p>
      )}
    </li>
  )
}

/** "Usage last updated 14m ago — usage check failing (HTTP 429)", once the
 *  account's numbers have gone stale while its usage check fails; `null`
 *  while they are fresh. */
function useProbeWarningText(
  account: PlanUsagePoolAccount,
  now: number
): string | null {
  const t = useTranslations("PlanUsage.pool")
  const locale = useLocale()
  const warning = poolAccountProbeWarning(account, now)
  if (!warning) return null
  const status = account.probe_error_status
  if (warning.age == null) {
    return status != null
      ? t("probeFailingStatus", { status })
      : t("probeFailing")
  }
  const duration = formatCompactDuration(warning.age, locale)
  return status != null
    ? t("probeStaleStatus", { status, duration })
    : t("probeStale", { duration })
}

function PoolWindowRow({
  limit,
  threshold,
  now,
  compact,
}: {
  limit: PlanUsageWindow
  threshold: number
  now: number
  compact: boolean
}) {
  const t = useTranslations("PlanUsage")
  const title = useWindowTitle(limit)
  const { used, left } = splitPercent(limit.used_percent)
  const reset = hasWindowReset(limit, now)
  const level = reset ? "normal" : poolUsageLevel(limit.used_percent, threshold)
  return (
    <li data-window={limit.id} data-level={level}>
      <div
        className={cn(
          "flex items-baseline justify-between gap-2",
          compact ? "text-[0.6875rem]" : "text-xs"
        )}
      >
        <span className="min-w-0 truncate">{title}</span>
        <span
          className={cn(
            "shrink-0 font-mono tabular-nums",
            reset ? "text-muted-foreground" : LEVEL_TEXT[level]
          )}
        >
          {t("used", { percent: used })}
        </span>
      </div>
      <WindowUsageBar
        limit={limit}
        title={title}
        now={now}
        level={level}
        className={compact ? "mt-1 h-1" : "mt-1 h-1.5"}
      />
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[0.6875rem] text-muted-foreground">
        {compact ? (
          <span />
        ) : (
          <span className="tabular-nums">{t("left", { percent: left })}</span>
        )}
        <span className="text-end">
          <WindowResetText limit={limit} now={now} />
        </span>
      </div>
    </li>
  )
}
