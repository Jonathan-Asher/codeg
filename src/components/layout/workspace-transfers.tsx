"use client"

import { useEffect, useRef } from "react"
import {
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  X,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { toErrorMessage } from "@/lib/app-error"
import { isDesktop, openLocalPath, revealLocalItemInDir } from "@/lib/platform"
import {
  formatBytes,
  formatDuration,
  formatRate,
  secondsRemaining,
  transferPercent,
} from "@/lib/transfer-format"
import { cn } from "@/lib/utils"
import {
  cancelTrackedDownload,
  dismissTrackedTransfer,
  useWorkspaceTransfer,
  useWorkspaceTransfers,
  type TrackedTransfer,
  type TrackedTransferStatus,
} from "@/lib/workspace-transfers"

/** How long a settled toast stays up; running and failed ones stay until
 *  closed (a failure must never vanish on its own). */
const DONE_TOAST_MS = 10_000
const CANCELLED_TOAST_MS = 3_000

function fileManagerLabelKey():
  | "showInFinder"
  | "showInExplorer"
  | "showInFileManager" {
  if (typeof navigator === "undefined") return "showInFileManager"
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (platform.includes("mac")) return "showInFinder"
  if (platform.includes("win")) return "showInExplorer"
  return "showInFileManager"
}

function StatusIcon({ status }: { status: TrackedTransferStatus }) {
  if (status === "done") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
  }
  if (status === "error") {
    return <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
  }
  return (
    <ArrowDownToLine
      className={cn(
        "h-4 w-4 shrink-0 text-muted-foreground",
        status === "running" && "text-primary"
      )}
    />
  )
}

/**
 * One transfer: name, bar, percentage, bytes, speed, time left and Cancel
 * while running; the saved location with Show / Open once done; the reason
 * when it failed. Shared by the toast and the status-bar popover.
 */
