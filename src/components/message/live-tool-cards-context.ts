"use client"

import { createContext, useContext } from "react"

import {
  BACKGROUND_JOB_META_KEY,
  SUBAGENT_RUN_META_KEY,
} from "@/lib/agent-run-meta"

/**
 * The latest card of each Pi sub-agent run and background job on the live
 * connection, by the call that started it (`tool_card` events and the
 * snapshot's `tool_cards`, `acp::pi_meta`): the card's `_meta` in the shape
 * the history parser writes (`codeg.subagentRun`, `codeg.backgroundJob`).
 *
 * A run outlives the turn that launched it, so its card keeps changing after
 * the call has been promoted, or replaced by the transcript's copy, which
 * only knows what was written before. The cards read their `_meta` through
 * {@link useToolCardMeta}, so the same renderer draws a call streaming in, the
 * same call in an earlier turn, and the same call after a reload.
 *
 * Provided by `MessageListView`; `null` with no live connection above.
 */
export type LiveToolCards = ReadonlyMap<string, Record<string, unknown>>

const LiveToolCardsContext = createContext<LiveToolCards | null>(null)

export const LiveToolCardsProvider = LiveToolCardsContext.Provider

type CardKey = typeof SUBAGENT_RUN_META_KEY | typeof BACKGROUND_JOB_META_KEY

const SETTLED: Record<CardKey, ReadonlySet<string>> = {
  [SUBAGENT_RUN_META_KEY]: new Set([
    "completed",
    "failed",
    "paused",
    "stopped",
  ]),
  [BACKGROUND_JOB_META_KEY]: new Set([
    "completed",
    "failed",
    "killed",
    "unknown",
  ]),
}

/** Whether `meta` holds the transcript's card (no `live` mark) for a run or
 *  job the transcript has seen end. */
function settledInTranscript(
  meta: Record<string, unknown> | null | undefined,
  key: CardKey
): boolean {
  const card = meta?.[key]
  if (!card || typeof card !== "object" || Array.isArray(card)) return false
  const record = card as Record<string, unknown>
  if (record.live === true) return false
  const state = key === SUBAGENT_RUN_META_KEY ? record.status : record.state
  return typeof state === "string" && SETTLED[key].has(state)
}

/**
 * The `_meta` a run's or job's card draws from: the call's own, or the live
 * connection's newest card for it.
 *
 * The live card wins while the run is going — the transcript can only say
 * it was launched — and over any copy of a live card the call carries (the
 * connection's is always the newest). Once the transcript has the run's end,
 * its own card wins: it is what every reload draws, read from the same notices
 * plus what only the transcript keeps (each child's usage, a lane's result),
 * so the card ends exactly as history shows it.
 */
export function useToolCardMeta<T extends Record<string, unknown>>(
  toolCallId: string | undefined,
  own: T | null | undefined,
  key: CardKey
): Record<string, unknown> | T | null | undefined {
  const cards = useContext(LiveToolCardsContext)
  if (!cards || !toolCallId) return own
  const live = cards.get(toolCallId)
  if (!live || settledInTranscript(own, key)) return own
  return live
}
