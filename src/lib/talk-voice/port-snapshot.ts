/**
 * The session as Talk's helper sees it (`TalkPort`), read from the tab's
 * connection, and what changed since it was last told.
 *
 * The cards pass through as the server sends them (snake_case); the helper
 * reads them as the iPhone does. A card that went away is sent as `null`.
 */

import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { TalkPort } from "./protocol"

/** The port for a connection (none yet: an idle, empty session). */
export function portSnapshot(
  conn: ConnectionState | undefined,
  title: string | null
): TalkPort {
  const prompting = conn?.status === "prompting"
  return {
    title,
    canInsertIntoTurn: prompting && conn?.nativeSteering === true,
    isInFlight: prompting,
    awaitingBackground: prompting && conn?.awaitingBackground === true,
    backgroundOutstanding: conn?.backgroundOutstanding ?? 0,
    pendingPermission: conn?.pendingPermission ?? null,
    pendingQuestion: conn?.pendingAskQuestion ?? null,
    pendingPlanApproval: conn?.pendingPlanApproval ?? null,
  }
}

const CARD_ID = {
  pendingPermission: (port: TalkPort) =>
    port.pendingPermission?.request_id ?? null,
  pendingQuestion: (port: TalkPort) =>
    port.pendingQuestion?.question_id ?? null,
  pendingPlanApproval: (port: TalkPort) =>
    port.pendingPlanApproval?.approval_id ?? null,
} as const

/**
 * The fields of `next` that differ from `prev` (all of them without a
 * `prev`), or null when nothing did. A card counts as changed when its id
 * did or its content did (a permission's queue depth, say).
 */
export function portChanges(
  prev: TalkPort | null,
  next: TalkPort
): Partial<TalkPort> | null {
  if (!prev) return { ...next }
  const changes: Partial<TalkPort> = {}
  if (prev.title !== next.title) changes.title = next.title
  if (prev.canInsertIntoTurn !== next.canInsertIntoTurn) {
    changes.canInsertIntoTurn = next.canInsertIntoTurn
  }
  if (prev.isInFlight !== next.isInFlight) changes.isInFlight = next.isInFlight
  if (prev.awaitingBackground !== next.awaitingBackground) {
    changes.awaitingBackground = next.awaitingBackground
  }
  if (prev.backgroundOutstanding !== next.backgroundOutstanding) {
    changes.backgroundOutstanding = next.backgroundOutstanding
  }
  for (const key of Object.keys(CARD_ID) as (keyof typeof CARD_ID)[]) {
    const before = prev[key]
    const after = next[key]
    if (before === after) continue
    if (
      CARD_ID[key](prev) !== CARD_ID[key](next) ||
      JSON.stringify(before) !== JSON.stringify(after)
    ) {
      Object.assign(changes, { [key]: after })
    }
  }
  return Object.keys(changes).length > 0 ? changes : null
}
