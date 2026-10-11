import { act, render, screen } from "@testing-library/react"
import { useTranslations } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  getSystemLanguageSettings: vi.fn(),
  getMessagesForLocale: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getSystemLanguageSettings: api.getSystemLanguageSettings,
}))

vi.mock("@/i18n/messages", async () => {
  const en = (await import("@/i18n/messages/en.json")).default
  return {
    getFallbackMessages: () => en,
    getMessagesForLocale: api.getMessagesForLocale,
  }
})

import enMessages from "@/i18n/messages/en.json"
import jaMessages from "@/i18n/messages/ja.json"
import { AppI18nProvider, STARTUP_RETRY_DELAYS_MS } from "./i18n-provider"

function Probe() {
  const t = useTranslations("AppErrorBoundary")
  return <div data-testid="probe">{t("retry")}</div>
}

function renderProvider() {
  return render(
    <AppI18nProvider initialLocale="en" initialMessages={enMessages}>
      <Probe />
    </AppI18nProvider>
  )
}

const UNREACHABLE = { code: "network_error", message: "Failed to fetch" }

beforeEach(() => {
  vi.useFakeTimers()
  api.getSystemLanguageSettings.mockReset()
  api.getMessagesForLocale.mockReset()
  api.getMessagesForLocale.mockImplementation(async (locale: string) =>
    locale === "ja" ? jaMessages : enMessages
  )
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("AppI18nProvider startup with the server unreachable", () => {
  it("renders the app instead of staying on the boot screen, and loads the language once the server answers", async () => {
    api.getSystemLanguageSettings
      .mockRejectedValueOnce(UNREACHABLE)
      .mockResolvedValueOnce({ mode: "manual", language: "ja" })

    renderProvider()
    await act(async () => {})
    expect(screen.getByTestId("probe")).toHaveTextContent("Try again")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_RETRY_DELAYS_MS[0])
    })
    expect(api.getSystemLanguageSettings).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("probe")).toHaveTextContent(
      jaMessages.AppErrorBoundary.retry
    )
  })

  it("renders with the messages it has when a locale's messages fail to load, then retries them", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "ja",
    })
    api.getMessagesForLocale
      .mockRejectedValueOnce(new TypeError("Importing a module script failed."))
      .mockImplementation(async () => jaMessages)

    renderProvider()
    await act(async () => {})
    // Not stuck on the boot screen: English for now.
    expect(screen.getByTestId("probe")).toHaveTextContent("Try again")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_RETRY_DELAYS_MS[0])
    })
    expect(screen.getByTestId("probe")).toHaveTextContent(
      jaMessages.AppErrorBoundary.retry
    )
  })

  it("gives up retrying after the last delay", async () => {
    api.getSystemLanguageSettings.mockRejectedValue(UNREACHABLE)
    renderProvider()
    await act(async () => {})
    const total = STARTUP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(total + 60_000)
    })
    expect(api.getSystemLanguageSettings).toHaveBeenCalledTimes(
      STARTUP_RETRY_DELAYS_MS.length + 1
    )
    expect(screen.getByTestId("probe")).toHaveTextContent("Try again")
  })
})
