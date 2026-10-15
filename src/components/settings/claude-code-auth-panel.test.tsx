import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClaudeAuthStatus } from "@/lib/types"

const api = vi.hoisted(() => ({
  claudeAuthStatus: vi.fn<() => Promise<ClaudeAuthStatus>>(),
  claudeAuthLoginStart: vi.fn(() =>
    Promise.resolve({ handle: "h1", url: "https://claude.test/authorize" })
  ),
  claudeAuthLoginFinish: vi.fn(() =>
    Promise.resolve({ ok: true, reason: null, retry: false })
  ),
  claudeAuthLoginState: vi.fn(() => Promise.resolve("waiting" as const)),
  claudeAuthLoginCancel: vi.fn(() => Promise.resolve()),
  claudeAuthLogout: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ClaudeCodeAuthPanel } from "./claude-code-auth-panel"
import enMessages from "@/i18n/messages/en.json"

const SIGNED_IN: ClaudeAuthStatus = {
  loggedIn: true,
  method: "claude_ai",
  email: "someone@example.com",
  subscription: "max",
  provider: "firstParty",
}

const SIGNED_OUT: ClaudeAuthStatus = {
  loggedIn: false,
  method: "none",
  email: null,
  subscription: null,
  provider: "firstParty",
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ClaudeCodeAuthPanel />
    </NextIntlClientProvider>
  )
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("ClaudeCodeAuthPanel", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows who the host's CLI is signed in as", async () => {
    api.claudeAuthStatus.mockResolvedValue(SIGNED_IN)
    renderPanel()
    await settle()
    expect(screen.getByText(/Signed in as someone@example.com/)).toBeTruthy()
    expect(screen.getByText(/Claude subscription/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy()
  })

  it("signs in from this device when the CLI is signed out", async () => {
    api.claudeAuthStatus.mockResolvedValueOnce(SIGNED_OUT)
    api.claudeAuthStatus.mockResolvedValueOnce(SIGNED_IN)
    renderPanel()
    await settle()
    expect(screen.getByText(/Not signed in/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await settle()
    expect(api.claudeAuthLoginStart).toHaveBeenCalledWith(false)
    expect(screen.getByText("https://claude.test/authorize")).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText("Paste the code here"), {
      target: { value: "code#state" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    await settle()
    expect(api.claudeAuthLoginFinish).toHaveBeenCalledWith("h1", "code#state")
    await settle()
    // The status is read again once the sign-in lands.
    expect(api.claudeAuthStatus).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Signed in as someone@example.com/)).toBeTruthy()
  })

  it("asks before signing every session out", async () => {
    api.claudeAuthStatus.mockResolvedValue(SIGNED_IN)
    renderPanel()
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    expect(screen.getByText("Sign Claude Code out?")).toBeTruthy()
    expect(api.claudeAuthLogout).not.toHaveBeenCalled()
    const confirm = screen
      .getAllByRole("button", { name: "Sign out" })
      .find((b) => b.closest("[role='alertdialog']"))!
    fireEvent.click(confirm)
    await settle()
    expect(api.claudeAuthLogout).toHaveBeenCalledTimes(1)
  })

  it("says when the status can't be read", async () => {
    api.claudeAuthStatus.mockRejectedValue(
      new Error("claude-agent-acp is not installed")
    )
    renderPanel()
    await settle()
    expect(screen.getByRole("alert").textContent).toContain(
      "claude-agent-acp is not installed"
    )
  })
})
