"use client"

/**
 * A pool account's usage-limit resets and its "Recheck now", through the
 * pool's own routes (`commands/usage_pool/resets.rs`): a row per kind of
 * reset saying which limit it refills ("1 Fable reset · refills only your
 * Fable weekly limit · expires Dec 10") with a "Use reset" that asks first
 * (it can't be undone) — held back, with the reason, where it would gain
 * nothing — and, beside a hold that a reset or a rollover may have made
 * old, a "Recheck now" that has the pool read the account again. Shared by
 * the pool card and a paused session's banner.
 *
 * The pool's advice shows too: "Reset available" at the top of the card for
 * each account it would use a reset on now, and, on an account whose limit
 * renews by itself soon (which the pool holds resets back on), when it
 * renews — its Use reset then asks with that warning and has the pool go
 * ahead anyway.
 */

import { useCallback, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Loader2, RefreshCw, RotateCcw } from "lucide-react"
import { toast } from "sonner"

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
import { usagePoolRecheck, usagePoolRedeemReset } from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import {
  formatResetDate,
  poolGrantFit,
  poolRenewsAt,
  poolRenewsSoon,
  poolResetErrorKey,
  poolResetGroupKey,
  poolResetGroups,
  poolResetOutcomeKey,
  poolResetRecommendations,
  poolRefillsKey,
  poolResetToUse,
  resetOutcomeTone,
  type PoolGrantFit,
} from "@/lib/limit-resets"
import { formatCompactDuration, formatHoldEnd } from "@/lib/plan-usage"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolAccountState,
  PlanUsagePoolRedeemResult,
  PlanUsagePoolResetGrant,
} from "@/lib/types"

type Translate = ReturnType<typeof useTranslations<"PlanUsage">>

/** A failed pool redeem or recheck, in words: the backend names the case
 *  (and, for an account whose limit renews by itself soon, when). */
export function poolResetErrorText(
  t: Translate,
  error: unknown,
  locale: string
): string {
  const appError = extractAppCommandError(error)
  const key = poolResetErrorKey(appError?.i18n_key)
  if (key === "pool.resets.error.renewsSoon") {
    const at = Number(appError?.i18n_params?.renews_at)
    const now = Math.floor(Date.now() / 1000)
    if (Number.isFinite(at) && at > now) {
      return t("pool.resets.error.renewsSoonAt", {
        time: formatHoldEnd(at, locale, now),
      })
    }
  }
  return key ? t(key) : toErrorMessage(error)
}

function showToast(tone: "success" | "info" | "warning", text: string) {
  if (tone === "success") toast.success(text)
  else if (tone === "warning") toast.warning(text)
  else toast.info(text)
}

/** Use a pool account's reset, saying what came of it. */
export function usePoolResetRun(onChanged?: () => void) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (args: {
      account: string
      grantId: string | null
      conversationId?: number | null
      /** Go ahead though the account's limit renews by itself soon: only
       *  after the confirmation said so. */
      force?: boolean
    }): Promise<PlanUsagePoolRedeemResult | null> => {
      setBusy(true)
      try {
        const result = await usagePoolRedeemReset({
          name: args.account,
          grantId: args.grantId,
          conversationId: args.conversationId,
          ...(args.force ? { force: true } : {}),
        })
        if (
          args.conversationId != null &&
          result.continued === args.conversationId
        ) {
          toast.success(t("pool.resets.continued", { name: result.account }))
        } else {
          showToast(
            resetOutcomeTone(result.outcome),
            t(poolResetOutcomeKey(result.outcome), { name: result.account })
          )
        }
        onChanged?.()
        return result
      } catch (error) {
        toast.error(poolResetErrorText(t, error, locale))
        onChanged?.()
        return null
      } finally {
        setBusy(false)
      }
    },
    [locale, onChanged, t]
  )
  return { busy, run }
}

/** An account whose limit renews by itself soon, for its confirmation. */
export interface PoolRenewsSoon {
  /** When it renews (epoch seconds), when known. */
  at: number | null
  now: number
  /** How close to its renewal the pool holds a reset back (seconds). */
  guardSecs?: number | null
}

