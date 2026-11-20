import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS_STORAGE_KEY,
  readShortcutSettings,
} from "@/lib/keyboard-shortcuts"

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast: toasts }))

import { ShortcutSettings } from "./shortcut-settings"

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ShortcutSettings />
    </NextIntlClientProvider>
  )
}

function row(title: string): HTMLElement {
  const heading = screen.getByText(title, { selector: "span" })
  const element = heading.closest("div.rounded-lg.border")
  if (!(element instanceof HTMLElement)) throw new Error(`no row ${title}`)
  return element
}

/** Click the row's binding, then press `key` with Ctrl (mod off a Mac). */
function record(title: string, key: string) {
  const button = row(title).querySelector("button")
  if (!button) throw new Error(`no button for ${title}`)
  fireEvent.click(button)
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: `Key${key.toUpperCase()}`,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  })
}

beforeEach(() => {
  localStorage.clear()
  toasts.success.mockReset()
  toasts.error.mockReset()
})

describe("ShortcutSettings conflicts", () => {
  it("says which context each action listens in", () => {
    renderPage()
    expect(row("New Terminal").textContent).toContain("Terminal")
    expect(row("Open Search").textContent).toContain("Workspace")
    expect(row("Send Message").textContent).toContain("Message box")
    expect(row("Search Settings").textContent).toContain("Settings window")
  })

  it("explains the chord the terminal shares with the workspace", () => {
    renderPage()
    expect(row("New Conversation").textContent).toContain(
      "While the terminal has focus, Ctrl+T runs “New Terminal” instead."
    )
  })

  it("assigns ⌘T to Search without tripping over New Terminal, offering the takeover", () => {
    renderPage()
    record("Open Search", "t")

    // Not blocked by the terminal's binding: only New Conversation is named.
    const prompt = screen.getByRole("alert")
    expect(prompt.textContent).toContain(
      "Ctrl+T is already used by New Conversation (Workspace)"
    )
    expect(prompt.textContent).not.toContain("New Terminal")
    expect(readShortcutSettings().toggle_search).toBe("mod+k")

    fireEvent.click(
      screen.getByRole("button", { name: "Use it for “Open Search” instead" })
    )

    const saved = JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY)!)
    expect(saved.toggle_search).toBe("mod+t")
    expect(saved.new_conversation).toBe("")
    expect(saved.new_terminal_tab).toBe("mod+t")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(toasts.success).toHaveBeenCalledWith(
      "Ctrl+T now runs “Open Search”. Unassigned: New Conversation."
    )
    // The row now says where ⌘T still opens a terminal instead.
    expect(row("Open Search").textContent).toContain(
      "While the terminal has focus, Ctrl+T runs “New Terminal” instead."
    )
    expect(row("New Conversation").textContent).toContain("Unassigned")
  })

  it("changes nothing on Cancel", () => {
    renderPage()
    record("Open Search", "t")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(readShortcutSettings()).toEqual(DEFAULT_SHORTCUTS)
  })

  it("assigns a chord another window uses without asking", () => {
    renderPage()
    // ⌘F is Settings' own search; the workspace never hears it there.
    record("Open Search", "f")
    expect(screen.queryByRole("alert")).toBeNull()
    expect(readShortcutSettings().toggle_search).toBe("mod+f")
    expect(readShortcutSettings().search_settings).toBe("mod+f")
  })
})
