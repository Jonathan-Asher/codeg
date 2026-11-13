"use client"

import type { ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Gauge,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { useLimitResets } from "@/hooks/use-limit-resets"
import { usePlanUsageReport } from "@/hooks/use-plan-usage-report"
import { getAgentLabel } from "@/lib/custom-agents"
import { findProviderResets } from "@/lib/limit-resets"
import {
  activePool,
  findSnapshot,
  formatAbsoluteTime,
  formatCompactDuration,
  hasWindowReset,
  isPoolStale,
  isSnapshotStale,
  PLAN_USAGE_AGENTS,
  splitPercent,
  unansweredPool,
  windowLagSince,
} from "@/lib/plan-usage"
import type {
  PlanUsageAgent,
  PlanUsagePool,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
  ProviderLimitResets,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  useEmptyCopy,
  useNowSeconds,
  useUpdatedLabel,
  useWindowTitle,
  WindowResetText,
  WindowUsageBar,
} from "./plan-usage-parts"
import {
  ClaudeResetsElsewhere,
  ProviderResetsSection,
} from "./plan-usage-resets"
import {
  PoolAccountList,
  PoolNotices,
  PoolRoutingLine,
  PoolSummaryLine,
  UnansweredPoolNotice,
} from "./plan-usage-pool"
import {
  PoolAddAccountButton,
  PoolReloadNotice,
  usePoolManage,
} from "./plan-usage-pool-manage"
import { PoolResetRecommendations } from "./plan-usage-pool-resets"

/** How often relative times ("resets in 2h 14m") re-render. */
const TICK_MS = 30_000

/** Status badges worth showing; `ok` gets none. */
const STATUS_KEYS = {
  limited: "status.limited",
  warning: "status.warning",
  overage: "status.overage",
} as const

const STATUS_VARIANT = {
  limited: "destructive",
  warning: "outline",
  overage: "outline",
} as const

/** Page title in the window-chrome strip — the shared breadcrumb header. */
export function PlanUsagePageTitle() {
  const t = useTranslations("PlanUsage")
  return <WorkbenchPageTitle title={t("title")} />
}

/**
 * The Subscription usage route: one card per provider, one bar per limit
 * window. Claude Code's numbers arrive live (pushed during a turn) and
 * survive restarts via the backend's saved copy; Codex's come from its newest
 * session log and are re-read on Refresh. Behind a local account pool the
 * Claude Code card lists every account in it instead, from the pool's own
 * status, and keeps the live reading folded away beneath them.
 */
export function PlanUsagePage() {
  const t = useTranslations("PlanUsage")
  const { report, loading, refreshing, error, load } = usePlanUsageReport()
  const resets = useLimitResets()
  const now = useNowSeconds(TICK_MS)

  const showCards = report != null || (!loading && error == null)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="h-full">
        <div className="p-4">
          <div className="mx-auto w-full max-w-4xl space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                {t("subtitle")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={refreshing || resets.refreshing}
                onClick={() => {
                  void load(true)
                  void resets.load(true)
                }}
              >
                <RefreshCw
                  className={cn(
                    "size-3.5",
                    (refreshing || resets.refreshing) && "animate-spin"
                  )}
                  aria-hidden="true"
                />
                {t("refresh")}
              </Button>
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {t("loadFailed")}: {error}
              </p>
            )}

            {loading && report == null ? (
              <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
                <div className="h-56 animate-pulse rounded-xl border border-border bg-muted/40" />
                <div className="h-56 animate-pulse rounded-xl border border-border bg-muted/40" />
              </div>
            ) : showCards ? (
              <div className="grid items-start gap-4 md:grid-cols-2">
                {PLAN_USAGE_AGENTS.map((agent) => (
                  <ProviderCard
                    key={agent}
                    agent={agent}
                    snapshot={findSnapshot(report, agent)}
                    report={report}
                    now={now}
                    onPoolChanged={() => void load(true)}
                    resets={findProviderResets(resets.report, agent)}
                    resetsLoading={resets.loading}
                    onResetUsed={() => void load(true)}
                  />
                ))}
              </div>
            ) : null}

            <p className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
              <ShieldCheck
                className="mt-0.5 size-3 shrink-0"
                aria-hidden="true"
              />
              <span>
                {t("privacyNote")}
                {report?.pool != null && <> {t("pool.privacyNote")}</>}
              </span>
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

