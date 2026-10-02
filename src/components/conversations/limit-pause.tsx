"use client"

/**
 * The usage-limit pause in the UI (`lib/limit-continue.ts`): when the limit
 * resets, kept current while it is shown, and the two things the user can do
 * about it — continue now (ahead of the reset; it may hit the limit again) or
 * cancel the automatic continuation (the turn is left interrupted, with the
 * manual Continue). Shared by the composer banner and the Session Details
 * activity line.
 */

import { useCallback, useEffect, useState } from "react"
import { Hourglass, Play, X } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cancelLimitContinue, continueLimitNow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { limitResetParts, type LimitResetParts } from "@/lib/limit-continue"
import type { LimitPause } from "@/lib/types"

/** How often "in 3h 12m" catches up. */
const REFRESH_MS = 30_000

/** When the limit resets ({@link limitResetParts}), refreshed while shown.
 *  `null` with no reset time. */
export function useLimitResetParts(
  resetsAt: string | null | undefined
): LimitResetParts | null {
  const locale = useLocale()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!resetsAt) return
    const id = window.setInterval(() => setNow(Date.now()), REFRESH_MS)
    return () => window.clearInterval(id)
  }, [resetsAt])
  return resetsAt ? limitResetParts(resetsAt, now, locale) : null
}

/** Continue now / Cancel auto-continue for one paused conversation. The
 *  backend broadcasts the row's new state to every client. */
export function useLimitPauseActions(conversationId: number) {
  const t = useTranslations("Folder.sessionActivity")
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    (action: (id: number) => Promise<unknown>) => {
      setBusy(true)
      action(conversationId)
        .catch((err) => {
          toast.error(t("limitActionFailed", { message: toErrorMessage(err) }))
        })
        .finally(() => setBusy(false))
    },
    [conversationId, t]
  )
  return {
    busy,
    continueNow: useCallback(() => run(continueLimitNow), [run]),
    cancel: useCallback(() => run(cancelLimitContinue), [run]),
  }
}

/** The two actions as buttons, in the style of the surface they sit on. */
export function LimitPauseButtons({
  conversationId,
  claimed,
  buttonClassName,
}: {
  conversationId: number
  /** The continuation is already going out: nothing left to choose. */
  claimed: boolean
  buttonClassName?: string
}) {
  const t = useTranslations("Folder.sessionActivity")
  const { busy, continueNow, cancel } = useLimitPauseActions(conversationId)
  if (claimed) return null
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="xs"
        variant="outline"
        className={buttonClassName}
        title={t("cancelAutoContinueTitle")}
        disabled={busy}
        onClick={cancel}
        data-testid="limit-cancel-auto-continue"
      >
        <X aria-hidden />
        {t("cancelAutoContinue")}
      </Button>
      <Button
        size="xs"
        variant="outline"
        className={buttonClassName}
        title={t("continueNowTitle")}
        disabled={busy}
        onClick={continueNow}
        data-testid="limit-continue-now"
      >
        <Play aria-hidden />
        {t("continueNow")}
      </Button>
    </div>
  )
}

/**
 * Docked above the composer of a conversation paused on the usage limit:
 * says when it continues by itself, and offers Cancel auto-continue and
 * Continue now. The caller decides when it shows.
 */
export function LimitPausedBanner({
  conversationId,
  pause,
}: {
  conversationId: number
  pause: LimitPause
}) {
  const t = useTranslations("Folder.sessionActivity")
  const parts = useLimitResetParts(pause.resets_at)
  const claimed = pause.state === "claimed"
  return (
    <div
      role="status"
      data-testid="limit-paused-banner"
      data-limit-state={pause.state}
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-xs text-violet-700 dark:text-violet-300"
    >
      <Hourglass aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-40 flex-1 leading-snug">
        <span className="font-medium">{t("limitBannerTitle")}</span>{" "}
        <span className="text-violet-700/80 dark:text-violet-300/80">
          {claimed
            ? t("limitBannerClaimed")
            : t("limitBannerDescription", {
                time: parts?.time ?? "",
                remaining: parts?.remaining ?? "",
              })}
        </span>
      </span>
      <LimitPauseButtons
        conversationId={conversationId}
        claimed={claimed}
        buttonClassName="border-violet-500/40 bg-transparent text-violet-700 hover:bg-violet-500/15 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
      />
    </div>
  )
}
