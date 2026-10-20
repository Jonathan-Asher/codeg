"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ATTACH_PHASE_LABEL_KEYS,
  SLOW_ATTACH_MS,
  isAttachingPhase,
  splitElapsed,
} from "@/lib/attach-phase"
import { formatPoolResumeTime, type PoolHold } from "@/lib/pool-hold"
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
 * second; `null` when `phase` is not an attaching phase. While it waits for
 * the account pool (`pool_wait`) it says so, with when the first account
 * frees up (`poolWait`), and no timer: the wait is the pool's, not the agent's.
 */
export function useAttachPhaseLabel(
  agent: string,
  phase: AttachPhase | null | undefined,
  startedAt: number | null | undefined,
  poolWait?: PoolHold | null
): AttachPhaseLabel | null {
  const t = useTranslations("Folder.chat.attachPhase")
  const attaching = isAttachingPhase(phase)
  const elapsed = useElapsedMs(startedAt, attaching && phase !== "pool_wait")
  if (!attaching) return null
  if (phase === "pool_wait") {
    const time = formatPoolResumeTime(poolWait?.resumesAt)
    const text = time ? t("poolWaitUntil", { time }) : t("poolWait")
    return { text, step: text, slow: false }
  }
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
