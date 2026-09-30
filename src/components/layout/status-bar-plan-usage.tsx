"use client"

import { useCallback, useState, type FocusEvent } from "react"
import { Gauge } from "lucide-react"
import { useTranslations } from "next-intl"
import { useNowSeconds } from "@/components/plan-usage/plan-usage-parts"
import {
  PlanUsageInlinePreview,
  PlanUsagePreviewCard,
  usePlanUsagePreviewSummary,
} from "@/components/plan-usage/plan-usage-preview"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { usePlanUsageReport } from "@/hooks/use-plan-usage-report"
import { isKeyboardFocus } from "@/lib/keyboard-focus"
import { planUsagePreview, tightestPreviewEntry } from "@/lib/plan-usage"
import { cn } from "@/lib/utils"

/** Refetch cadence while the window is visible. The backend caches its Codex
 *  log scan for a minute, so this is as fresh as a fetch can be. */
const POLL_MS = 60_000
/** How often "resets in" / "updated … ago" re-render. */
const TICK_MS = 60_000
/** Long enough that sweeping the pointer along the bar stays quiet. */
const HOVER_OPEN_DELAY_MS = 300
/** Grace period for crossing the gap into the bubble. */
const HOVER_CLOSE_DELAY_MS = 120

/**
 * The status-bar door to the Subscription usage route, beside the
 * conversation count that opens Token Usage.
 *
 * It previews what the page holds: each provider's tightest window as a
 * percentage — `Claude 35% · Codex 99%` — and, on hover or keyboard focus, a
 * bubble with every window's bar, reset time and reading age. Clicking still
 * opens the page. With no reading yet it keeps its plain "Limits" label.
 *
 * `compact` is the mobile bar, where width is scarce: only the single highest
 * percentage, or the bare gauge before any reading.
 */
export function StatusBarPlanUsage({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("Folder.statusBar.stats")
  const { routeId, setRoute } = useWorkbenchRoute()
  const active = routeId === "planUsage"
  const { report, loading, error } = usePlanUsageReport({ pollMs: POLL_MS })
  const now = useNowSeconds(TICK_MS)
  const [open, setOpen] = useState(false)

  const entries = planUsagePreview(report, now)
  const tightest = tightestPreviewEntry(entries)
  const shown = compact ? (tightest ? [tightest] : []) : entries
  const summary = usePlanUsagePreviewSummary(shown)

  const openFullView = useCallback(() => {
    setOpen(false)
    setRoute("planUsage")
  }, [setRoute])

  // A tap or click focuses the button too; only keyboard focus may open the
  // bubble, or a tap would strand it open with no pointer to leave it.
  const guardFocus = useCallback((event: FocusEvent) => {
    if (!isKeyboardFocus(event.target)) event.preventDefault()
  }, [])

  let ariaLabel: string | undefined
  if (shown.length > 0) ariaLabel = t("planUsageSummary", { summary })
  else if (compact) ariaLabel = t("openPlanUsage")

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={HOVER_OPEN_DELAY_MS}
      closeDelay={HOVER_CLOSE_DELAY_MS}
    >
      <HoverCardTrigger asChild onFocus={guardFocus}>
        <button
          type="button"
          onClick={openFullView}
          aria-label={ariaLabel}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors hover:text-foreground",
            active && "text-foreground"
          )}
        >
          <Gauge className="h-3 w-3 shrink-0" aria-hidden="true" />
          {shown.length > 0 ? (
            <PlanUsageInlinePreview entries={shown} showNames={!compact} />
          ) : (
            !compact && <span>{t("planUsage")}</span>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80">
        <PlanUsagePreviewCard
          report={report}
          loading={loading}
          error={error}
          now={now}
          onOpenFullView={openFullView}
        />
      </HoverCardContent>
    </HoverCard>
  )
}
