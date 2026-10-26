"use client"

import { createContext, useContext } from "react"

/**
 * The transcript controls whose action is waiting for the session to connect
 * (see `lib/pending-actions`), and how to take one back.
 *
 * Provided by the surface that owns the queue (`ConversationDetailPanel`) and
 * read by the controls themselves — a reply's "Fork from here", a message's
 * editor, Retry — which spin and say they are waiting meanwhile. Context
 * rather than props, like `ForkProgressContext`, so the transcript's memoized
 * message groups don't re-render for it.
 */
export interface PendingActionsValue {
  /** Targets (`forkActionTarget`, `editActionTarget`, …) with an action
   *  waiting. */
  pendingTargets: ReadonlySet<string>
  /** Take back the action waiting for `target`. */
  cancel: (target: string) => void
}

const NONE: PendingActionsValue = {
  pendingTargets: new Set<string>(),
  cancel: () => {},
}

const PendingActionsContext = createContext<PendingActionsValue>(NONE)

export const PendingActionsProvider = PendingActionsContext.Provider

export function usePendingActionsContext(): PendingActionsValue {
  return useContext(PendingActionsContext)
}
