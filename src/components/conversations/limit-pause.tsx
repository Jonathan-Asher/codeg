"use client"

/**
 * The usage-limit pause in the UI (`lib/limit-continue.ts`): when the limit
 * resets, kept current while it is shown, and what the user can do about it —
 * continue now (ahead of the reset; it may hit the limit again), cancel the
 * automatic continuation (the turn is left interrupted, with the manual
 * Continue), or, when one can be used, use a usage-limit reset and continue
 * right away (`lib/limit-resets.ts`): a Codex credit, or a grant of one of
 * the account pool's Claude accounts. Shared by the composer banner and the
 * Session Details activity line.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CirclePause,
  Hourglass,
  Loader2,
  Play,
  RotateCcw,
  X,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { useNowSeconds } from "@/components/plan-usage/plan-usage-parts"
import {
  PoolResetConfirmDialog,
  usePoolResetRun,
} from "@/components/plan-usage/plan-usage-pool-resets"
import {
  LimitResetConfirmDialog,
  useLimitResetRun,
} from "@/components/plan-usage/plan-usage-resets"
import { Button } from "@/components/ui/button"
import { useLimitResets } from "@/hooks/use-limit-resets"
import { usePlanUsageReport } from "@/hooks/use-plan-usage-report"
import { cancelLimitContinue, continueLimitNow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  limitResetParts,
  limitStopReason,
  waitingLimitPause,
  type LimitResetParts,
} from "@/lib/limit-continue"
import {
  defaultUsableReset,
  findProviderResets,
  poolResetForPause,
} from "@/lib/limit-resets"
import { poolAccountState } from "@/lib/plan-usage"
import type {
  AgentType,
  LimitPause,
  LimitReason,
  PlanUsageAgent,
} from "@/lib/types"
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

/** The provider whose usage-limit resets an agent's sessions can use. */
export function resetProviderOf(
  agentType: AgentType | null | undefined
): PlanUsageAgent | null {
  if (agentType === "claude_code") return "claude_code"
  if (agentType === "codex") return "codex"
  return null
}

/**
 * "Use a reset and continue" for a Codex session: shown only while Codex has
 * a reset it can use now. Asks first, like the Subscription usage screen;
 * once the reset lands, the backend sends the session's continuation right
 * away.
 */
export function LimitResetContinueButton({
  conversationId,
  provider,
  buttonClassName,
}: {
  conversationId: number
  provider: PlanUsageAgent
  buttonClassName?: string
}) {
  const t = useTranslations("Folder.sessionActivity")
  const { report } = useLimitResets()
  const resets = findProviderResets(report, provider)
  const reset = defaultUsableReset(resets)
  const { busy, run } = useLimitResetRun(provider)
  const [confirming, setConfirming] = useState(false)
  if (!resets || !reset) return null
  const applyReset = async () => {
    const { result, message } = await run({ id: reset.id, conversationId })
    if (result?.outcome === "reset" && result.continued === conversationId) {
      toast.success(t("resetContinued"))
      return
    }
    const show =
      message.tone === "success"
        ? toast.success
        : message.tone === "error"
          ? toast.error
          : message.tone === "warning"
            ? toast.warning
            : toast.info
    show(message.text)
  }
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className={buttonClassName}
        title={t("useResetTitle", { count: resets.available })}
        disabled={busy}
        onClick={() => setConfirming(true)}
        data-testid="limit-use-reset"
      >
        {busy ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : (
          <RotateCcw aria-hidden />
        )}
        {t("useReset")}
      </Button>
      {confirming && (
        <LimitResetConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false)
          }}
          kind={reset.kind}
          label={reset.label}
          available={resets.available}
          onConfirm={() => {
            setConfirming(false)
            void applyReset()
          }}
        />
      )}
    </>
  )
}

/** How often the pool's holds are re-judged while the banner shows. */
const POOL_TICK_MS = 30_000

/**
 * "Use a reset and continue" for a Claude Code session behind the account
 * pool: shown while one of the pool's accounts has a reset it can use now.
 * It asks first ("Use 1 reset on primary?"), has the pool use it on the
 * account it frees most (one held by its limit, the grant that expires
 * first), and sends the session's continuation once it lands.
 */
export function PoolResetContinueButton({
  conversationId,
  buttonClassName,
}: {
  conversationId: number
  buttonClassName?: string
}) {
  const t = useTranslations("Folder.sessionActivity")
  const { report, load } = usePlanUsageReport()
  const now = useNowSeconds(POOL_TICK_MS)
  const reload = useCallback(() => void load(true), [load])
  const { busy, run } = usePoolResetRun(reload)
  const [confirming, setConfirming] = useState(false)
  const pick = poolResetForPause(report?.pool ?? null, now, (account) =>
    poolAccountState(account, now)
  )
  if (!pick) return null
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className={buttonClassName}
        title={t("usePoolResetTitle", { name: pick.account.name })}
        disabled={busy}
        onClick={() => setConfirming(true)}
        data-testid="limit-use-reset"
        data-reset-account={pick.account.name}
      >
        {busy ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : (
          <RotateCcw aria-hidden />
        )}
        {t("useReset")}
      </Button>
      {confirming && (
        <PoolResetConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false)
          }}
          account={pick.account.name}
          grant={pick.grant}
          onConfirm={() => {
            setConfirming(false)
            void run({
              account: pick.account.name,
              grantId: pick.grant.id,
              conversationId,
            })
          }}
        />
      )}
    </>
  )
}

/**
 * Docked above the composer of a conversation paused on the usage limit:
 * says when it continues by itself, and offers Cancel auto-continue and
 * Continue now — and, when the account has a usage-limit reset, Use a reset
 * and continue. The caller decides when it shows.
 */
export function LimitPausedBanner({
  conversationId,
  pause,
  reason = "usage_limit",
  agentType,
}: {
  conversationId: number
  pause: LimitPause
  /** What it waits for: the account's own limit, or the account pool. */
  reason?: LimitReason
  /** The session's agent, whose provider's resets it can offer. */
  agentType?: AgentType | null
}) {
  const t = useTranslations("Folder.sessionActivity")
  const parts = useLimitResetParts(pause.resets_at)
  const claimed = pause.state === "claimed"
  // Codex's reset refills its own account, so it is offered for that
  // account's limit; a Claude session's comes from the account pool, which
  // is also what a pool's pause waits on.
  const provider = claimed ? null : resetProviderOf(agentType)
  const buttonClassName =
    "border-violet-500/40 bg-transparent text-violet-700 hover:bg-violet-500/15 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
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
      {provider === "codex" && reason === "usage_limit" && (
        <LimitResetContinueButton
          conversationId={conversationId}
          provider={provider}
          buttonClassName={buttonClassName}
        />
      )}
      {provider === "claude_code" && (
        <PoolResetContinueButton
          conversationId={conversationId}
          buttonClassName={buttonClassName}
        />
      )}
      <LimitPauseButtons
        conversationId={conversationId}
        claimed={claimed}
        buttonClassName={buttonClassName}
      />
    </div>
  )
}
