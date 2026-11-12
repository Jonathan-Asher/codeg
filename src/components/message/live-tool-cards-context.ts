"use client"

import { createContext, useContext } from "react"

/**
 * The latest card of each Pi sub-agent run and background job on the live
 * connection, by the call that started it (`tool_card` events and the
 * snapshot's `tool_cards`, `acp::pi_meta`): the card's `_meta` in the shape
 * the history parser writes (`codeg.subagentRun`, `codeg.backgroundJob`).
 *
 * A run outlives the turn that launched it, so its card keeps changing after
 * the call has been promoted, or replaced by the transcript's copy, which
 * only knows what was written before. The cards read this first and fall back
 * to their own `_meta`, so the same renderer draws a call streaming in, the
 * same call in an earlier turn, and the same call after a reload.
 *
 * Provided by `MessageListView`; `null` with no live connection above.
 */
export type LiveToolCards = ReadonlyMap<string, Record<string, unknown>>

const LiveToolCardsContext = createContext<LiveToolCards | null>(null)

export const LiveToolCardsProvider = LiveToolCardsContext.Provider

/** The live card `_meta` of call `toolCallId`, else `fallback`. */
export function useToolCardMeta<T extends Record<string, unknown>>(
  toolCallId: string | undefined,
  fallback: T | null | undefined
): Record<string, unknown> | T | null | undefined {
  const cards = useContext(LiveToolCardsContext)
  if (!cards || !toolCallId) return fallback
  return cards.get(toolCallId) ?? fallback
}
