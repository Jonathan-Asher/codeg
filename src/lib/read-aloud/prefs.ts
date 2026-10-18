"use client"

/**
 * Read-aloud preferences: the voice per language, the speaking rate, and
 * whether a finished reply is read on its own.
 *
 * Stored in localStorage, not the backend, because voices are a property of
 * the device: the Hebrew voice installed on this Mac is not the one a phone
 * browser attached to the same server has, and a remote-workspace window
 * speaks through the machine it is shown on. Same reactive shape as
 * `notification-sound-prefs.ts`: a custom event for this window and the
 * native `storage` event for the others.
 */

import { useSyncExternalStore } from "react"

const PREFS_KEY = "settings:read-aloud:v1"
const PREFS_EVENT = "codeg:read-aloud-prefs-changed"

export const MIN_RATE = 0.5
export const MAX_RATE = 2
export const RATE_STEP = 0.1

export interface ReadAloudPrefs {
  /** `voiceURI` of the Hebrew voice, or null for the automatic choice. */
  hebrewVoice: string | null
  /** `voiceURI` of the English voice, or null for the automatic choice. */
  englishVoice: string | null
  /** Speaking rate, 1 = the voice's normal pace. */
  rate: number
  /** Read each reply aloud when it finishes. Off until the user opts in. */
  autoRead: boolean
}

export const DEFAULT_READ_ALOUD_PREFS: ReadAloudPrefs = {
  hebrewVoice: null,
  englishVoice: null,
  rate: 1,
  autoRead: false,
}

function clampRate(rate: number): number {
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, rate))
  return Math.round(clamped * 10) / 10
}

/** Merge a stored blob over the defaults, one field at a time. */
export function parseReadAloudPrefs(raw: unknown): ReadAloudPrefs {
  const defaults = DEFAULT_READ_ALOUD_PREFS
  if (!raw || typeof raw !== "object") return { ...defaults }
  const source = raw as Record<string, unknown>
  const voice = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null
  return {
    hebrewVoice: voice(source.hebrewVoice),
    englishVoice: voice(source.englishVoice),
    rate:
      typeof source.rate === "number" && Number.isFinite(source.rate)
        ? clampRate(source.rate)
        : defaults.rate,
    autoRead:
      typeof source.autoRead === "boolean"
        ? source.autoRead
        : defaults.autoRead,
  }
}

function loadReadAloudPrefs(): ReadAloudPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_READ_ALOUD_PREFS }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw
      ? parseReadAloudPrefs(JSON.parse(raw))
      : { ...DEFAULT_READ_ALOUD_PREFS }
  } catch {
    return { ...DEFAULT_READ_ALOUD_PREFS }
  }
}

export function saveReadAloudPrefs(prefs: ReadAloudPrefs): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(parseReadAloudPrefs(prefs)))
  } catch {
    /* storage blocked or full: the change just doesn't stick */
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT))
}

// One memoized copy per window, invalidated by a write here or elsewhere, so
// the player can read it per utterance without parsing JSON each time.
let snapshot: ReadAloudPrefs | null = null
const listeners = new Set<() => void>()
let windowBound = false

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  const invalidate = () => {
    snapshot = null
    for (const listener of listeners) listener()
  }
  window.addEventListener(PREFS_EVENT, invalidate)
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === PREFS_KEY) invalidate()
  })
}

export function getReadAloudPrefs(): ReadAloudPrefs {
  bindWindow()
  if (typeof window === "undefined") return DEFAULT_READ_ALOUD_PREFS
  snapshot ??= loadReadAloudPrefs()
  return snapshot
}

export function subscribeReadAloudPrefs(onChange: () => void): () => void {
  bindWindow()
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** Reactive read of the preferences; live across windows. */
export function useReadAloudPrefs(): ReadAloudPrefs {
  return useSyncExternalStore(
    subscribeReadAloudPrefs,
    getReadAloudPrefs,
    () => DEFAULT_READ_ALOUD_PREFS
  )
}

/** Test seam: forget the memoized snapshot so the next read hits storage. */
export function resetReadAloudPrefsCacheForTests(): void {
  snapshot = null
}
