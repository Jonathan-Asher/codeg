// A remote workspace window (the Mac app showing a codeg server's sessions)
// gets "waiting on you" the same way a local one does: the snapshot through
// `remote_http_call`, the live `conversation://attention` broadcasts through
// the Rust proxy's socket frames. This drives the real RemoteDesktopTransport
// with the frames the server sends.
import { act, cleanup, render } from "@testing-library/react"
import type { Event } from "@tauri-apps/api/event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  getCurrentWebview: vi.fn(),
  listeners: new Map<string, Set<(event: Event<unknown>) => void>>(),
  transport: null as unknown,
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: ipc.getCurrentWebview,
}))
// The window's transport is the remote one, as `RemoteConnectionGate` binds
// it in the app.
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  getTransport: () => ipc.transport,
}))

import { RemoteDesktopTransport } from "@/lib/transport/remote-desktop-transport"
import type { ConversationAttentionEntry } from "@/lib/types"
import {
  __resetConversationAttentionForTests,
  useConversationAttention,
} from "@/stores/conversation-attention-store"
import { useConversationAttentionSync } from "./use-conversation-attention-sync"

type Handler = (event: Event<unknown>) => void
const CONNECTION_ID = 1
const WEBVIEW = "remote-workspace-1"

function on(target: string | null, event: string, handler: Handler) {
  const key = `${target ?? "*"}\u0000${event}`
  const set = ipc.listeners.get(key) ?? new Set<Handler>()
  set.add(handler)
  ipc.listeners.set(key, set)
  return () => set.delete(handler)
}

/** A frame as the Rust proxy forwards it from the server's socket, on this
 * window's own event name (`remote-ws-event-{connection}-{webview}`). */
function frame(payload: unknown) {
  const event = `remote-ws-event-${CONNECTION_ID}-${WEBVIEW}`
  for (const target of [WEBVIEW, null]) {
    for (const handler of ipc.listeners.get(`${target ?? "*"}\u0000${event}`) ??
      []) {
      handler({ event, id: 1, payload })
    }
  }
}

let snapshot: ConversationAttentionEntry[] = []

function Row({ id }: { id: number }) {
  const kind = useConversationAttention(id)
  return <span data-testid={`row-${id}`}>{kind ?? "none"}</span>
}

function Window() {
  useConversationAttentionSync()
  return (
    <>
      <Row id={334} />
      <Row id={12} />
    </>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  ipc.listeners.clear()
  snapshot = []
  ipc.invoke
    .mockReset()
    .mockImplementation(
      async (command: string, args?: { command?: string }) => {
        if (
          command === "remote_http_call" &&
          args?.command === "list_conversation_attention"
        ) {
          return snapshot
        }
        return undefined
      }
    )
  ipc.listen
    .mockReset()
    .mockImplementation(async (event: string, handler: Handler) =>
      on(null, event, handler)
    )
  ipc.getCurrentWebview.mockReset().mockReturnValue({
    label: WEBVIEW,
    listen: vi.fn((event: string, handler: Handler) =>
      Promise.resolve(on(WEBVIEW, event, handler))
    ),
  })
  ipc.transport = new RemoteDesktopTransport({
    id: CONNECTION_ID,
    name: "Johnnysclawd",
    baseUrl: "http://box.example:3080",
    token: "t",
    windowInstanceId: "rw-test",
  })
})

afterEach(() => {
  cleanup()
  __resetConversationAttentionForTests()
  ;(ipc.transport as RemoteDesktopTransport).destroy()
  ipc.transport = null
  vi.useRealTimers()
})

describe("waiting on you in a remote workspace window", () => {
  it("loads the server's snapshot, then follows its live broadcasts", async () => {
    snapshot = [
      { conversation_id: 12, kind: "permission", root_conversation_id: 12 },
    ]
    const view = render(<Window />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      frame({ channel: "__ready__", payload: null })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(ipc.invoke).toHaveBeenCalledWith(
      "remote_http_call",
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        command: "list_conversation_attention",
      })
    )
    expect(view.getByTestId("row-12").textContent).toBe("permission")
    expect(view.getByTestId("row-334").textContent).toBe("none")

    // The session asks a question (codeg-mcp `ask_user_question`).
    snapshot = [
      ...snapshot,
      { conversation_id: 334, kind: "question", root_conversation_id: 334 },
    ]
    await act(async () => {
      frame({
        channel: "conversation://attention",
        payload: { id: 334, kind: "question" },
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.getByTestId("row-334").textContent).toBe("question")

    // Answered: cleared at once, before the confirming snapshot.
    snapshot = snapshot.filter((e) => e.conversation_id !== 334)
    await act(async () => {
      frame({
        channel: "conversation://attention",
        payload: { id: 334, kind: null },
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.getByTestId("row-334").textContent).toBe("none")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(view.getByTestId("row-334").textContent).toBe("none")
    expect(view.getByTestId("row-12").textContent).toBe("permission")
  })

  it("puts a delegated sub-agent's question on its parent's row", async () => {
    const view = render(<Window />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      frame({ channel: "__ready__", payload: null })
      await vi.advanceTimersByTimeAsync(0)
    })
    // The broadcast names the hidden child row; the snapshot it triggers
    // knows the visible parent.
    snapshot = [
      { conversation_id: 335, kind: "question", root_conversation_id: 334 },
    ]
    await act(async () => {
      frame({
        channel: "conversation://attention",
        payload: { id: 335, kind: "question" },
      })
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(view.getByTestId("row-334").textContent).toBe("question")
  })
})
