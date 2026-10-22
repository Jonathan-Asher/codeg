"use client"

/**
 * The usage-limit pause in the UI (`lib/limit-continue.ts`): when the limit
 * resets, kept current while it is shown, and the two things the user can do
 * about it — continue now (ahead of the reset; it may hit the limit again) or
 * cancel the automatic continuation (the turn is left interrupted, with the
 * manual Continue). Shared by the composer banner and the Session Details
 * activity line.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { CirclePause, Hourglass, Play, X } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cancelLimitContinue, continueLimitNow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  limitResetParts,
  limitStopReason,
  waitingLimitPause,
  type LimitResetParts,
} from "@/lib/limit-continue"
import type { LimitPause, LimitReason } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

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

/** A conversation's usage-limit pause while it waits for the reset — not
 *  once its continuation's (or anyone's) turn runs — with why it waits. Read
 *  from the conversation list, which every client keeps current. */
export function useWaitingLimitPause(
  conversationId: number | null | undefined
): { pause: LimitPause; reason: LimitReason } | null {
  const find = (s: ReturnType<typeof useAppWorkspaceStore.getState>) =>
    conversationId != null
      ? s.conversations.find((c) => c.id === conversationId)
      : undefined
  const pause = useAppWorkspaceStore((s) => find(s)?.limit_pause ?? null)
  const reason = useAppWorkspaceStore((s) => find(s)?.limit_reason ?? null)
  const running = useAppWorkspaceStore((s) => find(s)?.turn_state === "running")
  return useMemo(() => {
    const waiting = waitingLimitPause({ limit_pause: pause })
    if (!waiting || running) return null
    return { pause: waiting, reason: reason ?? "usage_limit" }
  }, [pause, reason, running])
}

/**
 * The session header's word on a usage limit: paused until it continues by
 * itself (and why), or stopped on one for good — the continuations gave up
 * or were cancelled. Nothing otherwise.
 */
export function LimitPauseHeaderBadge({
  conversationId,
}: {
  conversationId: number | null
}) {
  const t = useTranslations("Folder.sessionActivity")
  const waiting = useWaitingLimitPause(conversationId)
  const stopped = useAppWorkspaceStore((s) => {
    if (conversationId == null) return null
    return limitStopReason(s.conversations.find((c) => c.id === conversationId))
  })
  const parts = useLimitResetParts(waiting?.pause.resets_at)
  if (waiting) {
    const pool = waiting.reason === "pool_capacity"
    const time = parts?.time ?? ""
    const label =
      waiting.pause.state === "claimed"
        ? t("limitClaimed")
        : pool
          ? t("limitPoolPaused", { time })
          : t("limitPausedBadge", { time })
    return (
      <span
        role="status"
        data-testid="header-limit-paused"
        data-limit-reason={waiting.reason}
        title={pool ? t("limitPoolPausedHint") : t("limitPausedHint")}
        className="flex min-w-0 max-w-[45%] shrink items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/5 px-1.5 py-0.5 text-2xs text-violet-700 dark:text-violet-300"
      >
        <Hourglass aria-hidden className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    )
  }
  if (stopped) {
    return (
      <span
        role="status"
        data-testid="header-limit-stopped"
        data-limit-reason={stopped}
        title={t("limitStoppedHint")}
        className="flex min-w-0 shrink items-center gap-1 rounded-md border border-orange-500/30 bg-orange-500/5 px-1.5 py-0.5 text-2xs text-orange-700 dark:text-orange-300"
      >
        <CirclePause aria-hidden className="h-3 w-3 shrink-0" />
        <span className="truncate">{t("limitStopped")}</span>
      </span>
    )
  }
  return null
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
  reason = "usage_limit",
}: {
  conversationId: number
  pause: LimitPause
  /** What it waits for: the account's own limit, or the account pool. */
  reason?: LimitReason
}) {
  const t = useTranslations("Folder.sessionActivity")
  const parts = useLimitResetParts(pause.resets_at)
  const claimed = pause.state === "claimed"
  return (
    <div
      role="status"
      data-testid="limit-paused-banner"
      data-limit-state={pause.state}
      data-limit-reason={reason}
      title={reason === "pool_capacity" ? t("limitPoolPausedHint") : undefined}
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-xs text-violet-700 dark:text-violet-300"
    >
      <Hourglass aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-40 flex-1 leading-snug">
        <span className="font-medium">
          {reason === "pool_capacity"
            ? t("limitPoolBannerTitle")
            : t("limitBannerTitle")}
        </span>{" "}
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