/** "Use 1 reset on primary? It refills the weekly limit now and can't be
 *  undone." — and for one model's own reset, "Use 1 Fable reset on primary?
 *  It refills only the weekly limit for Fable models, not your general
 *  weekly limit, and can't be undone." On an account whose limit renews by
 *  itself soon (`renews`), it also says when, that a reset now is mostly
 *  wasted, and asks to use it anyway. */
export function PoolResetConfirmDialog({
  open,
  onOpenChange,
  account,
  grant,
  fit,
  renews,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: string
  grant: PlanUsagePoolResetGrant
  /** How it stands against the account's limits now, when known. */
  fit?: PoolGrantFit | null
  renews?: PoolRenewsSoon | null
  onConfirm: () => void
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const b = (chunks: ReactNode) => <bdi className="font-medium">{chunks}</bdi>
  const guardHours =
    renews?.guardSecs != null && renews.guardSecs > 0
      ? Math.max(1, Math.round(renews.guardSecs / 3600))
      : null
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        data-testid="pool-reset-confirm"
        data-renews-soon={renews ? "true" : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("resets.confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p data-testid="pool-reset-confirm-body">
                {grant.kind === "model_weekly"
                  ? t.rich("pool.resets.confirmBodyModel", {
                      name: account,
                      model: grant.model ?? "",
                      b,
                    })
                  : t.rich("pool.resets.confirmBody", {
                      name: account,
                      refills: t(poolRefillsKey(grant.kind)),
                      b,
                    })}
              </p>
              {fit?.kind === "gives_back_only" && (
                <p className="text-xs" data-testid="pool-reset-confirm-note">
                  {t("pool.resets.givesBackOnlyNote", { model: fit.model })}
                </p>
              )}
              {renews && (
                <p
                  className="text-xs text-amber-700 dark:text-amber-400"
                  data-testid="pool-reset-confirm-renews"
                >
                  {renews.at != null && renews.at > renews.now
                    ? t("pool.resets.renewsSoonConfirm", {
                        time: formatHoldEnd(renews.at, locale, renews.now),
                        duration: formatCompactDuration(
                          renews.at - renews.now,
                          locale
                        ),
                      })
                    : t("pool.resets.renewsSoonConfirmUnknown")}
                  {guardHours != null && (
                    <>
                      {" "}
                      {t("pool.resets.renewsSoonGuard", { hours: guardHours })}
                    </>
                  )}
                </p>
              )}
              {grant.label && (
                <p className="text-xs text-muted-foreground">{grant.label}</p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("resets.confirm.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="pool-reset-confirm-use"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {renews ? t("pool.resets.useAnyway") : t("resets.confirm.use")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * A pool account's resets on its row: one line per kind of reset — how
 * many, which limit each refills, when they expire — with its own "Use
 * reset". A reset that would gain nothing now (one model's own, while the
 * account is at a limit every request meets) has its button held back with
 * the reason; one whose refill isn't known is shown, never used. Nothing
 * for an account without resets, or a pool that doesn't list them.
 */
export function PoolAccountResetsLine({
  pool,
  account,
  state,
  now,
  onChanged,
}: {
  pool: PlanUsagePool
  account: PlanUsagePoolAccount
  state: PlanUsagePoolAccountState
  now: number
  /** Re-read the pool after a reset was used (or tried). */
  onChanged?: () => void
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const { busy, run } = usePoolResetRun(onChanged)
  const [confirming, setConfirming] = useState<PlanUsagePoolResetGrant | null>(
    null
  )
  // The grant last sent to the pool: its row shows the attempt.
  const [sent, setSent] = useState<string | null>(null)
  const resets = account.resets
  if (!pool.resets_supported || !resets || account.provider) return null
  if (resets.available <= 0) return null
  const groups = poolResetGroups(account)
  if (groups.length === 0) return null
  const cooling =
    resets.cooldown_until != null && resets.cooldown_until > now
      ? resets.cooldown_until
      : null
  // The pool holds a reset back on an account whose limit renews by itself
  // soon: say when, and ask with that before having it go ahead anyway.
  const renewsSoon = poolRenewsSoon(account)
  const renewsAt = renewsSoon ? poolRenewsAt(account, now) : null
  const renewsText = renewsSoon
    ? renewsAt != null
      ? t("pool.resets.renewsSoon", {
          duration: formatCompactDuration(renewsAt - now, locale),
        })
      : t("pool.resets.renewsSoonUnknown")
    : null
  return (
    <div data-slot="pool-resets" className="mt-1.5 space-y-1">
      {renewsText && (
        <p
          className="text-[0.6875rem] text-amber-700 dark:text-amber-400"
          title={resets.advice ?? undefined}
          data-testid="pool-renews-soon"
        >
          {renewsText}
        </p>
      )}
      {groups.map((group, index) => {
        const grant = poolResetToUse(pool, account, state, now, group.grants)
        const fit = grant ? poolGrantFit(account, grant, now) : null
        const advice =
          fit?.kind === "wont_help"
            ? t(
                fit.limit === "weekly"
                  ? "pool.resets.wontHelp.weekly"
                  : "pool.resets.wontHelp.session"
              )
            : fit?.kind === "gives_back_only"
              ? t("pool.resets.givesBackOnly", { model: fit.model })
              : null
        // Why there is no button, for a kind whose refill is known.
        const held =
          grant || group.kind === "other"
            ? null
            : cooling != null
              ? t("pool.resets.cooldownUntil", {
                  time: formatResetDate(cooling, locale, now),
                })
              : group.grants.some((g) => g.usable_now && g.requires_limit)
                ? t("resets.needsLimit")
                : t("resets.notUsableNow")
        const wontHelp = fit?.kind === "wont_help"
        const usingThis = busy && grant != null && sent === grant.id
        return (
          <div
            key={group.key}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
            data-reset-kind={group.kind}
            data-reset-fit={fit?.kind}
          >
            <p
              className="text-[0.6875rem] text-muted-foreground tabular-nums"
              data-testid="pool-resets-available"
            >
              {t(poolResetGroupKey(group.kind), {
                count: group.count,
                model: group.model ?? "",
              })}
              {group.expires_at != null && (
                <>
                  {" · "}
                  {t("pool.resets.expires", {
                    date: formatResetDate(group.expires_at, locale, now),
                  })}
                </>
              )}
              {held && <> · {held}</>}
              {advice && (
                <>
                  {" · "}
                  <span
                    className={
                      wontHelp ? "text-amber-700 dark:text-amber-400" : ""
                    }
                    data-testid="pool-reset-advice"
                  >
                    {advice}
                  </span>
                </>
              )}
              {index === 0 && resets.auto_redeem && (
                <> · {t("pool.resets.auto")}</>
              )}
            </p>
            {grant && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="h-6 gap-1 px-2 text-[0.6875rem]"
                disabled={busy || wontHelp}
                title={
                  wontHelp ? (advice ?? undefined) : (renewsText ?? undefined)
                }
                onClick={() => setConfirming(grant)}
                data-testid="pool-reset-use"
                data-renews-soon={renewsSoon ? "true" : undefined}
              >
                {usingThis ? (
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                ) : (
                  <RotateCcw aria-hidden className="size-3" />
                )}
                {usingThis ? t("resets.using") : t("resets.use")}
              </Button>
            )}
          </div>
        )
      })}
      {confirming && (
        <PoolResetConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null)
          }}
          account={account.name}
          grant={confirming}
          fit={poolGrantFit(account, confirming, now)}
          renews={
            renewsSoon
              ? {
                  at: renewsAt,
                  now,
                  guardSecs: pool.reset_claim_guard_secs ?? null,
                }
              : null
          }
          onConfirm={() => {
            const grant = confirming
            setConfirming(null)
            setSent(grant.id)
            void run({
              account: account.name,
              grantId: grant.id,
              force: renewsSoon,
            })
          }}
        />
      )}
    </div>
  )
}

/**
 * "Reset available: primary is at its limit", at the top of the pool card:
 * one line per account the pool would use a reset on now, with a Use reset
 * for the grant it names. It asks first, with the same confirmation as the
 * account's row (it names the account and can't be undone). The pool's own
 * reason shows as a hint. Nothing when it recommends none, or doesn't list
 * resets.
 */
export function PoolResetRecommendations({
  pool,
  now,
  onChanged,
}: {
  pool: PlanUsagePool
  now: number
  /** Re-read the pool after a reset was used (or tried). */
  onChanged?: () => void
}) {
  const t = useTranslations("PlanUsage")
  const { busy, run } = usePoolResetRun(onChanged)
  const [confirming, setConfirming] = useState<{
    account: PlanUsagePoolAccount
    grant: PlanUsagePoolResetGrant
  } | null>(null)
  // The account last sent to the pool: its line shows the attempt.
  const [sent, setSent] = useState<string | null>(null)
  const picks = poolResetRecommendations(pool, now)
  if (picks.length === 0) return null
  const b = (chunks: ReactNode) => <bdi className="font-medium">{chunks}</bdi>
  return (
    <div
      role="status"
      data-slot="pool-reset-recommended"
      className="space-y-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs leading-relaxed text-emerald-800 dark:text-emerald-300"
    >
      {picks.map(({ account, grant }) => {
        const usingThis = busy && sent === account.name
        return (
          <div
            key={account.name}
            data-account={account.name}
            data-grant={grant.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
          >
            <p
              className="flex min-w-0 items-center gap-1.5"
              title={account.resets?.advice ?? undefined}
              data-testid="pool-reset-recommended-text"
            >
              <RotateCcw aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0">
                {t.rich("pool.resets.recommended", { name: account.name, b })}
              </span>
            </p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-6 gap-1 border-emerald-500/40 bg-transparent px-2 text-[0.6875rem] text-emerald-800 hover:bg-emerald-500/15 dark:text-emerald-300"
              disabled={busy}
              onClick={() => setConfirming({ account, grant })}
              data-testid="pool-reset-recommended-use"
            >
              {usingThis ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : (
                <RotateCcw aria-hidden className="size-3" />
              )}
              {usingThis ? t("resets.using") : t("resets.use")}
            </Button>
          </div>
        )
      })}
      {confirming && (
        <PoolResetConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null)
          }}
          account={confirming.account.name}
          grant={confirming.grant}
          fit={poolGrantFit(confirming.account, confirming.grant, now)}
          onConfirm={() => {
            const { account, grant } = confirming
            setConfirming(null)
            setSent(account.name)
            void run({ account: account.name, grantId: grant.id })
          }}
        />
      )}
    </div>
  )
}

/** "Recheck now": the pool reads the account's usage again, so a hold a
 *  reset or a rollover has made old is lifted at once. Never uses a reset. */
export function PoolRecheckButton({
  account,
  onChanged,
}: {
  account: PlanUsagePoolAccount
  onChanged?: () => void
}) {
  const t = useTranslations("PlanUsage")
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const recheck = async () => {
    setBusy(true)
    try {
      const result = await usagePoolRecheck(account.name)
      if (result.lifted) {
        toast.success(t("pool.resets.recheckLifted", { name: account.name }))
      } else if (result.read) {
        toast.info(t("pool.resets.recheckSame", { name: account.name }))
      } else {
        toast.warning(t("pool.resets.recheckUnread", { name: account.name }))
      }
    } catch (error) {
      toast.error(poolResetErrorText(t, error, locale))
    } finally {
      setBusy(false)
      onChanged?.()
    }
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-5 gap-1 px-1.5 text-[0.6875rem] text-muted-foreground"
      disabled={busy}
      onClick={() => void recheck()}
      title={t("pool.resets.recheckTitle")}
      data-testid="pool-recheck"
    >
      {busy ? (
        <Loader2 aria-hidden className="size-3 animate-spin" />
      ) : (
        <RefreshCw aria-hidden className="size-3" />
      )}
      {t("pool.resets.recheck")}
    </Button>
  )
}
