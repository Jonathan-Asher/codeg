"use client"

/**
 * The natural voice's status as this window last saw it: whether the backend
 * can synthesize, whether the models are downloaded, download progress.
 *
 * The player reads the snapshot synchronously when a reply is read (the click
 * must start speech at once), so it is kept current ahead of time. Every
 * window keeps its own copy, and the window that downloads or deletes the
 * models is often another one (Settings is a window of its own), so:
 * - it is fetched when the player is created and when Settings opens;
 * - the backend announces every change (a download that starts, ends, fails or
 *   is cancelled; models deleted), whichever window asked for it;
 * - it is fetched again when the window comes back into focus or view, in
 *   case an announcement was missed (a page reloading, a socket reconnecting).
 * While a download runs and Settings shows it, it is re-read every second.
 */

import { useEffect, useSyncExternalStore } from "react"

import { ttsApi, type TtsStatus } from "./natural-api"

const DOWNLOAD_POLL_MS = 1_000

/** undefined until the backend first answered; null if it couldn't. */
let snapshot: TtsStatus | null | undefined = undefined
/** When the backend last answered or announced (`Date.now()`). */
let snapshotAt: number | null = null
/** Announcements taken so far; a fetch that overlapped one is older news. */
let announcements = 0
let inflight: Promise<TtsStatus | null> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let unwatch: (() => void) | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function schedulePoll(): void {
  // Only for a progress bar on screen: other windows hear the end of the
  // download from the backend.
  if (pollTimer || listeners.size === 0) return
  if (snapshot?.download.state !== "downloading") return
  pollTimer = setTimeout(() => {
    pollTimer = null
    void refreshNaturalStatus()
  }, DOWNLOAD_POLL_MS)
}

/** Store a status the backend returned (also from download/delete calls). */
export function setNaturalStatus(next: TtsStatus | null): void {
  snapshot = next
  snapshotAt = Date.now()
  emit()
  schedulePoll()
}

/** The last status seen, or null before the first answer (or where the
 *  backend has no natural voice endpoints at all). */
export function getNaturalStatus(): TtsStatus | null {
  return snapshot ?? null
}

/** How long ago the backend last answered or announced, in ms; Infinity
 *  before it ever did. */
export function naturalStatusAge(): number {
  return snapshotAt === null ? Infinity : Date.now() - snapshotAt
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
  const seen = announcements
  inflight = Promise.resolve()
    .then(() => ttsApi.status())
    .then(
      (status) => (isStatus(status) ? status : null),
      () => null
    )
    .then((status) => {
      inflight = null
      // An announcement that came in meanwhile is newer than this answer.
      if (announcements !== seen) return getNaturalStatus()
      setNaturalStatus(status)
      return status
    })
  return inflight
}

export function subscribeNaturalStatus(listener: () => void): () => void {
  listeners.add(listener)
  schedulePoll()
  return () => {
    listeners.delete(listener)
  }
}

/** Keep this window's status current without being asked (see the top of
 *  this file). Once per window; the status comes from the same backend as
 *  the voice (`ttsApi`), never from a remote workspace's server. */
export function watchNaturalStatus(): void {
  if (unwatch || typeof window === "undefined") return
  let stopListening: (() => void) | null = null
  let stopped = false
  ttsApi
    .onStatus((next) => {
      if (!isStatus(next)) return
      announcements += 1
      setNaturalStatus(next)
    })
    .then(
      (off) => {
        if (stopped) off()
        else stopListening = off
      },
      () => {
        /* no live channel: the checks on focus and before reading cover it */
      }
    )
  const recheck = () => void refreshNaturalStatus()
  const onVisibility = () => {
    if (document.visibilityState === "visible") recheck()
  }
  window.addEventListener("focus", recheck)
  document.addEventListener("visibilitychange", onVisibility)
  unwatch = () => {
    stopped = true
    stopListening?.()
    window.removeEventListener("focus", recheck)
    document.removeEventListener("visibilitychange", onVisibility)
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
    watchNaturalStatus()
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
  unwatch?.()
  unwatch = null
  snapshot = undefined
  snapshotAt = null
  announcements = 0
  inflight = null
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  listeners.clear()
}
