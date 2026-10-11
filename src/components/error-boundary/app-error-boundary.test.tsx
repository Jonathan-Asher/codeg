import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The window's link, as the connection dialog sees it.
const link = vi.hoisted(() => {
  type State = "connected" | "connecting" | "reconnecting" | "unauthorized"
  let state: State = "connected"
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (next: State) => {
      state = next
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
  }
})

vi.mock("@/lib/transport/web-connection-store", () => ({
  subscribeWebConnection: link.subscribe,
  getWebConnectionSnapshot: link.get,
  getWebConnectionServerSnapshot: () => "connected",
}))

const reported = vi.hoisted(() => vi.fn())
vi.mock("@/lib/client-error-report", () => ({
  reportBoundaryError: reported,
}))

vi.mock("next/navigation", () => ({ usePathname: () => "/workspace" }))

import enMessages from "@/i18n/messages/en.json"
import { AppErrorBoundary, SILENT_RETRY_DELAYS_MS } from "./app-error-boundary"

/** A child that throws while `broken.now` is set. */
const broken = { now: true }
function Flaky({ label = "content" }: { label?: string }) {
  if (broken.now) throw new Error("Cannot read properties of undefined")
  return <div>{label}</div>
}

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  link.reset()
  reported.mockClear()
  broken.now = true
  // React logs every caught error; keep the output readable.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("AppErrorBoundary", () => {
  it("contains a failing region and keeps the rest of the window", () => {
    renderWithIntl(
      <>
        <div>sidebar</div>
        <AppErrorBoundary scope="conversation">
          <Flaky />
        </AppErrorBoundary>
      </>
    )
    expect(screen.getByText("sidebar")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong here"
    )
    expect(reported).toHaveBeenCalledWith(
      "conversation",
      expect.objectContaining({
        message: "Cannot read properties of undefined",
      }),
      expect.any(String)
    )
  })

  it("renders the region again on Try again", () => {
    renderWithIntl(
      <AppErrorBoundary scope="conversation">
        <Flaky />
      </AppErrorBoundary>
    )
    broken.now = false
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }))
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("clears the error when its reset key changes", () => {
    const { rerender } = renderWithIntl(
      <AppErrorBoundary scope="conversation" resetKey="tab-1">
        <Flaky />
      </AppErrorBoundary>
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    broken.now = false
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AppErrorBoundary scope="conversation" resetKey="tab-2">
          <Flaky label="other tab" />
        </AppErrorBoundary>
      </NextIntlClientProvider>
    )
    expect(screen.getByText("other tab")).toBeInTheDocument()
  })

  it("says it is waiting for the server while the link is down, then retries by itself", () => {
    link.set("reconnecting")
    renderWithIntl(
      <AppErrorBoundary scope="conversation">
        <Flaky />
      </AppErrorBoundary>
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Waiting for the server"
    )
    // No reload offered: it could not load anything.
    expect(screen.queryByRole("button", { name: /Reload/ })).toBeNull()

    broken.now = false
    act(() => link.set("connected"))
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("retries when the link drops and comes back after the failure", () => {
    renderWithIntl(
      <AppErrorBoundary scope="conversation">
        <Flaky />
      </AppErrorBoundary>
    )
    act(() => link.set("reconnecting"))
    broken.now = false
    act(() => link.set("connected"))
    expect(screen.getByText("content")).toBeInTheDocument()
  })

  it("lets a silent widget vanish and try again a few times by itself", () => {
    const { container } = renderWithIntl(
      <AppErrorBoundary scope="status-bar" variant="silent">
        <Flaky label="status" />
      </AppErrorBoundary>
    )
    expect(container).toBeEmptyDOMElement()

    // Still broken at the first retry: stays empty, schedules the next.
    act(() => vi.advanceTimersByTime(SILENT_RETRY_DELAYS_MS[0]))
    expect(container).toBeEmptyDOMElement()

    broken.now = false
    act(() => vi.advanceTimersByTime(SILENT_RETRY_DELAYS_MS[1]))
    expect(screen.getByText("status")).toBeInTheDocument()
  })

  it("stops retrying a silent widget that keeps failing", () => {
    const { container } = renderWithIntl(
      <AppErrorBoundary scope="status-bar" variant="silent">
        <Flaky label="status" />
      </AppErrorBoundary>
    )
    for (const delay of SILENT_RETRY_DELAYS_MS) {
      act(() => vi.advanceTimersByTime(delay))
    }
    const caught = reported.mock.calls.length
    act(() => vi.advanceTimersByTime(60 * 60 * 1000))
    expect(reported.mock.calls.length).toBe(caught)
    expect(container).toBeEmptyDOMElement()
  })

  it("still shows a fallback with no translations above it", () => {
    render(
      <AppErrorBoundary scope="page" variant="page">
        <Flaky />
      </AppErrorBoundary>
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong in this part of codeg."
    )
  })

  it("lets Next's own redirects through", () => {
    function Redirects(): React.ReactNode {
      throw Object.assign(new Error("NEXT_REDIRECT"), {
        digest: "NEXT_REDIRECT;replace;/login;307;",
      })
    }
    expect(() =>
      renderWithIntl(
        <AppErrorBoundary scope="page">
          <Redirects />
        </AppErrorBoundary>
      )
    ).toThrow("NEXT_REDIRECT")
    expect(reported).not.toHaveBeenCalled()
  })
})
