"use client"

import { Fragment, type ReactNode } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  activePool,
  findSnapshot,
  isPoolStale,
  isSnapshotStale,
  PLAN_USAGE_AGENTS,
  splitPercent,
  unansweredPool,
  type PlanUsagePreviewEntry,
} from "@/lib/plan-usage"
import type {
  PlanUsageAgent,
  PlanUsagePool,
  PlanUsageReport,
  PlanUsageSnapshot,
  PlanUsageWindow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  LEVEL_TEXT,
  useEmptyCopy,
  useUpdatedLabel,
  useWindowTitle,
  WindowResetText,
  WindowUsageBar,
} from "./plan-usage-parts"
import {
  PoolAccountList,
  PoolNotices,
  PoolSummaryLine,
  UnansweredPoolNotice,
} from "./plan-usage-pool"

/** Short provider names for the status bar, where "Claude Code" is too wide.
 *  Product names, so not translated. */
const SHORT_NAME: Record<PlanUsageAgent, string> = {
  claude_code: "Claude",
  codex: "Codex",
}

/**
 * The status bar's inline reading: each provider's tightest window as a
 * percentage used — `Claude 35% · Codex 99%` — tinted amber from 75% and red
 * from 90% (or once the limit is reached), dimmed and italic when the reading
 * is stale. `showNames` off leaves just the numbers, for the compact bar.
 *
 * Behind an account pool the agent's entry names the serving account and
 * shows its 5-hour window (`backup 56%`), tinted from the pool's switch
 * threshold, with a count when any account is exhausted.
 */
export function PlanUsageInlinePreview({
  entries,
  showNames = true,
}: {
  entries: readonly PlanUsagePreviewEntry[]
  showNames?: boolean
}) {
  const t = useTranslations("PlanUsage")
  return (
    <span
      data-slot="plan-usage-inline-preview"
      className="flex items-center gap-1 whitespace-nowrap tabular-nums"
    >
      {entries.map((entry, index) => (
        <Fragment key={entry.agent}>
          {index > 0 && (
            <span aria-hidden="true" className="opacity-60">
              ·
            </span>
          )}
          <span
            data-agent={entry.agent}
            data-level={entry.level}
            data-stale={entry.stale ? "true" : undefined}
            className={cn(entry.stale && "italic opacity-60")}
          >
            {showNames && `${SHORT_NAME[entry.agent]} `}
            {showNames && entry.pool && (
              <>
                <bdi data-slot="pool-account">{entry.pool.account}</bdi>{" "}
              </>
            )}
            <span
              className={cn(
                LEVEL_TEXT[entry.level],
                entry.level !== "normal" && "font-medium"
              )}
            >
              {t("preview.percent", { percent: entry.percent })}
            </span>
            {entry.pool && entry.pool.exhausted > 0 && (
              <span
                data-slot="pool-exhausted-count"
                className="ms-1 text-destructive"
              >
                {showNames
                  ? t("preview.poolExhausted", {
                      count: entry.pool.exhausted,
                    })
                  : t("preview.poolExhaustedShort", {
                      count: entry.pool.exhausted,
                    })}
              </span>
            )}
          </span>
        </Fragment>
      ))}
    </span>
  )
}

/** The inline reading as one phrase for assistive tech — "Claude 35%, Codex
 *  99% (stale)" — since the dot separator and the dimming don't read out. */
export function usePlanUsagePreviewSummary(
  entries: readonly PlanUsagePreviewEntry[]
): string {
  const t = useTranslations("PlanUsage")
  const format = useFormatter()
  const parts = entries.map((entry) => {
    const name = entry.pool
      ? `${SHORT_NAME[entry.agent]} ${entry.pool.account}`
      : SHORT_NAME[entry.agent]
    let text = `${name} ${t("preview.percent", { percent: entry.percent })}`
    if (entry.pool && entry.pool.exhausted > 0) {
      text = `${text} (${t("preview.poolExhausted", {
        count: entry.pool.exhausted,
      })})`
    }
    return entry.stale ? t("preview.staleEntry", { entry: text }) : text
  })
  return format.list(parts, { style: "narrow", type: "conjunction" })
}

/**
 * The hover preview's body: per provider, a mini bar for each window with
 * its used / left split and reset time, and how old the reading is; below
 * them, the way into the full page.
 */
export function PlanUsagePreviewCard({
  report,
  loading,
  error,
  now,
  onOpenFullView,
}: {
  report: PlanUsageReport | null
  loading: boolean
  error: string | null
  now: number
  onOpenFullView: () => void
}) {
  const t = useTranslations("PlanUsage")

  let body: ReactNode
  if (report == null && loading) {
    body = (
      <div
        className="h-24 animate-pulse rounded-lg bg-muted/40"
        aria-hidden="true"
      />
    )
  } else if (report == null && error != null) {
    body = (
      <p className="text-xs text-destructive">
        {t("loadFailed")}: {error}
      </p>
    )
  } else {
    body = (
      <div className="space-y-3">
        {PLAN_USAGE_AGENTS.map((agent) => (
          <PreviewProvider
            key={agent}
            agent={agent}
            snapshot={findSnapshot(report, agent)}
            report={report}
            now={now}
          />
        ))}
      </div>
    )
  }

  return (
    <div data-slot="plan-usage-preview-card">
      {body}
      <div className="mt-3 border-t border-border pt-2">
        <button
          type="button"
          onClick={onOpenFullView}
          className="text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {t("preview.openFullView")}
        </button>
      </div>
    </div>
  )
}

