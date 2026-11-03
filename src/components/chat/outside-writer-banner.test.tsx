import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { formatOutsideWriterStart } from "@/lib/outside-writer"
import type { OutsideWriterPhase } from "@/stores/outside-writer-store"
import { OutsideWriterBanner } from "./outside-writer-banner"

const STARTED = new Date(2026, 10, 3, 9, 5).getTime()

function renderBanner(
  phase: OutsideWriterPhase,
  startedAt: number | null = STARTED
) {
  const actions = {
    onConnectAnyway: vi.fn(),
    onStopWaiting: vi.fn(),
    onConnect: vi.fn(),
  }
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OutsideWriterBanner
        writer={{ pid: 4242, startedAt }}
        phase={phase}
        {...actions}
      />
    </NextIntlClientProvider>
  )
  return actions
}

describe("OutsideWriterBanner", () => {
  it("names the process and says codeg connects once it finishes", () => {
    renderBanner("waiting")
    const time = formatOutsideWriterStart(STARTED, "en")
    expect(
      screen.getByText(
        `This session is running in another process (pid 4242, started ${time}). codeg will connect when it finishes.`
      )
    ).toBeTruthy()
    expect(
      screen.getByTestId("outside-writer-banner").getAttribute("data-phase")
    ).toBe("waiting")
  })

  it("leaves the start out when the process did not say", () => {
    renderBanner("waiting", null)
    expect(
      screen.getByText(
        "This session is running in another process (pid 4242). codeg will connect when it finishes."
      )
    ).toBeTruthy()
  })

  it("connects anyway only once the user confirms", () => {
    const actions = renderBanner("waiting")
    fireEvent.click(screen.getByRole("button", { name: "Connect anyway" }))
    expect(actions.onConnectAnyway).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog")
    expect(dialog.textContent).toContain("Process 4242 is still running")

    // Cancel: nothing happens.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(actions.onConnectAnyway).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Connect anyway" }))
    const confirm = screen
      .getAllByRole("button", { name: "Connect anyway" })
      .find((button) => screen.getByRole("alertdialog").contains(button))
    fireEvent.click(confirm!)
    expect(actions.onConnectAnyway).toHaveBeenCalledTimes(1)
  })

  it("stops waiting on its link", () => {
    const actions = renderBanner("waiting")
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }))
    expect(actions.onStopWaiting).toHaveBeenCalledTimes(1)
    expect(actions.onConnect).not.toHaveBeenCalled()
  })

  it("holds its actions while the connect anyway is on its way", () => {
    renderBanner("connecting_anyway")
    const busy = screen.getByTestId("outside-writer-connect-anyway")
    expect(busy.textContent).toBe("Connecting…")
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByTestId("outside-writer-stop-waiting") as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it("offers a plain connect once the user stopped waiting", () => {
    const actions = renderBanner("stopped")
    expect(
      screen.getByText(
        "Not waiting for process 4242: codeg connects to this session only when you ask."
      )
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Connect anyway" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    expect(actions.onConnect).toHaveBeenCalledTimes(1)
  })
})
