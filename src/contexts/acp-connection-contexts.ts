"use client"

import { createContext, useContext } from "react"
import type {
  AcpActionsValue,
  ConnectionStoreApi,
} from "@/contexts/acp-connections-context"

// The two React contexts `AcpConnectionsProvider` publishes, kept in a module
// of their own so a view that only READS connection state (a sidebar row, the
// Session Details tab) can subscribe without importing the provider module —
// and with it every store and transport that module wires up at load time.
// Only types come from the provider module here, so the import is erased.

export const ConnectionStoreContext = createContext<ConnectionStoreApi | null>(
  null
)

export const AcpActionsContext = createContext<AcpActionsValue | null>(null)

/** The connection store, or `null` outside an `AcpConnectionsProvider`. */
export function useOptionalConnectionStore(): ConnectionStoreApi | null {
  return useContext(ConnectionStoreContext)
}

/** The connection actions, or `null` outside an `AcpConnectionsProvider`. */
export function useOptionalAcpActions(): AcpActionsValue | null {
  return useContext(AcpActionsContext)
}
