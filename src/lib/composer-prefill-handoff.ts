import type { AgentType } from "@/lib/types"

/**
 * Hand a draft tab's composer some text (and files) to start from, WITHOUT
 * sending it — "Start a new session from this" on a session whose history is
 * gone parks its saved text here, for the new conversation's panel to put in
 * its composer. The person reads it, edits it, and sends it when they choose.
 *
 * The same shape as the "ask about this selection" hand-off
 * (`ask-selection-handoff.ts`), for the same reasons: the target draft tab may
 * still be mounting (so it drains on mount), or may be mounted already (each
 * split group reuses one draft tab — hence the event), and only the tab the
 * text was meant for may take it. Unlike a parked prompt, a prefill is one
 * slot per tab: a second one replaces the first rather than queueing behind
 * it, since a composer holds one draft.
 */

export const COMPOSER_PREFILL_PARKED_EVENT = "codeg:composer-prefill-parked"

export interface ComposerPrefillParkedDetail {
  /** Draft tab the prefill was parked for. */
  tabId: string
}

export interface ParkedComposerPrefill {
  /** What goes in the composer. */
  text: string
  /** Files attached next to it, by their path on the machine the agent runs
   *  on. */
  files?: string[]
  /**
   * The state the target tab must be in before this may be taken — what
   * `openNewConversationTab` reported it would end up as. Reusing a draft of
   * another folder or agent retargets it asynchronously; taking the text
   * before that lands would leave it in the composer of the old one.
   */
  agentType: AgentType
  folderId: number
}

const parked = new Map<string, ParkedComposerPrefill>()

/** Park `entry` for `tabId` (replacing anything parked there before) and nudge
 *  its panel if it is already mounted. */
export function parkComposerPrefill(
  tabId: string,
  entry: ParkedComposerPrefill
): void {
  parked.set(tabId, entry)
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<ComposerPrefillParkedDetail>(
      COMPOSER_PREFILL_PARKED_EVENT,
      { detail: { tabId } }
    )
  )
}

/**
 * Take what is parked for `tabId` once the tab is in the state it was parked
 * for. Null when nothing is parked, or the tab has not got there yet — the
 * caller asks again when its agent or folder changes, which is when a pending
 * retarget lands.
 */
export function takeComposerPrefill(
  tabId: string,
  state: { agentType: AgentType; folderId: number }
): ParkedComposerPrefill | null {
  const entry = parked.get(tabId)
  if (!entry) return null
  if (entry.agentType !== state.agentType || entry.folderId !== state.folderId)
    return null
  parked.delete(tabId)
  return entry
}

/** Drop what is parked for a tab whose panel is going away for good. */
export function discardComposerPrefill(tabId: string): void {
  parked.delete(tabId)
}

/** Test seam: drop everything still parked. */
export function resetComposerPrefillsForTests(): void {
  parked.clear()
}
