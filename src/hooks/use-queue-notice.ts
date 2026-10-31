"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import type { QueueNotice } from "@/components/chat/message-queue-display"
import { useLimitResetParts } from "@/components/conversations/limit-pause"
import { formatPoolResumeTime } from "@/lib/pool-hold"
import { queueNoticeFor, type QueueNoticeInput } from "@/lib/queue-notice"

/**
 * The line shown above a composer's queue when its messages are held (see
 * `queueNoticeFor`), localized. `onRetry` asks for a new connection; the
 * queue then flushes by itself once it is up.
 */
export function useQueueNotice(
  input: QueueNoticeInput & { agentLabel: string; onRetry: () => void }
): QueueNotice | null {
  const t = useTranslations("Folder.chat.messageQueue")
  const {
    queueLength,
    held,
    connPoolWait,
    status,
    limitPause,
    newChat,
    agentLabel,
    onRetry,
  } = input
  const kind = queueNoticeFor({
    queueLength,
    held,
    connPoolWait,
    status,
    limitPause,
    newChat,
  })
  const resumesAt = kind?.kind === "pool" ? kind.resumesAt : null
  const resetsAt = kind?.kind === "limit" ? kind.resetsAt : null
  // When the paused session continues, kept current while it shows.
  const resetTime = useLimitResetParts(resetsAt)?.time ?? null
  const kindName = kind?.kind ?? null
  return useMemo(() => {
    if (kindName === "limit" && resetTime) {
      return { tone: "waiting", text: t("limitPaused", { time: resetTime }) }
    }
    if (kindName === "pool") {
      const time = formatPoolResumeTime(resumesAt)
      return {
        tone: "waiting",
        text: time ? t("poolWaitUntil", { time }) : t("poolWait"),
      }
    }
    if (kindName === "not_sent") {
      return {
        tone: "failed",
        text: t("notSent", { agent: agentLabel }),
        action: { label: t("retry"), onClick: onRetry },
      }
    }
    if (kindName === "sends_when_connected") {
      return {
        tone: "waiting",
        text: t("sendsWhenConnected", { agent: agentLabel }),
      }
    }
    return null
  }, [kindName, resumesAt, resetTime, agentLabel, onRetry, t])
}
