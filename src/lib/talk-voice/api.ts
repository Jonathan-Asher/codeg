/**
 * Talk on this Mac's backend calls (`src-tauri/src/commands/talk_voice.rs`):
 * the helper's status and probe, starting, driving and ending a Talk, the
 * speech models and the preferences.
 *
 * Always through the SHELL transport, never the remote one: the microphone,
 * the speakers and the helper are this Mac's. A remote-workspace window
 * drives its session on the remote server through the bridge, but its Talk
 * runs here.
 */

import { getShellTransport, type UnsubscribeFn } from "@/lib/transport"
import type { TtsDownloadState } from "@/lib/read-aloud/natural-api"
import type { WindowMessage, TalkEchoMode, TalkPatience } from "./protocol"

/** Mirrors `ProbeOutcome`. */
export interface TalkProbe {
  ok: boolean
  error: string | null
  /** `{arm64, macos, mic, protocol, version, whisperLoads}`. */
  report: {
    arm64?: boolean
    macos?: string
    mic?: string
    protocol?: number
    version?: string
    whisperLoads?: boolean
  } | null
}

/** Mirrors `ActiveTalkView`. */
export interface ActiveTalk {
  talkId: number
  /** The label of the window that holds it. */
  window: string
  conversationId: number
  local: boolean
  talking: boolean
}

/** Mirrors `PackStatus`. */
export interface TalkModelPack {
  id: string
  title: string
  required: boolean
  recommended: boolean
  installed: boolean
  download: TtsDownloadState
  packBytes: number
  bytesOnDisk: number
  dir: string
}

/** Mirrors `TalkModelsStatus`. */
export interface TalkModelsStatus {
  packs: TalkModelPack[]
  /** Every required pack is installed. */
  ready: boolean
  catalogError: string | null
  dir: string
}

/** Mirrors `TalkVoiceStatus`. */
export interface TalkVoiceStatus {
  supported: boolean
  /** `disabled`, `platform`, `arch`, `helperMissing`, `protocol`, `probe`. */
  unsupportedReason: string | null
  protocol: number
  probe: TalkProbe | null
  helperRunning: boolean
  helper: { protocol: number; version?: unknown; mic?: unknown } | null
  active: ActiveTalk | null
  models: TalkModelsStatus
  voiceInstalled: boolean
}

/** Mirrors `TalkStarted`. */
export interface TalkStarted {
  talkId: number
  hello: { protocol: number; version?: unknown; mic?: unknown }
}

/** Mirrors `TalkVoicePrefs` (+ the shortcut's registration). */
export interface TalkVoicePrefs {
  shortcutEnabled: boolean
  /** Accelerator syntax (`Alt+Super+KeyT`). */
  shortcut: string
  handsFree: boolean
  interruptBySpeaking: boolean
  useWhisper: boolean
  patience: TalkPatience
  echoMode: TalkEchoMode
  speakProgress: boolean
  smartTurnActive: boolean
  shareTelemetry: boolean
}

export interface TalkVoicePrefsView extends TalkVoicePrefs {
  shortcutRegistered: boolean
  shortcutError: string | null
}

/** ⌥⌘T. */
export const DEFAULT_TALK_SHORTCUT = "Alt+Super+KeyT"

export const DEFAULT_TALK_VOICE_PREFS: TalkVoicePrefs = {
  shortcutEnabled: true,
  shortcut: DEFAULT_TALK_SHORTCUT,
  handsFree: true,
  interruptBySpeaking: true,
  useWhisper: true,
  patience: "normal",
  echoMode: "automatic",
  speakProgress: false,
  smartTurnActive: false,
  shareTelemetry: true,
}

/** The helper's messages for the window that holds the Talk. */
export const TALK_VOICE_MESSAGE_EVENT = "talk-voice://message"
/** The status, to every window, when a Talk starts or ends. */
export const TALK_VOICE_STATUS_EVENT = "talk-voice://status"
/** The models' status, to every window, when a download starts or stops. */
export const TALK_VOICE_MODELS_EVENT = "talk-voice://models"
/** The global shortcut, with no Talk running: start one here. */
export const TALK_VOICE_SHORTCUT_EVENT = "talk-voice://shortcut"

