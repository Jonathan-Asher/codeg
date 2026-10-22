"use client"

import { useRef, useState, type ReactNode, type Ref } from "react"
import { flushSync } from "react-dom"
import { useLocale, useTranslations } from "next-intl"
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  formatCompactDuration,
  formatHoldEnd,
  hasWindowReset,
  isPoolStale,
  poolAccountProbeWarning,
  poolAccountState,
  poolExhaustion,
  poolNextReset,
  poolOrder,
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
import {
  PoolAccountActions,
  PoolPauseButton,
  PoolReserveButton,
  usePoolOrder,
} from "./plan-usage-pool-manage"

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
  reserved: "border-amber-500/40 text-amber-700 dark:text-amber-400",
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

/** How the pool picks an account for a new request: in order from the top,
 *  automatic balancing, or a mode this client doesn't know by name. Nothing
 *  when the pool doesn't say. */
export function PoolRoutingLine({
  pool,
  className,
}: {
  pool: PlanUsagePool
  className?: string
}) {
  const t = useTranslations("PlanUsage.pool")
  const mode = pool.routing_mode
  const { ordered } = poolOrder(pool)
  if (!mode && !ordered) return null
  const text = ordered
    ? t("routingOrdered")
    : mode === "automatic"
      ? t("routingAutomatic")
      : t("routingOther", { mode: mode ?? "" })
  return (
    <p
      data-slot="pool-routing"
      data-routing={ordered ? "ordered" : (mode ?? undefined)}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {text}
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
  onManaged,
}: {
  pool: PlanUsagePool
  now: number
  compact?: boolean
  /** Offer each account's controls (order, pause, reserve, sign in again,
   *  rename, remove); called after one changed the pool. Only where the host
   *  can run them. */
  onManaged?: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const stale = isPoolStale(pool, now)
  const order = usePoolOrder(pool, onManaged)
  const managed = onManaged != null && !compact
  const inOrder = order.accounts.filter((a) => !a.provider).length
  const rows = useRef<(HTMLLIElement | null)[]>([])
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)

  /** The row in the order under the pointer. */
  const rowAt = (clientY: number) => {
    let over = 0
    rows.current.slice(0, inOrder).forEach((row, index) => {
      if (row && row.getBoundingClientRect().top <= clientY) over = index
    })
    return over
  }
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= inOrder) return
    order.move(from, to)
  }

  return (
    <ul
      data-slot="pool-accounts"
      data-ordered={order.ordered ? "true" : undefined}
      className={cn(
        compact ? "space-y-2.5" : "space-y-3",
        stale && "opacity-70"
      )}
    >
      {order.accounts.map((account, index) => {
        const ordering =
          managed && !account.provider && inOrder > 1
            ? {
                index,
                last: inOrder - 1,
                handle: (
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) handles.current.set(account.name, el)
                      else handles.current.delete(account.name)
                    }}
                    data-slot="pool-order-handle"
                    aria-label={t("dragHandle", { name: account.name })}
                    className="mt-0.5 flex h-5 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      e.preventDefault()
                      e.currentTarget.setPointerCapture?.(e.pointerId)
                      setDrag({ from: index, over: index })
                    }}
                    onPointerMove={(e) => {
                      if (!drag) return
                      const over = rowAt(e.clientY)
                      if (over !== drag.over) setDrag({ ...drag, over })
                    }}
                    onPointerUp={() => {
                      if (drag && drag.over !== drag.from) {
                        move(drag.from, drag.over)
                      }
                      setDrag(null)
                    }}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(e) => {
                      const to =
                        e.key === "ArrowUp"
                          ? index - 1
                          : e.key === "ArrowDown"
                            ? index + 1
                            : e.key === "Home"
                              ? 0
                              : e.key === "End"
                                ? inOrder - 1
                                : null
                      if (to == null) return
                      e.preventDefault()
                      // The handle keeps the focus as its row moves.
                      flushSync(() => move(index, to))
                      handles.current.get(account.name)?.focus()
                    }}
                  >
                    <GripVertical className="size-3.5" aria-hidden="true" />
                  </button>
                ),
                dragging: drag?.from === index,
                dropTarget:
                  drag != null && drag.from !== index && drag.over === index,
                move: (to: number) => move(index, to),
              }
            : undefined
        return (
          <PoolAccountRow
            key={account.name}
            ref={(el) => {
              rows.current[index] = el
            }}
            account={account}
            position={order.ordered && !account.provider ? index + 1 : null}
            pool={pool}
            now={now}
            compact={compact}
            onManaged={managed ? onManaged : undefined}
            ordering={ordering}
            onMoveToTop={
              ordering && index > 0 ? () => move(index, 0) : undefined
            }
            onAutomatic={
              managed && order.ordered && index === 0 ? order.clear : undefined
            }
          />
        )
      })}
    </ul>
  )
}

interface RowOrdering {
  index: number
  last: number
  handle: ReactNode
  dragging: boolean
  dropTarget: boolean
  move: (to: number) => void
}

