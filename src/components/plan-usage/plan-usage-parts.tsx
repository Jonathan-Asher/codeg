"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Progress } from "@/components/ui/progress"
import {
  formatAbsoluteTime,
  formatCompactDuration,
  hasWindowReset,
  nowSeconds,
  splitPercent,
  usageLevel,
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

/**
 * Pieces shared by the Subscription usage page and the status-bar preview,
 * so both read a window the same way: its name, bar tint, reset time, and the
 * age of the reading it came from.
 */

/** Bar tint per level: the default primary until a window gets tight. */
export const LEVEL_BAR: Record<PlanUsageLevel, string> = {
  normal: "",
  high: "bg-amber-500/20 [&_[data-slot=progress-indicator]]:bg-amber-500",
  critical:
    "bg-destructive/20 [&_[data-slot=progress-indicator]]:bg-destructive",
}

/** Text tint per level, matching `LEVEL_BAR`; `normal` inherits. */
export const LEVEL_TEXT: Record<PlanUsageLevel, string> = {
  normal: "",
  high: "text-amber-600 dark:text-amber-400",
  critical: "text-destructive",
}

/** The current time in epoch seconds, re-read every `intervalMs` so relative
 *  times ("resets in 2h 14m") keep moving. */
export function useNowSeconds(intervalMs: number): number {
  const [now, setNow] = useState(nowSeconds)
  useEffect(() => {
    const id = setInterval(() => setNow(nowSeconds()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function useWindowTitle(limit: PlanUsageWindow): string {
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

/** "Updated 3m ago" / "Updated just now"; `null` when the reading carries no
 *  time. */
export function useUpdatedLabel(
  snapshot: PlanUsageSnapshot,
  now: number
): string | null {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  if (snapshot.observed_at <= 0) return null
  const age = Math.max(0, now - snapshot.observed_at)
  return age < 60
    ? t("updatedJustNow")
    : t("updatedAgo", { duration: formatCompactDuration(age, locale) })
}

/** What an empty provider card says: why there are no numbers yet. */
export function useEmptyCopy(
  agent: PlanUsageAgent,
  report: PlanUsageReport | null
): { title: string; hint: string } {
  const t = useTranslations("PlanUsage")
  if (agent === "claude_code") {
    return { title: t("empty.claudeTitle"), hint: t("empty.claudeHint") }
  }
  if (!report?.codex_rollouts_found) {
    return {
      title: t("empty.codexNoSessionsTitle"),
      hint: t("empty.codexNoSessionsHint", {
        dir: report?.codex_sessions_dir ?? "~/.codex/sessions",
      }),
    }
  }
  return {
    title: t("empty.codexNoLimitsTitle"),
    hint: t("empty.codexNoLimitsHint"),
  }
}

/** When the window resets — "Resets in 2h 14m", plus the wall-clock time
 *  with `withAbsolute` — or that it already has. */
export function WindowResetText({
  limit,
  now,
  withAbsolute = false,
}: {
  limit: PlanUsageWindow
  now: number
  withAbsolute?: boolean
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  if (limit.resets_at == null) return <>{t("resetUnknown")}</>
  if (hasWindowReset(limit, now)) {
    return (
      <>
        {t("resetSince", {
          duration: formatCompactDuration(now - limit.resets_at, locale),
        })}
      </>
    )
  }
  const absolute = formatAbsoluteTime(limit.resets_at, locale, now)
  return (
    <time
      dateTime={new Date(limit.resets_at * 1000).toISOString()}
      title={withAbsolute ? undefined : absolute}
    >
      {t("resetsIn", {
        duration: formatCompactDuration(limit.resets_at - now, locale),
      })}
      {withAbsolute && ` · ${absolute}`}
    </time>
  )
}

/** A window's usage bar, tinted as it gets tight (or by `level`, when the
 *  caller judges tightness differently) and faded once the window has rolled
 *  over past its reading. */
export function WindowUsageBar({
  limit,
  title,
  now,
  level = usageLevel(limit.used_percent),
  className,
}: {
  limit: PlanUsageWindow
  title: string
  now: number
  level?: PlanUsageLevel
  className?: string
}) {
  const t = useTranslations("PlanUsage")
  const { used } = splitPercent(limit.used_percent)
  // The shared Progress draws `value` but doesn't hand it to Radix, so the
  // bar would read as indeterminate; state the number explicitly.
  return (
    <Progress
      value={used}
      aria-label={title}
      aria-valuenow={used}
      aria-valuetext={t("used", { percent: used })}
      className={cn(
        "h-2",
        LEVEL_BAR[level],
        hasWindowReset(limit, now) && "opacity-40",
        className
      )}
    />
  )
}
