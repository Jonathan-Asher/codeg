"use client"

/**
 * How a background job ended, as a chip in its command card's header.
 *
 * Pi starts a job with `bgj_run` and hears about its end minutes later, in a
 * notice between unrelated work. The parser folds that notice into the launch
 * (`_meta["codeg.backgroundJob"]`, `parsers/pi/fold.rs`), so the card that
 * started the job says how it went: exit code, how it was stopped, how long it
 * ran. A job whose end the transcript never recorded says that instead of
 * claiming it still runs.
 */

import { memo } from "react"
import {
  Ban,
  CheckCircleIcon,
  CircleDashed,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { BackgroundJob } from "@/lib/agent-run-meta"
import { cn } from "@/lib/utils"

export const BackgroundJobChip = memo(function BackgroundJobChip({
  job,
}: {
  job: BackgroundJob
}) {
  const t = useTranslations("Folder.chat.contentParts.backgroundJob")
  let label: string
  let Icon = TerminalIcon
  let tone = "text-muted-foreground"
  switch (job.state) {
    case "completed":
      label = t("completed", { code: job.exitCode ?? 0 })
      Icon = CheckCircleIcon
      tone = "text-green-600"
      break
    case "failed":
      label =
        job.exitCode != null
          ? t("failedWithCode", { code: job.exitCode })
          : t("failed")
      Icon = XCircleIcon
      tone = "text-destructive"
      break
    case "killed":
      label = job.killedBy
        ? t("killedBy", { reason: job.killedBy })
        : t("killed")
      Icon = Ban
      break
    case "unknown":
      label = t("ended")
      Icon = CircleDashed
      break
    default:
      label = t("pending")
  }
  const text =
    job.duration && job.state !== "pending"
      ? `${label} · ${job.duration}`
      : label

  return (
    <span
      data-testid="background-job-chip"
      className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
      title={job.id ?? undefined}
    >
      <Icon aria-hidden className={cn("size-3", tone)} />
      {text}
    </span>
  )
})
