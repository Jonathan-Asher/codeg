import { getTransport, onActiveTransportChange } from "./index"
import type { Transport } from "./types"

/**
 * Which views have a turn streaming in front of the user, so the transport
 * can watch its link more closely meanwhile (see `liveness.ts`). A view
 * reports under its own key; the transport hears one boolean: some view
 * streams AND the page is visible. A hidden page needs no fast detection —
 * the wake check covers its return.
 */

const streamingKeys = new Set<string>()
let applied: { transport: Transport; streaming: boolean } | null = null
let listening = false

function pageVisible(): boolean {
  return typeof document === "undefined"
    ? true
    : document.visibilityState === "visible"
}

function apply() {
  const transport = getTransport()
  const streaming = streamingKeys.size > 0 && pageVisible()
  if (applied?.transport === transport && applied.streaming === streaming) {
    return
  }
  applied = { transport, streaming }
  transport.setStreamingOnScreen?.(streaming)
}

function listen() {
  if (listening || typeof document === "undefined") return
  listening = true
  document.addEventListener("visibilitychange", apply)
  // A remote window binds its transport after the views mount.
  onActiveTransportChange(apply)
}

export function setStreamingOnScreen(key: string, streaming: boolean): void {
  if (streaming) streamingKeys.add(key)
  else streamingKeys.delete(key)
  // A hint for the heartbeat: never worth breaking the view that gives it.
  try {
    listen()
    apply()
  } catch (err) {
    console.debug("[streaming-on-screen] not applied:", err)
  }
}
