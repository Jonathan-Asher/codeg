import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

// The status bar's leading entry as this fork ships it: the SRN account off
// (`lib/srn-account/enabled.ts` reads a build variable nobody sets), so the
// entry is the quick actions alone and nothing asks for the account.
const calls = vi.hoisted(() => [] as string[])

vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
  getShellTransport: () => ({
    call: async (command: string) => {
      calls.push(command)
      throw new Error(`Command ${command} not found`)
    },
    subscribe: async () => () => {},
  }),
  getTransport: () => ({
    call: async (command: string) => {
      calls.push(command)
      throw new Error(`Command ${command} not found`)
    },
    subscribe: async () => () => {},
  }),
}))
vi.mock("@/lib/platform", () => ({ isRemoteDesktopWindow: () => false }))
// The rows are `quick-actions-menu.test.tsx`'s: one marked item here.
vi.mock("@/components/layout/quick-actions-menu", async () => {
  const { DropdownMenuItem } = await import("@/components/ui/dropdown-menu")
  return {
    useQuickActions: () => ({}),
    QuickActionsItems: () => (
      <DropdownMenuItem data-quick-actions="">QUICK-ACTIONS</DropdownMenuItem>
    ),
    QuickActionsDialogs: () => null,
  }
})

import { StatusBarSrn } from "./status-bar-srn"

beforeEach(() => {
  calls.length = 0
})

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarSrn />
    </NextIntlClientProvider>
  )
}

describe("StatusBarSrn with the SRN account switched off", () => {
  it("is a quick-actions launcher whose menu holds the rows alone", async () => {
    mount()
    const trigger = screen.getByRole("button", { name: "Quick actions" })
    expect(trigger).not.toHaveAttribute("data-srn-status")

    await userEvent.click(trigger)

    const menu = await screen.findByRole("menu")
    expect(menu).toHaveTextContent("QUICK-ACTIONS")
    expect(menu).not.toHaveTextContent(/SRN|SpaceRing/)
    expect(
      screen.queryByRole("menuitem", { name: /sign in/i })
    ).not.toBeInTheDocument()
  })

  it("never asks for the account", async () => {
    mount()
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    await screen.findByRole("menu")

    expect(calls.filter((command) => command.startsWith("srn"))).toEqual([])
  })
})
