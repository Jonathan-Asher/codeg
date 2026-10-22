import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Controllable stand-in for the connection store. `vi.hoisted` guarantees the
// shared object exists before the hoisted `vi.mock` factory runs.
const store = vi.hoisted(() => {
  type State = "connected" | "connecting" | "reconnecting" | "unauthorized"
  let state: State = "connected"
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (s: State) => {
      state = s
      for (const l of listeners) l()
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    reset: () => {
      state = "connected"
      listeners.clear()
    },
    reconnectWebNow: vi.fn(),
    redirectToCodegLogin: vi.fn(),
    probeTransportLiveness: vi.fn(),
  }
})

vi.mock("@/lib/transport/web-connection-store", () => ({
  subscribeWebConnection: store.subscribe,
  getWebConnectionSnapshot: store.getState,
  getWebConnectionServerSnapshot: () => "connected",
  reconnectWebNow: store.reconnectWebNow,
  notifyWebUnauthorized: vi.fn(),
}))

vi.mock("@/lib/transport/web-auth", () => ({
  redirectToCodegLogin: store.redirectToCodegLogin,
  getCodegToken: () => "tok",
}))

vi.mock("@/lib/platform", () => ({
  probeTransportLiveness: store.probeTransportLiveness,
}))

import { WebConnectionGuard } from "./web-connection-guard"
import {
  ConnectionStatusPill,
  __resetConnectionDisplayForTests,
} from "./connection-banner"
import enMessages from "@/i18n/messages/en.json"

function renderGuard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WebConnectionGuard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetConnectionDisplayForTests()
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
  store.reset()
  store.reconnectWebNow.mockClear()
  store.redirectToCodegLogin.mockClear()
  store.probeTransportLiveness.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("WebConnectionGuard", () => {
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })

  it("renders nothing while connected", () => {
    renderGuard()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("never blocks the window for a lost link: a pill after a second, a banner after ten", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))
    // A brief blip shows nothing at all.
    expect(screen.queryByTestId("connection-pill")).not.toBeInTheDocument()
    advance(1_000)
    expect(screen.getByTestId("connection-pill")).toHaveTextContent(
      "Reconnecting…"
    )
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()

    advance(9_000)
    const banner = screen.getByTestId("connection-offline-banner")
    expect(banner).toHaveTextContent("Offline")
    expect(banner).toHaveTextContent("Showing what was already loaded")
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(store.reconnectWebNow).toHaveBeenCalledTimes(1)
  })

  it("says it is still connecting when the link never came up", () => {
    renderGuard()
    act(() => store.setState("connecting"))
    advance(1_000)
    expect(screen.getByTestId("connection-pill")).toHaveTextContent(
      "Connecting…"
    )
    advance(9_000)
    expect(screen.getByTestId("connection-offline-banner")).toHaveTextContent(
      "Waiting for the server to answer"
    )
  })

  it("shows the session-expired dialog immediately for unauthorized", () => {
    renderGuard()
    act(() => store.setState("unauthorized"))
    // No timer advance: a rejected token is surfaced at once.
    expect(screen.getByText("Session expired")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Go to login" }))
    expect(store.redirectToCodegLogin).toHaveBeenCalledTimes(1)
  })

  it("clears once the connection recovers, saying so for two seconds", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))
    advance(10_000)
    expect(screen.getByTestId("connection-offline-banner")).toBeInTheDocument()

    act(() => store.setState("connected"))
    expect(
      screen.queryByTestId("connection-offline-banner")
    ).not.toBeInTheDocument()
    expect(screen.getByTestId("connection-pill")).toHaveTextContent(
      "Back online"
    )
    advance(2_100)
    expect(screen.queryByTestId("connection-pill")).not.toBeInTheDocument()
  })

  it("leaves the pill to the status bar when one is on screen", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WebConnectionGuard />
        <ConnectionStatusPill />
      </NextIntlClientProvider>
    )
    act(() => store.setState("reconnecting"))
    advance(1_000)
    expect(screen.getAllByTestId("connection-pill")).toHaveLength(1)
  })

  it("probes transport liveness on network restore while reconnecting", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))

    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    // The transport decides what a probe means in this state (skip the
    // remaining backoff); the guard never reaches past it.
    expect(store.probeTransportLiveness).toHaveBeenCalledTimes(1)
    expect(store.reconnectWebNow).not.toHaveBeenCalled()
  })

  it("probes liveness on every wake signal even while the link looks connected", () => {
    // A socket that died during sleep still reports "connected" — the probe
    // is exactly how that gets noticed, so it must not be gated on state.
    renderGuard()
    act(() => {
      window.dispatchEvent(new Event("online"))
      window.dispatchEvent(new Event("pageshow"))
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(store.probeTransportLiveness).toHaveBeenCalledTimes(3)
  })

  it("does not probe when the tab goes hidden", () => {
    renderGuard()
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(store.probeTransportLiveness).not.toHaveBeenCalled()
  })
})
