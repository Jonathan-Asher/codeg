import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({
  desktop: true,
  get: null as unknown as ReturnType<typeof vi.fn>,
  update: null as unknown as ReturnType<typeof vi.fn>,
  toggle: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => h.desktop }))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
vi.mock("@/lib/quick-ask/desktop", () => ({
  getQuickAskSettings: () => h.get(),
  updateQuickAskSettings: (input: unknown) => h.update(input),
  toggleQuickAskWindow: () => h.toggle(),
}))

import { QuickAskSettingsSection } from "./quick-ask-settings"

const view = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  shortcut: "Alt+Space",
  hide_on_blur: true,
  registered: true,
  registration_error: null,
  ...over,
})

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QuickAskSettingsSection />
    </NextIntlClientProvider>
  )
}

describe("QuickAskSettingsSection", () => {
  beforeEach(() => {
    h.desktop = true
    h.get = vi.fn(async () => view())
    h.update = vi.fn(
      async (input: {
        enabled: boolean
        shortcut: string
        hideOnBlur: boolean
      }) =>
        view({
          enabled: input.enabled,
          shortcut: input.shortcut,
          hide_on_blur: input.hideOnBlur,
        })
    )
    h.toggle = vi.fn(async () => {})
  })

  it("is not offered outside the desktop app", () => {
    h.desktop = false
    const { container } = renderSection()
    expect(container).toBeEmptyDOMElement()
    expect(h.get).not.toHaveBeenCalled()
  })

  it("shows the shortcut, on by default as Option+Space", async () => {
    renderSection()
    expect(await screen.findByTestId("quick-ask-shortcut")).toHaveTextContent(
      "⌥Space"
    )
    expect(screen.getByLabelText("Global shortcut")).toBeChecked()
    expect(screen.getByLabelText("Hide when clicking outside")).toBeChecked()
    expect(
      screen.queryByTestId("quick-ask-registration-error")
    ).not.toBeInTheDocument()
  })

  it("says so when another app owns the combination", async () => {
    h.get = vi.fn(async () =>
      view({
        registered: false,
        registration_error:
          "Unable to register hotkey: RegisterEventHotKey failed",
      })
    )
    renderSection()
    const alert = await screen.findByTestId("quick-ask-registration-error")
    expect(alert).toHaveTextContent("⌥Space could not be registered")
    expect(alert).toHaveTextContent("RegisterEventHotKey failed")
  })

  it("records a new shortcut from the next key press", async () => {
    renderSection()
    fireEvent.click(await screen.findByTestId("quick-ask-shortcut"))
    expect(screen.getByTestId("quick-ask-shortcut")).toHaveTextContent(
      "Press keys…"
    )
    // A modifier alone keeps recording.
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "Control",
        code: "ControlLeft",
        ctrlKey: true,
      })
    })
    expect(h.update).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        shiftKey: true,
      })
    })
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith({
        enabled: true,
        shortcut: "Control+Shift+KeyK",
        hideOnBlur: true,
      })
    )
    expect(screen.getByTestId("quick-ask-shortcut")).toHaveTextContent("⌃⇧K")
  })

  it("turns the shortcut and click-outside hiding off", async () => {
    renderSection()
    fireEvent.click(await screen.findByLabelText("Hide when clicking outside"))
    await waitFor(() =>
      expect(h.update).toHaveBeenLastCalledWith({
        enabled: true,
        shortcut: "Alt+Space",
        hideOnBlur: false,
      })
    )
    fireEvent.click(screen.getByLabelText("Global shortcut"))
    await waitFor(() =>
      expect(h.update).toHaveBeenLastCalledWith({
        enabled: false,
        shortcut: "Alt+Space",
        hideOnBlur: false,
      })
    )
  })
})
