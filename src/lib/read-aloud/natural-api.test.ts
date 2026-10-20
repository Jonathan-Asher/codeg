import { afterEach, describe, expect, it, vi } from "vitest"

const transports = vi.hoisted(() => {
  type Call = (command: string, args?: unknown) => Promise<unknown>
  return {
    shell: { call: vi.fn<Call>(async () => ({ streamId: "s1" })) },
    remote: { call: vi.fn<Call>(async () => ({ streamId: "remote" })) },
  }
})
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => transports.shell,
  // A remote-workspace window's API calls go here; the voice must not.
  getTransport: () => transports.remote,
}))

import { naturalApi, naturalVoiceHost, ttsApi } from "./natural-api"

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

  it("are made locally in the desktop app and by the server in a browser", () => {
    expect(naturalVoiceHost()).toBe("server")
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(naturalVoiceHost()).toBe("local")
  })
})
