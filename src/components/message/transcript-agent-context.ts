"use client"

import { createContext, useContext } from "react"

import type { AgentType } from "@/lib/types"

/**
 * The agent whose transcript is on screen, provided once by whatever renders
 * one (`MessageListView`, the sub-agent session drawer) and read by the cards
 * deep inside it that open one of its sub-agents' sessions: a child is a
 * session of its parent's own kind, and the card itself does not know which.
 *
 * `null` with no provider above (an embed, a component test); the caller picks
 * its own fallback.
 */
const TranscriptAgentTypeContext = createContext<AgentType | null>(null)

export const TranscriptAgentTypeProvider = TranscriptAgentTypeContext.Provider

export function useTranscriptAgentType(): AgentType | null {
  return useContext(TranscriptAgentTypeContext)
}
