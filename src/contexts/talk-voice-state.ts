"use client"

/**
 * The light half of Talk on this Mac's window state: the context the menus
 * and the dock read, the eligibility of a conversation, and the dock's
 * fast-changing state (the helper's `state`, the levels) kept out of React
 * state. The provider (`talk-voice-context.tsx`) fills them; this module
 * imports nothing heavy, so a menu can read it anywhere.
 */

import { createContext, useContext, useSyncExternalStore } from "react"

import type { TalkVoiceStatus } from "@/lib/talk-voice/api"
import type {
  TalkControl,
  TalkLevel,
  TalkUiState,
} from "@/lib/talk-voice/protocol"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** Whether a conversation can be talked with on this Mac, and if not why. */
export type TalkEligibility =
  /** Talk on this Mac can start. */
  | "ok"
  /** Not the desktop app. */
  | "unavailable"
  /** The helper is missing, the Mac can't run it, or it is switched off. */
  | "unsupported"
  /** A new chat not saved yet. */
  | "notSaved"
  /** The session's server predates Talk mode. */
  | "noTalkMode"

export interface TalkSession {
  conversationId: number
  /** The conversation tab's id. */
  contextKey: string
  talkId: number | null
  phase: "starting" | "running"
}

/**
 * Changes only when a Talk starts or ends or the backend's status does, so
 * every menu can read it; the dock's fast-changing state (the helper's
 * `state`, the levels) lives in stores of its own ({@link useTalkUi},
 * {@link useTalkLevels}).
 */
export interface TalkVoiceContextValue {
  /** The desktop app: Talk on this Mac may run in this window. */
  available: boolean
  status: TalkVoiceStatus | null
  /** Talk on this Mac can run here (the helper is in and its check passed). */
  supported: boolean
  /** This window's Talk. */
  session: TalkSession | null
  startTalk(conversationId: number): Promise<void>
  endTalk(): Promise<void>
  control(control: TalkControl): void
  refreshStatus(refreshProbe?: boolean): Promise<void>
}

export const TalkVoiceContext = createContext<TalkVoiceContextValue | null>(
  null
)

/** Outside the provider (another page, a test): no Talk on this Mac. */
const INERT: TalkVoiceContextValue = {
  available: false,
  status: null,
  supported: false,
  session: null,
  startTalk: async () => {},
  endTalk: async () => {},
  control: () => {},
  refreshStatus: async () => {},
}

export function useTalkVoice(): TalkVoiceContextValue {
  return useContext(TalkVoiceContext) ?? INERT
}

/** Whether `conversationId` can be talked with on this Mac (a narrow store
 *  read per conversation, so a menu re-renders only for its own row). */
export function useTalkEligibility(
  conversationId: number | null | undefined
): TalkEligibility {
  const { available, supported } = useTalkVoice()
  const knowsTalk = useAppWorkspaceStore((s) => {
    if (conversationId == null || conversationId <= 0) return null
    const summary = s.conversations.find((c) => c.id === conversationId)
    if (!summary) return null
    return typeof summary.talk_mode === "boolean"
  })
  if (!available) return "unavailable"
  if (!supported) return "unsupported"
  if (knowsTalk === null) return "notSaved"
  if (!knowsTalk) return "noTalkMode"
  return "ok"
}

/** A value kept out of React state, so only its readers re-render. */
function externalValue<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(onChange: () => void) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

// The microphone and speech levels (15 a second) and the helper's `state`
// (up to 20 a second): only the dock reads them.
export const levelsStore = externalValue<TalkLevel | null>(null)
export const uiStore = externalValue<TalkUiState | null>(null)

/** The latest levels (`{in, out}`, 0…1), or null. */
export function useTalkLevels(): TalkLevel | null {
  return useSyncExternalStore(
    levelsStore.subscribe,
    levelsStore.get,
    () => null
  )
}

/** The helper's latest `state` for this window's Talk, or null. */
export function useTalkUi(): TalkUiState | null {
  return useSyncExternalStore(uiStore.subscribe, uiStore.get, () => null)
}
