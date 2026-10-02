import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({
  getPushSettings: vi.fn(),
  listPushDevices: vi.fn(),
  updatePushSettings: vi.fn(),
  sendTestPush: vi.fn(),
  unregisterPushDevice: vi.fn(),
  updatePushDevicePrefs: vi.fn(),
}))
vi.mock("@/lib/api", () => h)
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { IphonePushSettingsSection } from "./iphone-push-settings"

const VIEW = {
  team_id: "ABCDE12345",
  key_id: "KEY1234567",
  bundle_id: "org.example.codeg",
  environment: "production",
  language: "en",
  has_key: true,
  key_error: null,
  server_id: "srv123",
  configured: true,
}

const PREFS = {
  turn_finished: "away",
  needs_you: "away",
  critical: true,
  errors: false,
}

const DEVICE = {
  id: 7,
  name: "Jonathan's iPhone",
  platform: "ios",
  environment: "sandbox",
  bundle_id: "org.example.codeg",
  token_hint: "…1a2b3c4d",
  prefs: PREFS,
  created_at: "2026-10-02T10:00:00Z",
  last_seen_at: "2026-10-02T10:00:00Z",
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <IphonePushSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.getPushSettings.mockReset().mockResolvedValue(VIEW)
  h.listPushDevices.mockReset().mockResolvedValue([DEVICE])
  h.updatePushSettings
    .mockReset()
    .mockImplementation(async (settings: object) => ({ ...VIEW, ...settings }))
  h.sendTestPush.mockReset().mockResolvedValue([])
  h.unregisterPushDevice.mockReset().mockResolvedValue(true)
  h.updatePushDevicePrefs
    .mockReset()
    .mockImplementation(async (id: number, prefs: object) => ({
      ...DEVICE,
      id,
      prefs,
    }))
})

describe("IphonePushSettingsSection", () => {
  it("shows the stored ids, the key state and the registered devices", async () => {
    renderSection()
    expect(await screen.findByText("iPhone push")).toBeTruthy()
    expect((screen.getByLabelText("Team ID") as HTMLInputElement).value).toBe(
      "ABCDE12345"
    )
    expect((screen.getByLabelText("Bundle ID") as HTMLInputElement).value).toBe(
      "org.example.codeg"
    )
    expect(screen.getByText("Ready to send")).toBeTruthy()
    expect(screen.getByText(/A key is stored/)).toBeTruthy()
    expect(await screen.findByText("Jonathan's iPhone")).toBeTruthy()
    expect(screen.getByText(/sandbox · token …1a2b3c4d/)).toBeTruthy()
    expect(
      screen.getByRole("combobox", {
        name: "Jonathan's iPhone: Turn finished",
      }).textContent
    ).toBe("Only when away")
  })

  it("saves the ids, the app language and a pasted key", async () => {
    renderSection()
    const keyId = await screen.findByLabelText("Key ID")
    fireEvent.change(keyId, { target: { value: "newkey0001" } })
    fireEvent.change(screen.getByLabelText(".p8 key"), {
      target: {
        value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(h.updatePushSettings).toHaveBeenCalledWith(
        {
          team_id: "ABCDE12345",
          key_id: "newkey0001",
          bundle_id: "org.example.codeg",
          environment: "production",
          language: "en",
        },
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
      )
    )
  })

  it("keeps the stored key when the key box is empty, and removes it on request", async () => {
    renderSection()
    fireEvent.click(await screen.findByRole("button", { name: "Save" }))
    await waitFor(() => expect(h.updatePushSettings).toHaveBeenCalledTimes(1))
    expect(h.updatePushSettings.mock.calls[0][1]).toBeUndefined()

    fireEvent.click(screen.getByRole("button", { name: /Remove key/ }))
    await waitFor(() => expect(h.updatePushSettings).toHaveBeenCalledTimes(2))
    expect(h.updatePushSettings.mock.calls[1][1]).toBe("")
  })

  it("shows each device's test result and a clear error", async () => {
    h.sendTestPush.mockResolvedValueOnce([
      {
        device_id: 7,
        name: "Jonathan's iPhone",
        ok: false,
        error:
          "APNs answered 403: InvalidProviderToken — the Team ID, Key ID and .p8 key do not belong together",
        removed: false,
      },
    ])
    renderSection()
    fireEvent.click(
      await screen.findByRole("button", { name: /Send test push/ })
    )
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Jonathan's iPhone: APNs answered 403")
    expect(alert.textContent).toContain("do not belong together")

    h.sendTestPush.mockRejectedValueOnce(
      new Error("iPhone push is not set up: add the .p8 key")
    )
    fireEvent.click(screen.getByRole("button", { name: /Send test push/ }))
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Test push failed: iPhone push is not set up"
      )
    )
  })

  it("updates a device's prefs and removes a device", async () => {
    renderSection()
    const critical = await screen.findByRole("switch", {
      name: "Jonathan's iPhone: Critical alerts",
    })
    fireEvent.click(critical)
    await waitFor(() =>
      expect(h.updatePushDevicePrefs).toHaveBeenCalledWith(7, {
        ...PREFS,
        critical: false,
      })
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Jonathan's iPhone" })
    )
    await waitFor(() => expect(h.unregisterPushDevice).toHaveBeenCalledWith(7))
    await waitFor(() =>
      expect(screen.queryByText("Jonathan's iPhone")).toBeNull()
    )
  })
})