export function TransferCard({
  transfer,
  onClose,
}: {
  transfer: TrackedTransfer
  onClose?: () => void
}) {
  const t = useTranslations("Folder.transfers")
  const locale = useLocale()
  const percent = transferPercent(transfer.loaded, transfer.total)
  const rate = formatRate(transfer.rate)
  const eta = secondsRemaining(transfer.loaded, transfer.total, transfer.rate)
  const localFileActions =
    transfer.status === "done" && transfer.savePath && isDesktop()

  const reveal = () => {
    if (!transfer.savePath) return
    revealLocalItemInDir(transfer.savePath).catch((err) => {
      toast.error(t("openFailed"), { description: toErrorMessage(err) })
    })
  }
  const open = () => {
    if (!transfer.savePath) return
    openLocalPath(transfer.savePath).catch((err) => {
      toast.error(t("openFailed"), { description: toErrorMessage(err) })
    })
  }

  const title =
    transfer.status === "done"
      ? t("done")
      : transfer.status === "error"
        ? t("failed")
        : transfer.status === "cancelled"
          ? t("cancelled")
          : t("downloading")

  return (
    <div className="w-full min-w-0 space-y-1.5" data-transfer-id={transfer.id}>
      <div className="flex items-start gap-2">
        <StatusIcon status={transfer.status} />
        <div className="min-w-0 flex-1">
          <div className="text-2xs text-muted-foreground">{title}</div>
          <div
            className="truncate text-xs font-medium text-foreground"
            title={transfer.savePath ?? transfer.name}
          >
            {transfer.name}
          </div>
        </div>
        {transfer.status === "running" && (
          <Button
            variant="ghost"
            size="xs"
            className="h-5 px-1.5"
            disabled={transfer.cancelRequested}
            onClick={() => void cancelTrackedDownload(transfer.id)}
          >
            {transfer.cancelRequested ? t("cancelling") : t("cancel")}
          </Button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("dismiss")}
            title={t("dismiss")}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {transfer.status === "running" && (
        <>
          {percent != null ? (
            <Progress
              value={percent}
              className="h-1.5"
              aria-label={t("progressAria", { name: transfer.name })}
            />
          ) : (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
            </div>
          )}
          {/* Wraps rather than truncates: the time left is the part most
              worth reading, and it comes last. */}
          <div className="text-2xs text-muted-foreground tabular-nums">
            {percent != null && (
              <span className="font-medium text-foreground">{percent}%</span>
            )}
            {percent != null && " · "}
            {transfer.loaded === 0 && transfer.total == null
              ? t("preparing")
              : transfer.total != null
                ? t("progress", {
                    loaded: formatBytes(transfer.loaded),
                    total: formatBytes(transfer.total),
                  })
                : t("progressNoTotal", {
                    loaded: formatBytes(transfer.loaded),
                  })}
            {rate && ` · ${rate}`}
            {eta != null &&
              ` · ${t("timeLeft", { time: formatDuration(eta, locale) })}`}
          </div>
        </>
      )}

      {transfer.status === "done" && (
        <>
          <div className="truncate text-2xs text-muted-foreground tabular-nums">
            {formatBytes(transfer.loaded)}
            {transfer.savePath && ` · ${transfer.savePath}`}
          </div>
          {localFileActions && (
            <div className="flex gap-1">
              <Button variant="outline" size="xs" onClick={reveal}>
                <FolderOpen />
                {t(fileManagerLabelKey())}
              </Button>
              <Button variant="ghost" size="xs" onClick={open}>
                <ExternalLink />
                {t("open")}
              </Button>
            </div>
          )}
        </>
      )}

      {transfer.status === "error" && transfer.error && (
        <p className="break-words text-2xs text-destructive">
          {transfer.error}
        </p>
      )}
    </div>
  )
}

/** The toast body: re-reads its transfer from the store on every update. */
function TransferToast({
  transferId,
  toastId,
}: {
  transferId: string
  toastId: string | number
}) {
  const transfer = useWorkspaceTransfer(transferId)
  if (!transfer) return null
  return (
    <div className="w-[356px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <TransferCard
        transfer={transfer}
        onClose={() => {
          toast.dismiss(toastId)
          // Closing a settled transfer's toast is "I've seen it". A running
          // one keeps going — the status-bar indicator still shows it.
          if (transfer.status !== "running") dismissTrackedTransfer(transfer.id)
        }}
      />
    </div>
  )
}

function toastDuration(status: TrackedTransferStatus): number {
  if (status === "done") return DONE_TOAST_MS
  if (status === "cancelled") return CANCELLED_TOAST_MS
  return Infinity
}

/**
 * Raises one live toast per download and re-raises it when the download
 * settles — so the "Downloaded" (or the failure) shows up even if the user
 * closed the progress toast halfway. Mounted once per workspace window.
 */
export function WorkspaceTransfersToasts() {
  const transfers = useWorkspaceTransfers()
  const announced = useRef(new Map<string, TrackedTransferStatus>())

  useEffect(() => {
    const live = new Set<string>()
    for (const transfer of transfers) {
      live.add(transfer.id)
      if (announced.current.get(transfer.id) === transfer.status) continue
      announced.current.set(transfer.id, transfer.status)
      const toastId = `transfer:${transfer.id}`
      toast.custom(
        (id) => <TransferToast transferId={transfer.id} toastId={id} />,
        { id: toastId, duration: toastDuration(transfer.status) }
      )
    }
    for (const id of [...announced.current.keys()]) {
      if (live.has(id)) continue
      announced.current.delete(id)
      toast.dismiss(`transfer:${id}`)
    }
  }, [transfers])

  return null
}

/**
 * Status-bar indicator: aggregate progress while anything is downloading, and
 * a popover with every transfer — the place to find a download whose toast
 * was closed.
 */
export function StatusBarTransfers() {
  const t = useTranslations("Folder.transfers")
  const transfers = useWorkspaceTransfers()
  if (transfers.length === 0) return null

  const running = transfers.filter((transfer) => transfer.status === "running")
  const failed = transfers.some((transfer) => transfer.status === "error")
  const sized = running.filter((transfer) => transfer.total != null)
  const percent =
    sized.length > 0
      ? transferPercent(
          sized.reduce((sum, transfer) => sum + transfer.loaded, 0),
          sized.reduce((sum, transfer) => sum + (transfer.total ?? 0), 0)
        )
      : null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          aria-label={
            running.length > 0
              ? t("statusBarRunning", { count: running.length })
              : t("title")
          }
          title={t("title")}
        >
          {running.length > 0 ? (
            <ArrowDownToLine className="h-3 w-3 text-primary" />
          ) : failed ? (
            <AlertCircle className="h-3 w-3 text-destructive" />
          ) : (
            <CheckCircle2 className="h-3 w-3" />
          )}
          {running.length > 0 && percent != null && (
            <>
              <span className="tabular-nums">{percent}%</span>
              <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </span>
            </>
          )}
          {running.length > 1 && (
            <span className="tabular-nums">×{running.length}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-3">
        <div className="mb-2 text-xs font-medium">{t("title")}</div>
        <div className="max-h-72 space-y-3 overflow-y-auto">
          {[...transfers].reverse().map((transfer) => (
            <TransferCard
              key={transfer.id}
              transfer={transfer}
              onClose={
                transfer.status === "running"
                  ? undefined
                  : () => dismissTrackedTransfer(transfer.id)
              }
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
