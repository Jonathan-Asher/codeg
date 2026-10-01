"use client"

import { createContext, useContext } from "react"
import type { RemoteWorkspaceConnection } from "@/lib/types"

/**
 * The remote connection a window is bound to, as `RemoteConnectionGate`
 * provides it. Kept apart from the gate so a consumer that only reads the
 * connection (e.g. to name the remote) doesn't pull in the gate's loading and
 * problem screens.
 */
export interface RemoteConnectionContextValue {
  connection: RemoteWorkspaceConnection | null
  expired: boolean
  markExpired: () => void
}

export const RemoteConnectionContext =
  createContext<RemoteConnectionContextValue | null>(null)

export function useRemoteConnection() {
  return useContext(RemoteConnectionContext)
}
