import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WindowlessSettingsView } from "@/lib/types"

const getSettings = vi.fn<() => Promise<WindowlessSettingsView>>()
const updateSettings =
  vi.fn<(enabled: boolean) => Promise<WindowlessSettingsView>>()
const toastError = vi.fn()

vi.mock("@/lib/api", () => ({
  getWindowlessSettings: () => getSettings(),
  updateWindowlessSettings: (enabled: boolean) => updateSettings(enabled),
}))
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { WindowlessSettingsSection } from "./windowless-settings"

const messages = enMessages.WindowlessSettings

function view(patch: Partial<WindowlessSettingsView> = {}) {
  return {
    supported: true,
    enabled: false,
    active: false,
    source: null,
    web_service_auto_start: true,
    ...patch,
  } satisfies WindowlessSettingsView
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WindowlessSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  toastError.mockClear()
  getSettings.mockReset()
  updateSettings.mockReset()
  getSettings.mockResolvedValue(view())
})
afterEach(() => cleanup())

describe("WindowlessSettingsSection", () => {
  it("shows the switch off by default, with what it is for", async () => {
    renderSection()
    const toggle = await screen.findByRole("switch")
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(messages.title)).toBeInTheDocument()
    expect(screen.getByText(messages.description)).toBeInTheDocument()
  })

  it("turns it on and says it takes effect at the next start", async () => {
    const user = userEvent.setup()
    updateSettings.mockResolvedValue(view({ enabled: true }))
    renderSection()

    await user.click(await screen.findByRole("switch"))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(true))
    expect(await screen.findByText(messages.pendingOn)).toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeChecked()
  })

  it("turns it off on a codeg running without a window", async () => {
    const user = userEvent.setup()
    getSettings.mockResolvedValue(
      view({ enabled: true, active: true, source: "file" })
    )
    updateSettings.mockResolvedValue(
      view({ enabled: false, active: true, source: "file" })
    )
    renderSection()

    expect(await screen.findByText(messages.activeNow)).toBeInTheDocument()
    await user.click(screen.getByRole("switch"))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(false))
    expect(await screen.findByText(messages.pendingOff)).toBeInTheDocument()
  })

  it("puts the switch back when the write fails", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("read-only file system"))
    renderSection()

    await user.click(await screen.findByRole("switch"))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // A switch left on would claim a mode the next start will not have.
    expect(screen.getByRole("switch")).not.toBeChecked()
  })

  it("says when a launch flag or the environment decided this run", async () => {
    getSettings.mockResolvedValue(
      view({ enabled: false, active: true, source: "flag" })
    )
    const { unmount } = renderSection()
    expect(await screen.findByText(messages.setByFlag)).toBeInTheDocument()
    unmount()

    getSettings.mockResolvedValue(
      view({ enabled: true, active: false, source: "env" })
    )
    renderSection()
    expect(await screen.findByText(messages.setByEnvOff)).toBeInTheDocument()
  })

  it("warns when nothing could reach a codeg without a window", async () => {
    getSettings.mockResolvedValue(
      view({ enabled: true, web_service_auto_start: false })
    )
    renderSection()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      messages.webServiceOff
    )
  })

  it("stays out of the page where the backend cannot do it", async () => {
    getSettings.mockResolvedValue(view({ supported: false }))
    renderSection()
    await waitFor(() => expect(getSettings).toHaveBeenCalled())
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("stays out of the page when the backend does not know the setting", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    getSettings.mockRejectedValue(new Error("404"))
    renderSection()
    await waitFor(() => expect(consoleError).toHaveBeenCalled())
    expect(screen.queryByRole("switch")).toBeNull()
    consoleError.mockRestore()
  })
})
