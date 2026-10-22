"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpToLine,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Shuffle,
  Trash2,
} from "lucide-react"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  PasteSignIn,
  type PasteSignInFlow,
} from "@/components/shared/paste-sign-in"
import {
  usagePoolLoginCancel,
  usagePoolLoginFinish,
  usagePoolLoginStart,
  usagePoolLoginState,
  usagePoolManageInfo,
  usagePoolRemove,
  usagePoolRename,
  usagePoolRestartNow,
  usagePoolSetEnabled,
  usagePoolSetOrder,
  usagePoolSetReserve,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { moveInList, poolOrder } from "@/lib/plan-usage"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
  PlanUsagePoolReserve,
  PoolApply,
  PoolManageInfo,
} from "@/lib/types"

/**
 * Account changes for the pool on the codeg host, driven through maxpool's
 * own tools there. Offered only where a pool is configured and maxpool can
 * be run — the host's own business; a machine without a pool shows none of
 * this.
 */
export function usePoolManage(pool: PlanUsagePool | null): {
  info: PoolManageInfo | null
  reload: () => void
} {
  const [info, setInfo] = useState<PoolManageInfo | null>(null)
  const fetchInfo = useCallback(async () => {
    const next = await usagePoolManageInfo().catch(() => null)
    setInfo(next)
  }, [])
  // Re-asked when the pool's reading changes: a change waiting for the
  // server's restart clears once the server is back.
  const checkedAt = pool?.checked_at ?? null
  useEffect(() => {
    // The state is only set once the host has answered.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchInfo()
  }, [checkedAt, fetchInfo])
  return { info, reload: () => void fetchInfo() }
}

function useApplyToast() {
  const t = useTranslations("PlanUsage.pool.manage")
  return useCallback(
    (applied: PoolApply, done: string) => {
      const note =
        applied === "live"
          ? t("appliedLive")
          : applied === "restarting"
            ? t("appliedRestarting")
            : t("appliedNeedsRestart")
      toast.success(done, { description: note })
    },
    [t]
  )
}

/** "Add account": a name (optional) and the paste sign-in. */
export function PoolAddAccountButton({ onChanged }: { onChanged: () => void }) {
  const t = useTranslations("PlanUsage.pool.manage")
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ms-auto h-7 gap-1.5"
        data-slot="pool-add-account"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t("addAccount")}
      </Button>
      {open && (
        <PoolSignInDialog
          mode={{ kind: "add" }}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  )
}

type SignInMode = { kind: "add" } | { kind: "reconnect"; name: string }

