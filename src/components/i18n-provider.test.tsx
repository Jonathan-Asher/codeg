import { act, render, screen, waitFor } from "@testing-library/react"
import { useTranslations } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SystemLanguageSettings } from "@/lib/types"

const api = vi.hoisted(() => ({
  getSystemLanguageSettings: vi.fn<() => Promise<SystemLanguageSettings>>(),
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

import arMessages from "@/i18n/messages/ar.json"
import enMessages from "@/i18n/messages/en.json"
import jaMessages from "@/i18n/messages/ja.json"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

function renderTabs() {
  render(
    <AppI18nProvider>
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Body</TabsContent>
      </Tabs>
    </AppI18nProvider>
  )
}

const UNREACHABLE = { code: "network_error", message: "Failed to fetch" }

beforeEach(() => {
  api.getSystemLanguageSettings.mockReset()
  api.getMessagesForLocale.mockReset()
  api.getMessagesForLocale.mockImplementation(async (locale: string) =>
    locale === "ja" ? jaMessages : locale === "ar" ? arMessages : enMessages
  )
})

describe("AppI18nProvider startup with the server unreachable", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

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

const tabsRoot = () => screen.getByText("Body").closest('[data-slot="tabs"]')

describe("AppI18nProvider direction", () => {
  afterEach(() => {
    document.documentElement.dir = ""
    window.localStorage.clear()
  })

  // Radix components read their direction from context, not from the page:
  // without a provider a Tabs root stamps `dir="ltr"` on itself, and
  // everything inside it — switches, rows, menus — stays left-to-right in an
  // Arabic window whose page is right-to-left.
  it("hands Radix components the page's right-to-left direction", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "ar",
    })
    renderTabs()
    await waitFor(() => expect(tabsRoot()).toHaveAttribute("dir", "rtl"))
    expect(document.documentElement.dir).toBe("rtl")
  })

  it("keeps them left-to-right otherwise", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "en",
    })
    renderTabs()
    await waitFor(() => expect(tabsRoot()).toHaveAttribute("dir", "ltr"))
    expect(document.documentElement.dir).toBe("ltr")
  })
})
