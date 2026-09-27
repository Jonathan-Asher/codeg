"use client"

import { useCallback, useRef, useSyncExternalStore } from "react"
import type { ConnectionStoreApi } from "@/contexts/acp-connections-context"
// The light module, not the provider's: this hook backs read-only views (a
// sidebar row, the Session Details tab) that must not load the provider.
import { useOptionalConnectionStore } from "@/contexts/acp-connection-contexts"
import { isAttachingPhase } from "@/lib/attach-phase"
import type { AttachPhase, ConnectionStatus } from "@/lib/types"

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

/**
 * Where this client's attempt to open a session stands — what the Session
 * Details "Activity" line needs so it never reads "Idle" for a session the
 * agent is still opening, or one it could not open at all.
 */
export interface ConnectionAttachInfo {
  /** `connecting` while the agent starts or resumes the session, `failed`
   *  when the last attempt failed, `null` when neither (open, or no attempt). */
  state: "connecting" | "failed" | null
  /** The step being waited on while `connecting` ("resuming", …). */
  phase: AttachPhase | null
  /** Client-clock estimate (epoch ms) of when the agent was spawned. */
  startedAt: number | null
  /** Why it failed, readable, when `failed`. */
  error: string | null
}

const NO_ATTACH_INFO: ConnectionAttachInfo = {
  state: null,
  phase: null,
  startedAt: null,
  error: null,
}

/** Derive the attach info for one key from the store. Exported for tests. */
export function readConnectionAttachInfo(
  store: Pick<
    ConnectionStoreApi,
    "getConnection" | "getConnectPending" | "getConnectError"
  >,
  contextKey: string
): ConnectionAttachInfo {
  const conn = store.getConnection(contextKey)
  const attachPhase = conn?.attachPhase
  const attachingPhase = isAttachingPhase(attachPhase)
    ? attachPhase
    : "starting"
  // A connect() in flight wins: it is the attempt the user is waiting on, even
  // while the entry it replaces still reads as failed.
  if (store.getConnectPending(contextKey)) {
    return {
      state: "connecting",
      phase: attachingPhase,
      // Only the entry's own attach is timed; an entry left from an earlier
      // attempt says nothing about how long this one has taken.
      startedAt: isAttachingPhase(attachPhase)
        ? (conn?.attachStartedAt ?? null)
        : null,
      error: null,
    }
  }
  if (conn) {
    if (conn.status === "connecting") {
      return {
        state: "connecting",
        phase: attachingPhase,
        startedAt: conn.attachStartedAt ?? null,
        error: null,
      }
    }
    if (
      conn.attachPhase === "failed" &&
      (conn.status === "error" || conn.status === "disconnected")
    ) {
      return {
        state: "failed",
        phase: "failed",
        startedAt: conn.attachStartedAt ?? null,
        error: conn.error ?? conn.loadError ?? null,
      }
    }
    return NO_ATTACH_INFO
  }
  const failed = store.getConnectError(contextKey)
  if (failed) {
    return {
      state: "failed",
      phase: null,
      startedAt: null,
      error: failed.detail ? `${failed.title}: ${failed.detail}` : failed.title,
    }
  }
  return NO_ATTACH_INFO
}

function sameAttachInfo(a: ConnectionAttachInfo, b: ConnectionAttachInfo) {
  return (
    a.state === b.state &&
    a.phase === b.phase &&
    a.startedAt === b.startedAt &&
    a.error === b.error
  )
}

/**
 * {@link ConnectionAttachInfo} for the connection keyed `contextKey`. The
 * snapshot is reference-stable while nothing it reports changes, so callers
 * re-render on a phase change and not on every streamed token.
 */
export function useConnectionAttachInfo(
  contextKey: string | null | undefined
): ConnectionAttachInfo {
  const store = useOptionalConnectionStore()
  const cacheRef = useRef<ConnectionAttachInfo>(NO_ATTACH_INFO)
  const subscribe = useCallback(
    (onChange: () => void) =>
      store && contextKey
        ? store.subscribeKey(contextKey, onChange)
        : noopUnsubscribe,
    [store, contextKey]
  )
  const getSnapshot = useCallback(() => {
    const next =
      store && contextKey
        ? readConnectionAttachInfo(store, contextKey)
        : NO_ATTACH_INFO
    if (!sameAttachInfo(cacheRef.current, next)) cacheRef.current = next
    return cacheRef.current
  }, [store, contextKey])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
