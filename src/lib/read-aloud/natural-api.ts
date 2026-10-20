/**
 * The natural voice's backend calls (`src-tauri/src/tts`): model download,
 * and audio streamed sentence by sentence as 16-bit PCM.
 *
 * Always through the SHELL transport, never the remote one: the voice is made
 * on the machine whose speakers play it. In the desktop app that is the local
 * backend, a remote-workspace window included (it runs inside this Mac's own
 * app); in a browser it is the server the page came from.
 */

import { detectEnvironment } from "@/lib/transport/detect"
import { getShellTransport } from "@/lib/transport"

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

export const ttsApi = {
  status: () => call<TtsStatus>("tts_status"),
  downloadModels: () => call<TtsStatus>("tts_download_models"),
  cancelDownload: () => call<TtsStatus>("tts_cancel_download"),
  deleteModels: () => call<TtsStatus>("tts_delete_models"),
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
