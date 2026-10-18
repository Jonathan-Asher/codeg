import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

import {
  READ_ALOUD_SAMPLE,
  ReadAloudSettingsSection,
} from "./read-aloud-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getReadAloudPrefs,
  resetReadAloudPrefsCacheForTests,
} from "@/lib/read-aloud/prefs"
import { fakeVoice, installFakeSpeech } from "@/lib/read-aloud/testing"

const t = enMessages.ReadAloudSettings

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ReadAloudSettingsSection />
    </NextIntlClientProvider>
  )
}

function expandSection() {
  fireEvent.click(screen.getByRole("button", { name: t.title }))
}

let uninstall: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  resetReadAloudPrefsCacheForTests()
})

afterEach(() => {
  uninstall?.()
  uninstall = null
})

describe("ReadAloudSettingsSection", () => {
  it("says read aloud is unavailable where there is no speech synthesis", () => {
    renderSection()
    expect(screen.getByText(t.unsupported)).toBeInTheDocument()
    // Nothing to unfold.
    expect(
      screen.queryByRole("button", { name: t.title })
    ).not.toBeInTheDocument()
  })

  it("shows the voices, the rate, Test and the auto-read switch", () => {
    uninstall = installFakeSpeech().uninstall
    renderSection()
    // ⌘⇧L on a Mac, Ctrl+Shift+L elsewhere.
    expect(
      screen.getByText(/^Esc stops reading; .*L reads the last reply\.$/)
    ).toBeInTheDocument()
    expandSection()

    expect(screen.getByLabelText(t.hebrewVoice)).toHaveTextContent(
      "Automatic (Carmit)"
    )
    expect(screen.getByLabelText(t.englishVoice)).toHaveTextContent(
      /Automatic \((Samantha|Daniel)\)/
    )
    expect(screen.getByText("1.0×")).toBeInTheDocument()
    expect(screen.queryByText(t.noHebrewVoice)).not.toBeInTheDocument()
  })

  it("explains how to install a Hebrew voice when there is none", () => {
    uninstall = installFakeSpeech([fakeVoice("Samantha", "en-US")]).uninstall
    renderSection()
    expandSection()
    expect(screen.getByText(t.noHebrewVoice)).toBeInTheDocument()
    expect(screen.getByLabelText(t.hebrewVoice)).toHaveTextContent(
      t.automaticNone
    )
  })

  it("plays a Hebrew and an English sample, and stops it", () => {
    const speech = installFakeSpeech()
    uninstall = speech.uninstall
    renderSection()
    expandSection()

    expect(READ_ALOUD_SAMPLE).toMatch(/[א-ת]/)
    fireEvent.click(screen.getByRole("button", { name: t.test }))
    expect(speech.synth.spoken[0].lang).toBe("he-IL")
    act(() => {
      expect(speech.synth.finishAll().join(" ")).toContain("English voice")
    })
    expect(speech.synth.spoken.some((u) => u.voice?.name === "Samantha")).toBe(
      true
    )

    fireEvent.click(screen.getByRole("button", { name: t.test }))
    fireEvent.click(screen.getByRole("button", { name: t.stopTest }))
    expect(screen.getByRole("button", { name: t.test })).toBeInTheDocument()
  })

  it("turns automatic reading on, off by default", () => {
    uninstall = installFakeSpeech().uninstall
    renderSection()
    expandSection()
    const toggle = screen.getByRole("switch", { name: t.autoRead })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(getReadAloudPrefs().autoRead).toBe(true)
    expect(toggle).toBeChecked()
  })
})
