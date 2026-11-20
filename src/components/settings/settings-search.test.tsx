import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { takePendingSettingsReveal } from "@/lib/settings-search/reveal"

const nav = vi.hoisted(() => ({
  pathname: "/settings/appearance",
  push: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
}))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))

import { SettingsShell } from "./settings-shell"

function renderShell(children: React.ReactNode = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SettingsShell>{children}</SettingsShell>
    </NextIntlClientProvider>
  )
}

function searchBox(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Search settings" })
}

beforeEach(() => {
  nav.pathname = "/settings/appearance"
  nav.push.mockReset()
  window.history.replaceState(null, "", "/settings/appearance")
  window.sessionStorage.clear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Settings search", () => {
  it("finds a setting on a page that is not open, and opens it there", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.type(searchBox(), "quiet hours")

    const option = screen.getByRole("option", { name: /^Quiet hours/ })
    expect(option.textContent).toContain("General › Reminders")
    expect(option.getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{Enter}")
    expect(nav.push).toHaveBeenCalledWith("/settings/general")
    expect(takePendingSettingsReveal("/settings/general")).toEqual([
      "general.reminders.quiet",
      "general.reminders",
    ])
  })

  it("moves through the results with the arrow keys", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.type(searchBox(), "notification")
    const options = screen.getAllByRole("option")
    expect(options.length).toBeGreaterThan(2)
    expect(options[0].getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{ArrowDown}")
    expect(options[1].getAttribute("aria-selected")).toBe("true")
    expect(searchBox().getAttribute("aria-activedescendant")).toBe(
      options[1].id
    )
    await user.keyboard("{ArrowUp}{ArrowUp}")
    const wrapped = screen.getAllByRole("option")
    expect(wrapped[wrapped.length - 1].getAttribute("aria-selected")).toBe(
      "true"
    )
  })

  it("clears with Esc and gives the nav back", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.type(searchBox(), "zoom")
    expect(screen.queryByRole("button", { name: /Appearance/ })).toBeNull()
    await user.keyboard("{Escape}")
    expect(searchBox().value).toBe("")
    expect(screen.getByRole("button", { name: /Appearance/ })).toBeTruthy()
  })

  it("says so when nothing matches", async () => {
    const user = userEvent.setup()
    renderShell()
    await user.type(searchBox(), "qwertyuiop")
    expect(screen.getByText("No settings match “qwertyuiop”")).toBeTruthy()
  })

  it("scrolls to the setting and marks it when it is on this page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderShell(
      <div>
        <section data-settings-anchor="appearance.zoom">zoom</section>
      </div>
    )

    await user.type(searchBox(), "window zoom")
    await user.keyboard("{Enter}")

    const section = document.querySelector(
      '[data-settings-anchor="appearance.zoom"]'
    ) as HTMLElement
    expect(nav.push).not.toHaveBeenCalled()
    expect(section.scrollIntoView).toHaveBeenCalled()
    expect(section.hasAttribute("data-settings-highlight")).toBe(true)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(section.hasAttribute("data-settings-highlight")).toBe(false)
    // The caret stays in the box for the next search.
    expect(searchBox()).toHaveFocus()
  })

  it("lands on a setting that appears only after its page has loaded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    nav.pathname = "/settings/general"
    window.history.replaceState(null, "", "/settings/general")
    window.sessionStorage.setItem(
      "settings:search-reveal",
      JSON.stringify({
        path: "/settings/general",
        anchors: ["general.quick-ask.hide-on-blur", "general.quick-ask"],
      })
    )
    renderShell()

    // The page fetches its settings first; the row turns up afterwards.
    const row = document.createElement("div")
    row.setAttribute("data-settings-anchor", "general.quick-ask.hide-on-blur")
    act(() => {
      vi.advanceTimersByTime(300)
      document.body.appendChild(row)
      vi.advanceTimersByTime(100)
    })
    expect(row.scrollIntoView).toHaveBeenCalled()
    expect(row.hasAttribute("data-settings-highlight")).toBe(true)
    row.remove()
  })

  it("puts the caret in the box on Cmd/Ctrl+F", () => {
    renderShell()
    expect(searchBox()).not.toHaveFocus()
    const event = new KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(searchBox()).toHaveFocus()
  })

  it("follows the key Settings → Shortcuts assigns it", () => {
    localStorage.setItem(
      "settings:shortcuts:v1",
      JSON.stringify({ search_settings: "mod+shift+p" })
    )
    renderShell()
    fireEvent.keyDown(window, { key: "f", code: "KeyF", ctrlKey: true })
    expect(searchBox()).not.toHaveFocus()
    fireEvent.keyDown(window, {
      key: "P",
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
    })
    expect(searchBox()).toHaveFocus()
  })
})
