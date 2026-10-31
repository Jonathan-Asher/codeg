import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TalkUiState } from "@/lib/talk-voice/protocol"

const h = vi.hoisted(() => ({
  session: null as null | {
    conversationId: number
    contextKey: string
    talkId: number | null
    phase: "starting" | "running"
  },
  ui: null as unknown,
  control: vi.fn(),
  endTalk: vi.fn(async () => {}),
  openMicSettings: vi.fn(async () => {}),
  prefsGet: vi.fn(),
  prefsUpdate: vi.fn(),
}))

vi.mock("@/contexts/talk-voice-context", () => ({
  useTalkVoice: () => ({
    session: h.session,
    control: h.control,
    endTalk: h.endTalk,
  }),
  useTalkUi: () => h.ui,
  useTalkLevels: () => ({ type: "level", in: 0.4, out: 0 }),
}))
vi.mock("@/lib/talk-voice/api", () => ({
  openMicSettings: () => h.openMicSettings(),
  talkPrefsApi: {
    get: () => h.prefsGet(),
    update: (prefs: unknown) => h.prefsUpdate(prefs),
  },
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { TalkDock } from "./talk-dock"

function ui(over: Partial<TalkUiState> = {}): TalkUiState {
  return {
    type: "state",
    status: "listening",
    pauseReason: null,
    error: null,
    title: "Fix the flaky build",
    heard: "תבדוק למה הבילד נופל",
    heardFinal: true,
    spoken: [
      { id: "42:7#0", text: "בדקתי את הלוגים של ה-CI." },
      { id: "42:7#1", text: "חסר משתנה סביבה." },
    ],
    current: null,
    ask: null,
    mute: "none",
    handsFree: true,
    backgroundOutstanding: 0,
    awaitingBackground: false,
    fastMode: false,
    naturalVoice: true,
    canReportCutOff: false,
    route: "builtIn",
    echo: "voiceProcessing",
    speaksHebrew: true,
    mic: "granted",
    suggestHeadphones: false,
    ...over,
  }
}

function renderDock(conversationId: number | null = 42) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TalkDock conversationId={conversationId} />
    </NextIntlClientProvider>
  )
}

describe("TalkDock", () => {
  beforeEach(() => {
    h.session = {
      conversationId: 42,
      contextKey: "conv-3-claude_code-42",
      talkId: 7,
      phase: "running",
    }
    h.ui = ui()
    h.control.mockClear()
    h.endTalk.mockClear()
    h.openMicSettings.mockClear()
    h.prefsGet.mockReset()
    h.prefsUpdate.mockReset()
  })

  it("shows nothing for a conversation this window isn't talking with", () => {
    const { container } = renderDock(43)
    expect(container).toBeEmptyDOMElement()
    h.session = null
    const again = renderDock(42)
    expect(again.container).toBeEmptyDOMElement()
  })

  it("shows the status and the captions: what you said, and the last line said", () => {
    renderDock()
    expect(screen.getByTestId("talk-status")).toHaveTextContent("Listening")
    expect(screen.getByTestId("talk-heard")).toHaveTextContent(
      "תבדוק למה הבילד נופל"
    )
    expect(screen.getByTestId("talk-said")).toHaveTextContent(
      "חסר משתנה סביבה."
    )
  })

  it("captions the line being said", () => {
    h.ui = ui({ status: "speaking", current: "42:7#0" })
    renderDock()
    expect(screen.getByTestId("talk-status")).toHaveTextContent("Speaking")
    expect(screen.getByTestId("talk-said")).toHaveTextContent(
      "בדקתי את הלוגים של ה-CI."
    )
  })

  it("says it is starting before the helper's first state", () => {
    h.session = { ...h.session!, phase: "starting", talkId: null }
    h.ui = null
    renderDock()
    expect(screen.getByTestId("talk-status")).toHaveTextContent("Starting…")
  })

  it("mutes, skips and ends", () => {
    h.ui = ui({ status: "speaking" })
    renderDock()
    fireEvent.click(screen.getByRole("button", { name: /^Mute$/ }))
    expect(h.control).toHaveBeenLastCalledWith({ op: "toggleMute" })
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }))
    expect(h.control).toHaveBeenLastCalledWith({ op: "skip" })
    fireEvent.click(screen.getByRole("button", { name: /End/ }))
    expect(h.endTalk).toHaveBeenCalled()
  })

  it("offers Unmute while muted, and Skip only while speaking", () => {
    h.ui = ui({ mute: "hard" })
    renderDock()
    expect(screen.getByRole("button", { name: /Unmute/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Skip/ })).toBeDisabled()
  })

  it("shows the choices as big buttons and answers with one", () => {
    h.ui = ui({
      status: "asking",
      ask: {
        id: "permission:perm-7",
        kind: "permission",
        prompt: "אני רוצה להריץ rm -rf build. לאשר?",
        choices: [
          { id: "allow", label: "Allow" },
          { id: "deny", label: "Reject" },
        ],
        multiSelect: false,
        acceptsOwnWords: false,
        isSecret: false,
        answerableByVoice: true,
      },
    })
    renderDock()
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    expect(h.control).toHaveBeenLastCalledWith({
      op: "choose",
      choiceId: "allow",
    })
  })

  it("lets you say it cut you off, while it can be reported", () => {
    h.ui = ui({ canReportCutOff: true })
    renderDock()
    fireEvent.click(screen.getByRole("button", { name: "You cut me off" }))
    expect(h.control).toHaveBeenLastCalledWith({ op: "reportCutOff" })
  })

  it("links to the microphone setting when access is off", () => {
    h.ui = ui({
      status: "failed",
      mic: "denied",
      error: "Microphone access is off for codeg.",
    })
    renderDock()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access is off for codeg."
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Open microphone settings" })
    )
    expect(h.openMicSettings).toHaveBeenCalled()
  })

  it("switches to hold to talk and pushes while the orb is held", async () => {
    h.prefsGet.mockResolvedValue({
      shortcutEnabled: true,
      shortcut: "Alt+Super+KeyT",
      handsFree: true,
      interruptBySpeaking: true,
      useWhisper: true,
      patience: "normal",
      echoMode: "automatic",
      speakProgress: false,
      smartTurnActive: false,
      shareTelemetry: true,
      shortcutRegistered: true,
      shortcutError: null,
    })
    h.prefsUpdate.mockImplementation(async (prefs) => prefs)
    const view = renderDock()
    fireEvent.click(screen.getByRole("button", { name: "Hold to talk" }))
    expect(h.control).toHaveBeenLastCalledWith({
      op: "setHandsFree",
      value: false,
    })
    await vi.waitFor(() =>
      expect(h.prefsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ handsFree: false })
      )
    )
    // The helper says it is in hold-to-talk now.
    h.ui = ui({ handsFree: false })
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TalkDock conversationId={42} />
      </NextIntlClientProvider>
    )
    const orb = screen.getByTestId("talk-orb")
    fireEvent.pointerDown(orb)
    expect(h.control).toHaveBeenLastCalledWith({ op: "press", down: true })
    fireEvent.pointerUp(orb)
    expect(h.control).toHaveBeenLastCalledWith({ op: "press", down: false })
  })

  it("taps the orb to interrupt in hands-free", () => {
    h.ui = ui({ status: "speaking" })
    renderDock()
    fireEvent.click(screen.getByTestId("talk-orb"))
    expect(h.control).toHaveBeenLastCalledWith({ op: "tapOrb" })
  })
})
