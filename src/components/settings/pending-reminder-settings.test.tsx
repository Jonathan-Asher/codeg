import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PendingReminderSettings } from "@/lib/types"

const h = vi.hoisted(() => ({
  getPendingReminderSettings: vi.fn(),
  updatePendingReminderSettings: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getPendingReminderSettings: h.getPendingReminderSettings,
  updatePendingReminderSettings: h.updatePendingReminderSettings,
  updateConversationCritical: vi.fn(),
}))

import {
  minutesToTime,
  PendingReminderSettingsSection,
  timeToMinutes,
} from "./pending-reminder-settings"

const DEFAULTS: PendingReminderSettings = {
  enabled: true,
  steps_secs: [300, 1800, 7200],
  repeat_secs: 14400,
  quiet_hours: false,
  quiet_start_min: 22 * 60,
  quiet_end_min: 7 * 60,
  timezone: "",
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PendingReminderSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.getPendingReminderSettings.mockReset().mockResolvedValue(DEFAULTS)
  h.updatePendingReminderSettings
    .mockReset()
    .mockImplementation(async (s: PendingReminderSettings) => s)
})

afterEach(() => cleanup())

describe("PendingReminderSettingsSection", () => {
  it("shows the stored schedule", async () => {
    renderSection()
    expect(await screen.findByText("Reminders")).toBeInTheDocument()
    expect(
      screen.getByRole("combobox", { name: "Remind after" }).textContent
    ).toBe("5 min, 30 min, 2 h")
    expect(
      screen.getByRole("combobox", { name: "Then every" }).textContent
    ).toBe("4 h")
  })

  it("saves quiet hours with this device's time zone", async () => {
    renderSection()
    fireEvent.click(await screen.findByLabelText("Quiet hours"))
    await waitFor(() =>
      expect(h.updatePendingReminderSettings).toHaveBeenCalledTimes(1)
    )
    const saved = h.updatePendingReminderSettings.mock.calls[0][0]
    expect(saved.quiet_hours).toBe(true)
    expect(saved.timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    )
    const from = await screen.findByLabelText("Quiet hours start")
    expect(from).toHaveValue("22:00")
    fireEvent.change(from, { target: { value: "23:30" } })
    await waitFor(() =>
      expect(h.updatePendingReminderSettings).toHaveBeenCalledTimes(2)
    )
    expect(
      h.updatePendingReminderSettings.mock.calls[1][0].quiet_start_min
    ).toBe(23 * 60 + 30)
  })

  it("hides the schedule when reminders are off", async () => {
    renderSection()
    fireEvent.click(await screen.findByLabelText("Remind me"))
    await waitFor(() =>
      expect(screen.queryByText("Remind after")).not.toBeInTheDocument()
    )
    expect(h.updatePendingReminderSettings.mock.calls[0][0].enabled).toBe(false)
  })

  it("converts times both ways", () => {
    expect(minutesToTime(0)).toBe("00:00")
    expect(minutesToTime(22 * 60 + 5)).toBe("22:05")
    expect(timeToMinutes("07:30")).toBe(450)
    expect(timeToMinutes("24:00")).toBeNull()
    expect(timeToMinutes("")).toBeNull()
  })
})
