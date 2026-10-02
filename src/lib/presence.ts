/**
 * This window's presence: whether the user is looking at it, and at which
 * session (Rust `crate::presence`).
 *
 * The backend only counts a client as "someone is looking" while its latest
 * report says visible AND focused and the user touched it recently — an open
 * connection alone means nothing. That decides whether a critical alert also
 * goes to the chat channels, and whether a push is sent to the iPhone ("only
 * when away"), and nothing is pushed about the session a looking window
 * shows.
 *
 * Reports go out on every change and at least every {@link HEARTBEAT_MS}; a
 * window that stops reporting (a laptop asleep with its socket half-open)
 * goes stale on the backend after 90 s.
 */

import {
  getShellTransport,
  getTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "./transport"
import type { ClientPresence } from "./transport/types"

export type { ClientPresence }

/** Resend at least this often while the window lives. */
export const HEARTBEAT_MS = 30_000

/** Idle at least this long, the next touch is reported at once. */
const IDLE_REPORT_SECS = 60

function samePresence(a: ClientPresence | null, b: ClientPresence): boolean {
  if (!a) return false
  return (
    a.visible === b.visible &&
    a.focused === b.focused &&
    a.conversation_ids.length === b.conversation_ids.length &&
    a.conversation_ids.every((id, i) => id === b.conversation_ids[i])
  )
}

/** Hand one report to every backend that decides about this window. */
function deliver(presence: ClientPresence): void {
  // The event socket of a browser or remote-desktop window.
  getTransport().reportPresence?.(presence)
  if (!isDesktop()) return
  // The desktop app's own backend, which runs the alerts for its local
  // sessions. A remote window's session ids belong to the remote server, so
  // the local backend only learns that the user is at this machine.
  const local = isRemoteDesktopMode()
    ? { ...presence, conversation_ids: [] }
    : presence
  void getShellTransport()
    .call("report_client_presence", { presence: local })
    .catch(() => {
      // An older desktop backend without the command: nothing to tell.
    })
}

export interface PresenceSource {
  /** The sessions this window shows right now. */
  conversationIds(): number[]
  /** Call `onChange` when they change; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void
}

// The sessions this window shows, set by the workspace (which owns the tab
// store) — kept here so the reporter, mounted for every window, does not pull
// the workspace stores into pages that have none.
let shownIds: number[] = []
const shownListeners = new Set<() => void>()

export function setShownConversations(ids: number[]): void {
  if (
    ids.length === shownIds.length &&
    ids.every((id, i) => id === shownIds[i])
  ) {
    return
  }
  shownIds = [...ids]
  for (const listener of shownListeners) listener()
}

export const shownConversations: PresenceSource = {
  conversationIds: () => shownIds,
  subscribe: (onChange) => {
    shownListeners.add(onChange)
    return () => {
      shownListeners.delete(onChange)
    }
  },
}

/**
 * Report this window's presence until the returned stop function runs.
 * `send` is the delivery seam for tests.
 */
export function startPresenceReporting(
  source: PresenceSource,
  send: (presence: ClientPresence) => void = deliver
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {}
  }
  let lastInput = Date.now()
  let lastSent: ClientPresence | null = null

  const current = (): ClientPresence => ({
    visible: document.visibilityState === "visible",
    focused: typeof document.hasFocus === "function" && document.hasFocus(),
    idle_secs: Math.max(0, Math.floor((Date.now() - lastInput) / 1000)),
    conversation_ids: source.conversationIds(),
  })

  const report = (force: boolean) => {
    const next = current()
    if (!force && samePresence(lastSent, next)) return
    lastSent = next
    send(next)
  }

  const onInput = () => {
    const wasIdleSecs = (Date.now() - lastInput) / 1000
    lastInput = Date.now()
    if (wasIdleSecs >= IDLE_REPORT_SECS) report(true)
  }
  const onChange = () => report(false)

  const inputEvents = ["pointerdown", "keydown", "wheel", "touchstart"]
  for (const name of inputEvents) {
    window.addEventListener(name, onInput, { capture: true, passive: true })
  }
  // Moving the mouse counts too, but only to stamp the time: cheap.
  window.addEventListener("pointermove", onInput, {
    capture: true,
    passive: true,
  })
  window.addEventListener("focus", onChange)
  window.addEventListener("blur", onChange)
  document.addEventListener("visibilitychange", onChange)
  const unsubscribe = source.subscribe(onChange)
  const heartbeat = window.setInterval(() => report(true), HEARTBEAT_MS)
  report(true)

  return () => {
    for (const name of inputEvents) {
      window.removeEventListener(name, onInput, { capture: true })
    }
    window.removeEventListener("pointermove", onInput, { capture: true })
    window.removeEventListener("focus", onChange)
    window.removeEventListener("blur", onChange)
    document.removeEventListener("visibilitychange", onChange)
    unsubscribe()
    window.clearInterval(heartbeat)
  }
}
