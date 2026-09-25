import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// A remote-workspace window: the hook reaches the window's transport through
// `onTransportReconnect`, and the transport talks to the Rust proxy through
// Tauri's `invoke` / `listen`, whose side the test plays.
const env = vi.hoisted(() => ({
  invoke: vi.fn(),
  onFrame: null as ((event: { payload: unknown }) => void) | null,
  transport: null as { onReconnect(cb: () => void): () => void } | null,
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: env.invoke }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_event: string, handler: (event: { payload: unknown }) => void) => {
      env.onFrame = handler
      return () => {
        env.onFrame = null
      }
    }
  ),
}))
vi.mock("@/lib/platform", () => ({
  onTransportReconnect: (cb: () => void) =>
    env.transport?.onReconnect(cb) ?? null,
}))

import { RemoteDesktopTransport } from "@/lib/transport/remote-desktop-transport"
import { useWakeResync } from "./use-wake-resync"

const UNREACHABLE = {
  code: "network_error",
  message: "Remote HTTP request failed",
}

function frame(channel: string) {
  env.onFrame?.({ payload: { channel, payload: null } })
}

async function openRemoteWindow() {
  const transport = new RemoteDesktopTransport({
    id: 3,
    name: "build box",
    baseUrl: "http://box:3080/",
    token: "token",
    windowInstanceId: "rw-1",
    onUnauthorized: vi.fn(),
  })
  env.transport = transport
  const refetch = vi.fn(async () => true)
  renderHook(() =>
    useWakeResync({
      enabled: true,
      conversationId: 7,
      isStreaming: false,
      turnReachedView: () => false,
      refetch,
    })
  )
  transport.reconnectNow() // nothing started yet → starts the proxied WS
  await vi.waitFor(() => expect(env.onFrame).not.toBeNull())
  return { transport, refetch }
}

beforeEach(() => {
  env.invoke.mockReset()
  env.invoke.mockResolvedValue(undefined)
  env.onFrame = null
  env.transport = null
})

describe("useWakeResync in a remote-workspace window", () => {
  it("refetches when the proxied link comes back after a drop", async () => {
    const { refetch } = await openRemoteWindow()
    frame("__ready__")
    // The first connect is not a recovery: nothing was missed yet.
    expect(refetch).not.toHaveBeenCalled()

    frame("__disconnected__")
    frame("__ready__")
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith(7)
  })

  it("refetches on the first connect when calls failed before it (opened while the server was down)", async () => {
    const { transport, refetch } = await openRemoteWindow()
    env.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })
    // The panel's own detail load, say: it failed for want of a link.
    await transport.call("get_folder_conversation").catch(() => {})

    frame("__ready__")
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
