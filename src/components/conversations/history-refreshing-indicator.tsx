"use client"

import { RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

/**
 * A small mark while the transcript on screen, a kept copy or one a reconnect
 * is re-reading, is being brought up to date. It fades in only once the
 * refresh has taken a moment (`codeg-delayed-show`), so a quick one that
 * finds nothing new shows nothing at all.
 */
export function HistoryRefreshingIndicator({
  conversationId,
}: {
  conversationId: number
}) {
  const t = useTranslations("Folder.conversation")
  const refreshing = useConversationRuntimeStore(
    (s) => s.byConversationId.get(conversationId)?.detailRevalidating === true
  )
  if (!refreshing) return null
  return (
    <span
      role="status"
      className="codeg-delayed-show ml-1.5 flex shrink-0 items-center text-muted-foreground/60"
      title={t("refreshing")}
      aria-label={t("refreshing")}
      data-testid="history-refreshing"
    >
      <RefreshCw className="size-3 animate-spin" aria-hidden />
    </span>
  )
}
