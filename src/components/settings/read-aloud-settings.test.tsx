import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

const platform = vi.hoisted(() => ({ isMac: true }))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => platform.isMac }))

// The natural voice's backend: what `tts_status` answers, where the voice is
// made, and which actions were asked for (each answers `tts.next`).
const tts = vi.hoisted(() => ({
  status: null as unknown,
  next: null as unknown,
  host: "local" as "local" | "server",
  calls: [] as string[],
}))
vi.mock("@/lib/read-aloud/natural-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/read-aloud/natural-api")>()
  const action = (name: string) => async () => {
    tts.calls.push(name)
    return tts.next
  }
  return {
    ...actual,
    naturalVoiceHost: () => tts.host,
    ttsApi: {
      status: async () => tts.status,
      downloadModels: action("download"),
      cancelDownload: action("cancel"),
      deleteModels: action("delete"),
      onStatus: async () => () => {},
    },
  }
})

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
import { resetNaturalStatusForTests } from "@/lib/read-aloud/natural-status"
import {
  fakeTtsStatus,
  fakeVoice,
  installFakeSpeech,
} from "@/lib/read-aloud/testing"

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
  resetNaturalStatusForTests()
  platform.isMac = true
  tts.status = null
  tts.next = null
  tts.host = "local"
  tts.calls = []
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

  describe("natural voice", () => {
    const PACK = "549.0 MB"

    function chooseNatural() {
      saveReadAloudPrefs({ ...getReadAloudPrefs(), engine: "natural" })
    }

    it("is the default once its models are installed, with its own speaker", async () => {
      tts.status = fakeTtsStatus()
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(
        await screen.findByText(t.naturalInstalledLocal.replace("{size}", PACK))
      ).toBeInTheDocument()
      expect(screen.getByLabelText(t.engine)).toHaveTextContent(t.engineNatural)
      expect(screen.getByLabelText(t.naturalSpeaker)).toHaveTextContent("Noa")
      // The system voice pickers belong to the other engine.
      expect(screen.queryByLabelText(t.hebrewVoice)).not.toBeInTheDocument()
    })

    it("stays on the system voices until the models are downloaded", async () => {
      tts.status = fakeTtsStatus({ installed: false, bytesOnDisk: 0 })
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      await act(async () => {})
      expect(screen.getByLabelText(t.engine)).toHaveTextContent(t.engineSystem)
      expect(screen.getByLabelText(t.hebrewVoice)).toBeInTheDocument()
    })

    it("downloads only when asked, says what it costs here, and shows progress", async () => {
      chooseNatural()
      tts.status = fakeTtsStatus({ installed: false, bytesOnDisk: 0 })
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(
        await screen.findByText(
          t.naturalDownloadHintLocal.replace("{size}", PACK)
        )
      ).toBeInTheDocument()
      expect(screen.getByText(t.engineNaturalPending)).toBeInTheDocument()
      expect(tts.calls).toEqual([])

      tts.next = fakeTtsStatus({
        installed: false,
        download: {
          state: "downloading",
          bytesDone: 104_857_600,
          bytesTotal: 575_644_743,
        },
      })
      const user = userEvent.setup()
      await user.click(
        screen.getByRole("button", {
          name: t.naturalDownload.replace("{size}", PACK),
        })
      )
      expect(tts.calls).toEqual(["download"])
      expect(
        await screen.findByText(
          t.naturalDownloading
            .replace("{done}", "100.0 MB")
            .replace("{total}", PACK)
        )
      ).toBeInTheDocument()
      expect(screen.getByRole("progressbar")).toBeInTheDocument()

      tts.next = fakeTtsStatus({ installed: false })
      await user.click(screen.getByRole("button", { name: t.naturalCancel }))
      expect(tts.calls).toEqual(["download", "cancel"])
    })

    it("says what the download costs the server in a browser", async () => {
      chooseNatural()
      tts.host = "server"
      tts.status = fakeTtsStatus({ installed: false })
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(
        await screen.findByText(
          t.naturalDownloadHintServer.replace("{size}", PACK)
        )
      ).toBeInTheDocument()
    })

    it("offers a retry after a failed download", async () => {
      chooseNatural()
      tts.status = fakeTtsStatus({
        installed: false,
        download: { state: "failed", message: "HTTP 503" },
      })
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(
        await screen.findByText(
          t.naturalDownloadFailed.replace("{message}", "HTTP 503")
        )
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: t.naturalRetry }))
      await act(async () => {})
      expect(tts.calls).toEqual(["download"])
    })

    it("deletes the models on request", async () => {
      tts.status = fakeTtsStatus()
      uninstall = installFakeSpeech().uninstall
      chooseNatural()
      renderSection()
      expandSection()
      tts.next = fakeTtsStatus({ installed: false, bytesOnDisk: 0 })
      fireEvent.click(
        await screen.findByRole("button", { name: t.naturalDelete })
      )
      expect(
        await screen.findByRole("button", {
          name: t.naturalDownload.replace("{size}", PACK),
        })
      ).toBeInTheDocument()
      expect(tts.calls).toEqual(["delete"])
    })

    it("explains a backend that can't make the voice", async () => {
      chooseNatural()
      tts.status = fakeTtsStatus({
        supported: false,
        unsupportedReason: "platform",
        installed: false,
      })
      tts.host = "server"
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      expect(
        await screen.findByText(t.naturalUnsupportedPlatformServer)
      ).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /Download/ })).toBeNull()
    })

    it("stores the engine and the speaker the user picks", async () => {
      tts.status = fakeTtsStatus()
      uninstall = installFakeSpeech().uninstall
      renderSection()
      expandSection()
      const user = userEvent.setup()
      await user.click(await screen.findByLabelText(t.naturalSpeaker))
      await user.click(screen.getByRole("option", { name: "Adam" }))
      expect(getReadAloudPrefs().naturalVoice).toBe("adam")

      await user.click(screen.getByLabelText(t.engine))
      await user.click(screen.getByRole("option", { name: t.engineSystem }))
      expect(getReadAloudPrefs().engine).toBe("system")
      expect(screen.getByLabelText(t.hebrewVoice)).toBeInTheDocument()
    })
  })
})
