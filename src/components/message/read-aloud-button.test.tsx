import { type ReactNode } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

const toastWarning = vi.fn()
const toastInfo = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarning(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

// The create-task action pulls contexts this test doesn't mount.
vi.mock("./use-create-task-from-message", () => ({
  useCreateTaskFromMessage: () => () => {},
}))

import { TurnStats } from "./turn-stats"
import { MessageScrollProvider } from "./message-scroll-context"
import enMessages from "@/i18n/messages/en.json"
import { RESTART_DELAY_MS } from "@/lib/read-aloud/player"
import { fakeVoice, installFakeSpeech } from "@/lib/read-aloud/testing"

const labels = enMessages.Folder.chat.messageList

function renderStats(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageScrollProvider value={{ scrollToIndex: vi.fn() }}>
        {ui}
      </MessageScrollProvider>
    </NextIntlClientProvider>
  )
}

let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  toastWarning.mockClear()
  toastInfo.mockClear()
  localStorage.clear()
})

describe("Read aloud in the reply footer", () => {
  it("is not offered where the runtime has no speech synthesis", () => {
    renderStats(<TurnStats copyText="Hello there." readAloudId="c:1" />)
    expect(screen.getByLabelText(labels.copyMessage)).toBeInTheDocument()
    expect(screen.queryByLabelText(labels.readAloud)).not.toBeInTheDocument()
  })

  it("is not offered on a surface that gives the reply no id", () => {
    uninstall = installFakeSpeech().uninstall
    renderStats(<TurnStats copyText="Hello there." />)
    expect(screen.queryByLabelText(labels.readAloud)).not.toBeInTheDocument()
  })

  it("reads the reply, then offers Stop and Pause, and stops", async () => {
    const speech = installFakeSpeech()
    uninstall = speech.uninstall
    renderStats(
      <TurnStats copyText="Hello there. Second line." readAloudId="c:1" />
    )

    await userEvent.click(screen.getByLabelText(labels.readAloud))
    expect(speech.synth.spoken.map((u) => u.text)).toEqual(["Hello there."])
    const stop = screen.getByLabelText(labels.stopReading)
    expect(stop).toHaveAttribute("data-read-aloud", "playing")

    await userEvent.click(screen.getByLabelText(labels.pauseReading))
    expect(stop).toHaveAttribute("data-read-aloud", "paused")
    await userEvent.click(screen.getByLabelText(labels.resumeReading))
    expect(speech.synth.spoken.map((u) => u.text)).toEqual([
      "Hello there.",
      "Hello there.",
    ])

    await userEvent.click(screen.getByLabelText(labels.stopReading))
    expect(screen.getByLabelText(labels.readAloud)).toBeInTheDocument()
    expect(screen.queryByLabelText(labels.pauseReading)).not.toBeInTheDocument()
  })

  it("shows only the reply being read as playing", async () => {
    const speech = installFakeSpeech()
    uninstall = speech.uninstall
    renderStats(
      <>
        <TurnStats copyText="First reply." readAloudId="c:1" />
        <TurnStats copyText="Second reply." readAloudId="c:2" />
      </>
    )
    const [first, second] = screen.getAllByLabelText(labels.readAloud)
    await userEvent.click(first)
    expect(screen.getAllByLabelText(labels.stopReading)).toHaveLength(1)

    await userEvent.click(second)
    const stops = screen.getAllByLabelText(labels.stopReading)
    expect(stops).toHaveLength(1)
    expect(screen.getAllByLabelText(labels.readAloud)).toHaveLength(1)

    // The second reply starts after the restart pause; finishing it returns
    // the footer to "Read aloud".
    await act(
      () => new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS * 2))
    )
    act(() => {
      expect(speech.synth.finishAll()).toEqual(["Second reply."])
    })
    expect(screen.getAllByLabelText(labels.readAloud)).toHaveLength(2)
  })

  it("says once that no Hebrew voice is installed", async () => {
    const speech = installFakeSpeech([fakeVoice("Samantha", "en-US")])
    uninstall = speech.uninstall
    renderStats(<TurnStats copyText="שלום לכולם." readAloudId="c:1" />)

    await userEvent.click(screen.getByLabelText(labels.readAloud))
    expect(toastWarning).toHaveBeenCalledTimes(1)
    expect(toastWarning.mock.calls[0][0]).toBe(
      enMessages.ReadAloud.missingHebrewVoice
    )

    await userEvent.click(screen.getByLabelText(labels.stopReading))
    await userEvent.click(screen.getByLabelText(labels.readAloud))
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })
})
