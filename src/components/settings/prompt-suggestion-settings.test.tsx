import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  getPromptSuggestionSettings: vi.fn(),
  updatePromptSuggestionSettings: vi.fn(),
  getPromptSuggestionStats: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
const toastError = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }))

import enMessages from "@/i18n/messages/en.json"

import { PromptSuggestionSettingsSection } from "./prompt-suggestion-settings"

const T = enMessages.PromptSuggestionSettings

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PromptSuggestionSettingsSection />
    </NextIntlClientProvider>
  )
}

describe("PromptSuggestionSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getPromptSuggestionSettings.mockResolvedValue({ enabled: true })
    api.updatePromptSuggestionSettings.mockImplementation(
      async (settings: unknown) => settings
    )
    api.getPromptSuggestionStats.mockResolvedValue({
      received: 12,
      shown: 9,
      accepted: 4,
    })
  })

  it("shows the stored setting with what it costs and when it applies", async () => {
    renderSection()
    const toggle = await screen.findByRole("switch")
    expect(toggle).toBeChecked()
    expect(screen.getByText(T.title)).toBeInTheDocument()
    expect(screen.getByText(T.description)).toBeInTheDocument()
    expect(screen.getByText(T.appliesNextConnect)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("prompt-suggestion-stats")).toHaveTextContent(
        "12 received, 9 shown, 4 accepted"
      )
    )
  })

  it("turns the suggestions off", async () => {
    renderSection()
    const toggle = await screen.findByRole("switch")
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(api.updatePromptSuggestionSettings).toHaveBeenCalledWith({
        enabled: false,
      })
    )
    await waitFor(() => expect(toggle).not.toBeChecked())
  })

  it("puts the switch back when the save fails", async () => {
    api.updatePromptSuggestionSettings.mockRejectedValue(new Error("disk full"))
    renderSection()
    const toggle = await screen.findByRole("switch")
    fireEvent.click(toggle)
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toggle).toBeChecked()
  })

  it("stays hidden until the stored value is known", () => {
    api.getPromptSuggestionSettings.mockReturnValue(new Promise(() => {}))
    api.getPromptSuggestionStats.mockReturnValue(new Promise(() => {}))
    renderSection()
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("works without the counters on an older server", async () => {
    api.getPromptSuggestionStats.mockRejectedValue(new Error("not found"))
    renderSection()
    await screen.findByRole("switch")
    expect(screen.queryByTestId("prompt-suggestion-stats")).toBeNull()
  })
})
