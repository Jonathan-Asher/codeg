"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Gauge, RefreshCw, ShieldCheck } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { getPlanUsage, subscribePlanUsageChanged } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import { onTransportReconnect } from "@/lib/platform"
import {
  findSnapshot,
  formatAbsoluteTime,
  formatCompactDuration,
  hasWindowReset,
  isSnapshotStale,
  mergeFetchedReport,
  nowSeconds,
  PLAN_USAGE_AGENTS,
  replaceSnapshot,
  splitPercent,
  usageLevel,
  windowLagSince,
  windowName,
  type PlanUsageLevel,
} from "@/lib/plan-usage"
import type {
  PlanUsageAgent,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
} from "@/lib/types"
import { cn } from "@/lib/utils"

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

/** Bar tint per level: the default primary until a window gets tight. */
const LEVEL_BAR: Record<PlanUsageLevel, string> = {
  normal: "",
  high: "bg-amber-500/20 [&_[data-slot=progress-indicator]]:bg-amber-500",
  critical:
    "bg-destructive/20 [&_[data-slot=progress-indicator]]:bg-destructive",
}

/** Page title in the window-chrome strip — the shared breadcrumb header. */
export function PlanUsagePageTitle() {
  const t = useTranslations("PlanUsage")
  return <WorkbenchPageTitle title={t("title")} />
}

function useNowSeconds(intervalMs: number): number {
  const [now, setNow] = useState(nowSeconds)
  useEffect(() => {
    const id = setInterval(() => setNow(nowSeconds()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * The Subscription usage route: one card per provider, one bar per limit
 * window. Claude Code's numbers arrive live (pushed during a turn) and
 * survive restarts via the backend's saved copy; Codex's come from its newest
 * session log and are re-read on Refresh.
 */
export function PlanUsagePage() {
  const t = useTranslations("PlanUsage")
  const [report, setReport] = useState<PlanUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = useNowSeconds(TICK_MS)

  // Only the newest request may land: a slow mount fetch must not overwrite
  // the answer to a Refresh clicked after it.
  const requestRef = useRef(0)
  const load = useCallback(async (force: boolean) => {
    const id = ++requestRef.current
    if (force) setRefreshing(true)
    try {
      const next = await getPlanUsage(force)
      if (id !== requestRef.current) return
      setReport((prev) => mergeFetchedReport(prev, next))
      setError(null)
    } catch (e) {
      if (id !== requestRef.current) return
      setError(toErrorMessage(e))
    } finally {
      if (id === requestRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  // Live Claude readings, pushed as a turn reports them.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribePlanUsageChanged((snapshot) => {
      setReport((prev) => replaceSnapshot(prev, snapshot))
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  // A push sent while the web socket was down is gone; refetch once it is
  // back rather than showing the older reading until the next turn.
  useEffect(() => {
    const off = onTransportReconnect(() => void load(false))
    return () => off?.()
  }, [load])

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
  const known = snapshot.observed_at > 0
  const age = Math.max(0, now - snapshot.observed_at)

  return (
    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
      {known && (
        <>
          <time
            dateTime={new Date(snapshot.observed_at * 1000).toISOString()}
            title={formatAbsoluteTime(snapshot.observed_at, locale, now)}
          >
            {age < 60
              ? t("updatedJustNow")
              : t("updatedAgo", {
                  duration: formatCompactDuration(age, locale),
                })}
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

function useWindowTitle(limit: PlanUsageWindow): string {
  const t = useTranslations("PlanUsage")
  const name = windowName(limit)
  switch (name.key) {
    case "session5h":
      return t("window.session5h")
    case "sessionSpan":
      return t("window.sessionSpan", name.values)
    case "weekly":
      return t("window.weekly")
    case "weeklyModel":
      return t("window.weeklyModel", name.values)
    case "weeklyWithExtra":
      return t("window.weeklyWithExtra")
    case "extraUsage":
      return t("window.extraUsage")
    case "other":
      return t("window.other", name.values)
  }
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
  const level = usageLevel(limit.used_percent)
  const lagSince = windowLagSince(limit, snapshot)

  let resetText: ReactNode
  if (limit.resets_at == null) {
    resetText = t("resetUnknown")
  } else if (reset) {
    resetText = t("resetSince", {
      duration: formatCompactDuration(now - limit.resets_at, locale),
    })
  } else {
    resetText = (
      <time dateTime={new Date(limit.resets_at * 1000).toISOString()}>
        {t("resetsIn", {
          duration: formatCompactDuration(limit.resets_at - now, locale),
        })}
        {" · "}
        {formatAbsoluteTime(limit.resets_at, locale, now)}
      </time>
    )
  }

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
      {/* The shared Progress draws `value` but doesn't hand it to Radix, so
          the bar would read as indeterminate; state the number explicitly. */}
      <Progress
        value={used}
        aria-label={title}
        aria-valuenow={used}
        aria-valuetext={t("used", { percent: used })}
        className={cn("mt-1.5 h-2", LEVEL_BAR[level], reset && "opacity-40")}
      />
      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span className="tabular-nums">{t("left", { percent: left })}</span>
        <span className="text-end">{resetText}</span>
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
  const t = useTranslations("PlanUsage")
  let title: string
  let hint: string
  if (agent === "claude_code") {
    title = t("empty.claudeTitle")
    hint = t("empty.claudeHint")
  } else if (!report?.codex_rollouts_found) {
    title = t("empty.codexNoSessionsTitle")
    hint = t("empty.codexNoSessionsHint", {
      dir: report?.codex_sessions_dir ?? "~/.codex/sessions",
    })
  } else {
    title = t("empty.codexNoLimitsTitle")
    hint = t("empty.codexNoLimitsHint")
  }
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
