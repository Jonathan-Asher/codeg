import { afterEach, describe, expect, it, vi } from "vitest"

const transports = vi.hoisted(() => {
  type Call = (command: string, args?: unknown) => Promise<unknown>
  type Subscribe = (
    event: string,
    handler: (payload: unknown) => void
  ) => Promise<() => void>
  const transport = (streamId: string) => ({
    call: vi.fn<Call>(async () => ({ streamId })),
    subscribe: vi.fn<Subscribe>(async () => () => {}),
  })
  return { shell: transport("s1"), remote: transport("remote") }
})
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => transports.shell,
  // A remote-workspace window's API calls go here; the voice must not.
  getTransport: () => transports.remote,
}))

import {
  naturalApi,
  naturalVoiceHost,
  TTS_STATUS_EVENT,
  ttsApi,
} from "./natural-api"

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.clearAllMocks()
})

describe("natural voice backend calls", () => {
  it("go to this window's own backend, never the remote server it shows", async () => {
    await naturalApi.speak("שלום world.", "noa", 1.1)
    await naturalApi.poll("s1", 10_000)
    await naturalApi.cancel("s1")
    await ttsApi.status()
    expect(transports.remote.call).not.toHaveBeenCalled()
    expect(transports.shell.call.mock.calls.map((c) => c[0])).toEqual([
      "tts_speak",
      "tts_poll",
      "tts_cancel",
      "tts_status",
    ])
    expect(transports.shell.call.mock.calls[0][1]).toEqual({
      text: "שלום world.",
      voice: "noa",
      speed: 1.1,
    })
    expect(transports.shell.call.mock.calls[1][1]).toEqual({
      streamId: "s1",
      waitMs: 10_000,
    })
  })

  it("download, delete and report on the models of this window's own backend, in a remote-workspace window too", async () => {
    await ttsApi.status()
    await ttsApi.downloadModels()
    await ttsApi.cancelDownload()
    await ttsApi.deleteModels()
    const handler = vi.fn()
    await ttsApi.onStatus(handler)
    expect(transports.remote.call).not.toHaveBeenCalled()
    expect(transports.remote.subscribe).not.toHaveBeenCalled()
    expect(transports.shell.call.mock.calls.map((c) => c[0])).toEqual([
      "tts_status",
      "tts_download_models",
      "tts_cancel_download",
      "tts_delete_models",
    ])
    expect(transports.shell.subscribe).toHaveBeenCalledWith(
      TTS_STATUS_EVENT,
      handler
    )
  })

  it("are made locally in the desktop app and by the server in a browser", () => {
    expect(naturalVoiceHost()).toBe("server")
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(naturalVoiceHost()).toBe("local")
  })
})
