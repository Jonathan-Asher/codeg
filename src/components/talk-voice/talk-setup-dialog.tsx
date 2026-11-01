"use client"

/**
 * Talk on this Mac needs its speech models first: the dialog "Talk on this
 * Mac" opens when they are missing. It downloads the required packs (and
 * offers the recommended whisper), and starts the Talk once they are in.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { AudioLines } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatBytes } from "@/lib/transfer-format"
import { TalkModelRow } from "./talk-model-row"
import { useTalkModels } from "./use-talk-models"

export interface TalkSetupDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** The required packs are in: start the Talk. */
  onReady(): void
}

export function TalkSetupDialog({
  open,
  onOpenChange,
  onReady,
}: TalkSetupDialogProps) {
  const t = useTranslations("TalkVoice")
  const models = useTalkModels(open)
  const status = models.status
  const missing =
    status?.packs.filter((pack) => pack.required && !pack.installed) ?? []
  const missingBytes = missing.reduce(
    (sum, pack) => sum + Math.max(0, pack.packBytes - pack.bytesOnDisk),
    0
  )
  const anyDownloading =
    status?.packs.some((pack) => pack.download.state === "downloading") ?? false

  // Became ready while the dialog was open (a download finished): start.
  const wasReady = useRef<boolean | null>(null)
  const ready = status?.ready ?? false
  useEffect(() => {
    if (!status) return
    if (wasReady.current === false && ready) onReady()
    wasReady.current = ready
  }, [status, ready, onReady])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="talk-setup-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AudioLines className="size-4" />
            {t("setupTitle")}
          </DialogTitle>
          <DialogDescription>{t("setupDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {status?.packs.map((pack) => (
            <TalkModelRow
              key={pack.id}
              pack={pack}
              busy={models.busy}
              onDownload={() => void models.download([pack.id])}
              onCancel={() => void models.cancel([pack.id])}
            />
          ))}
          {status?.catalogError && (
            <p className="text-xs text-destructive">{status.catalogError}</p>
          )}
          {models.error && (
            <p className="text-xs text-destructive">{models.error}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t("setupClose")}
          </Button>
          {ready ? (
            <Button type="button" onClick={onReady}>
              {t("setupStart")}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={models.busy || anyDownloading || missing.length === 0}
              onClick={() =>
                void models.download(missing.map((pack) => pack.id))
              }
            >
              {t("setupDownload", { size: formatBytes(missingBytes) })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
