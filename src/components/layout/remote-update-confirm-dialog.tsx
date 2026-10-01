"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AgentType } from "@/lib/types"
import {
  type BusyReason,
  type BusySession,
  type BusySessionsReport,
  type UpdateMode,
  getBusySessions,
} from "@/lib/updater"
import { cn } from "@/lib/utils"

/** The quiet window the remote waits out before a "when idle" install
 * (`IDLE_QUIET` in src-tauri/src/update/desktop_remote.rs). */
const QUIET_SECONDS = 60

const REASON_KEYS = {
  working: "busyReasonWorking",
  needs_you: "busyReasonNeedsYou",
  background: "busyReasonBackground",
} as const satisfies Record<BusyReason, string>

/** The sessions a restart would cut off, one line each. */
export function BusySessionList({
  sessions,
  className,
}: {
  sessions: BusySession[]
  className?: string
}) {
  const t = useTranslations("SystemSettings")
  return (
    <ul
      className={cn(
        "max-h-40 space-y-1 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 text-xs",
        className
      )}
    >
      {sessions.map((session, i) => (
        <li
          key={session.conversationId ?? `unbound-${i}`}
          className="flex items-center justify-between gap-3"
        >
          <span className="min-w-0 truncate">
            {session.title?.trim() || t("untitledSession")}
            {session.agentType && (
              <span className="text-muted-foreground">
                {" · "}
                {getAgentLabel(session.agentType as AgentType)}
              </span>
            )}
          </span>
          <span
            className={cn(
              "shrink-0 text-2xs",
              session.reason === "needs_you"
                ? "text-amber-500"
                : "text-muted-foreground"
            )}
          >
            {t(REASON_KEYS[session.reason] ?? REASON_KEYS.working)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ConfirmBody({
  remoteName,
  version,
  onConfirm,
}: {
  remoteName: string | null
  version: string | null
  onConfirm: (mode: UpdateMode) => void
}) {
  const t = useTranslations("SystemSettings")
  const [report, setReport] = useState<BusySessionsReport | null>(null)
  const [failed, setFailed] = useState(false)

  // Mounted with the dialog's content, so every opening reads afresh.
  useEffect(() => {
    let cancelled = false
    getBusySessions()
      .then((next) => {
        if (!cancelled) setReport(next)
      })
      .catch((err) => {
        console.error("[Update] busy sessions failed:", err)
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const name = remoteName ?? t("updateTargetRemoteFallback")
  const busy = report?.sessions ?? []

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {version
            ? t("remoteUpdateDialogTitle", { name, version })
            : t("remoteUpdateDialogTitleNoVersion", { name })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {t("remoteUpdateDialogDescription", { name })}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div className="space-y-2 text-xs" data-testid="remote-update-busy">
        {!report && !failed ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("remoteUpdateCheckingSessions")}
          </div>
        ) : failed ? (
          <p className="text-amber-500">{t("remoteUpdateSessionsUnknown")}</p>
        ) : busy.length > 0 ? (
          <>
            <p className="font-medium">
              {t("remoteUpdateBusyHeading", { count: busy.length })}
            </p>
            <BusySessionList sessions={busy} />
          </>
        ) : (
          <p className="text-muted-foreground">{t("remoteUpdateNoBusy")}</p>
        )}
        {report && (
          <p className="text-muted-foreground leading-5">
            {report.autoResume
              ? t("remoteUpdateAutoResumeOn")
              : t("remoteUpdateAutoResumeOff", { name })}
          </p>
        )}
        <p className="text-muted-foreground leading-5">
          {t("remoteUpdateWhenIdleHint", { seconds: QUIET_SECONDS })}
        </p>
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel>{t("remoteUpdateCancel")}</AlertDialogCancel>
        <Button variant="outline" onClick={() => onConfirm("now")}>
          {t("remoteUpdateNow")}
        </Button>
        <Button data-autofocus onClick={() => onConfirm("when_idle")}>
          {t("remoteUpdateWhenIdle")}
        </Button>
      </AlertDialogFooter>
    </>
  )
}

/**
 * Asks before updating a remote desktop app: its restart cuts off every turn
 * in flight there, so this lists the sessions mid-turn (working, waiting on the
 * user, or held for background work) and offers to wait until they are done.
 * "Update when idle" is the default — focused, and what Enter picks.
 */
export function RemoteUpdateConfirmDialog({
  open,
  onOpenChange,
  remoteName,
  version,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  remoteName: string | null
  version: string | null
  onConfirm: (mode: UpdateMode) => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        ref={contentRef}
        className="data-[size=default]:sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          const preferred =
            contentRef.current?.querySelector<HTMLElement>("[data-autofocus]")
          if (preferred) {
            event.preventDefault()
            preferred.focus()
          }
        }}
      >
        <ConfirmBody
          remoteName={remoteName}
          version={version}
          onConfirm={onConfirm}
        />
      </AlertDialogContent>
    </AlertDialog>
  )
}
