"use client"

import { createContext, useContext } from "react"

/**
 * The conversation (its DB row) whose transcript is on screen, provided by
 * `MessageListView` and read by the Agent cards inside it that open one of the
 * session's Claude Code sub-agents in a tab of its own (`openSubagentTab`).
 * A sub-agent's tab provides its session's id, so a card nested in that
 * thread opens beside it too.
 *
 * `null` with no provider above, or for a draft that has no row yet.
 */
const TranscriptConversationContext = createContext<number | null>(null)

export const TranscriptConversationProvider =
  TranscriptConversationContext.Provider

export function useTranscriptConversationId(): number | null {
  return useContext(TranscriptConversationContext)
}
