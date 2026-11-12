"use client"

/**
 * Usage-limit resets on the Subscription usage cards: Codex's
 * (`commands/limit_resets.rs`) — how many are left and until when, and a
 * "Use reset" that asks first (it can't be undone), shows the attempt, says
 * what came of it and offers to continue the sessions paused at the limit —
 * and, on Claude Code's own card, where Claude's resets are used (its
 * terminal app and claude.ai; a pool's accounts show theirs on the pool
 * card). The confirmation and the attempt are shared with a paused
 * session's banner (`conversations/limit-pause.tsx`).
 */

import { useCallback, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ExternalLink, Loader2, Play, RotateCcw } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { publishProviderResets } from "@/hooks/use-limit-resets"
import { consumeLimitReset, continueLimitNow } from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { openInSystemBrowser } from "@/lib/link-open"
import {
  CLAUDE_USAGE_URL,
  formatResetDate,
  groupLimitResets,
  isQuietResetError,
  resetErrorKey,
  resetErrorKeyFromApp,
  resetKindKey,
  resetOutcomeKey,
  resetOutcomeTone,
  resetRefillsKey,
  soonestResetExpiry,
  type LimitResetGroup,
} from "@/lib/limit-resets"
import type {
  LimitResetKind,
  PlanUsageAgent,
  ProviderLimitResets,
  UseLimitResetResult,
} from "@/lib/types"
import { cn } from "@/lib/utils"

type Translate = ReturnType<typeof useTranslations<"PlanUsage">>

export interface ResetMessage {
  tone: "success" | "info" | "warning" | "error"
  text: string
}

/** What an attempt came to, in words. */
export function resetOutcomeText(
  t: Translate,
  result: UseLimitResetResult
): string {
  const text = t(resetOutcomeKey(result.outcome))
  if (result.outcome === "reset" && result.resets) {
    return `${text} ${t("resets.left", { count: result.resets.available })}`
  }
  return text
}

/** A failed attempt, in words: the backend names the case. */
export function resetErrorText(t: Translate, error: unknown): string {
  const app = extractAppCommandError(error)
  const key = resetErrorKeyFromApp(app?.i18n_key, app?.i18n_params?.reason)
  return key ? t(key) : toErrorMessage(error)
}

/** Use a reset of one provider, keeping every screen's listing current. */
export function useLimitResetRun(
  provider: PlanUsageAgent,
  onUsed?: (result: UseLimitResetResult) => void
) {
  const t = useTranslations("PlanUsage")
  const [busyId, setBusyId] = useState<string | null | undefined>(undefined)
  const [message, setMessage] = useState<ResetMessage | null>(null)
  const [result, setResult] = useState<UseLimitResetResult | null>(null)
  const run = useCallback(
    async (args: {
      id: string | null
      conversationId?: number | null
    }): Promise<{
      result: UseLimitResetResult | null
      message: ResetMessage
    }> => {
      setBusyId(args.id)
      setMessage(null)
      setResult(null)
      try {
        const used = await consumeLimitReset({
          provider,
          id: args.id,
          conversationId: args.conversationId,
        })
        if (used.resets) publishProviderResets(used.resets)
        const said: ResetMessage = {
          tone: resetOutcomeTone(used.outcome),
          text: resetOutcomeText(t, used),
        }
        setResult(used)
        setMessage(said)
        onUsed?.(used)
        return { result: used, message: said }
      } catch (error) {
        const said: ResetMessage = {
          tone: "error",
          text: resetErrorText(t, error),
        }
        setMessage(said)
        return { result: null, message: said }
      } finally {
        setBusyId(undefined)
      }
    },
    [provider, onUsed, t]
  )
  return {
    /** The reset being used (`null`: the provider's pick); `undefined`
     *  while idle. */
    busyId,
    busy: busyId !== undefined,
    run,
    message,
    result,
  }
}

