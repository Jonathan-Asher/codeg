import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  shellCall: vi.fn(),
  windowCall: vi.fn(),
}))

// `getTransport` is the WINDOW's transport: in a remote workspace window it
// reaches the server that window is bound to. The startup workspace and the
// local workspace window belong to the app on this machine, so a call that
// went through it would ask the wrong codeg.
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: mocks.shellCall }),
  getTransport: () => ({ call: mocks.windowCall }),
}))

import {
  getStartupWorkspaceSettings,
  showLocalWorkspace,
  updateStartupWorkspaceSettings,
} from "./remote-workspace"

beforeEach(() => {
  mocks.shellCall.mockReset()
  mocks.windowCall.mockReset()
  mocks.shellCall.mockResolvedValue(undefined)
})

describe("remote-workspace — calls about this machine's app", () => {
  it("reads and writes the startup workspace on the local app", async () => {
    mocks.shellCall.mockResolvedValueOnce({ remote_connection_id: 3 })

    await expect(getStartupWorkspaceSettings()).resolves.toEqual({
      remote_connection_id: 3,
    })
    expect(mocks.shellCall).toHaveBeenCalledWith(
      "get_system_startup_workspace_settings"
    )

    await updateStartupWorkspaceSettings({ remote_connection_id: null })
    expect(mocks.shellCall).toHaveBeenLastCalledWith(
      "update_system_startup_workspace_settings",
      { settings: { remote_connection_id: null } }
    )
    expect(mocks.windowCall).not.toHaveBeenCalled()
  })

  it("asks the local app to show its own workspace window", async () => {
    await showLocalWorkspace()

    expect(mocks.shellCall).toHaveBeenCalledWith("show_local_workspace")
    expect(mocks.windowCall).not.toHaveBeenCalled()
  })
})
