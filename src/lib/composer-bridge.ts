"use client"

import { useCallback, useSyncExternalStore } from "react"
import type { ComposerSendRoute } from "@/lib/background-idle"
import type { PromptDraft } from "@/lib/types"

/**
 * A session's composer as seen from outside it, so another part of the window
 * can send a message the way the composer sends one, or hand it text to edit.
 * The right-hand panel's Prompts tab is the user: its prepared prompts go out
 * through here, never down a send path of their own.
 *
 * The composer (`MessageInput`) publishes its bridge under its tab's id while
 * it is on screen and takes it back when it goes, so a tab whose composer is
 * hidden (a session that takes no message, the welcome page) has none.
 */
export interface ComposerBridge {
  /**
   * Where a message sent now would go, decided exactly as for one typed and
   * sent with Enter: `send` (the session is idle), `enqueue` (a reply is
   * running, or the session is still opening — it waits in the queue above
   * the composer), `deliver` (into a turn held open only for background work).
   * `null` while the composer would refuse a send: disconnected, the session's
   * settings still loading, a delivery already in flight.
   */
  sendRoute: ComposerSendRoute | null
  /** A reply is running: an `enqueue` waits for it to end (otherwise for the
   *  session to finish opening). */
  isReplying: boolean
  /**
   * Send `text` by {@link sendRoute}, through the composer's own handlers, as
   * if it had been typed and sent: queueing, mid-turn delivery, the attention
   * bookkeeping and Talk's notes all apply. What the composer holds is left
   * alone. The route taken, or `null` when nothing was sent.
   */
  send: (text: string) => ComposerSendRoute | null
  /**
   * Put `text` in the composer to edit before sending it by hand: an empty
   * composer takes it whole; a draft keeps every word and gets it at the
   * caret, on a line of its own. The composer takes focus. False when there
   * was no editor to put it in.
   */
  insert: (text: string) => boolean
}

const bridges = new Map<string, ComposerBridge>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Publish `bridge` as the composer of `key` (a tab id), replacing what was
 * there. The returned function takes it back, unless another composer has
 * published under the key since (a remount whose new copy came up first).
 */
export function registerComposerBridge(
  key: string,
  bridge: ComposerBridge
): () => void {
  bridges.set(key, bridge)
  notify()
  return () => {
    if (bridges.get(key) !== bridge) return
    bridges.delete(key)
    notify()
  }
}

/** The composer published under `key`, if one is on screen. */
export function getComposerBridge(
  key: string | null | undefined
): ComposerBridge | null {
  return key ? (bridges.get(key) ?? null) : null
}

/** {@link getComposerBridge}, kept current as composers come and go and as
 *  their send route changes. */
export function useComposerBridge(
  key: string | null | undefined
): ComposerBridge | null {
  const read = useCallback(() => getComposerBridge(key), [key])
  return useSyncExternalStore(subscribe, read, () => null)
}

/** The draft a plain-text message is sent as: what the composer builds for
 *  the same words typed into it. Trimmed like a typed message. */
export function textPromptDraft(text: string): PromptDraft {
  const trimmed = text.trim()
  return { blocks: [{ type: "text", text: trimmed }], displayText: trimmed }
}

/** Test seam: forget every published composer. */
export function resetComposerBridgesForTests(): void {
  bridges.clear()
  notify()
}
