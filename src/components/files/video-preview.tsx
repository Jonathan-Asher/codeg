"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Download,
  ExternalLink,
  FolderOpen,
  RotateCcw,
  VideoOff,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import {
  downloadWorkspaceFile,
  openWorkspaceMediaStream,
  revokeWorkspaceMediaStream,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { isTransferErrorReported } from "@/lib/workspace-transfers"
import { videoPlaybackSupport } from "@/lib/language-detect"
import {
  isDesktop,
  isLocalDesktop,
  openPath,
  openUrl,
  revealItemInDir,
} from "@/lib/platform"
import { formatBytes } from "@/lib/transfer-format"

// HTMLMediaElement error codes (MediaError.MEDIA_ERR_*).
const MEDIA_ERR_NETWORK = 2

type Notice =
  | { kind: "unsupported" }
  | { kind: "failed"; message: string | null }

interface Stream {
  token: string
  src: string
  size: number
}

/** "Show in Finder" / "Show in Explorer" / "Show in file manager". */
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

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * Streaming video viewer for a file tab.
 *
 * The bytes never pass through JSON: the backend mints a short-lived
 * capability for this one file and the `<video>` element loads it directly —
 * from the server's Range endpoint in web mode, or through the desktop app's
 * `codeg-media://` scheme (which forwards to the remote server for a remote
 * workspace). Seeking is just the element asking for a new byte range, so a
 * multi-GB file starts playing as soon as its first slice arrives.
 *
 * Formats no browser engine plays skip the request entirely and go straight
 * to the notice; formats some engines play (Matroska, Ogg) are tried, and an
 * element error turns into the same notice. Download / open-externally stay
 * available either way.
 */
export function VideoPreview({
  tab,
  rootPath,
  relPath,
}: {
  tab: FileWorkspaceTab
  /** Backend read pair: the file's directory and its name within it. */
  rootPath: string | null
  relPath: string | null
}) {
  const t = useTranslations("Folder.videoPreview")
  const support = videoPlaybackSupport(tab.path)
  const knownUnsupported = support === "unsupported"

  const [stream, setStream] = useState<Stream | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dimensions, setDimensions] = useState<{
    width: number
    height: number
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [downloading, setDownloading] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  // Set once the element has parsed the header: a later error is then about
  // the connection (an idle capability expired, the network dropped), not the
  // format, and is worth one silent re-mint that resumes where it stopped.
  const loadedRef = useRef(false)
  const resumeRef = useRef<{ time: number; play: boolean } | null>(null)
  const silentRetryUsedRef = useRef(false)

  // Mint on mount / retry; revoke on unmount. The tab is keyed upstream, so a
  // different file remounts fresh.
  useEffect(() => {
    if (!rootPath || !relPath || knownUnsupported) return
    let cancelled = false
    let token: string | null = null
    openWorkspaceMediaStream(rootPath, relPath)
      .then((minted) => {
        if (cancelled) {
          void revokeWorkspaceMediaStream(minted.token).catch(() => {})
          return
        }
        token = minted.token
        setStream({ token: minted.token, src: minted.src, size: minted.size })
        setNotice(null)
      })
      .catch((err) => {
        if (cancelled) return
        setStream(null)
        setNotice({ kind: "failed", message: toErrorMessage(err) })
      })
    return () => {
      cancelled = true
      if (token) void revokeWorkspaceMediaStream(token).catch(() => {})
    }
  }, [rootPath, relPath, knownUnsupported, attempt])

  const retry = useCallback(() => {
    loadedRef.current = false
    setNotice(null)
    setAttempt((n) => n + 1)
  }, [])

  const handleLoadedMetadata = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    loadedRef.current = true
    setDimensions(
      el.videoWidth > 0 && el.videoHeight > 0
        ? { width: el.videoWidth, height: el.videoHeight }
        : null
    )
    const resume = resumeRef.current
    if (resume) {
      resumeRef.current = null
      el.currentTime = resume.time
      if (resume.play) void el.play().catch(() => {})
    }
  }, [])

  const handleError = useCallback(() => {
    const el = videoRef.current
    const code = el?.error?.code ?? null
    if (loadedRef.current && !silentRetryUsedRef.current && el) {
      silentRetryUsedRef.current = true
      resumeRef.current = { time: el.currentTime, play: !el.paused }
      loadedRef.current = false
      setAttempt((n) => n + 1)
      return
    }
    setNotice(
      code === MEDIA_ERR_NETWORK
        ? { kind: "failed", message: el?.error?.message || null }
        : { kind: "unsupported" }
    )
  }, [])

  const absPath = tab.path
  const name = tab.title || relPath || ""
  const localDesktop = isLocalDesktop()
  const web = !isDesktop()

  const handleDownload = useCallback(async () => {
    if (!rootPath || !relPath) return
    setDownloading(true)
    try {
      // Web hands the file to the browser's download manager ("started"),
      // and a cancelled save dialog or transfer needs no word; a tracked
      // remote download already announced itself ("reported").
      const result = await downloadWorkspaceFile(rootPath, relPath, name)
      if (result.status === "done" && !result.reported && result.savedPath) {
        toast.success(t("downloadSaved", { name }), {
          description: result.savedPath,
        })
      }
    } catch (err) {
      if (!isTransferErrorReported(err)) {
        toast.error(t("downloadFailed", { name }), {
          description: toErrorMessage(err),
        })
      }
    } finally {
      setDownloading(false)
    }
  }, [name, relPath, rootPath, t])

  const handleOpenExternally = useCallback(() => {
    const run = async () => {
      if (localDesktop) {
        await openPath(absPath)
      } else if (stream) {
        await openUrl(stream.src)
      }
    }
    run().catch((err) => {
      toast.error(t("openFailed", { name }), {
        description: toErrorMessage(err),
      })
    })
  }, [absPath, localDesktop, name, stream, t])

  const handleReveal = useCallback(() => {
    revealItemInDir(absPath).catch((err) => {
      toast.error(t("openFailed", { name }), {
        description: toErrorMessage(err),
      })
    })
  }, [absPath, name, t])

  const showNotice: Notice | null = knownUnsupported
    ? { kind: "unsupported" }
    : !rootPath || !relPath
      ? { kind: "failed", message: null }
      : notice

  // Local desktop: the file is already here — open it or show it. Web: the
  // browser downloads it, or plays it in a tab of its own. Remote desktop:
  // download (with progress) — the done toast then offers Open / Show.
  const actions = (
    <div className="flex flex-wrap items-center justify-center gap-1">
      {localDesktop ? (
        <>
          <Button variant="ghost" size="xs" onClick={handleOpenExternally}>
            <ExternalLink />
            {t("openExternally")}
          </Button>
          <Button variant="ghost" size="xs" onClick={handleReveal}>
            <FolderOpen />
            {t(fileManagerLabelKey())}
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void handleDownload()}
            disabled={downloading || !rootPath || !relPath}
          >
            <Download />
            {t("download")}
          </Button>
          {web && stream && (
            <Button variant="ghost" size="xs" onClick={handleOpenExternally}>
              <ExternalLink />
              {t("openInNewTab")}
            </Button>
          )}
        </>
      )}
    </div>
  )

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-none flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-1 text-2xs text-muted-foreground">
        {dimensions && (
          <span className="tabular-nums">
            {dimensions.width} x {dimensions.height}
          </span>
        )}
        {stream && stream.size > 0 && (
          <span className="tabular-nums">{formatBytes(stream.size)}</span>
        )}
        <div className="ml-auto">{actions}</div>
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center bg-black/90">
        {showNotice ? (
          <div
            role="status"
            className="flex max-w-md flex-col items-center gap-2 px-6 text-center text-xs text-neutral-300"
          >
            <VideoOff className="h-6 w-6 text-neutral-400" />
            {showNotice.kind === "unsupported" ? (
              <>
                <p className="font-medium text-neutral-100">
                  {t("unsupportedTitle")}
                </p>
                <p>
                  {t("unsupportedHint", {
                    format: extensionOf(absPath).toUpperCase() || "?",
                  })}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-neutral-100">
                  {t("loadFailed")}
                </p>
                {showNotice.message && (
                  <p className="break-words">{showNotice.message}</p>
                )}
                {rootPath && relPath && (
                  <Button variant="secondary" size="xs" onClick={retry}>
                    <RotateCcw />
                    {t("retry")}
                  </Button>
                )}
              </>
            )}
          </div>
        ) : stream ? (
          <video
            key={stream.token}
            ref={videoRef}
            src={stream.src}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
            className="max-h-full max-w-full"
            onLoadedMetadata={handleLoadedMetadata}
            onError={handleError}
          />
        ) : (
          <span className="text-xs text-neutral-400">{t("loading")}</span>
        )}
      </div>
    </div>
  )
}