function PoolSignInDialog({
  mode,
  onClose,
  onChanged,
}: {
  mode: SignInMode
  onClose: () => void
  onChanged: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const [name, setName] = useState("")
  // Adding asks for a name first; reconnecting already has one.
  const [started, setStarted] = useState(mode.kind === "reconnect")
  const reconnectName = mode.kind === "reconnect" ? mode.name : null
  const flow = useMemo<PasteSignInFlow>(
    () => ({
      start: () =>
        reconnectName != null
          ? usagePoolLoginStart({ reconnect: reconnectName })
          : usagePoolLoginStart({ name: name.trim() || null }),
      finish: usagePoolLoginFinish,
      state: usagePoolLoginState,
      cancel: usagePoolLoginCancel,
    }),
    [reconnectName, name]
  )
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-slot="pool-sign-in-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode.kind === "reconnect"
              ? t("reconnectTitle", { name: mode.name })
              : t("addTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode.kind === "reconnect" ? t("reconnectHint") : t("addHint")}
          </DialogDescription>
        </DialogHeader>
        {started ? (
          <PasteSignIn
            flow={flow}
            stepOpen={t("stepOpen")}
            stepPaste={t("stepPaste")}
            pastePlaceholder={t("pastePlaceholder")}
            onDone={() => {
              toast.success(
                mode.kind === "reconnect"
                  ? t("reconnectedToast", { name: mode.name })
                  : t("addedToast"),
                { description: t("appliedLive") }
              )
              onChanged()
              onClose()
            }}
            onClose={onClose}
          />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs" htmlFor="pool-add-name">
                {t("nameLabel")}
              </label>
              <Input
                id="pool-add-name"
                data-slot="pool-add-name"
                value={name}
                maxLength={64}
                placeholder={t("namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setStarted(true)
                }}
                className="h-8 text-xs"
              />
            </div>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                data-slot="pool-add-continue"
                onClick={() => setStarted(true)}
              >
                {t("continue")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Run one change to the pool: a toast saying how it applies, the page read
 *  again, or the error. Resolves whether it went through. */
function useRunChange(onChanged?: () => void) {
  const t = useTranslations("PlanUsage.pool.manage")
  const applyToast = useApplyToast()
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (
      action: () => Promise<{ applied: PoolApply }>,
      done: string
    ): Promise<boolean> => {
      setBusy(true)
      try {
        const change = await action()
        applyToast(change.applied, done)
        onChanged?.()
        return true
      } catch (err) {
        toast.error(t("failed", { message: toErrorMessage(err) }))
        return false
      } finally {
        setBusy(false)
      }
    },
    [applyToast, onChanged, t]
  )
  return { busy, run }
}

/** The pool's accounts in their order, with a new order shown at once while
 *  it is written through maxpool's config: `move` reorders the Claude
 *  accounts, `clear` drops the order for automatic balancing. */
export function usePoolOrder(
  pool: PlanUsagePool,
  onChanged?: () => void
): {
  accounts: PlanUsagePoolAccount[]
  ordered: boolean
  move: (from: number, to: number) => void
  clear: () => void
} {
  const t = useTranslations("PlanUsage.pool.manage")
  const { run } = useRunChange(onChanged)
  const base = useMemo(() => poolOrder(pool), [pool])
  // The order just asked for, until the next reading of the pool shows it.
  const [asked, setAsked] = useState<{ at: number; names: string[] } | null>(
    null
  )
  const pending = asked?.at === pool.checked_at ? asked.names : null
  const accounts = useMemo(() => {
    if (!pending) return base.accounts
    const byName = new Map(base.accounts.map((a) => [a.name, a]))
    const claude = pending.flatMap((name) => byName.get(name) ?? [])
    return [...claude, ...base.accounts.filter((a) => a.provider)]
  }, [base.accounts, pending])
  const move = useCallback(
    (from: number, to: number) => {
      const names = accounts.filter((a) => !a.provider).map((a) => a.name)
      if (from === to || to < 0 || to >= names.length) return
      const next = moveInList(names, from, to)
      setAsked({ at: pool.checked_at, names: next })
      void run(() => usagePoolSetOrder(next), t("orderSaved")).then((ok) => {
        if (!ok) setAsked(null)
      })
    },
    [accounts, pool.checked_at, run, t]
  )
  const clear = useCallback(() => {
    setAsked(null)
    void run(() => usagePoolSetOrder(null), t("automaticToast"))
  }, [run, t])
  return { accounts, ordered: base.ordered || pending != null, move, clear }
}

/** Pause or resume an account. A paused account is skipped in the order. */
export function PoolPauseButton({
  account,
  onChanged,
}: {
  account: PlanUsagePoolAccount
  onChanged: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const { busy, run } = useRunChange(onChanged)
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 gap-1 px-1.5 text-[0.6875rem]"
      data-slot="pool-pause"
      disabled={busy}
      onClick={() =>
        void run(
          () => usagePoolSetEnabled(account.name, !account.enabled),
          account.enabled
            ? t("disabledToast", { name: account.name })
            : t("enabledToast", { name: account.name })
        )
      }
    >
      {account.enabled ? (
        <Pause className="size-3" aria-hidden="true" />
      ) : (
        <Play className="size-3" aria-hidden="true" />
      )}
      {account.enabled ? t("disable") : t("enable")}
    </Button>
  )
}

const RESERVE_PRESETS = [5, 10, 15, 20, 25]

/** "Reserve 10%": the account's reserve, and the place to change it. */
export function PoolReserveButton({
  account,
  onChanged,
}: {
  account: PlanUsagePoolAccount
  onChanged: () => void
}) {
  const t = useTranslations("PlanUsage.pool")
  const [open, setOpen] = useState(false)
  const reserve = account.reserve ?? null
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-slot="pool-reserve"
        className="h-5 gap-1 rounded-full px-2 text-[0.6875rem] font-normal text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Shield className="size-3" aria-hidden="true" />
        {reserve
          ? t(
              reserve.mode === "dynamic"
                ? "reserveSummaryDynamic"
                : "reserveSummary",
              { percent: reserve.percent }
            )
          : t("manage.reserveNone")}
      </Button>
      {open && (
        <PoolReserveDialog
          account={account}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  )
}

function PoolReserveDialog({
  account,
  onClose,
  onChanged,
}: {
  account: PlanUsagePoolAccount
  onClose: () => void
  onChanged: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const { busy, run } = useRunChange(onChanged)
  const current = account.reserve ?? null
  const [choice, setChoice] = useState(() =>
    current == null
      ? "none"
      : RESERVE_PRESETS.includes(current.percent)
        ? String(current.percent)
        : "custom"
  )
  const [custom, setCustom] = useState(
    current && !RESERVE_PRESETS.includes(current.percent)
      ? String(current.percent)
      : ""
  )
  const [mode, setMode] = useState<PlanUsagePoolReserve["mode"]>(
    current?.mode ?? "fixed"
  )
  const percent =
    choice === "none"
      ? null
      : Number(choice === "custom" ? custom.trim() : choice)
  const invalid =
    percent != null &&
    !(Number.isInteger(percent) && percent >= 1 && percent <= 99)
  const save = async () => {
    const ok = await run(
      () => usagePoolSetReserve(account.name, percent, mode),
      percent == null
        ? t("reserveClearedToast", { name: account.name })
        : t("reserveToast", { name: account.name, percent })
    )
    if (ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-slot="pool-reserve-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="leading-snug [overflow-wrap:anywhere]">
            {t("reserveTitle", { name: account.name })}
          </DialogTitle>
          <DialogDescription>{t("reserveBody")}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-medium">
            {t("reserveAmount")}
          </legend>
          <RadioGroup
            value={choice}
            onValueChange={setChoice}
            className="grid grid-cols-4 gap-2"
          >
            {["none", ...RESERVE_PRESETS.map(String), "custom"].map((value) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-1.5 text-xs"
              >
                <RadioGroupItem value={value} />
                {value === "none"
                  ? t("reserveOff")
                  : value === "custom"
                    ? t("reserveCustom")
                    : `${value}%`}
              </label>
            ))}
          </RadioGroup>
          {choice === "custom" && (
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              step={1}
              autoFocus
              data-slot="pool-reserve-custom"
              aria-label={t("reserveCustomLabel")}
              aria-invalid={invalid && custom !== ""}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="h-8 w-24 text-xs"
            />
          )}
          {choice === "custom" && invalid && custom !== "" && (
            <p className="text-[0.6875rem] text-destructive">
              {t("reserveInvalid")}
            </p>
          )}
        </fieldset>
        <fieldset disabled={percent == null} className="space-y-2">
          <legend className="mb-2 text-xs font-medium">
            {t("reserveMode")}
          </legend>
          <RadioGroup
            value={mode}
            onValueChange={(value) =>
              setMode(value === "dynamic" ? "dynamic" : "fixed")
            }
            className="gap-2"
          >
            {(["fixed", "dynamic"] as const).map((value) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-60"
              >
                <RadioGroupItem value={value} className="mt-0.5" />
                <span className="text-xs">
                  <span className="font-medium">
                    {value === "fixed"
                      ? t("reserveFixed")
                      : t("reserveDynamic")}
                  </span>
                  <span className="block text-[0.6875rem] text-muted-foreground">
                    {value === "fixed"
                      ? t("reserveFixedHint")
                      : t("reserveDynamicHint")}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            data-slot="pool-reserve-save"
            disabled={busy || (choice === "custom" && invalid)}
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Per-account actions: sign in again, rename, move to the top of the
 *  order, go back to automatic balancing, remove. */
export function PoolAccountActions({
  account,
  onChanged,
  onMoveToTop,
  onAutomatic,
}: {
  account: PlanUsagePoolAccount
  onChanged: () => void
  /** Put it first in the order; absent where it already is first or is not
   *  part of the order. */
  onMoveToTop?: () => void
  /** Drop the order for automatic balancing; offered on the first account
   *  of an ordered pool. */
  onAutomatic?: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const [dialog, setDialog] = useState<
    "reconnect" | "rename" | "remove" | null
  >(null)
  const { busy, run: runChange } = useRunChange(onChanged)
  const [newName, setNewName] = useState(account.name)
  const run = async (
    action: () => Promise<{ applied: PoolApply }>,
    done: string
  ) => {
    if (await runChange(action, done)) setDialog(null)
  }
  const rename = () =>
    void run(
      () => usagePoolRename(account.name, newName),
      t("renamedToast", { name: newName.trim() })
    )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            data-slot="pool-account-actions"
            aria-label={t("actionsFor", { name: account.name })}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-slot="pool-action-reconnect"
            onSelect={() => setDialog("reconnect")}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {account.refresh_failed ? t("reconnect") : t("signInAgain")}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-slot="pool-action-rename"
            onSelect={() => {
              setNewName(account.name)
              setDialog("rename")
            }}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            {t("rename")}
          </DropdownMenuItem>
          {onMoveToTop && (
            <DropdownMenuItem
              data-slot="pool-action-top"
              onSelect={onMoveToTop}
            >
              <ArrowUpToLine className="size-3.5" aria-hidden="true" />
              {t("moveToTop")}
            </DropdownMenuItem>
          )}
          {onAutomatic && (
            <DropdownMenuItem
              data-slot="pool-action-automatic"
              onSelect={onAutomatic}
            >
              <Shuffle className="size-3.5" aria-hidden="true" />
              {t("useAutomatic")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-slot="pool-action-remove"
            variant="destructive"
            onSelect={() => setDialog("remove")}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {t("remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "reconnect" && (
        <PoolSignInDialog
          mode={{ kind: "reconnect", name: account.name }}
          onClose={() => setDialog(null)}
          onChanged={onChanged}
        />
      )}

      <Dialog
        open={dialog === "rename"}
        onOpenChange={(next) => !next && setDialog(null)}
      >
        <DialogContent data-slot="pool-rename-dialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="leading-snug [overflow-wrap:anywhere]">
              {t("renameTitle", { name: account.name })}
            </DialogTitle>
            <DialogDescription>{t("renameHint")}</DialogDescription>
          </DialogHeader>
          <Input
            data-slot="pool-rename-input"
            value={newName}
            maxLength={64}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim() && !busy) rename()
            }}
            className="h-8 text-xs"
          />
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              data-slot="pool-rename-save"
              disabled={busy || !newName.trim()}
              onClick={rename}
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={dialog === "remove"}
        onOpenChange={(next) => !next && setDialog(null)}
      >
        <AlertDialogContent data-slot="pool-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle className="leading-snug [overflow-wrap:anywhere]">
              {t("removeTitle", { name: account.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("removeBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-slot="pool-remove-confirm-action"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void run(
                  () => usagePoolRemove(account.name),
                  t("removedToast", { name: account.name })
                )
              }}
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** A removal or rename that only a restart of the pool's server applies. */
export function PoolReloadNotice({
  info,
  onChanged,
}: {
  info: PoolManageInfo
  onChanged: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const [busy, setBusy] = useState(false)
  if (info.reload === "idle") return null
  return (
    <div
      role="status"
      data-slot="pool-reload-notice"
      data-reload={info.reload}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
    >
      <span className="min-w-0 flex-1">
        {info.reload === "waiting"
          ? t("reloadWaiting")
          : t("reloadNeedsRestart")}
      </span>
      {info.reload === "waiting" && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await usagePoolRestartNow()
            } catch (err) {
              toast.error(t("failed", { message: toErrorMessage(err) }))
            } finally {
              setBusy(false)
              onChanged()
            }
          }}
        >
          {busy && (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          )}
          {t("restartNow")}
        </Button>
      )}
    </div>
  )
}
