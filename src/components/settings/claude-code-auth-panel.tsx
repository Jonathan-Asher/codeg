"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  XCircle,
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
  PasteSignIn,
  type PasteSignInFlow,
} from "@/components/shared/paste-sign-in"
import {
  claudeAuthLoginCancel,
  claudeAuthLoginFinish,
  claudeAuthLoginStart,
  claudeAuthLoginState,
  claudeAuthLogout,
  claudeAuthStatus,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { ClaudeAuthStatus } from "@/lib/types"

type Load =
  | { kind: "loading" }
  | { kind: "ready"; status: ClaudeAuthStatus }
  | { kind: "error"; message: string }

/**
 * Claude Code's own sign-in on the codeg host: who it is signed in as, and a
 * sign-in that works from any device — the link opens here, the code the
 * consent page shows is pasted back, and the host's CLI finishes it. Every
 * Claude Code session on the host shares this one sign-in.
 */
export function ClaudeCodeAuthPanel() {
  const t = useTranslations("AcpAgentSettings.claudeAuth")
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [signingIn, setSigningIn] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const status = await claudeAuthStatus()
      setLoad({ kind: "ready", status })
    } catch (err) {
      setLoad({ kind: "error", message: toErrorMessage(err) })
    }
  }, [])

  const refresh = useCallback(() => {
    setLoad({ kind: "loading" })
    void fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const flow = useMemo<PasteSignInFlow>(
    () => ({
      start: () => claudeAuthLoginStart(false),
      finish: claudeAuthLoginFinish,
      state: claudeAuthLoginState,
      cancel: claudeAuthLoginCancel,
    }),
    []
  )

  const signOut = useCallback(async () => {
    setSigningOut(true)
    try {
      await claudeAuthLogout()
      toast.success(t("signedOutToast"))
    } catch (err) {
      toast.error(t("signOutFailed", { message: toErrorMessage(err) }))
    } finally {
      setSigningOut(false)
      setConfirmSignOut(false)
      refresh()
    }
  }, [refresh, t])

  const status = load.kind === "ready" ? load.status : null
  const methodLabel = status ? t(`method.${status.method}`) : null

  return (
    <div
      data-slot="claude-code-auth"
      className="space-y-2 rounded-md border bg-muted/10 p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("title")}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">{t("hint")}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 shrink-0 p-0"
          title={t("refresh")}
          aria-label={t("refresh")}
          disabled={load.kind === "loading"}
          onClick={refresh}
        >
          <RefreshCw
            className={
              load.kind === "loading" ? "size-3.5 animate-spin" : "size-3.5"
            }
            aria-hidden="true"
          />
        </Button>
      </div>

      {load.kind === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {t("checking")}
        </div>
      )}
      {load.kind === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {t("statusFailed", { message: load.message })}
        </p>
      )}
      {status && (
        <div data-slot="claude-auth-status" data-logged-in={status.loggedIn}>
          {status.loggedIn ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-green-600">
              <CheckCircle2 className="size-3" aria-hidden="true" />
              {status.email
                ? t("signedInAs", { email: status.email })
                : t("signedIn")}
              <span className="text-muted-foreground">
                {" · "}
                {methodLabel}
                {status.subscription
                  ? ` · ${t("plan", { plan: status.subscription })}`
                  : ""}
              </span>
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <XCircle className="size-3" aria-hidden="true" />
              {t("signedOut")}
            </p>
          )}
        </div>
      )}

      {signingIn ? (
        <PasteSignIn
          flow={flow}
          stepOpen={t("stepOpen")}
          stepPaste={t("stepPaste")}
          pastePlaceholder={t("pastePlaceholder")}
          onDone={() => {
            toast.success(t("signedInToast"))
            setSigningIn(false)
            refresh()
          }}
          onClose={() => setSigningIn(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={status && !status.loggedIn ? "default" : "outline"}
            className="gap-1.5"
            onClick={() => setSigningIn(true)}
          >
            <LogIn className="size-3.5" aria-hidden="true" />
            {status?.loggedIn ? t("signInAgain") : t("signIn")}
          </Button>
          {status?.loggedIn && status.method !== "api_key" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={signingOut}
              onClick={() => setConfirmSignOut(true)}
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              {t("signOut")}
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("signOutConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("signOutConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={signingOut}
              onClick={(e) => {
                e.preventDefault()
                void signOut()
              }}
            >
              {t("signOut")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