function ProviderCard({
  agent,
  snapshot,
  report,
  now,
  onPoolChanged,
  resets,
  resetsLoading,
  onResetUsed,
}: {
  agent: PlanUsageAgent
  snapshot: PlanUsageSnapshot | null
  report: PlanUsageReport | null
  now: number
  onPoolChanged?: () => void
  /** The agent's usage-limit resets, once listed. */
  resets: ProviderLimitResets | null
  resetsLoading: boolean
  /** A reset was used: re-read the bars. */
  onResetUsed?: () => void
}) {
  const t = useTranslations("PlanUsage")
  const label = getAgentLabel(agent)
  const hasData = snapshot != null && snapshot.windows.length > 0
  const stale = hasData && isSnapshotStale(snapshot, now)
  const statusKey =
    hasData && !stale && snapshot.status && snapshot.status in STATUS_KEYS
      ? (snapshot.status as keyof typeof STATUS_KEYS)
      : null
  // Claude Code's own resets are used in its apps; a pool's accounts show
  // theirs on their rows, where the pool can use them.
  const resetsSection =
    agent === "claude_code" ? (
      <ClaudeResetsElsewhere />
    ) : (
      <ProviderResetsSection
        agent={agent}
        resets={resets}
        loading={resetsLoading}
        now={now}
        onUsed={onResetUsed}
      />
    )
  const pool = activePool(report)
  if (pool && pool.agent === agent) {
    return (
      <PoolProviderCard
        agent={agent}
        label={label}
        pool={pool}
        snapshot={hasData ? snapshot : null}
        now={now}
        onPoolChanged={onPoolChanged}
        resetsSection={
          agent === "claude_code" && pool.resets_supported
            ? undefined
            : resetsSection
        }
      />
    )
  }
  const unanswered = unansweredPool(report)

  return (
    <section
      aria-label={label}
      data-agent={agent}
      className="flex flex-col rounded-xl border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <AgentIcon agentType={agent} className="size-4" />
        <h2 className="text-[0.8125rem] font-semibold">{label}</h2>
        {hasData && snapshot.plan_label && (
          <Badge variant="secondary" title={t("planTitle")}>
            {snapshot.plan_label}
          </Badge>
        )}
        {statusKey && (
          <Badge
            variant={STATUS_VARIANT[statusKey]}
            className={cn(
              statusKey !== "limited" &&
                "border-amber-500/40 text-amber-700 dark:text-amber-400"
            )}
          >
            {t(STATUS_KEYS[statusKey])}
          </Badge>
        )}
        {stale && (
          <Badge
            variant="outline"
            title={t("staleHint")}
            className="text-muted-foreground"
          >
            {t("stale")}
          </Badge>
        )}
      </header>

      {unanswered && unanswered.agent === agent && (
        <UnansweredPoolNotice pool={unanswered} />
      )}
      {hasData ? (
        <>
          <ObservedLine snapshot={snapshot} now={now} />
          <ul className="mt-4 space-y-4">
            {snapshot.windows.map((limit) => (
              <WindowRow
                key={limit.id}
                limit={limit}
                snapshot={snapshot}
                now={now}
              />
            ))}
          </ul>
        </>
      ) : (
        <EmptyState agent={agent} report={report} />
      )}
      {resetsSection}
    </section>
  )
}

/**
 * The card behind an account pool: every account with its windows, which
 * one serves, and why any is held back. The agent's own reading describes
 * whichever account served last, so it is folded away underneath.
 */
