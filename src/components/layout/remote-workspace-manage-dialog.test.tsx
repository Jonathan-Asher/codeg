import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteWorkspaceConnection } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  listRemoteWorkspaceConnections: vi.fn(),
  createRemoteWorkspaceConnection: vi.fn(),
  updateRemoteWorkspaceConnection: vi.fn(),
  deleteRemoteWorkspaceConnection: vi.fn(),
  reorderRemoteWorkspaceConnections: vi.fn(),
  getStartupWorkspaceSettings: vi.fn(),
  updateStartupWorkspaceSettings: vi.fn(),
}))

vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: mocks.listRemoteWorkspaceConnections,
  createRemoteWorkspaceConnection: mocks.createRemoteWorkspaceConnection,
  updateRemoteWorkspaceConnection: mocks.updateRemoteWorkspaceConnection,
  deleteRemoteWorkspaceConnection: mocks.deleteRemoteWorkspaceConnection,
  reorderRemoteWorkspaceConnections: mocks.reorderRemoteWorkspaceConnections,
  getStartupWorkspaceSettings: mocks.getStartupWorkspaceSettings,
  updateStartupWorkspaceSettings: mocks.updateStartupWorkspaceSettings,
}))

import { RemoteWorkspaceManageDialog } from "./remote-workspace-manage-dialog"
import enMessages from "@/i18n/messages/en.json"

function connection(
  overrides: Partial<RemoteWorkspaceConnection> = {}
): RemoteWorkspaceConnection {
  return {
    id: 1,
    name: "prod-box",
    base_url: "https://prod.example",
    token: "secret",
    headers: [],
    sort_order: 0,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
    ...overrides,
  }
}

async function mount(
  connections: RemoteWorkspaceConnection[],
  startupConnectionId: number | null = null
) {
  mocks.listRemoteWorkspaceConnections.mockResolvedValue(connections)
  mocks.getStartupWorkspaceSettings.mockResolvedValue({
    remote_connection_id: startupConnectionId,
  })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteWorkspaceManageDialog
        open
        onOpenChange={() => {}}
        onChanged={() => {}}
      />
    </NextIntlClientProvider>
  )
  await screen.findByDisplayValue(connections[0].name)
}

describe("RemoteWorkspaceManageDialog custom headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps the editor collapsed when the connection has no headers", async () => {
    await mount([connection()])
    expect(screen.queryByLabelText("Header name")).not.toBeInTheDocument()
  })

  it("opens the editor when the connection already has headers", async () => {
    await mount([
      connection({ headers: [{ name: "CF-Access-Client-Id", value: "abc" }] }),
    ])
    expect(await screen.findByDisplayValue("CF-Access-Client-Id")).toBeVisible()
  })

  it("masks every header value", async () => {
    await mount([connection({ headers: [{ name: "X-Secret", value: "abc" }] })])
    expect(await screen.findByDisplayValue("abc")).toHaveAttribute(
      "type",
      "password"
    )
  })

  it("sends the added header on save and drops a removed one", async () => {
    const saved = connection({
      headers: [{ name: "X-Team", value: "core" }],
    })
    mocks.updateRemoteWorkspaceConnection.mockResolvedValue(saved)
    await mount([connection()])

    await userEvent.click(
      screen.getByRole("button", { name: /Custom headers/ })
    )
    await userEvent.click(screen.getByRole("button", { name: "Add header" }))
    fireEvent.change(screen.getByLabelText("Header name"), {
      target: { value: "X-Team" },
    })
    fireEvent.change(screen.getByLabelText("Header value"), {
      target: { value: "core" },
    })

    // A second row, then removed again: the payload must hold one header.
    await userEvent.click(screen.getByRole("button", { name: "Add header" }))
    await userEvent.click(
      screen.getAllByRole("button", { name: "Remove header" })[1]
    )

    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mocks.updateRemoteWorkspaceConnection).toHaveBeenCalledWith(1, {
        name: "prod-box",
        baseUrl: "https://prod.example",
        token: "secret",
        headers: [{ name: "X-Team", value: "core" }],
      })
    })
  })
})

describe("RemoteWorkspaceManageDialog open at startup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows the switch on for the connection a launch opens", async () => {
    await mount([connection()], 1)

    expect(
      await screen.findByRole("switch", { name: "Open when codeg starts" })
    ).toHaveAttribute("data-state", "checked")
  })

  it("makes a saved connection the startup workspace right away", async () => {
    mocks.updateStartupWorkspaceSettings.mockResolvedValue({
      remote_connection_id: 1,
    })
    await mount([connection()])

    const toggle = await screen.findByRole("switch", {
      name: "Open when codeg starts",
    })
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    await userEvent.click(toggle)

    await waitFor(() =>
      expect(mocks.updateStartupWorkspaceSettings).toHaveBeenCalledWith({
        remote_connection_id: 1,
      })
    )
    expect(toggle).toHaveAttribute("data-state", "checked")
    // Not part of the form: nothing else was saved with it.
    expect(mocks.updateRemoteWorkspaceConnection).not.toHaveBeenCalled()
  })

  it("switching it off goes back to the local workspace", async () => {
    mocks.updateStartupWorkspaceSettings.mockResolvedValue({
      remote_connection_id: null,
    })
    await mount([connection()], 1)

    await userEvent.click(
      await screen.findByRole("switch", { name: "Open when codeg starts" })
    )

    await waitFor(() =>
      expect(mocks.updateStartupWorkspaceSettings).toHaveBeenCalledWith({
        remote_connection_id: null,
      })
    )
  })

  it("flips back and says why when the save fails", async () => {
    mocks.updateStartupWorkspaceSettings.mockRejectedValue(
      new Error("db locked")
    )
    await mount([connection()])

    const toggle = await screen.findByRole("switch", {
      name: "Open when codeg starts",
    })
    await userEvent.click(toggle)

    expect(
      await screen.findByText("Failed to save the startup workspace: db locked")
    ).toBeInTheDocument()
    expect(toggle).toHaveAttribute("data-state", "unchecked")
  })

  it("has no switch for a connection that is not saved yet", async () => {
    await mount([connection()])
    await screen.findByRole("switch", { name: "Open when codeg starts" })

    await userEvent.click(
      screen.getByRole("button", { name: "New connection" })
    )

    expect(
      screen.queryByRole("switch", { name: "Open when codeg starts" })
    ).toBeNull()
  })
})
