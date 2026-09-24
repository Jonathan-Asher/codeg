import { beforeEach, describe, expect, it, vi } from "vitest"

// The transport talks to the Rust proxy through two Tauri APIs: `invoke` for
// commands and `listen` for the `remote-ws-event-{id}` frames. Capture the
// frame handler so tests can play the proxy's side.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  onFrame: null as ((event: { payload: unknown }) => void) | null,
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_event: string, handler: (event: { payload: unknown }) => void) => {
      tauri.onFrame = handler
      return () => {
        tauri.onFrame = null
      }
    }
  ),
}))

import { RemoteDesktopTransport } from "./remote-desktop-transport"

const UNREACHABLE = {
  code: "network_error",
  message: "Remote HTTP request failed",
}

function makeTransport(onUnauthorized = vi.fn()) {
  return new RemoteDesktopTransport({
    id: 7,
    name: "build box",
    baseUrl: "http://box:3080/",
    token: "token",
    windowInstanceId: "rw-1",
    onUnauthorized,
  })
}

function frame(channel: string) {
  tauri.onFrame?.({ payload: { channel, payload: null } })
}

async function startLink(transport: RemoteDesktopTransport) {
  transport.reconnectNow() // nothing started yet → starts the proxied WS
  await vi.waitFor(() => expect(tauri.onFrame).not.toBeNull())
}

function invoked(command: string) {
  return tauri.invoke.mock.calls.filter(([name]) => name === command).length
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.invoke.mockResolvedValue(undefined)
  tauri.onFrame = null
})

describe("RemoteDesktopTransport connection health", () => {
  it("is connecting until the first __ready__, reconnecting after a drop, connected again after", async () => {
    const transport = makeTransport()
    const seen: string[] = []
    transport.subscribeConnection(() =>
      seen.push(transport.getConnectionSnapshot())
    )
    expect(transport.getConnectionSnapshot()).toBe("connecting")

    await startLink(transport)
    frame("__ready__")
    frame("__disconnected__")
    frame("__ready__")

    expect(seen).toEqual(["connected", "reconnecting", "connected"])
  })

  it("leaves a rejected token to the window's gate instead of a state", async () => {
    const onUnauthorized = vi.fn()
    const transport = makeTransport(onUnauthorized)
    await startLink(transport)
    frame("__ready__")

    frame("__unauthorized__")
    transport.markUnauthorized()

    expect(onUnauthorized).toHaveBeenCalledTimes(2)
    expect(transport.getConnectionSnapshot()).toBe("connected")
  })

  it("asks the proxy to retry now on Reconnect once the link has started", async () => {
    const transport = makeTransport()
    await startLink(transport)
    expect(invoked("remote_ws_subscribe")).toBe(1)

    transport.reconnectNow()

    expect(invoked("remote_ws_probe")).toBe(1)
    expect(invoked("remote_ws_subscribe")).toBe(1)
  })
})

describe("RemoteDesktopTransport recovery after calls failed", () => {
  it("probes the link when a call cannot reach the remote", async () => {
    const transport = makeTransport()
    await startLink(transport)
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })

    await expect(transport.call("list_folders")).rejects.toBe(UNREACHABLE)
    expect(invoked("remote_ws_probe")).toBe(1)
  })

  it("does not treat the server's own network errors as a lost link", async () => {
    const transport = makeTransport()
    await startLink(transport)
    const serverError = {
      code: "network_error",
      message: "Failed to fetch https://example.com",
    }
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw serverError
    })

    await expect(transport.call("fetch_url")).rejects.toBe(serverError)
    expect(invoked("remote_ws_probe")).toBe(0)
  })

  it("fires the reconnect callbacks on the first __ready__ when calls failed before it", async () => {
    const transport = makeTransport()
    const recovered = vi.fn()
    transport.onReconnect(recovered)
    await startLink(transport)
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })
    await transport.call("list_folders").catch(() => {})

    frame("__ready__")

    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it("keeps the first __ready__ quiet when nothing failed before it", async () => {
    const transport = makeTransport()
    const recovered = vi.fn()
    transport.onReconnect(recovered)
    await startLink(transport)

    frame("__ready__")
    expect(recovered).not.toHaveBeenCalled()

    frame("__disconnected__")
    frame("__ready__")
    expect(recovered).toHaveBeenCalledTimes(1)
  })
})
