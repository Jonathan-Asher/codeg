"use client"

import { create } from "zustand"

/**
 * State the Quick Ask shell (outside the remote-connection gate) shares with
 * the window inside it: whether a question is on screen, and a backend switch
 * that has to wait until it is cleared.
 */
interface QuickAskWindowState {
  /** A question (and possibly its answer) is on screen. */
  hasContent: boolean
  /** Route of the backend the user moved to while a question was open. */
  pendingRoute: string | null
  setHasContent: (value: boolean) => void
  setPendingRoute: (route: string | null) => void
}

export const useQuickAskWindowState = create<QuickAskWindowState>((set) => ({
  hasContent: false,
  pendingRoute: null,
  setHasContent: (hasContent) => set({ hasContent }),
  setPendingRoute: (pendingRoute) => set({ pendingRoute }),
}))

export type BackendSwitch = "stay" | "navigate" | "defer"

/**
 * The window follows the workspace the user was last in (local or a remote
 * workspace), so questions run where their projects live. Moving an open
 * question to another server is impossible, though, so a switch waits for
 * "New question" while one is on screen.
 */
export function decideBackendSwitch(args: {
  current: number | null
  wanted: number | null
  hasContent: boolean
}): BackendSwitch {
  if (args.current === args.wanted) return "stay"
  return args.hasContent ? "defer" : "navigate"
}

/** The remote connection id this page was loaded for (`null` = local). */
export function currentRemoteConnectionId(search: string): number | null {
  const raw = new URLSearchParams(search).get("remoteConnectionId")
  if (!raw) return null
  const id = Number(raw)
  return Number.isFinite(id) ? id : null
}

/** Browser-side event the shell fires each time the window is shown. */
export const QUICK_ASK_FOCUS_INPUT_EVENT = "codeg:quick-ask-focus-input"
