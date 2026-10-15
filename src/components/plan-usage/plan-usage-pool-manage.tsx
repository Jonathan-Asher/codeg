"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
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
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  PlanUsagePool,
  PlanUsagePoolAccount,
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

/** Per-account actions: sign in again, rename, switch off/on, remove. */
export function PoolAccountActions({
  account,
  onChanged,
}: {
  account: PlanUsagePoolAccount
  onChanged: () => void
}) {
  const t = useTranslations("PlanUsage.pool.manage")
  const applyToast = useApplyToast()
  const [dialog, setDialog] = useState<
    "reconnect" | "rename" | "remove" | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState(account.name)

  const run = useCallback(
    async (action: () => Promise<{ applied: PoolApply }>, done: string) => {
      setBusy(true)
      try {
        const change = await action()
        applyToast(change.applied, done)
        onChanged()
        setDialog(null)
      } catch (err) {
        toast.error(t("failed", { message: toErrorMessage(err) }))
      } finally {
        setBusy(false)
      }
    },
    [applyToast, onChanged, t]
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
          <DropdownMenuItem
            data-slot="pool-action-toggle"
            onSelect={() =>
              void run(
                () => usagePoolSetEnabled(account.name, !account.enabled),
                account.enabled
                  ? t("disabledToast", { name: account.name })
                  : t("enabledToast", { name: account.name })
              )
            }
          >
            {account.enabled ? (
              <PowerOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Power className="size-3.5" aria-hidden="true" />
            )}
            {account.enabled ? t("disable") : t("enable")}
          </DropdownMenuItem>
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
            <DialogTitle>
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
              if (e.key === "Enter" && newName.trim() && !busy) {
                void run(
                  () => usagePoolRename(account.name, newName),
                  t("renamedToast", { name: newName.trim() })
                )
              }
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
              onClick={() =>
                void run(
                  () => usagePoolRename(account.name, newName),
                  t("renamedToast", { name: newName.trim() })
                )
              }
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
            <AlertDialogTitle>
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
