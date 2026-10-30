/**
 * The natural voice's backend calls (`src-tauri/src/tts`): model download,
 * and audio streamed sentence by sentence as 16-bit PCM.
 *
 * Always through the SHELL transport, never the remote one: the voice is made
 * on the machine whose speakers play it. In the desktop app that is the local
 * backend, a remote-workspace window included (it runs inside this Mac's own
 * app); in a browser it is the server the page came from. The status events
 * come from the same backend, so a remote-workspace window hears about this
 * Mac's models, not the remote server's.
 */

import { detectEnvironment } from "@/lib/transport/detect"
import { getShellTransport, type UnsubscribeFn } from "@/lib/transport"

export type TtsDownloadState =
  | { state: "idle" }
  | { state: "downloading"; bytesDone: number; bytesTotal: number }
  | { state: "failed"; message: string }

/** Mirrors `TtsStatus` in `src-tauri/src/tts/mod.rs`. */
export interface TtsStatus {
  supported: boolean
  /** `platform`, `sidecarMissing`, `disabled`, or a catalog error. */
  unsupportedReason: string | null
  installed: boolean
  download: TtsDownloadState
  packBytes: number
  bytesOnDisk: number
  modelsDir: string
  voices: string[]
  defaultVoice: string
  engineRunning: boolean
  engineLoaded: boolean
}

export interface TtsChunk {
  index: number
  sampleRate: number
  /** 16-bit little-endian mono PCM, base64. */
  pcm: string
}

export interface TtsPollResult {
  chunks: TtsChunk[]
  done: boolean
  error: string | null
  stats: {
    chunks: number
    cancelled: boolean
    audioMs: number
    elapsedMs: number
    firstChunkMs: number | null
  } | null
}

/** What the natural player needs from the backend; tests pass a fake. */
export interface NaturalApi {
  speak(
    text: string,
    voice: string | null,
    speed: number
  ): Promise<{ streamId: string }>
  poll(streamId: string, waitMs: number): Promise<TtsPollResult>
  cancel(streamId: string): Promise<void>
}

/** Where the natural voice is made for this window. */
export type NaturalVoiceHost = "local" | "server"

export function naturalVoiceHost(): NaturalVoiceHost {
  return detectEnvironment() === "tauri" ? "local" : "server"
}

/** Longest a poll waits server-side; well inside the web call timeout. */
export const POLL_WAIT_MS = 10_000

function call<T>(command: string, args?: Record<string, unknown>) {
  return getShellTransport().call<T>(command, args, { timeoutMs: 30_000 })
}

/** Sent by the backend with the new status whenever a download starts, ends,
 *  fails or is cancelled, or the models are deleted, from whichever window
 *  asked (`TTS_STATUS_EVENT` in `src-tauri/src/commands/tts.rs`). */
export const TTS_STATUS_EVENT = "tts://status"

export const ttsApi = {
  status: () => call<TtsStatus>("tts_status"),
  downloadModels: () => call<TtsStatus>("tts_download_models"),
  cancelDownload: () => call<TtsStatus>("tts_cancel_download"),
  deleteModels: () => call<TtsStatus>("tts_delete_models"),
  onStatus: (handler: (status: unknown) => void): Promise<UnsubscribeFn> =>
    getShellTransport().subscribe<unknown>(TTS_STATUS_EVENT, handler),
}

export const naturalApi: NaturalApi = {
  speak: (text, voice, speed) =>
    call<{ streamId: string }>("tts_speak", { text, voice, speed }),
  poll: (streamId, waitMs) =>
    call<TtsPollResult>("tts_poll", { streamId, waitMs }),
  cancel: async (streamId) => {
    await call<null>("tts_cancel", { streamId })
  },
}
