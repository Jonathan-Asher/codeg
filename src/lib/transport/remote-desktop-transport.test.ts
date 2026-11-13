import { beforeEach, describe, expect, it, vi } from "vitest"

// The transport talks to the Rust proxy through two Tauri APIs: `invoke` for
// commands and `listen` for the `remote-ws-event-{id}` frames. Capture the
// frame handler so tests can play the proxy's side.
type ListenTarget = { kind: string; label?: string }
type FrameHandler = (event: { payload: unknown }) => void
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  onFrame: null as FrameHandler | null,
  /** Live listeners with the target each registered for. */
  listeners: [] as { target: ListenTarget; handler: FrameHandler }[],
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      _event: string,
      handler: FrameHandler,
      options?: { target?: ListenTarget }
    ) => {
      const entry = { target: options?.target ?? { kind: "Any" }, handler }
      tauri.listeners.push(entry)
      tauri.onFrame = handler
      return () => {
        tauri.listeners = tauri.listeners.filter((l) => l !== entry)
        if (tauri.onFrame === handler) tauri.onFrame = null
      }
    }
  ),
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ label: "remote-workspace-7" }),
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
  tauri.listeners = []
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

  it("hands a rejected token to the window's gate, even mid-reconnect", async () => {
    const onUnauthorized = vi.fn()
    const transport = makeTransport(onUnauthorized)
    await startLink(transport)
    frame("__ready__")
    frame("__disconnected__")

    frame("__unauthorized__")

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    // No longer "reconnecting": the dialog must not stack on the gate.
    expect(transport.getConnectionSnapshot()).toBe("unauthorized")
  })

  it("treats a 401 on a call as a rejected token", async () => {
    const onUnauthorized = vi.fn()
    const transport = makeTransport(onUnauthorized)
    const rejected = { code: "authentication_failed", message: "invalid" }
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw rejected
    })

    await expect(transport.call("list_folders")).rejects.toBe(rejected)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(transport.getConnectionSnapshot()).toBe("unauthorized")
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
    frame("__ready__")
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })

    await expect(transport.call("list_folders")).rejects.toBe(UNREACHABLE)
    expect(invoked("remote_ws_probe")).toBe(1)
  })

  it("asks once for a burst of failed calls, not once per call", async () => {
    const transport = makeTransport()
    await startLink(transport)
    frame("__ready__")
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })

    await Promise.all(
      Array.from({ length: 25 }, () =>
        transport.call("list_folders").catch(() => {})
      )
    )
    expect(invoked("remote_ws_probe")).toBe(1)
  })

  it("leaves the retrying to the proxy's backoff once the link is known down", async () => {
    // The 2026-10-11 loop: every failed call's probe cut the proxy's backoff
    // short, and the UI's calls failed as fast as they were made.
    const transport = makeTransport()
    await startLink(transport)
    frame("__ready__")
    frame("__disconnected__")
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })

    for (let i = 0; i < 25; i++) {
      await transport.call("list_folders").catch(() => {})
    }
    expect(invoked("remote_ws_probe")).toBe(0)
    // The user's own "Reconnect now" still goes through.
    transport.reconnectNow()
    expect(invoked("remote_ws_probe")).toBe(1)
  })

  it("does not probe while the first connect is still under way", async () => {
    const transport = makeTransport()
    await startLink(transport)
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "remote_http_call") throw UNREACHABLE
    })

    await transport.call("list_folders").catch(() => {})
    expect(invoked("remote_ws_probe")).toBe(0)
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

  it("resyncs on the server's hint without dropping the link", async () => {
    const transport = makeTransport()
    const recovered = vi.fn()
    transport.onReconnect(recovered)
    await startLink(transport)
    frame("__ready__")

    frame("__resync__")
    expect(recovered).toHaveBeenCalledTimes(1)
    expect(transport.getConnectionSnapshot()).toBe("connected")
  })
})

