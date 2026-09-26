"use client"

import { Gauge } from "lucide-react"
import { useTranslations } from "next-intl"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { cn } from "@/lib/utils"

/**
 * The status-bar door to the Subscription usage route, beside the
 * conversation count that opens Token Usage — the two usage pages sit side by
 * side here the same way. It carries no numbers of its own: a figure in the
 * corner would need its own polling and could only show one window of one
 * provider, while the page shows all of them with their reset times.
 *
 * `compact` drops the label for the mobile bar, where width is scarce.
 */
export function StatusBarPlanUsage({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("Folder.statusBar.stats")
  const { routeId, setRoute } = useWorkbenchRoute()
  const active = routeId === "planUsage"

  return (
    <button
      type="button"
      onClick={() => setRoute("planUsage")}
      title={t("openPlanUsage")}
      aria-label={compact ? t("openPlanUsage") : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-1.5 transition-colors hover:text-foreground",
        active && "text-foreground"
      )}
    >
      <Gauge className="h-3 w-3" aria-hidden="true" />
      {!compact && <span>{t("planUsage")}</span>}
    </button>
  )
}
