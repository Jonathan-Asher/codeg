"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ATTACH_PHASE_LABEL_KEYS,
  SLOW_ATTACH_MS,
  isAttachingPhase,
  splitElapsed,
} from "@/lib/attach-phase"
import type { AttachPhase } from "@/lib/types"

/**
 * Milliseconds since `startedAt`, re-rendering once a second while `active`.
 * `null` when there is nothing to time.
 */
export function useElapsedMs(
  startedAt: number | null | undefined,
  active: boolean
): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt == null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, startedAt])
  if (!active || startedAt == null) return null
  return Math.max(0, now - startedAt)
}

export interface AttachPhaseLabel {
  /** "Resuming the session · 14s" — the step, and how long it has run. */
  text: string
  /** The step alone ("Resuming the session"), without the timer. */
  step: string
  /** Past `SLOW_ATTACH_MS`: worth saying the wait is the agent's own startup. */
  slow: boolean
}

/**
 * The live label for a connection that is opening its session. Ticks once a
 * second; `null` when `phase` is not an attaching phase.
 */
export function useAttachPhaseLabel(
  agent: string,
  phase: AttachPhase | null | undefined,
  startedAt: number | null | undefined
): AttachPhaseLabel | null {
  const t = useTranslations("Folder.chat.attachPhase")
  const attaching = isAttachingPhase(phase)
  const elapsed = useElapsedMs(startedAt, attaching)
  if (!attaching) return null
  const step = t(ATTACH_PHASE_LABEL_KEYS[phase], { agent })
  if (elapsed == null) return { text: step, step, slow: false }
  const { minutes, seconds } = splitElapsed(elapsed)
  const elapsedText =
    minutes > 0
      ? t("elapsedMinutes", { minutes, seconds })
      : t("elapsedSeconds", { seconds })
  return {
    text: t("withElapsed", { step, elapsed: elapsedText }),
    step,
    slow: elapsed >= SLOW_ATTACH_MS,
  }
}
