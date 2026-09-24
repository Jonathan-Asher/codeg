import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { RemoteWorkspaceConnection } from "@/lib/types"

const h = vi.hoisted(() => ({
  getConnection: vi.fn(),
  testConnection: vi.fn(),
  closeCurrentWindow: vi.fn(),
  manageProps: null as null | {
    open: boolean
    initialSelectedId?: number
    onOpenChange: (open: boolean) => void
    onChanged: () => void
  },
}))

vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: h.getConnection,
  testRemoteWorkspaceConnection: h.testConnection,
}))

vi.mock("@/lib/platform", () => ({
  closeCurrentWindow: h.closeCurrentWindow,
}))

// The editor itself has its own tests; here only its wiring matters.
vi.mock("@/components/layout/remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: (props: NonNullable<typeof h.manageProps>) => {
    h.manageProps = props
    return props.open ? <div data-testid="manage-dialog" /> : null
  },
}))

import { RemoteConnectionProblem } from "./remote-connection-problem"

const CONNECTION: RemoteWorkspaceConnection = {
  id: 4,
  name: "build box",
  base_url: "http://box:3080",
  token: "old-token",
  headers: [],
  sort_order: 0,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
}

const reload = vi.fn()
const originalLocation = window.location

function renderProblem(
  props: Partial<Parameters<typeof RemoteConnectionProblem>[0]> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteConnectionProblem
        connection={CONNECTION}
        loadError={null}
        onRetryLoad={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.getConnection.mockReset()
  h.testConnection.mockReset()
  h.closeCurrentWindow.mockReset()
  h.manageProps = null
  reload.mockReset()
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload },
  })
})

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  })
})

describe("RemoteConnectionProblem — rejected token", () => {
  it("reconnects with the saved details read fresh, then reloads the window", async () => {
    h.getConnection.mockResolvedValue({ ...CONNECTION, token: "new-token" })
    h.testConnection.mockResolvedValue(undefined)
    renderProblem()

    expect(screen.getByText("Disconnected from build box")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(h.getConnection).toHaveBeenCalledWith(4)
    expect(h.testConnection).toHaveBeenCalledWith({
      name: "build box",
      baseUrl: "http://box:3080",
      token: "new-token",
      headers: [],
    })
  })

  it("stays on the screen and says why when the server still refuses", async () => {
    h.getConnection.mockResolvedValue(CONNECTION)
    h.testConnection.mockRejectedValue({
      code: "authentication_failed",
      message: "Remote Workspace token is invalid",
    })
    renderProblem()

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))

    expect(
      await screen.findByText(/Still can't connect: .*token is invalid/)
    ).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled()
  })

  it("opens the editor on this connection and reconnects once a change is saved", async () => {
    h.getConnection.mockResolvedValue(CONNECTION)
    h.testConnection.mockResolvedValue(undefined)
    renderProblem()

    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }))
    expect(screen.getByTestId("manage-dialog")).toBeInTheDocument()
    expect(h.manageProps?.initialSelectedId).toBe(4)

    act(() => {
      h.manageProps?.onChanged()
      h.manageProps?.onOpenChange(false)
    })

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it("does not reconnect when the editor closes without a change", () => {
    renderProblem()
    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }))
    act(() => h.manageProps?.onOpenChange(false))
    expect(h.getConnection).not.toHaveBeenCalled()
  })

  it("closes the window", () => {
    renderProblem()
    fireEvent.click(screen.getByRole("button", { name: "Close window" }))
    expect(h.closeCurrentWindow).toHaveBeenCalledTimes(1)
  })
})

describe("RemoteConnectionProblem — connection could not be read", () => {
  it("shows the error and tries loading again on request", () => {
    const onRetryLoad = vi.fn()
    renderProblem({ connection: null, loadError: "no such row", onRetryLoad })

    expect(
      screen.getByText("Couldn't open this remote workspace")
    ).toBeInTheDocument()
    expect(screen.getByText(/no such row/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetryLoad).toHaveBeenCalledTimes(1)
  })
})
