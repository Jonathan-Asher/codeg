import { getShellTransport } from "@/lib/transport"
import type {
  RemoteWorkspaceConnection,
  RemoteWorkspaceConnectionInput,
  SystemStartupWorkspaceSettings,
} from "@/lib/types"

export async function listRemoteWorkspaceConnections(): Promise<
  RemoteWorkspaceConnection[]
> {
  return getShellTransport().call("list_remote_workspace_connections")
}

export async function getRemoteWorkspaceConnection(
  id: number
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("get_remote_workspace_connection", { id })
}

export async function testRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<void> {
  return getShellTransport().call("test_remote_workspace_connection", { input })
}

export async function createRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("create_remote_workspace_connection", {
    input,
  })
}

export async function updateRemoteWorkspaceConnection(
  id: number,
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("update_remote_workspace_connection", {
    id,
    input,
  })
}

export async function deleteRemoteWorkspaceConnection(
  id: number
): Promise<void> {
  return getShellTransport().call("delete_remote_workspace_connection", { id })
}

export async function reorderRemoteWorkspaceConnections(
  ids: number[]
): Promise<void> {
  return getShellTransport().call("reorder_remote_workspace_connections", {
    ids,
  })
}

export async function openRemoteWorkspace(id: number): Promise<void> {
  return getShellTransport().call("open_remote_workspace", { id })
}

/**
 * Show this machine's local workspace window, rebuilding it if it was closed.
 * The way back from a remote workspace window once a launch opened that
 * workspace instead of the local one.
 */
export async function showLocalWorkspace(): Promise<void> {
  return getShellTransport().call("show_local_workspace")
}

/**
 * The workspace this machine's codeg opens at launch. A preference of the
 * local app like the connections themselves, so it goes through the shell
 * transport too — also from a remote window, whose own transport would ask the
 * server it is bound to.
 */
export async function getStartupWorkspaceSettings(): Promise<SystemStartupWorkspaceSettings> {
  return getShellTransport().call("get_system_startup_workspace_settings")
}

/** Rejects (`not_found`) a connection id that no longer exists. */
export async function updateStartupWorkspaceSettings(
  settings: SystemStartupWorkspaceSettings
): Promise<SystemStartupWorkspaceSettings> {
  return getShellTransport().call("update_system_startup_workspace_settings", {
    settings,
  })
}
