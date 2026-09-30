"use client"

import { useLocale, useTranslations } from "next-intl"
import { Gauge, RefreshCw, ShieldCheck } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { usePlanUsageReport } from "@/hooks/use-plan-usage-report"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  findSnapshot,
  formatAbsoluteTime,
  formatCompactDuration,
  hasWindowReset,
  isSnapshotStale,
  PLAN_USAGE_AGENTS,
  splitPercent,
  windowLagSince,
} from "@/lib/plan-usage"
import type {
  PlanUsageAgent,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
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
 * session log and are re-read on Refresh.
 */
export function PlanUsagePage() {
  const t = useTranslations("PlanUsage")
  const { report, loading, refreshing, error, load } = usePlanUsageReport()
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
                disabled={refreshing}
                onClick={() => void load(true)}
              >
                <RefreshCw
                  className={cn("size-3.5", refreshing && "animate-spin")}
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
                  />
                ))}
              </div>
            ) : null}

            <p className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
              <ShieldCheck
                className="mt-0.5 size-3 shrink-0"
                aria-hidden="true"
              />
              {t("privacyNote")}
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
}: {
  agent: PlanUsageAgent
  snapshot: PlanUsageSnapshot | null
  report: PlanUsageReport | null
  now: number
}) {
  const t = useTranslations("PlanUsage")
  const label = getAgentLabel(agent)
  const hasData = snapshot != null && snapshot.windows.length > 0
  const stale = hasData && isSnapshotStale(snapshot, now)
  const statusKey =
    hasData && !stale && snapshot.status && snapshot.status in STATUS_KEYS
      ? (snapshot.status as keyof typeof STATUS_KEYS)
      : null

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
      ? t("source.codexLog")
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
