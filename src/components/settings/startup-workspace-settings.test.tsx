import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  RemoteWorkspaceConnection,
  SystemStartupWorkspaceSettings,
} from "@/lib/types"

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn<() => Promise<RemoteWorkspaceConnection[]>>(),
  getSettings: vi.fn<() => Promise<SystemStartupWorkspaceSettings>>(),
  updateSettings:
    vi.fn<
      (
        settings: SystemStartupWorkspaceSettings
      ) => Promise<SystemStartupWorkspaceSettings>
    >(),
  toastError: vi.fn(),
}))
let desktop = true

vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: () => mocks.listConnections(),
  getStartupWorkspaceSettings: () => mocks.getSettings(),
  updateStartupWorkspaceSettings: (settings: SystemStartupWorkspaceSettings) =>
    mocks.updateSettings(settings),
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => desktop }))
vi.mock("sonner", () => ({
  toast: { error: (message: string) => mocks.toastError(message) },
}))

import { StartupWorkspaceSettingsSection } from "./startup-workspace-settings"

function connection(id: number, name: string): RemoteWorkspaceConnection {
  return {
    id,
    name,
    base_url: `https://${name}.example`,
    token: "secret",
    headers: [],
    sort_order: id,
    created_at: "2026-09-24T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z",
  }
}

const SAVED = [connection(11, "prod-box"), connection(12, "lab-box")]

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StartupWorkspaceSettingsSection />
    </NextIntlClientProvider>
  )
}

async function pick(option: string) {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("combobox"))
  await user.click(await screen.findByRole("option", { name: option }))
}

beforeEach(() => {
  desktop = true
  mocks.listConnections.mockReset()
  mocks.getSettings.mockReset()
  mocks.updateSettings.mockReset()
  mocks.toastError.mockClear()
  mocks.listConnections.mockResolvedValue(SAVED)
  mocks.getSettings.mockResolvedValue({ remote_connection_id: null })
})
afterEach(() => cleanup())

describe("StartupWorkspaceSettingsSection", () => {
  it("starts in the local workspace by default", async () => {
    renderSection()

    expect(await screen.findByText("Local workspace")).toBeInTheDocument()
    expect(screen.getByLabelText("When codeg starts, open")).toBeEnabled()
  })

  it("names the saved remote workspace a launch opens", async () => {
    mocks.getSettings.mockResolvedValue({ remote_connection_id: 12 })

    renderSection()

    expect(await screen.findByText("lab-box")).toBeInTheDocument()
  })

  it("offers every saved remote workspace and persists the pick", async () => {
    mocks.updateSettings.mockResolvedValue({ remote_connection_id: 11 })
    renderSection()

    const user = userEvent.setup()
    await user.click(await screen.findByRole("combobox"))
    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["Local workspace", "prod-box", "lab-box"])
    await user.click(screen.getByRole("option", { name: "prod-box" }))

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        remote_connection_id: 11,
      })
    )
    expect(await screen.findByText("prod-box")).toBeInTheDocument()
  })

  it("goes back to the local workspace", async () => {
    mocks.getSettings.mockResolvedValue({ remote_connection_id: 11 })
    mocks.updateSettings.mockResolvedValue({ remote_connection_id: null })
    renderSection()
    await screen.findByText("prod-box")

    await pick("Local workspace")

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        remote_connection_id: null,
      })
    )
  })

  it("puts the picker back when the save fails", async () => {
    mocks.updateSettings.mockRejectedValue(
      new Error("Remote connection 11 not found")
    )
    renderSection()
    await screen.findByText("Local workspace")

    await pick("prod-box")

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    // Left on "prod-box", the picker would promise a launch the next start
    // will not make.
    expect(await screen.findByText("Local workspace")).toBeInTheDocument()
  })

  it("reads a choice missing from the list as the local workspace", async () => {
    // Deleted between the two reads: that launch opens the local workspace.
    mocks.getSettings.mockResolvedValue({ remote_connection_id: 99 })

    renderSection()

    expect(await screen.findByText("Local workspace")).toBeInTheDocument()
  })

  it("explains an empty picker when no remote workspace is saved", async () => {
    mocks.listConnections.mockResolvedValue([])

    renderSection()

    expect(
      await screen.findByText(
        "No remote workspaces saved yet. Save one to have codeg open it when it starts."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("combobox")).toBeDisabled()
  })

  it("stays hidden until it knows the stored choice", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db locked"))

    renderSection()

    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled())
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it("stays out of web builds", async () => {
    desktop = false

    renderSection()

    await waitFor(() => expect(mocks.getSettings).not.toHaveBeenCalled())
    expect(mocks.listConnections).not.toHaveBeenCalled()
    expect(screen.queryByRole("combobox")).toBeNull()
  })
})
