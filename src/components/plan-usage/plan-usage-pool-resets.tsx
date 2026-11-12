"use client"

/**
 * A pool account's usage-limit resets and its "Recheck now", through the
 * pool's own routes (`commands/usage_pool/resets.rs`): "2 resets · first
 * expires Dec 10" with a "Use reset" that asks first (it can't be undone),
 * and, beside a hold that a reset or a rollover may have made old, a
 * "Recheck now" that has the pool read the account again. Shared by the pool
 * card and a paused session's banner.
 */

import { useCallback, useState } from "react"
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
  poolResetErrorKey,
  poolResetOutcomeKey,
  poolResetsExpiry,
  poolRefillsKey,
  poolResetToUse,
  resetOutcomeTone,
} from "@/lib/limit-resets"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolAccountState,
  PlanUsagePoolRedeemResult,
  PlanUsagePoolResetGrant,
} from "@/lib/types"

type Translate = ReturnType<typeof useTranslations<"PlanUsage">>

/** A failed pool redeem or recheck, in words: the backend names the case. */
export function poolResetErrorText(t: Translate, error: unknown): string {
  const key = poolResetErrorKey(extractAppCommandError(error)?.i18n_key)
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
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (args: {
      account: string
      grantId: string | null
      conversationId?: number | null
    }): Promise<PlanUsagePoolRedeemResult | null> => {
      setBusy(true)
      try {
        const result = await usagePoolRedeemReset({
          name: args.account,
          grantId: args.grantId,
          conversationId: args.conversationId,
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
        toast.error(poolResetErrorText(t, error))
        onChanged?.()
        return null
      } finally {
        setBusy(false)
      }
    },
    [onChanged, t]
  )
  return { busy, run }
}

/** "Use 1 reset on primary? It refills the weekly limit now and can't be
 *  undone." */
export function PoolResetConfirmDialog({
  open,
  onOpenChange,
  account,
  grant,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: string
  grant: PlanUsagePoolResetGrant
  onConfirm: () => void
}) {
  const t = useTranslations("PlanUsage")
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="pool-reset-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("resets.confirm.title")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {t.rich("pool.resets.confirmBody", {
                  name: account,
                  refills: t(poolRefillsKey(grant.kind)),
                  b: (chunks) => <bdi className="font-medium">{chunks}</bdi>,
                })}
              </p>
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
            {t("resets.confirm.use")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * "2 resets · first expires Dec 10" and "Use reset" on a pool account's
 * row. Nothing for an account without resets, or a pool that doesn't list
 * them.
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
  const [confirming, setConfirming] = useState(false)
  const resets = account.resets
  if (!pool.resets_supported || !resets || account.provider) return null
  if (resets.available <= 0) return null
  const grant = poolResetToUse(pool, account, state, now)
  const expiry = poolResetsExpiry(account)
  const cooling =
    resets.cooldown_until != null && resets.cooldown_until > now
      ? resets.cooldown_until
      : null
  const held = grant
    ? null
    : cooling != null
      ? t("pool.resets.cooldownUntil", {
          time: formatResetDate(cooling, locale, now),
        })
      : resets.grants.some((g) => g.usable_now && g.requires_limit)
        ? t("resets.needsLimit")
        : t("resets.notUsableNow")
  return (
    <div
      data-slot="pool-resets"
      className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
    >
      <p
        className="text-[0.6875rem] text-muted-foreground tabular-nums"
        data-testid="pool-resets-available"
      >
        {expiry != null
          ? t("pool.resets.availableUntil", {
              count: resets.available,
              date: formatResetDate(expiry, locale, now),
            })
          : t("pool.resets.available", { count: resets.available })}
        {held && <> · {held}</>}
        {resets.auto_redeem && <> · {t("pool.resets.auto")}</>}
      </p>
      {grant && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-6 gap-1 px-2 text-[0.6875rem]"
          disabled={busy}
          onClick={() => setConfirming(true)}
          data-testid="pool-reset-use"
        >
          {busy ? (
            <Loader2 aria-hidden className="size-3 animate-spin" />
          ) : (
            <RotateCcw aria-hidden className="size-3" />
          )}
          {busy ? t("resets.using") : t("resets.use")}
        </Button>
      )}
      {confirming && grant && (
        <PoolResetConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false)
          }}
          account={account.name}
          grant={grant}
          onConfirm={() => {
            setConfirming(false)
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
      toast.error(poolResetErrorText(t, error))
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
