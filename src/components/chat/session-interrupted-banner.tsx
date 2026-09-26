"use client"

import { CirclePause, Play } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

/**
 * Docked above the composer of a conversation whose last turn was cut off
 * (codeg exited, or the agent process or its connection died mid-turn): says
 * so, and offers the one-click way back in. The caller owns what Continue does
 * — the conversation panel queues "continue" through its normal send path —
 * and decides when the banner shows at all.
 */
export function SessionInterruptedBanner({
  onContinue,
}: {
  onContinue: () => void
}) {
  const t = useTranslations("Folder.sessionActivity")
  return (
    <div
      role="status"
      data-testid="session-interrupted-banner"
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs text-orange-700 dark:text-orange-300"
    >
      <CirclePause aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-40 flex-1 leading-snug">
        <span className="font-medium">{t("bannerTitle")}</span>{" "}
        <span className="text-orange-700/80 dark:text-orange-300/80">
          {t("bannerDescription")}
        </span>
      </span>
      <Button
        size="xs"
        variant="outline"
        className="border-orange-500/40 bg-transparent text-orange-700 hover:bg-orange-500/15 hover:text-orange-800 dark:text-orange-300 dark:hover:text-orange-200"
        title={t("continueTitle")}
        onClick={onContinue}
      >
        <Play aria-hidden />
        {t("continue")}
      </Button>
    </div>
  )
}
