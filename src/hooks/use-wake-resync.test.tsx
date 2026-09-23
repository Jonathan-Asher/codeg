import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWakeResync } from "./use-wake-resync"

const onReconnectCallbacks = new Set<() => void>()
const onReconnect = vi.fn((cb: () => void) => {
  onReconnectCallbacks.add(cb)
  return () => {
    onReconnectCallbacks.delete(cb)
  }
})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ onReconnect }),
}))

function fireVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("useWakeResync", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    onReconnectCallbacks.clear()
    onReconnect.mockClear()
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  type WakeResyncProps = Parameters<typeof useWakeResync>[0]

  const setup = (overrides?: Partial<WakeResyncProps>) => {
    const refetch = vi.fn()
    const rerun = (next?: Partial<WakeResyncProps>) =>
      renderHook((props: WakeResyncProps) => useWakeResync(props), {
        initialProps: {
          enabled: true,
          conversationId: 7,
          isStreaming: false,
          refetch,
          ...overrides,
          ...next,
        },
      })
    const view = rerun()
    return {
      refetch,
      view,
      rerun: (n: Partial<WakeResyncProps>) =>
        view.rerender({
          enabled: true,
          conversationId: 7,
          isStreaming: false,
          refetch,
          ...n,
        }),
    }
  }

  it("refetches when the document becomes visible (wake)", () => {
    const { refetch } = setup()
    fireVisibility("visible")
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith(7)
  })

  it("does not refetch when hidden", () => {
    const { refetch } = setup()
    fireVisibility("hidden")
    expect(refetch).not.toHaveBeenCalled()
  })

  it("refetches on window focus", () => {
    const { refetch } = setup()
    window.dispatchEvent(new Event("focus"))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("refetches on transport reconnect", () => {
    const { refetch } = setup()
    expect(onReconnect).toHaveBeenCalledTimes(1)
    for (const cb of onReconnectCallbacks) cb()
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("defers a wake that lands mid-stream and releases it when the stream settles", () => {
    const refetch = vi.fn()
    const view = renderHook((props) => useWakeResync(props), {
      initialProps: {
        enabled: true,
        conversationId: 7,
        isStreaming: true,
        refetch,
      },
    })
    fireVisibility("visible")
    // Mid-stream: never refetch under a live stream.
    expect(refetch).not.toHaveBeenCalled()
    // Stream settles (isStreaming -> false): the owed wake fires by itself —
    // after sleep this is the only chance, no later trigger is coming.
    view.rerender({
      enabled: true,
      conversationId: 7,
      isStreaming: false,
      refetch,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith(7)
    // Released once: a later settle without a new trigger stays quiet.
    view.rerender({
      enabled: true,
      conversationId: 7,
      isStreaming: true,
      refetch,
    })
    view.rerender({
      enabled: true,
      conversationId: 7,
      isStreaming: false,
      refetch,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("defers a reconnect that arrives while the client still believes it is streaming", () => {
    // The sleep case: the turn ended server-side while the socket was dead,
    // so the client is still `prompting` when the WS comes back. The
    // reconnect callback fires BEFORE the re-attach snapshot flips the
    // status — it must wait for that flip, not be lost.
    const refetch = vi.fn()
    const view = renderHook((props) => useWakeResync(props), {
      initialProps: {
        enabled: true,
        conversationId: 7,
        isStreaming: true,
        refetch,
      },
    })
    act(() => {
      for (const cb of onReconnectCallbacks) cb()
    })
    expect(refetch).not.toHaveBeenCalled()
    view.rerender({
      enabled: true,
      conversationId: 7,
      isStreaming: false,
      refetch,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("forgets a deferred trigger when the conversation changes", () => {
    const refetch = vi.fn()
    const view = renderHook((props) => useWakeResync(props), {
      initialProps: {
        enabled: true,
        conversationId: 7,
        isStreaming: true,
        refetch,
      },
    })
    fireVisibility("visible")
    view.rerender({
      enabled: true,
      conversationId: 8,
      isStreaming: false,
      refetch,
    })
    // The wake was owed to conversation 7; it must not fire against 8.
    expect(refetch).not.toHaveBeenCalled()
  })

  it("debounces trigger bursts to one refetch", () => {
    const { refetch } = setup()
    fireVisibility("visible")
    window.dispatchEvent(new Event("focus"))
    for (const cb of onReconnectCallbacks) cb()
    expect(refetch).toHaveBeenCalledTimes(1)
    // After the debounce window a new trigger fires again.
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    window.dispatchEvent(new Event("focus"))
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it("does not fire when disabled (background tab)", () => {
    const { refetch } = setup({ enabled: false })
    fireVisibility("visible")
    window.dispatchEvent(new Event("focus"))
    for (const cb of onReconnectCallbacks) cb()
    expect(refetch).not.toHaveBeenCalled()
  })

  it("does not fire without a conversation id", () => {
    const { refetch } = setup({ conversationId: null })
    fireVisibility("visible")
    expect(refetch).not.toHaveBeenCalled()
  })
})
