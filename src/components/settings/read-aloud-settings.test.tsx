import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

const platform = vi.hoisted(() => ({ isMac: true }))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => platform.isMac }))

import {
  READ_ALOUD_SAMPLE,
  ReadAloudSettingsSection,
} from "./read-aloud-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getReadAloudPrefs,
  resetReadAloudPrefsCacheForTests,
  saveReadAloudPrefs,
} from "@/lib/read-aloud/prefs"
import { fakeVoice, installFakeSpeech } from "@/lib/read-aloud/testing"

const t = enMessages.ReadAloudSettings

function betterVoiceHint(voice: string, tier: string): string {
  return t.betterVoiceHint.replace("{voice}", voice).replace("{tier}", tier)
}
const HEBREW_HINT = betterVoiceHint("Carmit", t.tierEnhanced)
const ENGLISH_HINT = betterVoiceHint("Ava", t.tierPremium)

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
  platform.isMac = true
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
      `Automatic (Carmit · ${t.tierBasic})`
    )
    expect(screen.getByLabelText(t.englishVoice)).toHaveTextContent(
      /Automatic \((Samantha|Daniel) · Basic\)/
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

  describe("better-voice hint", () => {
    it("shows once per language read by a compact voice, on a Mac", () => {
      // The default fakes are the compact Samantha, Daniel and Carmit.
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(screen.getAllByText(HEBREW_HINT)).toHaveLength(1)
      expect(screen.getAllByText(ENGLISH_HINT)).toHaveLength(1)
      expect(HEBREW_HINT).toContain("Siri")
    })

    it("is gone once Premium and Enhanced voices are installed", () => {
      uninstall = installFakeSpeech([
        fakeVoice("Samantha", "en-US"),
        fakeVoice("Ava (Premium)", "en-US"),
        fakeVoice("Carmit", "he-IL"),
        fakeVoice("Carmit (Enhanced)", "he-IL"),
      ]).uninstall
      renderSection()
      expandSection()
      expect(screen.getByLabelText(t.hebrewVoice)).toHaveTextContent(
        `Automatic (Carmit · ${t.tierEnhanced})`
      )
      expect(screen.getByLabelText(t.englishVoice)).toHaveTextContent(
        `Automatic (Ava · ${t.tierPremium})`
      )
      expect(screen.queryByText(HEBREW_HINT)).not.toBeInTheDocument()
      expect(screen.queryByText(ENGLISH_HINT)).not.toBeInTheDocument()
    })

    it("follows the voice picked in Settings, not the automatic one", () => {
      uninstall = installFakeSpeech([
        fakeVoice("Samantha", "en-US"),
        fakeVoice("Ava (Premium)", "en-US"),
        fakeVoice("Carmit (Enhanced)", "he-IL"),
      ]).uninstall
      saveReadAloudPrefs({
        ...getReadAloudPrefs(),
        englishVoice: "uri:Samantha",
      })
      renderSection()
      expandSection()
      expect(screen.getByText(ENGLISH_HINT)).toBeInTheDocument()
      expect(screen.queryByText(HEBREW_HINT)).not.toBeInTheDocument()
    })

    it("is not shown away from a Mac, where the steps don't apply", () => {
      platform.isMac = false
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(screen.queryByText(HEBREW_HINT)).not.toBeInTheDocument()
      expect(screen.queryByText(ENGLISH_HINT)).not.toBeInTheDocument()
    })
  })

  it("marks each voice's tier and lists better tiers first", async () => {
    uninstall = installFakeSpeech([
      fakeVoice("Samantha", "en-US"),
      fakeVoice("Albert", "en-US"),
      fakeVoice("Zoe (Enhanced)", "en-US"),
      fakeVoice("Ava (Premium)", "en-US"),
      fakeVoice("Carmit", "he-IL"),
    ]).uninstall
    renderSection()
    expandSection()

    const user = userEvent.setup()
    await user.click(screen.getByLabelText(t.englishVoice))
    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual([
      `Automatic (Ava · ${t.tierPremium})`,
      `Ava (en-US) · ${t.tierPremium}`,
      `Zoe (en-US) · ${t.tierEnhanced}`,
      `Samantha (en-US) · ${t.tierBasic}`,
      `Albert (en-US) · ${t.tierBasic}`,
    ])
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