/** Error keys the backend stamps (`talk_voice.rs`). */
export const TALK_VOICE_ERROR_UNSUPPORTED = "talkVoice.unsupported"
export const TALK_VOICE_ERROR_MODELS_MISSING = "talkVoice.modelsMissing"

function call<T>(command: string, args?: Record<string, unknown>) {
  return getShellTransport().call<T>(command, args, { timeoutMs: 30_000 })
}

/** What the bridge and the UI need from the backend; tests pass a fake. */
export interface TalkVoiceApi {
  status(refreshProbe?: boolean): Promise<TalkVoiceStatus>
  start(
    conversationId: number,
    local: boolean,
    message: WindowMessage
  ): Promise<TalkStarted>
  /** Messages for the helper, in order (one call per batch: separate calls
   *  are not handled in the order they were made). */
  send(talkId: number, messages: WindowMessage[]): Promise<void>
  stop(talkId: number): Promise<void>
  onMessage(handler: (payload: unknown) => void): Promise<UnsubscribeFn>
  onStatus(handler: (status: unknown) => void): Promise<UnsubscribeFn>
  onShortcut(handler: (payload: unknown) => void): Promise<UnsubscribeFn>
}

export const talkVoiceApi: TalkVoiceApi = {
  status: (refreshProbe) =>
    call<TalkVoiceStatus>(
      "talk_voice_status",
      refreshProbe ? { refreshProbe: true } : {}
    ),
  start: (conversationId, local, message) =>
    call<TalkStarted>("talk_voice_start", { conversationId, local, message }),
  send: async (talkId, messages) => {
    await call<null>("talk_voice_send", { talkId, messages })
  },
  stop: async (talkId) => {
    await call<null>("talk_voice_stop", { talkId })
  },
  onMessage: (handler) =>
    getShellTransport().subscribe<unknown>(TALK_VOICE_MESSAGE_EVENT, handler),
  onStatus: (handler) =>
    getShellTransport().subscribe<unknown>(TALK_VOICE_STATUS_EVENT, handler),
  onShortcut: (handler) =>
    getShellTransport().subscribe<unknown>(TALK_VOICE_SHORTCUT_EVENT, handler),
}

export const talkModelsApi = {
  status: () => call<TalkModelsStatus>("talk_models_status"),
  download: (packs?: string[]) =>
    call<TalkModelsStatus>("talk_models_download", packs ? { packs } : {}),
  cancel: (packs?: string[]) =>
    call<TalkModelsStatus>("talk_models_cancel", packs ? { packs } : {}),
  delete: (packs?: string[]) =>
    call<TalkModelsStatus>("talk_models_delete", packs ? { packs } : {}),
  onChange: (handler: (status: unknown) => void): Promise<UnsubscribeFn> =>
    getShellTransport().subscribe<unknown>(TALK_VOICE_MODELS_EVENT, handler),
}

/** System Settings › Privacy & Security › Microphone. */
export function openMicSettings(): Promise<void> {
  return call<void>("talk_voice_open_mic_settings")
}

export const talkPrefsApi = {
  get: () => call<TalkVoicePrefsView>("talk_voice_prefs_get"),
  update: (prefs: TalkVoicePrefs) =>
    call<TalkVoicePrefsView>("talk_voice_prefs_update", { prefs }),
}

/** The helper's `prefs` from the stored preferences (`useWhisper` is ours;
 *  Rust reads it, the helper ignores it). */
export function wirePrefs(prefs: TalkVoicePrefs) {
  return {
    handsFree: prefs.handsFree,
    patience: prefs.patience,
    interruptBySpeaking: prefs.interruptBySpeaking,
    speakProgress: prefs.speakProgress,
    smartTurnActive: prefs.smartTurnActive,
    echoMode: prefs.echoMode,
    shareTelemetry: prefs.shareTelemetry,
    useWhisper: prefs.useWhisper,
  }
}
