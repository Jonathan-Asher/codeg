"use client"

/**
 * The toast for the automatic resume after a restart
 * (`src-tauri/src/acp/auto_resume.rs`): "Resuming 3 sessions interrupted by
 * the restart", the sessions and where each stands, and a Stop that cancels
 * the resumes whose prompt has not gone out yet. Resumes already running are
 * ordinary turns, stopped from their tab.
 *
 * The backend runs the resume whether or not anyone is watching, so the toast
 * only reports: every connected client shows it, from the live status event,
 * and a client that connects mid-batch reads the batch on mount (events fired
 * before it connected are gone). A client that connects after every resume
 * settled has nothing to act on and shows nothing. Mounted once per workspace
 * window.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { RotateCw, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useTabStore } from "@/contexts/tab-context"
import { getAutoResumeStatus, stopAutoResume } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  AUTO_RESUME_STATE_LABEL_KEYS,
  AUTO_RESUME_STATUS_EVENT,
  unsettledAutoResumes,
} from "@/lib/auto-resume"
import { getTransport } from "@/lib/transport"
import type { AutoResumeItem, AutoResumeStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

export const AUTO_RESUME_TOAST_ID = "auto-resume"

/** How long the toast stays once every resume has settled. */
const SETTLED_TOAST_MS = 8_000

function openConversation(item: AutoResumeItem) {
  useTabStore
    .getState()
    .openTab(item.folder_id, item.conversation_id, item.agent_type, true)
}

/** One session of the batch. Named as the sidebar names it now — the batch
 *  carries the title from when the resume was planned, which a fresh session
 *  may since have replaced with the agent's own. */
function AutoResumeRow({ item }: { item: AutoResumeItem }) {
  const t = useTranslations("AutoResume")
  const liveTitle = useAppWorkspaceStore(
    (s) => s.conversations.find((c) => c.id === item.conversation_id)?.title
  )
  const title = liveTitle?.trim() || item.title?.trim() || t("untitled")
  return (
    <li
      data-auto-resume-item={item.state}
      className="flex items-center justify-between gap-3 text-xs"
    >
      <button
        type="button"
        onClick={() => openConversation(item)}
        className="min-w-0 truncate text-left hover:underline"
      >
        {title}
      </button>
      <span
        className={cn(
          "shrink-0 text-muted-foreground",
          item.state === "resumed" && "text-foreground",
          item.state === "failed" && "text-destructive"
        )}
        title={
          item.state === "failed"
            ? [item.error, t("failedHint")].filter(Boolean).join(" — ")
            : undefined
        }
      >
        {t(AUTO_RESUME_STATE_LABEL_KEYS[item.state])}
      </span>
    </li>
  )
}

function AutoResumeToast({
  status,
  onStatus,
  onClose,
}: {
  status: AutoResumeStatus
  onStatus: (status: AutoResumeStatus) => void
  onClose: () => void
}) {
  const t = useTranslations("AutoResume")
  const [stopping, setStopping] = useState(false)
  const unsettled = unsettledAutoResumes(status)
  const title = status.stopped
    ? t("stoppedTitle")
    : unsettled > 0
      ? t("title", { count: status.items.length })
      : t("settledTitle")

  const stop = () => {
    setStopping(true)
    stopAutoResume()
      .then(onStatus)
      .catch((err) => {
        toast.error(t("stopFailed", { message: toErrorMessage(err) }))
      })
      .finally(() => setStopping(false))
  }

  return (
    <div
      data-auto-resume-toast
      className="w-[356px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <RotateCw
          className="mt-0.5 h-4 w-4 shrink-0 text-primary"
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug">
          {title}
        </p>
        <button
          type="button"
          aria-label={t("dismiss")}
          title={t("dismiss")}
          onClick={onClose}
          className="shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
        {status.items.map((item) => (
          <AutoResumeRow key={item.conversation_id} item={item} />
        ))}
      </ul>
      {unsettled > 0 && !status.stopped && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="min-w-0 text-2xs text-muted-foreground">
            {t("stopHint")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            disabled={stopping}
            onClick={stop}
          >
            {t("stop")}
          </Button>
        </div>
      )}
    </div>
  )
}

export function AutoResumeToasts() {
  const [status, setStatus] = useState<AutoResumeStatus | null>(null)
  // The batch (by its start time) whose toast this client has raised, and the
  // one the user closed — a closed toast stays closed for its batch.
  const raisedFor = useRef<string | null>(null)
  const closedFor = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    getAutoResumeStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((err) => {
        console.error("[auto-resume] load status failed:", err)
      })
    getTransport()
      .subscribe<AutoResumeStatus>(AUTO_RESUME_STATUS_EVENT, (next) => {
        setStatus(next)
      })
      .then((dispose) => {
        if (cancelled) {
          dispose()
          return
        }
        unlisten = dispose
      })
      .catch((err) => {
        console.error("[auto-resume] subscribe failed:", err)
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const close = useCallback((batch: string) => {
    closedFor.current = batch
    toast.dismiss(AUTO_RESUME_TOAST_ID)
  }, [])

  useEffect(() => {
    const batch = status?.started_at
    if (!status || !batch || status.items.length === 0) return
    if (closedFor.current === batch) return
    const unsettled = unsettledAutoResumes(status)
    if (raisedFor.current !== batch) {
      if (unsettled === 0) return
      raisedFor.current = batch
    }
    toast.custom(
      () => (
        <AutoResumeToast
          status={status}
          onStatus={setStatus}
          onClose={() => close(batch)}
        />
      ),
      {
        id: AUTO_RESUME_TOAST_ID,
        duration: unsettled > 0 ? Infinity : SETTLED_TOAST_MS,
      }
    )
  }, [status, close])

  return null
}