/** "Use 1 of N resets? This refills … now. It can't be undone." */
export function LimitResetConfirmDialog({
  open,
  onOpenChange,
  kind,
  label,
  available,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: LimitResetKind
  /** The provider's name for the reset, when it gives one. */
  label: string | null
  /** Resets left in all, for "1 of N". */
  available: number
  onConfirm: () => void
}) {
  const t = useTranslations("PlanUsage")
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="limit-reset-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("resets.confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {t("resets.confirm.body", {
                  count: Math.max(1, available),
                  refills: t(resetRefillsKey(kind)),
                })}
              </p>
              {label && (
                <p className="text-xs text-muted-foreground">{label}</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("resets.confirm.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="limit-reset-confirm-use"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {t("resets.confirm.use")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const MESSAGE_TONE: Record<ResetMessage["tone"], string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  info: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-400",
  error: "text-destructive",
}

/**
 * A provider card's resets: "Resets available: N · expires …", one row per
 * kind of reset with its own "Use reset", then what the last attempt came
 * to. Says nothing for an agent that isn't installed here.
 */
export function ProviderResetsSection({
  agent,
  resets,
  loading,
  now,
  onUsed,
}: {
  agent: PlanUsageAgent
  resets: ProviderLimitResets | null
  /** The first listing is still on its way. */
  loading: boolean
  now: number
  /** A reset was used (or tried): re-read the bars. */
  onUsed?: (result: UseLimitResetResult) => void
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const { busyId, busy, run, message, result } = useLimitResetRun(agent, onUsed)
  const [pending, setPending] = useState<LimitResetGroup | null>(null)
  const [continuing, setContinuing] = useState<
    "idle" | "running" | "done" | "failed"
  >("idle")

  const continuePaused = useCallback(async (ids: number[]) => {
    setContinuing("running")
    const sent = await Promise.allSettled(ids.map((id) => continueLimitNow(id)))
    setContinuing(sent.some((s) => s.status === "rejected") ? "failed" : "done")
  }, [])

  if (resets == null) {
    if (!loading) return null
    return (
      <div
        data-slot="limit-resets"
        className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground"
      >
        {t("resets.checking")}
      </div>
    )
  }
  if (isQuietResetError(resets.error)) return null

  const groups = groupLimitResets(resets.items)
  const soonest = soonestResetExpiry(resets)
  const paused = result?.outcome === "reset" ? result.paused_conversations : []

  return (
    <div
      data-slot="limit-resets"
      data-agent={agent}
      className="mt-4 border-t border-border pt-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-xs font-medium">{t("resets.title")}</h3>
        {resets.error == null && (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="limit-resets-available"
          >
            {resets.available > 0
              ? soonest != null
                ? t("resets.availableUntil", {
                    count: resets.available,
                    date: formatResetDate(soonest, locale, now),
                  })
                : t("resets.available", { count: resets.available })
              : t("resets.none")}
          </span>
        )}
      </div>
      {resets.account && (
        <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">
          {t("resets.account", { account: resets.account })}
        </p>
      )}
      {resets.error && (
        <p
          role="note"
          data-error={resets.error.code}
          className="mt-1.5 text-xs leading-relaxed text-muted-foreground"
        >
          {t(resetErrorKey(resets.error))}
        </p>
      )}
      {groups.length > 0 && (
        <ul className="mt-2 space-y-2">
          {groups.map((group) => {
            const usingThis = busy && busyId === group.id
            return (
              <li
                key={group.key}
                data-reset-kind={group.kind}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p
                    className="truncate text-sm"
                    title={group.description ?? undefined}
                  >
                    {group.label ?? t(resetKindKey(group.kind))}
                    {group.count > 1 && (
                      <span className="ms-1.5 text-xs tabular-nums text-muted-foreground">
                        {t("resets.times", { count: group.count })}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {group.expires_at != null
                      ? t("resets.expires", {
                          date: formatResetDate(group.expires_at, locale, now),
                        })
                      : t("resets.noExpiry")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy}
                  onClick={() => setPending(group)}
                  data-testid="limit-reset-use"
                >
                  {usingThis ? (
                    <Loader2 aria-hidden className="animate-spin" />
                  ) : (
                    <RotateCcw aria-hidden />
                  )}
                  {usingThis ? t("resets.using") : t("resets.use")}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {message && (
        <p
          role="status"
          data-tone={message.tone}
          className={cn(
            "mt-2 text-xs leading-relaxed",
            MESSAGE_TONE[message.tone]
          )}
        >
          {message.text}
        </p>
      )}
      {paused.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-500/30 bg-violet-500/5 px-2.5 py-1.5 text-xs text-violet-700 dark:text-violet-300">
          <span>
            {continuing === "done"
              ? t("resets.continuedPaused", { count: paused.length })
              : continuing === "failed"
                ? t("resets.continuePausedFailed")
                : t("resets.pausedSessions", { count: paused.length })}
          </span>
          {continuing !== "done" && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={continuing === "running"}
              onClick={() => void continuePaused(paused)}
              data-testid="limit-reset-continue-paused"
            >
              {continuing === "running" ? (
                <Loader2 aria-hidden className="animate-spin" />
              ) : (
                <Play aria-hidden />
              )}
              {t("resets.continuePaused")}
            </Button>
          )}
        </div>
      )}
      {pending && (
        <LimitResetConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null)
          }}
          kind={pending.kind}
          label={pending.label}
          available={resets.available}
          onConfirm={() => {
            const chosen = pending
            setPending(null)
            setContinuing("idle")
            void run({ id: chosen.id })
          }}
        />
      )}
    </div>
  )
}

/**
 * Claude Code's resets on its own card (no pool in between): Claude offers
 * them only in Claude Code's terminal app (`/limit-reset`) and on claude.ai,
 * so the card says so and opens claude.ai's usage page.
 */
export function ClaudeResetsElsewhere() {
  const t = useTranslations("PlanUsage")
  return (
    <div
      data-slot="limit-resets"
      data-agent="claude_code"
      className="mt-4 border-t border-border pt-3"
    >
      <h3 className="text-xs font-medium">{t("resets.title")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {t("resets.claude.elsewhere")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void openInSystemBrowser(CLAUDE_USAGE_URL)}
          data-testid="claude-resets-open"
        >
          <ExternalLink aria-hidden />
          {t("resets.claude.open")}
        </Button>
        <span className="text-[0.6875rem] text-muted-foreground">
          {t.rich("resets.claude.hint", {
            code: (chunks) => (
              <code className="rounded bg-muted px-1 font-mono">{chunks}</code>
            ),
          })}
        </span>
      </div>
    </div>
  )
}
