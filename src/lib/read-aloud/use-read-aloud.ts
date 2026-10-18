"use client"

/**
 * React bindings for the window's read-aloud player: whether it can speak,
 * what it is reading, the installed voices, and actions that report what the
 * user needs to know (nothing to read, no Hebrew voice installed) as toasts.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  IDLE_STATE,
  getReadAloudPlayer,
  isReadAloudSupported,
  type ReadAloudState,
  type SpeakResult,
} from "./player"
import type { VoiceLike } from "./voices"

const noop = () => () => {}
const NO_VOICES: VoiceLike[] = []

/** Whether this runtime has speech synthesis. False before hydration. */
export function useReadAloudSupported(): boolean {
  return useSyncExternalStore(noop, isReadAloudSupported, () => false)
}

function subscribeState(listener: () => void): () => void {
  return getReadAloudPlayer()?.subscribe(listener) ?? (() => {})
}

function getState(): ReadAloudState {
  return getReadAloudPlayer()?.getState() ?? IDLE_STATE
}

/** What the player is doing; the same object until that changes. */
export function useReadAloudState(): ReadAloudState {
  return useSyncExternalStore(subscribeState, getState, () => IDLE_STATE)
}

function subscribeVoices(listener: () => void): () => void {
  return getReadAloudPlayer()?.subscribeVoices(listener) ?? (() => {})
}

function getVoices(): VoiceLike[] {
  return getReadAloudPlayer()?.getVoices() ?? NO_VOICES
}

/** The installed system voices, refreshed when the engine's list changes. */
export function useReadAloudVoices(): VoiceLike[] {
  return useSyncExternalStore(subscribeVoices, getVoices, () => NO_VOICES)
}

/** Remembered per language, so the hint is given once rather than per reply. */
const MISSING_VOICE_NOTICE_KEY = "read-aloud:missing-voice-notice:"

function claimMissingVoiceNotice(lang: string): boolean {
  if (typeof window === "undefined") return false
  try {
    const key = MISSING_VOICE_NOTICE_KEY + lang
    if (localStorage.getItem(key)) return false
    localStorage.setItem(key, "1")
    return true
  } catch {
    return true
  }
}

export interface ReadAloudActions {
  /** Read `markdown` as `id`, replacing whatever is being read. */
  read: (id: string, markdown: string) => SpeakResult | null
  /** Read `markdown` as `id`, or stop if `id` is what is being read. */
  toggle: (id: string, markdown: string) => SpeakResult | null
  pause: () => void
  resume: () => void
  stop: () => void
}

export function useReadAloudActions(): ReadAloudActions {
  const t = useTranslations("ReadAloud")

  const report = useCallback(
    (result: SpeakResult | null) => {
      if (!result) return result
      if (!result.ok) {
        if (result.reason === "empty") toast.info(t("nothingToRead"))
        return result
      }
      if (
        result.missingVoices.includes("he") &&
        claimMissingVoiceNotice("he")
      ) {
        toast.warning(t("missingHebrewVoice"), {
          description: t("missingVoiceHint"),
          duration: 12_000,
        })
      }
      return result
    },
    [t]
  )

  return useMemo(
    () => ({
      read: (id, markdown) =>
        report(getReadAloudPlayer()?.speak(id, markdown) ?? null),
      toggle: (id, markdown) =>
        report(getReadAloudPlayer()?.toggle(id, markdown) ?? null),
      pause: () => getReadAloudPlayer()?.pause(),
      resume: () => getReadAloudPlayer()?.resume(),
      stop: () => getReadAloudPlayer()?.stop(),
    }),
    [report]
  )
}
