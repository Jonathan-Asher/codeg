import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ClaudePlanSettings } from "@/lib/types"

const getSettings = vi.fn<() => Promise<ClaudePlanSettings>>()
const updateSettings =
  vi.fn<(s: ClaudePlanSettings) => Promise<ClaudePlanSettings>>()
const toastError = vi.fn()

vi.mock("@/lib/api", () => ({
  getClaudePlanSettings: () => getSettings(),
  updateClaudePlanSettings: (s: ClaudePlanSettings) => updateSettings(s),
}))
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { ClaudeCodePlanSettingsPanel } from "./claude-code-plan-settings"

const DEFAULTS: ClaudePlanSettings = {
  while_planning: "when_elevated",
  after_approval: "pre_plan",
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ClaudeCodePlanSettingsPanel />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  toastError.mockClear()
  getSettings.mockReset()
  updateSettings.mockReset()
  getSettings.mockResolvedValue(DEFAULTS)
})
afterEach(() => cleanup())

describe("ClaudeCodePlanSettingsPanel", () => {
  it("shows the defaults: no prompts after Auto or Bypass, continue in the pre-plan mode", async () => {
    renderPanel()
    expect(
      await screen.findByText("Don't ask for permission while planning")
    ).toBeInTheDocument()
    expect(
      screen.getByText("When the session was in Auto or Bypass")
    ).toBeInTheDocument()
    expect(screen.getByText("The mode before planning")).toBeInTheDocument()
  })

  it("turns the planning auto-approval off", async () => {
    const user = userEvent.setup()
    updateSettings.mockImplementation(async (s) => s)
    renderPanel()

    const [whilePlanning] = await screen.findAllByRole("combobox")
    await user.click(whilePlanning)
    await user.click(
      await screen.findByRole("option", { name: "Off (ask every time)" })
    )

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        while_planning: "off",
        after_approval: "pre_plan",
      })
    )
  })

  it("stores the mode to continue in after a plan", async () => {
    const user = userEvent.setup()
    updateSettings.mockImplementation(async (s) => s)
    renderPanel()

    const [, afterApproval] = await screen.findAllByRole("combobox")
    await user.click(afterApproval)
    await user.click(
      await screen.findByRole("option", { name: "Ask each time" })
    )

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        while_planning: "when_elevated",
        after_approval: "ask",
      })
    )
    expect(await screen.findByText("Ask each time")).toBeInTheDocument()
  })

  it("puts the previous value back when the save fails", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("db locked"))
    renderPanel()

    const [whilePlanning] = await screen.findAllByRole("combobox")
    await user.click(whilePlanning)
    await user.click(await screen.findByRole("option", { name: "Always" }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(
      await screen.findByText("When the session was in Auto or Bypass")
    ).toBeInTheDocument()
  })
})
