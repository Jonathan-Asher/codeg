"use client"

/**
 * The natural voice's status as this window last saw it: whether the backend
 * can synthesize, whether the models are downloaded, download progress.
 *
 * The player reads the snapshot synchronously when a reply is read (the click
 * must start speech at once), so it is fetched ahead of time: when the player
 * is created and when Settings opens. While a download runs it is re-read
 * every second.
 */

import { useEffect, useSyncExternalStore } from "react"

import { ttsApi, type TtsStatus } from "./natural-api"

const DOWNLOAD_POLL_MS = 1_000

/** undefined until the backend first answered; null if it couldn't. */
let snapshot: TtsStatus | null | undefined = undefined
let inflight: Promise<TtsStatus | null> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function schedulePoll(): void {
  if (pollTimer || snapshot?.download.state !== "downloading") return
  pollTimer = setTimeout(() => {
    pollTimer = null
    void refreshNaturalStatus()
  }, DOWNLOAD_POLL_MS)
}

/** Store a status the backend returned (also from download/delete calls). */
export function setNaturalStatus(next: TtsStatus | null): void {
  snapshot = next
  emit()
  schedulePoll()
}

/** The last status seen, or null before the first answer (or where the
 *  backend has no natural voice endpoints at all). */
export function getNaturalStatus(): TtsStatus | null {
  return snapshot ?? null
}

function isStatus(value: unknown): value is TtsStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TtsStatus).supported === "boolean" &&
    typeof (value as TtsStatus).download === "object"
  )
}

/** Ask the backend again. Failures (an older backend without these
 *  commands, a network error) leave the natural voice unavailable. */
export function refreshNaturalStatus(): Promise<TtsStatus | null> {
  if (inflight) return inflight
  inflight = Promise.resolve()
    .then(() => ttsApi.status())
    .then(
      (status) => (isStatus(status) ? status : null),
      () => null
    )
    .then((status) => {
      inflight = null
      setNaturalStatus(status)
      return status
    })
  return inflight
}

export function subscribeNaturalStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether the natural voice can read right now. */
export function naturalVoiceReady(status: TtsStatus | null): boolean {
  return Boolean(status?.supported && status.installed)
}

/** Reactive status, `undefined` while the first answer is on its way; asks
 *  the backend again whenever a component using it mounts. */
export function useNaturalStatus(): TtsStatus | null | undefined {
  useEffect(() => {
    void refreshNaturalStatus()
  }, [])
  return useSyncExternalStore(
    subscribeNaturalStatus,
    () => snapshot,
    () => undefined
  )
}

/** Test seam: forget everything. */
export function resetNaturalStatusForTests(): void {
  snapshot = undefined
  inflight = null
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  listeners.clear()
}
