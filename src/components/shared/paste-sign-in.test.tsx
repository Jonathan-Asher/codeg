import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SignInOutcome, SignInState } from "@/lib/types"

const openUrl = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve())

vi.mock("@/lib/platform", () => ({
  openUrl: (url: string) => openUrl(url),
}))

import { PasteSignIn, type PasteSignInFlow } from "./paste-sign-in"
import enMessages from "@/i18n/messages/en.json"

const LINK = "https://claude.test/oauth/authorize?code=true&state=st"

function makeFlow(overrides: Partial<PasteSignInFlow> = {}) {
  const flow = {
    start: vi.fn(() => Promise.resolve({ handle: "h1", url: LINK })),
    finish: vi.fn<(h: string, p: string) => Promise<SignInOutcome>>(() =>
      Promise.resolve({ ok: true, reason: null, retry: false })
    ),
    state: vi.fn<(h: string) => Promise<SignInState>>(() =>
      Promise.resolve("waiting")
    ),
    cancel: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
  return flow
}

function renderFlow(flow: PasteSignInFlow) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PasteSignIn
        flow={flow}
        stepOpen="Open the page"
        stepPaste="Paste the code"
        pastePlaceholder="code"
        onDone={onDone}
        onClose={onClose}
      />
    </NextIntlClientProvider>
  )
  return { ...view, onDone, onClose }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("PasteSignIn", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the host's link, opens it, and finishes with the pasted code", async () => {
    const flow = makeFlow()
    const { onDone } = renderFlow(flow)
    await settle()
    expect(flow.start).toHaveBeenCalledTimes(1)
    expect(screen.getByText(LINK)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Open sign-in page" }))
    expect(openUrl).toHaveBeenCalledWith(LINK)

    fireEvent.change(screen.getByPlaceholderText("code"), {
      target: { value: "abc#st" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    await settle()
    expect(flow.finish).toHaveBeenCalledWith("h1", "abc#st")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Signed in.")).toBeTruthy()
    // A finished sign-in is not cancelled on the way out.
    expect(flow.cancel).not.toHaveBeenCalled()
  })

  it("keeps waiting after a code the CLI asks to have again", async () => {
    const flow = makeFlow({
      finish: vi.fn(() =>
        Promise.resolve({
          ok: false,
          reason: "invalid_code" as const,
          retry: true,
        })
      ),
    })
    const { onDone } = renderFlow(flow)
    await settle()
    fireEvent.change(screen.getByPlaceholderText("code"), {
      target: { value: "nohash" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    await settle()
    expect(screen.getByRole("alert").textContent).toContain(
      "isn't the code the page showed"
    )
    // Still the paste step, ready for another try.
    expect(screen.getByPlaceholderText("code")).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("ends on a refused code and can start over", async () => {
    const flow = makeFlow({
      finish: vi.fn(() =>
        Promise.resolve({
          ok: false,
          reason: "rejected" as const,
          retry: false,
        })
      ),
    })
    renderFlow(flow)
    await settle()
    fireEvent.change(screen.getByPlaceholderText("code"), {
      target: { value: "bad#st" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    await settle()
    expect(screen.getByRole("alert").textContent).toContain("was refused")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await settle()
    expect(flow.start).toHaveBeenCalledTimes(2)
  })

  it("says so when the host can't start the sign-in", async () => {
    const flow = makeFlow({
      start: vi.fn(() => Promise.reject(new Error("maxpool is not installed"))),
    })
    renderFlow(flow)
    await settle()
    expect(screen.getByRole("alert").textContent).toContain(
      "maxpool is not installed"
    )
  })

  it("cancels the pending sign-in on Cancel", async () => {
    const flow = makeFlow()
    const { onClose } = renderFlow(flow)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(flow.cancel).toHaveBeenCalledWith("h1")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("notices a sign-in that finished without a paste", async () => {
    vi.useFakeTimers()
    try {
      const flow = makeFlow({
        state: vi.fn(() => Promise.resolve("succeeded" as const)),
      })
      const { onDone } = renderFlow(flow)
      await settle()
      await act(async () => {
        vi.advanceTimersByTime(3_100)
        await Promise.resolve()
      })
      await settle()
      expect(flow.state).toHaveBeenCalledWith("h1")
      expect(onDone).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
