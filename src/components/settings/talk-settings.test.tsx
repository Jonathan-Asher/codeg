import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TalkSettings } from "@/lib/types"

const h = vi.hoisted(() => ({
  getTalkSettings: vi.fn(),
  updateTalkSettings: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock("@/lib/api", () => ({
  getTalkSettings: h.getTalkSettings,
  updateTalkSettings: h.updateTalkSettings,
}))
vi.mock("sonner", () => ({ toast: { error: h.toastError } }))

import { TalkSettingsSection } from "./talk-settings"

const L = enMessages.TalkSettings
const DEFAULTS: TalkSettings = { language: "auto", address: "auto" }

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TalkSettingsSection />
    </NextIntlClientProvider>
  )
}

const languagePicker = () =>
  screen.getByRole("combobox", { name: L.languageTitle })
const addressPicker = () =>
  screen.getByRole("combobox", { name: L.addressTitle })

beforeEach(() => {
  h.getTalkSettings.mockReset().mockResolvedValue(DEFAULTS)
  h.updateTalkSettings
    .mockReset()
    .mockImplementation(async (settings: TalkSettings) => settings)
  h.toastError.mockReset()
})

afterEach(() => cleanup())

describe("TalkSettingsSection", () => {
  it("shows the stored settings", async () => {
    h.getTalkSettings.mockResolvedValue({
      language: "he",
      address: "feminine",
    })
    renderSection()
    expect(await screen.findByText(L.title)).toBeInTheDocument()
    expect(screen.getByText(L.description)).toBeInTheDocument()
    expect(languagePicker().textContent).toBe(L.languageHebrew)
    expect(addressPicker().textContent).toBe(L.addressFeminine)
  })

  it("stays hidden until the stored settings are known", async () => {
    h.getTalkSettings.mockReturnValue(new Promise(() => {}))
    renderSection()
    await waitFor(() => expect(h.getTalkSettings).toHaveBeenCalled())
    expect(screen.queryByText(L.title)).toBeNull()
  })

  it("saves a new language, keeping the address form", async () => {
    const user = userEvent.setup()
    h.getTalkSettings.mockResolvedValue({
      language: "auto",
      address: "masculine",
    })
    renderSection()
    await screen.findByText(L.title)

    await user.click(languagePicker())
    await user.click(
      await screen.findByRole("option", { name: L.languageEnglish })
    )

    await waitFor(() =>
      expect(h.updateTalkSettings).toHaveBeenCalledWith({
        language: "en",
        address: "masculine",
      })
    )
    await waitFor(() =>
      expect(languagePicker().textContent).toBe(L.languageEnglish)
    )
  })

  it("saves a new address form", async () => {
    const user = userEvent.setup()
    renderSection()
    await screen.findByText(L.title)

    await user.click(addressPicker())
    await user.click(
      await screen.findByRole("option", { name: L.addressFeminine })
    )

    await waitFor(() =>
      expect(h.updateTalkSettings).toHaveBeenCalledWith({
        language: "auto",
        address: "feminine",
      })
    )
  })

  it("puts the picker back and says so when the save fails", async () => {
    const user = userEvent.setup()
    h.updateTalkSettings.mockRejectedValue(new Error("db locked"))
    renderSection()
    await screen.findByText(L.title)

    await user.click(languagePicker())
    await user.click(
      await screen.findByRole("option", { name: L.languageHebrew })
    )

    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith("Could not save: db locked")
    )
    expect(languagePicker().textContent).toBe(L.languageAuto)
  })
})
