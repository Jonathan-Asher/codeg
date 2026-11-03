"use client"

import { AlertTriangle, Play } from "lucide-react"
import { useTranslations } from "next-intl"

/**
 * Under a reply the model cut off because it ran out of output tokens (the
 * turn ended with `max_tokens`, see `lib/output-limit`): says so, and offers
 * Continue. The host owns what Continue sends and when the notice shows (see
 * `MessageListView`'s `onContinueAfterOutputLimit`).
 */
export function OutputLimitNotice({ onContinue }: { onContinue: () => void }) {
  const t = useTranslations("Folder.chat.messageList")
  return (
    <div
      role="status"
      data-output-limit-notice
      className="flex flex-wrap items-center gap-2 ps-1 pt-1 text-[0.6875rem] text-muted-foreground"
    >
      <span className="flex items-center gap-1">
        <AlertTriangle
          className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        {t("outputLimitReached")}
      </span>
      <button
        type="button"
        onClick={onContinue}
        title={t("outputLimitContinueHint")}
        className="flex items-center gap-1 rounded-full border border-border bg-background/90 px-2 py-[0.125rem] text-[0.6875rem] text-muted-foreground shadow-sm transition-colors hover:bg-muted/90 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Play className="h-3 w-3" aria-hidden />
        {t("outputLimitContinue")}
      </button>
    </div>
  )
}
