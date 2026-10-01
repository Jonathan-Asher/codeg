import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BusySessionsReport } from "@/lib/updater"

let report: () => Promise<BusySessionsReport>
vi.mock("@/lib/updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/updater")>()),
  getBusySessions: () => report(),
}))

import { RemoteUpdateConfirmDialog } from "./remote-update-confirm-dialog"
import enMessages from "@/i18n/messages/en.json"

const onConfirm = vi.fn()
const onOpenChange = vi.fn()

function renderDialog(version: string | null = "0.21.9") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteUpdateConfirmDialog
        open
        onOpenChange={onOpenChange}
        remoteName="studio"
        version={version}
        onConfirm={onConfirm}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  onConfirm.mockClear()
  onOpenChange.mockClear()
})

describe("RemoteUpdateConfirmDialog", () => {
  it("lists the sessions the restart would cut off and defaults to waiting", async () => {
    report = async () => ({
      autoResume: true,
      sessions: [
        {
          conversationId: 3,
          title: "Ship the parser",
          agentType: "claude_code",
          reason: "working",
        },
        { conversationId: 4, title: "Answer me", reason: "needs_you" },
        { conversationId: 5, reason: "background" },
      ],
    })
    renderDialog()

    expect(screen.getByText("Update studio to v0.21.9?")).toBeVisible()
    expect(await screen.findByText("3 sessions are mid-turn")).toBeVisible()
    expect(screen.getByText("Ship the parser")).toBeVisible()
    expect(screen.getByText("Answer me")).toBeVisible()
    expect(screen.getByText("Untitled session")).toBeVisible()
    expect(screen.getByText("Needs you")).toBeVisible()
    expect(screen.getByText("Background work")).toBeVisible()
    expect(
      screen.getByText(
        "Turns the restart cuts off resume by themselves afterwards."
      )
    ).toBeVisible()

    // "Update when idle" is the default: focused, so Enter picks it.
    const whenIdle = screen.getByRole("button", { name: "Update when idle" })
    await waitFor(() => expect(whenIdle).toHaveFocus())
    fireEvent.click(whenIdle)
    expect(onConfirm).toHaveBeenCalledWith("when_idle")
  })

  it("says when nothing is mid-turn, and can update right away", async () => {
    report = async () => ({ autoResume: true, sessions: [] })
    renderDialog()

    expect(
      await screen.findByText("No session is mid-turn right now.")
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Update now" }))
    expect(onConfirm).toHaveBeenCalledWith("now")
  })

  it("warns when interrupted turns won't come back by themselves", async () => {
    report = async () => ({
      autoResume: false,
      sessions: [{ conversationId: 1, title: "Busy", reason: "working" }],
    })
    renderDialog()

    expect(
      await screen.findByText(
        /Resuming interrupted sessions after restart is off on studio/
      )
    ).toBeVisible()
  })

  it("still lets the user choose when the sessions can't be read", async () => {
    report = async () => {
      throw new Error("offline")
    }
    renderDialog(null)

    expect(screen.getByText("Update studio?")).toBeVisible()
    expect(
      await screen.findByText("Couldn't check which sessions are mid-turn.")
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
