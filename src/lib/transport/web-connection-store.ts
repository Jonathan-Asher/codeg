// SSR-safe adapter between a network transport's connection-health state
// machine and React's `useSyncExternalStore`. Kept as plain functions (no
// context, no hooks) so the single global `<WebConnectionGuard>` can subscribe
// without threading the transport singleton through the tree.
//
// Which transport it follows:
//   1. SSR / static-export prerender (`window` undefined) → none: a stable
//      "connected", so the dialog never renders server-side and hydration
//      stays clean.
//   2. Remote-workspace desktop window → its `RemoteDesktopTransport`, whose
//      link runs through the Rust proxy. A rejected token reads as
//      "connected" here: that case belongs to the window's full-screen gate
//      (see remote-connection-context.tsx), so the two never stack.
//   3. Browser client → the `WebTransport`.
//   4. Local desktop window → none: IPC has no link to lose.
//
// The remote transport is configured after the guard has mounted (the gate
// sets it up from the URL), so subscriptions re-bind on
// `onActiveTransportChange`.

import { detectEnvironment } from "./detect"
import {
  getShellTransport,
  getTransport,
  isRemoteDesktopMode,
  onActiveTransportChange,
} from "./index"
import type {
  ConnectionHealth,
  ConnectionHealthSource,
  Transport,
} from "./types"

// Module-level constant so `getServerSnapshot` returns a STABLE reference on
// every call — React warns / loops if the server snapshot identity changes.
const CONNECTED: ConnectionHealth = "connected"

const noop = () => {}

function hasHealthSurface(
  transport: Transport
): transport is Transport & ConnectionHealthSource {
  return (
    typeof (transport as Partial<ConnectionHealthSource>)
      .subscribeConnection === "function"
  )
}

// Resolve the transport whose link the dialog follows, or null when it must
// stay dormant (SSR, local desktop). The shape check is belt-and-braces: it
// keeps a future transport swap from crashing the dialog plumbing.
function connectionSource(): ConnectionHealthSource | null {
  if (typeof window === "undefined") return null
  let transport: Transport
  if (isRemoteDesktopMode()) {
    transport = getTransport()
  } else if (detectEnvironment() === "web") {
    transport = getShellTransport()
  } else {
    return null
  }
  return hasHealthSurface(transport) ? transport : null
}

export function subscribeWebConnection(callback: () => void): () => void {
  if (typeof window === "undefined") return noop
  let unsubscribeSource = connectionSource()?.subscribeConnection(callback)
  const unsubscribeChange = onActiveTransportChange(() => {
    unsubscribeSource?.()
    unsubscribeSource = connectionSource()?.subscribeConnection(callback)
    callback()
  })
  return () => {
    unsubscribeSource?.()
    unsubscribeChange()
  }
}

export function getWebConnectionSnapshot(): ConnectionHealth {
  const state = connectionSource()?.getConnectionSnapshot() ?? CONNECTED
  // A remote window's rejected token is shown by its own full-window screen
  // (RemoteConnectionGate): the dialog stays out of the way rather than
  // stacking a second, web-only "sign in again" prompt on top of it.
  if (state === "unauthorized" && isRemoteDesktopMode()) return CONNECTED
  return state
}

export function getWebConnectionServerSnapshot(): ConnectionHealth {
  return CONNECTED
}

/** Manual "Reconnect now" from the dialog: retry at once. */
export function reconnectWebNow(): void {
  connectionSource()?.reconnectNow()
}

/**
 * Funnel a definitive HTTP 401 (e.g. from a raw file-upload fetch in
 * `lib/api.ts` that bypasses the transport's `call`) into the same
 * unauthorized handling the transport uses for its own calls, rather than an
 * abrupt redirect. No-op in a local desktop window.
 */
export function notifyWebUnauthorized(): void {
  connectionSource()?.markUnauthorized()
}
