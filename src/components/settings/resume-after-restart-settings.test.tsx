import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AutoResumeSettings } from "@/lib/types"

const getSettings = vi.fn<() => Promise<AutoResumeSettings>>()
const updateSettings =
  vi.fn<(s: AutoResumeSettings) => Promise<AutoResumeSettings>>()
const toastError = vi.fn()

vi.mock("@/lib/api", () => ({
  getAutoResumeSettings: () => getSettings(),
  updateAutoResumeSettings: (s: AutoResumeSettings) => updateSettings(s),
}))
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { ResumeAfterRestartSettingsSection } from "./resume-after-restart-settings"

const L = enMessages.AutoResumeSettings

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ResumeAfterRestartSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  toastError.mockClear()
  getSettings.mockReset()
  updateSettings.mockReset()
  getSettings.mockResolvedValue({ enabled: true, background: true })
  updateSettings.mockImplementation(async (s) => s)
})
afterEach(() => cleanup())

describe("ResumeAfterRestartSettingsSection", () => {
  it("offers the background switch under the main one, on by default", async () => {
    renderSection()
    const main = await screen.findByRole("switch", { name: L.title })
    const background = screen.getByRole("switch", { name: L.backgroundTitle })
    expect(main).toBeChecked()
    expect(background).toBeChecked()
    expect(screen.getByText(L.backgroundDescription)).toBeInTheDocument()
  })

  it("saves the background switch with the main one as it stands", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(
      await screen.findByRole("switch", { name: L.backgroundTitle })
    )
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        enabled: true,
        background: false,
      })
    )
    expect(
      screen.getByRole("switch", { name: L.backgroundTitle })
    ).not.toBeChecked()
  })

  it("hides the background switch while resuming is off", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(await screen.findByRole("switch", { name: L.title }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        enabled: false,
        background: true,
      })
    )
    expect(screen.queryByRole("switch", { name: L.backgroundTitle })).toBeNull()
  })

  it("puts the switch back when the save fails", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("db locked"))
    renderSection()
    await user.click(
      await screen.findByRole("switch", { name: L.backgroundTitle })
    )
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(
      screen.getByRole("switch", { name: L.backgroundTitle })
    ).toBeChecked()
  })

  it("offers no background switch on a server that predates it", async () => {
    getSettings.mockResolvedValue({ enabled: true })
    renderSection()
    expect(
      await screen.findByRole("switch", { name: L.title })
    ).toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: L.backgroundTitle })).toBeNull()
  })
})
