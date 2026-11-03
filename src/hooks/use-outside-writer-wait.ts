"use client"

import { useEffect, useRef } from "react"

import { acpOutsideWriterStatus } from "@/lib/api"
import {
  OUTSIDE_WRITER_POLL_MAX_MS,
  OUTSIDE_WRITER_POLL_MS,
} from "@/lib/outside-writer"
import type { AgentType } from "@/lib/types"
import {
  clearOutsideWriter,
  updateOutsideWriter,
} from "@/stores/outside-writer-store"

interface UseOutsideWriterWaitOptions {
  agentType: AgentType
  /** The agent session another process runs. */
  sessionId: string | undefined
  /** The session is in front of the user, and they are waiting for that
   *  process (not stopped waiting, not connecting anyway). */
  enabled: boolean
  /** The other process wrote to the transcript since the last look. */
  onTranscriptChanged?: () => void
}

/**
 * While another process runs a session the user is looking at and waiting
 * for: ask every {@link OUTSIDE_WRITER_POLL_MS} whether it still runs, and
 * re-read the transcript whenever it grew. Once the process is gone the
 * session leaves the outside-writer store, which lifts its tab's connect
 * hold, and the tab connects the way it always does — queued messages then
 * go out. Asks that fail are spaced out, up to
 * {@link OUTSIDE_WRITER_POLL_MAX_MS}.
 */
export function useOutsideWriterWait({
  agentType,
  sessionId,
  enabled,
  onTranscriptChanged,
}: UseOutsideWriterWaitOptions): void {
  const onChangedRef = useRef(onTranscriptChanged)
  useEffect(() => {
    onChangedRef.current = onTranscriptChanged
  }, [onTranscriptChanged])

  useEffect(() => {
    if (!enabled || !sessionId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastStamp: string | null = null
    let delay = OUTSIDE_WRITER_POLL_MS

    const ask = async () => {
      try {
        const status = await acpOutsideWriterStatus(agentType, sessionId)
        if (cancelled) return
        delay = OUTSIDE_WRITER_POLL_MS
        const stamp = status.transcript
          ? `${status.transcript.len}:${status.transcript.modifiedMs ?? ""}`
          : null
        // Its last turns too: the transcript is read before the connect.
        if (lastStamp !== null && stamp !== lastStamp) {
          onChangedRef.current?.()
        }
        lastStamp = stamp
        if (!status.writer) {
          clearOutsideWriter(sessionId)
          return
        }
        updateOutsideWriter(sessionId, status.writer)
      } catch {
        if (cancelled) return
        delay = Math.min(delay * 2, OUTSIDE_WRITER_POLL_MAX_MS)
      }
      if (!cancelled) timer = setTimeout(() => void ask(), delay)
    }

    void ask()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [agentType, sessionId, enabled])
}
