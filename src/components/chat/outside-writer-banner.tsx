"use client"

import { useState } from "react"
import { Hourglass, Plug } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

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
  formatOutsideWriterStart,
  type OutsideWriter,
} from "@/lib/outside-writer"
import type { OutsideWriterPhase } from "@/stores/outside-writer-store"

/**
 * Docked above the composer of a session another process runs (see
 * `lib/outside-writer`). While codeg waits: which process, since when, and
 * that codeg connects once it finishes — with "Connect anyway" (confirmed
 * first: two processes writing one session can split its history) and a way
 * to stop waiting. Once the user stopped waiting: a plain "Connect", which
 * checks again. The caller owns what the actions do and when it shows.
 */
export function OutsideWriterBanner({
  writer,
  phase,
  onConnectAnyway,
  onStopWaiting,
  onConnect,
}: {
  writer: OutsideWriter
  phase: OutsideWriterPhase
  /** Connect while the process still runs (after the user confirmed). */
  onConnectAnyway: () => void
  onStopWaiting: () => void
  /** Connect the ordinary way, which waits again if the process still runs. */
  onConnect: () => void
}) {
  const t = useTranslations("Folder.chat.outsideWriter")
  const locale = useLocale()
  const [confirming, setConfirming] = useState(false)
  const started = formatOutsideWriterStart(writer.startedAt, locale)
  const stopped = phase === "stopped"
  const connectingAnyway = phase === "connecting_anyway"
  const Icon = stopped ? Plug : Hourglass
  return (
    <div
      role="status"
      data-testid="outside-writer-banner"
      data-phase={phase}
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-800 dark:text-sky-200"
    >
      <Icon aria-hidden className="h-4 w-4 shrink-0" />
      <span className="min-w-40 flex-1 leading-snug">
        {stopped
          ? t("stopped", { pid: writer.pid })
          : started
            ? t("waiting", { pid: writer.pid, time: started })
            : t("waitingNoTime", { pid: writer.pid })}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {stopped ? (
          <Button
            size="xs"
            variant="outline"
            className="border-sky-500/40 bg-transparent"
            onClick={onConnect}
            data-testid="outside-writer-connect"
          >
            {t("connect")}
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              variant="outline"
              className="border-sky-500/40 bg-transparent"
              disabled={connectingAnyway}
              title={t("connectAnywayHint")}
              onClick={() => setConfirming(true)}
              data-testid="outside-writer-connect-anyway"
            >
              {connectingAnyway ? t("connecting") : t("connectAnyway")}
            </Button>
            <Button
              size="xs"
              variant="link"
              className="px-1 text-sky-800 dark:text-sky-200"
              disabled={connectingAnyway}
              onClick={onStopWaiting}
              data-testid="outside-writer-stop-waiting"
            >
              {t("stopWaiting")}
            </Button>
          </>
        )}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDescription", { pid: writer.pid })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                onConnectAnyway()
              }}
            >
              {t("confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