function PoolProviderCard({
  agent,
  label,
  pool,
  snapshot,
  now,
  onPoolChanged,
  resetsSection,
}: {
  agent: PlanUsageAgent
  label: string
  pool: PlanUsagePool
  snapshot: PlanUsageSnapshot | null
  now: number
  /** Re-read the report after an account change. */
  onPoolChanged?: () => void
  /** The agent's own resets, when the pool's rows don't carry them. */
  resetsSection?: ReactNode
}) {
  const t = useTranslations("PlanUsage")
  const stale = isPoolStale(pool, now)
  const { info: manage, reload: reloadManage } = usePoolManage(pool)
  const managed = manage?.available
    ? () => {
        reloadManage()
        onPoolChanged?.()
      }
    : undefined
  return (
    <section
      aria-label={label}
      data-agent={agent}
      data-pool={pool.kind}
      className="flex flex-col rounded-xl border border-border bg-card p-4"
    >
      <header className="flex flex-wrap items-center gap-2">
        <AgentIcon agentType={agent} className="size-4" />
        <h2 className="text-[0.8125rem] font-semibold">{label}</h2>
        <Badge
          variant="secondary"
          title={
            pool.version
              ? t("pool.labelVersion", { version: pool.version })
              : t("pool.labelTitle")
          }
        >
          {t("pool.label")}
        </Badge>
        {stale && (
          <Badge variant="outline" className="text-muted-foreground">
            {t("stale")}
          </Badge>
        )}
        {managed && <PoolAddAccountButton onChanged={managed} />}
      </header>
      <PoolSummaryLine pool={pool} now={now} className="mt-1.5" />
      <PoolRoutingLine pool={pool} className="mt-0.5" />
      <div className="mt-3 space-y-2 empty:hidden">
        {managed && (
          <PoolResetRecommendations pool={pool} now={now} onChanged={managed} />
        )}
        <PoolNotices pool={pool} now={now} />
        {manage?.available && managed && (
          <PoolReloadNotice info={manage} onChanged={managed} />
        )}
      </div>
      <div className="mt-3">
        <PoolAccountList pool={pool} now={now} onManaged={managed} />
      </div>
      {snapshot && (
        <details data-slot="live-reading" className="group mt-4">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3.5 group-open:hidden rtl:-scale-x-100"
              aria-hidden="true"
            />
            <ChevronDown
              className="hidden size-3.5 group-open:block"
              aria-hidden="true"
            />
            {t("pool.liveReading")}
          </summary>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
            {t("pool.liveReadingHint")}
          </p>
          <ObservedLine snapshot={snapshot} now={now} />
          <ul className="mt-3 space-y-4">
            {snapshot.windows.map((limit) => (
              <WindowRow
                key={limit.id}
                limit={limit}
                snapshot={snapshot}
                now={now}
              />
            ))}
          </ul>
        </details>
      )}
      {resetsSection}
    </section>
  )
}

/** When the reading was taken, and where it came from. */
function ObservedLine({
  snapshot,
  now,
}: {
  snapshot: PlanUsageSnapshot
  now: number
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const source =
    snapshot.agent === "codex"
      ? snapshot.source === "live"
        ? t("source.codexLive")
        : t("source.codexLog")
      : snapshot.source === "saved"
        ? t("source.claudeSaved")
        : t("source.claudeLive")
  const updated = useUpdatedLabel(snapshot, now)

  return (
    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
      {updated != null && (
        <>
          <time
            dateTime={new Date(snapshot.observed_at * 1000).toISOString()}
            title={formatAbsoluteTime(snapshot.observed_at, locale, now)}
          >
            {updated}
            {" · "}
            {formatAbsoluteTime(snapshot.observed_at, locale, now)}
          </time>
          <br />
        </>
      )}
      {source}
    </p>
  )
}

function WindowRow({
  limit,
  snapshot,
  now,
}: {
  limit: PlanUsageWindow
  snapshot: PlanUsageSnapshot
  now: number
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const title = useWindowTitle(limit)
  const { used, left } = splitPercent(limit.used_percent)
  const reset = hasWindowReset(limit, now)
  const lagSince = windowLagSince(limit, snapshot)

  return (
    <li data-window={limit.id}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <span
          className={cn(
            "shrink-0 font-mono text-sm tabular-nums",
            reset && "text-muted-foreground"
          )}
        >
          {t("used", { percent: used })}
        </span>
      </div>
      <WindowUsageBar
        limit={limit}
        title={title}
        now={now}
        className="mt-1.5"
      />
      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span className="tabular-nums">{t("left", { percent: left })}</span>
        <span className="text-end">
          <WindowResetText limit={limit} now={now} withAbsolute />
        </span>
      </div>
      {lagSince != null && (
        <p className="mt-0.5 text-[0.6875rem] text-muted-foreground/80">
          {t("windowAsOf", {
            duration: formatCompactDuration(
              Math.max(0, now - lagSince),
              locale
            ),
          })}
        </p>
      )}
    </li>
  )
}

function EmptyState({
  agent,
  report,
}: {
  agent: PlanUsageAgent
  report: PlanUsageReport | null
}) {
  const { title, hint } = useEmptyCopy(agent, report)
  return (
    <div className="mt-3 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <Gauge className="size-8 text-muted-foreground/40" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-xs break-words text-xs leading-relaxed text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}
