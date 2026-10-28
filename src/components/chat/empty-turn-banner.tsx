"use client"

import { MessageCircleWarning, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

/**
 * Docked above the composer when the last turn ended without a reply
 * (`turn_failed_empty*`): the agent returned at once and said nothing, which
 * in practice means the prompt never reached it (a session still resuming, an
 * agent process in a bad state). Without this the turn just stops, and looks
 * like the session froze. Retry sends the last message again — the caller
 * owns how (the panel's normal send path).
 */
export function EmptyTurnBanner({
  agent,
  onRetry,
}: {
  agent: string
  onRetry: () => void
}) {
  const t = useTranslations("Folder.chat.acpConnections")
  return (
    <div
      role="status"
      data-testid="empty-turn-banner"
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
    >
      <MessageCircleWarning aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-40 flex-1 leading-snug">
        {t("emptyTurnNotice", { agent })}
      </span>
      <Button
        size="xs"
        variant="outline"
        className="border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
        onClick={onRetry}
      >
        <RotateCcw aria-hidden />
        {t("emptyTurnRetry")}
      </Button>
    </div>
  )
}
