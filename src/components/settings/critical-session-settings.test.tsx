import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({
  getCriticalSessionSettings: vi.fn(),
  updateCriticalSessionSettings: vi.fn(),
  listChatChannels: vi.fn(),
}))
vi.mock("@/lib/api", () => h)
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { CriticalSessionSettingsSection } from "./critical-session-settings"

const DEFAULTS = {
  idle_secs: 60,
  repeat_secs: 300,
  stall_secs: 300,
  sound: true,
  send_to_channel: false,
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CriticalSessionSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.getCriticalSessionSettings.mockReset().mockResolvedValue(DEFAULTS)
  h.updateCriticalSessionSettings
    .mockReset()
    .mockImplementation(async (v: unknown) => v)
  h.listChatChannels.mockReset().mockResolvedValue([])
})

describe("CriticalSessionSettingsSection", () => {
  it("shows the stored thresholds", async () => {
    renderSection()
    expect(await screen.findByText("Critical sessions")).toBeTruthy()
    expect(
      screen.getByRole("combobox", { name: "Alert after idle for" }).textContent
    ).toBe("1 min")
    expect(
      screen.getByRole("combobox", { name: "Repeat every" }).textContent
    ).toBe("5 min")
    expect(
      screen.getByRole("combobox", { name: "Stall threshold" }).textContent
    ).toBe("5 min")
    // No chat channel configured: nothing to send to.
    expect(screen.queryByText("Also send to chat channels")).toBeNull()
  })

  it("shows a value set outside the choices, and the channel switch when channels exist", async () => {
    h.getCriticalSessionSettings.mockResolvedValue({
      ...DEFAULTS,
      idle_secs: 10,
      repeat_secs: 0,
    })
    h.listChatChannels.mockResolvedValue([{ id: 1 }])
    renderSection()
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Alert after idle for" })
          .textContent
      ).toBe("10 s")
    )
    expect(
      screen.getByRole("combobox", { name: "Repeat every" }).textContent
    ).toBe("Never")
    expect(await screen.findByText("Also send to chat channels")).toBeTruthy()
  })

  it("saves a switch through the backend", async () => {
    renderSection()
    const sound = await screen.findByRole("switch", { name: /Play a sound/ })
    sound.click()
    await waitFor(() =>
      expect(h.updateCriticalSessionSettings).toHaveBeenCalledWith({
        ...DEFAULTS,
        sound: false,
      })
    )
  })
})
