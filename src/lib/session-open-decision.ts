/**
 * Where a session picked in the sidebar or the ⌘K switcher opens: in the tab
 * that already holds it, in place of the tab in front, or as before (a sidebar
 * click previews, the switcher opens a tab of its own).
 *
 * Pure, so every rule is tested without a store: the caller reads the tab in
 * front into a {@link CurrentTabState} and carries out what comes back.
 */

/** The setting "When you open a session". */
export const SESSION_OPEN_MODES = ["smart", "new_tab", "replace"] as const
export type SessionOpenMode = (typeof SESSION_OPEN_MODES)[number]
export const DEFAULT_SESSION_OPEN_MODE: SessionOpenMode = "smart"

/**
 * What the gesture itself asked for, over the setting: a plain click or Enter
 * (`auto`), a modifier for a new tab, or one for this tab (and the switcher's
 * "switch this tab" mode).
 */
export type SessionOpenIntent = "auto" | "new_tab" | "replace"

/** How long a tab he sent a message from still counts as one he works in. */
export const RECENT_SEND_WINDOW_MS = 10 * 60_000

/** The tab in front, as far as the decision cares. */
export interface CurrentTabState {
  tabId: string
  /** A session, an unsent draft, or a sub-agent's read-only thread. */
  kind: "conversation" | "draft" | "subagent"
  /** Pinned to the start of the strip ("Pin tab"). */
  anchored: boolean
  /** Its composer holds something: text (saved or still being typed), an
   *  attachment, or a file on its way in. */
  composerHasContent: boolean
  /** An "Edit message" editor is open on one of its earlier messages: its
   *  text lives only in the view, which showing another session unmounts. */
  messageEditOpen: boolean
  /** Messages wait in its queue. */
  queued: boolean
  /** A turn is running, or background work the session started. */
  working: boolean
  /** It waits on the user: a permission, a question, a plan to approve. */
  waitingOnUser: boolean
  /** When he last sent a message from this tab (ms), or null. */
  lastSentAt: number | null
  /** The session can take its slot: while tabs follow the folder, only one of
   *  the same folder can (the slot belongs to that folder's tab view). */
  sameScope: boolean
}

export type SessionOpenDecision =
  /** Already open: bring that tab to the front. */
  | { action: "switch"; tabId: string }
  /** Load the session into this tab, in its slot and group. */
  | { action: "replace"; tabId: string }
  /** A tab of its own, kept (not a preview). */
  | { action: "new_tab" }
  /** As before: a sidebar click previews, the switcher opens a kept tab. */
  | { action: "default" }

/**
 * "Just looking": nothing in the tab in front would be lost or interrupted by
 * showing another session there. All of it must hold: a session (or an empty
 * draft), not pinned, nothing running or waiting on him, an empty composer
 * with nothing queued and no message being edited, and no message sent from
 * it in the last ten minutes.
 */
export function isJustLooking(tab: CurrentTabState, now: number): boolean {
  if (tab.kind === "subagent") return false
  if (tab.anchored || !tab.sameScope) return false
  if (tab.composerHasContent || tab.queued || tab.messageEditOpen) return false
  if (tab.working || tab.waitingOnUser) return false
  if (tab.lastSentAt != null && now - tab.lastSentAt < RECENT_SEND_WINDOW_MS) {
    return false
  }
  return true
}

/**
 * Whether an explicit "this tab" may take the tab in front. A running turn is
 * no obstacle — replacing never stops it, the session goes on in the
 * background — but a pinned tab is never replaced, and neither is one whose
 * composer holds something that could be lost with it (an attachment is never
 * saved), whose queue still waits to go out, or with a message being edited
 * (that text is saved nowhere).
 */
export function canReplaceTab(tab: CurrentTabState): boolean {
  return (
    !tab.anchored &&
    tab.sameScope &&
    !tab.composerHasContent &&
    !tab.queued &&
    !tab.messageEditOpen
  )
}

export interface SessionOpenInput {
  /** The tab already holding the session, if any. */
  openTabId: string | null
  /** The tab in front, or null when there is none (no conversation tab). */
  current: CurrentTabState | null
  intent: SessionOpenIntent
  mode: SessionOpenMode
  now: number
}

/**
 * - Open already: switch to it, whatever was asked (a session has one tab).
 * - An explicit new tab: a kept tab of its own.
 * - "This tab" (asked for, or the setting): in place of the tab in front when
 *   it may be replaced, else a new tab — a pinned tab is never replaced.
 * - Smart (the default setting): in place of the tab in front when he is just
 *   looking at it, else as before.
 * - The setting "Always a new tab": as before.
 */
export function decideSessionOpen({
  openTabId,
  current,
  intent,
  mode,
  now,
}: SessionOpenInput): SessionOpenDecision {
  if (openTabId != null) return { action: "switch", tabId: openTabId }
  if (intent === "new_tab") return { action: "new_tab" }
  const wanted = intent === "replace" ? "replace" : mode
  if (wanted === "new_tab") return { action: "default" }
  if (wanted === "replace") {
    if (!current) return { action: "default" }
    return canReplaceTab(current)
      ? { action: "replace", tabId: current.tabId }
      : { action: "new_tab" }
  }
  if (current && isJustLooking(current, now)) {
    return { action: "replace", tabId: current.tabId }
  }
  return { action: "default" }
}

/** The intent a click or an Enter spells with its modifiers: ⌘ (Ctrl
 *  elsewhere) for a new tab, ⌥ (Alt) for this tab. */
export function intentFromModifiers(event: {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): SessionOpenIntent {
  if (event.metaKey || event.ctrlKey) return "new_tab"
  if (event.altKey) return "replace"
  return "auto"
}