function PreviewProvider({
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
  const label = getAgentLabel(agent)
  const hasData = snapshot != null && snapshot.windows.length > 0
  const pool = activePool(report)
  if (pool && pool.agent === agent) {
    return (
      <section aria-label={label} data-agent={agent} data-pool={pool.kind}>
        <PoolReading agent={agent} label={label} pool={pool} now={now} />
      </section>
    )
  }
  const unanswered = unansweredPool(report)
  return (
    <section aria-label={label} data-agent={agent}>
      {hasData ? (
        <ProviderReading label={label} snapshot={snapshot} now={now} />
      ) : (
        <>
          <ProviderHeading agent={agent} label={label} />
          <EmptyLine agent={agent} report={report} />
        </>
      )}
      {unanswered && unanswered.agent === agent && (
        <UnansweredPoolNotice pool={unanswered} compact />
      )}
    </section>
  )
}

function PoolReading({
  agent,
  label,
  pool,
  now,
}: {
  agent: PlanUsageAgent
  label: string
  pool: PlanUsagePool
  now: number
}) {
  const t = useTranslations("PlanUsage")
  const stale = isPoolStale(pool, now)
  return (
    <>
      <ProviderHeading agent={agent} label={label}>
        <span className="ms-auto flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <span>{t("pool.label")}</span>
          {stale && (
            <Badge
              variant="outline"
              className="h-4 px-1.5 text-[0.625rem] text-muted-foreground"
            >
              {t("stale")}
            </Badge>
          )}
        </span>
      </ProviderHeading>
      <PoolSummaryLine
        pool={pool}
        now={now}
        className="mt-0.5 text-[0.6875rem]"
      />
      <div className="mt-1 space-y-1 empty:hidden">
        <PoolNotices pool={pool} now={now} compact />
      </div>
      <div className="mt-1.5">
        <PoolAccountList pool={pool} now={now} compact />
      </div>
    </>
  )
}

function ProviderHeading({
  agent,
  label,
  children,
}: {
  agent: PlanUsageAgent
  label: string
  children?: ReactNode
}) {
  return (
    <header className="flex items-center gap-1.5">
      <AgentIcon agentType={agent} className="size-3.5" />
      <h3 className="text-xs font-semibold">{label}</h3>
      {children}
    </header>
  )
}

function ProviderReading({
  label,
  snapshot,
  now,
}: {
  label: string
  snapshot: PlanUsageSnapshot
  now: number
}) {
  const t = useTranslations("PlanUsage")
  const updated = useUpdatedLabel(snapshot, now)
  const stale = isSnapshotStale(snapshot, now)
  return (
    <>
      <ProviderHeading agent={snapshot.agent} label={label}>
        <span className="ms-auto flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          {updated != null && <span data-slot="reading-age">{updated}</span>}
          {stale && (
            <Badge
              variant="outline"
              title={t("staleHint")}
              className="h-4 px-1.5 text-[0.625rem] text-muted-foreground"
            >
              {t("stale")}
            </Badge>
          )}
        </span>
      </ProviderHeading>
      <ul className={cn("mt-1.5 space-y-2", stale && "opacity-70")}>
        {snapshot.windows.map((limit) => (
          <PreviewWindowRow key={limit.id} limit={limit} now={now} />
        ))}
      </ul>
    </>
  )
}

function PreviewWindowRow({
  limit,
  now,
}: {
  limit: PlanUsageWindow
  now: number
}) {
  const t = useTranslations("PlanUsage")
  const title = useWindowTitle(limit)
  const { used, left } = splitPercent(limit.used_percent)
  return (
    <li data-window={limit.id}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0 font-mono tabular-nums">
          {t("used", { percent: used })}
        </span>
      </div>
      <WindowUsageBar
        limit={limit}
        title={title}
        now={now}
        className="mt-1 h-1.5"
      />
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[0.6875rem] text-muted-foreground">
        <span className="tabular-nums">{t("left", { percent: left })}</span>
        <span className="text-end">
          <WindowResetText limit={limit} now={now} />
        </span>
      </div>
    </li>
  )
}

function EmptyLine({
  agent,
  report,
}: {
  agent: PlanUsageAgent
  report: PlanUsageReport | null
}) {
  const { title, hint } = useEmptyCopy(agent, report)
  return (
    <p className="mt-1 text-[0.6875rem] text-muted-foreground" title={hint}>
      {title}
    </p>
  )
}