describe("RemoteDesktopTransport liveness hints", () => {
  const streamingCalls = () =>
    tauri.invoke.mock.calls.filter(
      ([name]) => name === "remote_ws_set_streaming"
    )

  it("tells the proxy when a turn streams on screen, and again after a reconnect", async () => {
    const transport = makeTransport()
    await startLink(transport)
    frame("__ready__")

    transport.setStreamingOnScreen(true)
    transport.setStreamingOnScreen(true)
    expect(streamingCalls()).toHaveLength(1)
    expect(streamingCalls()[0][1]).toMatchObject({
      connectionId: 7,
      streaming: true,
    })

    // The proxy's task may have been replaced while the link was down.
    frame("__disconnected__")
    frame("__ready__")
    expect(streamingCalls()).toHaveLength(2)

    transport.setStreamingOnScreen(false)
    expect(streamingCalls()[2][1]).toMatchObject({ streaming: false })
  })

  it("gives reads a short timeout while the link is down, never writes", async () => {
    const transport = makeTransport()
    await startLink(transport)
    frame("__ready__")
    frame("__disconnected__")
    const timeouts = () =>
      tauri.invoke.mock.calls
        .filter(([name]) => name === "remote_http_call")
        .map(([, args]) => (args as { timeoutMs?: number }).timeoutMs)

    await transport.call("list_folders")
    await transport.call("rename_conversation", { id: 1 })
    await transport.call("list_folders", {}, { timeoutMs: 60_000 })
    frame("__ready__")
    await transport.call("list_folders")

    expect(timeouts()).toEqual([8_000, undefined, 60_000, undefined])
  })
})

describe("RemoteDesktopTransport delivery with several windows on one connection", () => {
  // Tauri's rule for `emit_to(EventTarget::webview(label))`: a listener gets
  // the emit when its target is `Any`, or names that same label. The proxy
  // addresses frames per subscribed window (`emit_internal_to_label` still
  // does), so this is what the transport has to hold up against.
  function emitToWindows(labels: string[], payload: unknown) {
    for (const label of labels) {
      for (const { target, handler } of tauri.listeners) {
        if (target.kind === "Any" || target.label === label) {
          handler({ payload })
        }
      }
    }
  }
  const WINDOWS = ["quick-ask", "remote-workspace-7"]
  const output = (seq: number) => ({
    channel: "terminal://output/t1",
    payload: { terminal_id: "t1", data: "l", seq },
  })

  async function subscribed(transport: RemoteDesktopTransport) {
    const got = vi.fn()
    const pending = transport.subscribe("terminal://output/t1", got)
    await vi.waitFor(() => expect(tauri.listeners).toHaveLength(1))
    emitToWindows(WINDOWS, { channel: "__ready__", payload: null })
    await pending
    return got
  }

  it("listens on its own window only", async () => {
    await subscribed(makeTransport())
    expect(tauri.listeners[0].target).toEqual({
      kind: "Webview",
      label: "remote-workspace-7",
    })
  })

  it("takes one copy of a frame addressed to every window", async () => {
    const got = await subscribed(makeTransport())

    emitToWindows(WINDOWS, output(1))
    emitToWindows(WINDOWS, output(2))

    expect(got.mock.calls.map(([p]) => p.seq)).toEqual([1, 2])
  })

  it("still takes one copy after the link reconnects", async () => {
    const got = await subscribed(makeTransport())
    emitToWindows(WINDOWS, output(1))

    emitToWindows(WINDOWS, { channel: "__disconnected__", payload: null })
    emitToWindows(WINDOWS, { channel: "__ready__", payload: null })
    emitToWindows(WINDOWS, output(2))
    emitToWindows(WINDOWS, output(3))

    expect(tauri.listeners).toHaveLength(1)
    expect(got.mock.calls.map(([p]) => p.seq)).toEqual([1, 2, 3])
  })

  it("leaves nothing behind when the window rebinds to a new transport", async () => {
    const first = makeTransport()
    const stale = await subscribed(first)
    first.destroy()
    const got = await subscribed(makeTransport())

    emitToWindows(WINDOWS, output(1))

    expect(stale).not.toHaveBeenCalled()
    expect(got).toHaveBeenCalledTimes(1)
  })

  it("ignores the __ready__ another window gets when it joins", async () => {
    const transport = makeTransport()
    const recovered = vi.fn()
    transport.onReconnect(recovered)
    await subscribed(transport)

    emitToWindows(["quick-ask"], { channel: "__ready__", payload: null })

    expect(recovered).not.toHaveBeenCalled()
  })
})