function PoolAccountRow({
  ref,
  account,
  position,
  pool,
  now,
  compact,
  onManaged,
  ordering,
  onMoveToTop,
  onAutomatic,
}: {
  ref?: Ref<HTMLLIElement>
  account: PlanUsagePoolAccount
  /** Its place in the pool's order, shown when the pool has one. */
  position: number | null
  pool: PlanUsagePool
  now: number
  compact: boolean
  onManaged?: () => void
  ordering?: RowOrdering
  onMoveToTop?: () => void
  onAutomatic?: () => void
}) {
  const t = useTranslations("PlanUsage.pool")
  const tm = useTranslations("PlanUsage.pool.manage")
  const locale = useLocale()
  const state = poolAccountState(account, now)
  const held = state !== "available" ? state : null
  const until =
    held != null &&
    held !== "disabled" &&
    account.blocked_until != null &&
    account.blocked_until > now
      ? account.blocked_until
      : null
  const reserve = account.reserve ?? null
  const stateHint =
    held === "at_threshold"
      ? t("stateHint.at_threshold", {
          threshold: Math.round(pool.switch_threshold),
        })
      : held === "reserved"
        ? t("stateHint.reserved", { percent: reserve?.percent ?? 0 })
        : held
          ? t(`stateHint.${held}`)
          : undefined
  const badge = compact ? "h-4 px-1.5 text-[0.625rem]" : undefined
  const muted = state === "disabled"
  const probeText = useProbeWarningText(account, now)
  // The reserve's line on the windows it holds the account to.
  const reserveAt = reserve ? 100 - reserve.percent : null

  return (
    <li
      ref={ref}
      data-account={account.name}
      data-state={state}
      data-serving={account.serving ? "true" : undefined}
      data-position={position ?? undefined}
      data-dragging={ordering?.dragging ? "true" : undefined}
      className={cn(
        !compact && "rounded-lg border border-border px-3 py-2.5",
        !compact && account.serving && "border-primary/40 bg-primary/[0.03]",
        ordering?.dragging && "opacity-60",
        ordering?.dropTarget && "ring-2 ring-primary/50"
      )}
    >
      <div className="flex items-start gap-1.5">
        {ordering?.handle}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {/* The position and the name stay on one line; a long name
              truncates there, whole in its tooltip. */}
          <span className="flex max-w-full min-w-0 items-baseline gap-1.5">
            {position != null && !compact && (
              <span
                data-slot="pool-position"
                aria-label={t("position", { position })}
                className="text-xs text-muted-foreground tabular-nums"
              >
                {position}
              </span>
            )}
            <bdi
              title={account.name}
              className={cn(
                "min-w-0 truncate font-medium",
                compact ? "text-xs" : "text-sm",
                muted && "text-muted-foreground"
              )}
            >
              {account.name}
            </bdi>
          </span>
          {account.serving && (
            <Badge variant="default" className={badge}>
              {t("servingBadge")}
            </Badge>
          )}
          {compact && account.preferred && (
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
          {until != null && (
            <span
              data-slot="pool-hold-end"
              className="text-[0.6875rem] text-muted-foreground tabular-nums"
            >
              {held === "exhausted"
                ? t("atLimitUntil", {
                    time: formatHoldEnd(until, locale, now),
                  })
                : t("backIn", {
                    duration: formatCompactDuration(until - now, locale),
                  })}
            </span>
          )}
        </div>
        {onManaged && (
          <div className="flex shrink-0 items-center gap-0.5">
            {ordering && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  data-slot="pool-move-up"
                  aria-label={tm("moveUp", { name: account.name })}
                  disabled={ordering.index === 0}
                  onClick={() => ordering.move(ordering.index - 1)}
                >
                  <ChevronUp className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  data-slot="pool-move-down"
                  aria-label={tm("moveDown", { name: account.name })}
                  disabled={ordering.index === ordering.last}
                  onClick={() => ordering.move(ordering.index + 1)}
                >
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </Button>
              </>
            )}
            <PoolPauseButton account={account} onChanged={onManaged} />
            <PoolAccountActions
              account={account}
              onChanged={onManaged}
              onMoveToTop={onMoveToTop}
              onAutomatic={onAutomatic}
            />
          </div>
        )}
      </div>
      {onManaged ? (
        <div className={cn("mt-1.5", ordering && "ps-5")}>
          <PoolReserveButton account={account} onChanged={onManaged} />
        </div>
      ) : (
        reserve &&
        !compact && (
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            {t(
              reserve.mode === "dynamic"
                ? "reserveSummaryDynamic"
                : "reserveSummary",
              { percent: reserve.percent }
            )}
          </p>
        )
      )}
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
              reserveAt={
                limit.id === "five_hour" || limit.id === "seven_day"
                  ? reserveAt
                  : null
              }
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
  reserveAt,
  now,
  compact,
}: {
  limit: PlanUsageWindow
  threshold: number
  /** Percent used where the account's reserve starts, drawn on the bar. */
  reserveAt: number | null
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
      <div className="relative">
        <WindowUsageBar
          limit={limit}
          title={title}
          now={now}
          level={level}
          className={compact ? "mt-1 h-1" : "mt-1 h-1.5"}
        />
        {reserveAt != null && (
          <span
            data-slot="reserve-line"
            data-at={reserveAt}
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
            // The bar fills from the left in every direction.
            style={{ left: `${reserveAt}%` }}
          />
        )}
      </div>
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
