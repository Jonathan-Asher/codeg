"use client"

import { useCallback, useSyncExternalStore } from "react"
import { useOptionalConnectionStore } from "@/contexts/acp-connections-context"
import type { ConnectionStatus } from "@/lib/types"

const noopUnsubscribe = () => {}

/**
 * Just the status of the connection keyed `contextKey` (a conversation tab's
 * id), or `null` when there is no such connection, no key, or no connection
 * provider at all. A primitive snapshot, so the caller re-renders when the
 * status changes and not on every streamed token — unlike `useConnection`,
 * which also requires the provider.
 */
export function useConnectionStatus(
  contextKey: string | null | undefined
): ConnectionStatus | null {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (onChange: () => void) =>
      store && contextKey
        ? store.subscribeKey(contextKey, onChange)
        : noopUnsubscribe,
    [store, contextKey]
  )
  const getSnapshot = useCallback(
    () =>
      store && contextKey
        ? (store.getConnection(contextKey)?.status ?? null)
        : null,
    [store, contextKey]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
