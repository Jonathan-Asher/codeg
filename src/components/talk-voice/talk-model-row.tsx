"use client"

/** One of Talk's speech model packs: its size, whether it is downloaded or
 *  how far along, and download / cancel / delete. */

import { useTranslations } from "next-intl"
import { Check, Download, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { TalkModelPack } from "@/lib/talk-voice/api"
import { formatBytes } from "@/lib/transfer-format"

export interface TalkModelRowProps {
  pack: TalkModelPack
  busy: boolean
  onDownload(): void
  onCancel(): void
  onDelete?(): void
}

export function TalkModelRow({
  pack,
  busy,
  onDownload,
  onCancel,
  onDelete,
}: TalkModelRowProps) {
  const t = useTranslations("TalkVoice")
  const size = formatBytes(pack.packBytes)
  const download = pack.download
  const tag = pack.required
    ? t("packRequired")
    : pack.recommended
      ? t("packRecommended")
      : null

  let detail: string
  if (pack.installed) detail = t("packInstalled", { size })
  else if (download.state === "downloading") {
    detail = t("packDownloading", {
      done: formatBytes(download.bytesDone),
      total: formatBytes(download.bytesTotal),
    })
  } else if (download.state === "failed") {
    detail = t("packFailed", { message: download.message })
  } else detail = size

  const percent =
    download.state === "downloading" && download.bytesTotal > 0
      ? Math.round((download.bytesDone / download.bytesTotal) * 100)
      : 0

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border bg-background/60 px-3 py-2"
      data-testid={`talk-pack-${pack.id}`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {pack.installed && (
              <Check className="size-3.5 shrink-0 text-emerald-600" />
            )}
            <span className="truncate">{pack.title}</span>
            {tag && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                {tag}
              </span>
            )}
          </div>
          <div
            className={
              download.state === "failed" && !pack.installed
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {detail}
          </div>
        </div>
        {download.state === "downloading" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={onCancel}
          >
            {t("packCancel")}
          </Button>
        ) : pack.installed ? (
          onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={onDelete}
              aria-label={t("packDelete")}
            >
              <Trash2 className="size-3.5" />
              {t("packDelete")}
            </Button>
          )
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={onDownload}
          >
            <Download className="size-3.5" />
            {download.state === "failed" ? t("packRetry") : t("packDownload")}
          </Button>
        )}
      </div>
      {download.state === "downloading" && (
        <Progress value={percent} aria-label={pack.title} />
      )}
    </div>
  )
}
