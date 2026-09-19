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

  it("drops the trigger while streaming (dropped, not queued)", () => {
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
    expect(refetch).not.toHaveBeenCalled()
    // Stream settles (isStreaming -> false): the NEXT trigger still fires —
    // the dropped wake doesn't block later syncs.
    view.rerender({
      enabled: true,
      conversationId: 7,
      isStreaming: false,
      refetch,
    })
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    window.dispatchEvent(new Event("focus"))
    expect(refetch).toHaveBeenCalledTimes(1)
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
