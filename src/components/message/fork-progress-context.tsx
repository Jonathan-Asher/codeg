"use client"

import { createContext, useContext } from "react"

/**
 * The reply a "Fork from here" is running on in this transcript — the id its
 * button forks at (`source_turn_id ?? id`) — or `null` while no fork runs.
 *
 * Provided by the surface that owns the fork (`ConversationDetailPanel`) and
 * read by each reply's footer (`TurnStats`): the reply being forked shows a
 * spinner and "Forking…", every other fork button greys out until it ends.
 * Context rather than a prop so the transcript's memoized message groups don't
 * re-render for it — only the footers do.
 */
const ForkProgressContext = createContext<string | null>(null)

export const ForkProgressProvider = ForkProgressContext.Provider

export function useForkingTurnId(): string | null {
  return useContext(ForkProgressContext)
}
