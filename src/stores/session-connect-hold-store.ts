"use client"

import { create } from "zustand"

/**
 * How long a keyboard step through the sidebar's sessions has to rest before
 * the session it landed on connects its agent.
 */
export const SESSION_CONNECT_SETTLE_MS = 400

interface SessionConnectHoldState {
  /** True while sessions are being stepped through faster than they settle. */
  held: boolean
}

/**
 * Holds back the active conversation's auto-connect while the user steps
 * through the sidebar with the keyboard.
 *
 * Each step opens its session at once, so the transcript is on screen
 * immediately, but an active tab connects (spawning or attaching to the agent)
 * as soon as it becomes active. Holding the arrow chord down would then start
 * one agent per session it passes. A step re-arms the hold instead, and only
 * the session the user stops on connects, once the steps have paused for
 * {@link SESSION_CONNECT_SETTLE_MS}.
 */
export const useSessionConnectHoldStore = create<SessionConnectHoldState>()(
  () => ({ held: false })
)

let releaseTimer: ReturnType<typeof setTimeout> | null = null

/** Start (or extend) the hold; it lifts itself after `settleMs` of quiet. */
export function holdSessionConnect(
  settleMs: number = SESSION_CONNECT_SETTLE_MS
): void {
  if (releaseTimer != null) clearTimeout(releaseTimer)
  releaseTimer = setTimeout(releaseSessionConnectHold, settleMs)
  if (!useSessionConnectHoldStore.getState().held) {
    useSessionConnectHoldStore.setState({ held: true })
  }
}

/** Lift the hold now, letting the active conversation connect. */
export function releaseSessionConnectHold(): void {
  if (releaseTimer != null) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  if (useSessionConnectHoldStore.getState().held) {
    useSessionConnectHoldStore.setState({ held: false })
  }
}
