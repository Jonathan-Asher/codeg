import type { DbConversationSummary } from "@/lib/types"
import {
  matchShortcutEvent,
  type ShortcutSettings,
} from "@/lib/keyboard-shortcuts"
import {
  flatIndexOfConversation,
  type SidebarRow,
} from "./sidebar-conversation-grouping"

/** 1 = the next session down the list, -1 = the previous one. */
export type SessionNavDirection = 1 | -1

/** The session the active tab shows, as the sidebar identifies it. */
export interface SessionNavSelection {
  id: number
  agentType: string
}

/**
 * The row a step landed on. A session can be listed twice — in its folder and
 * again under Recent — and the next step has to continue from the copy the
 * user is on, not jump back to the other one.
 */
export interface SessionNavAnchor {
  id: number
  agentType: string
  recent: boolean
  /** Its position when it was chosen; rows can move under it before the next
   *  step, so this only breaks ties between copies. */
  index: number
}

export interface SessionNavStep {
  index: number
  conversation: DbConversationSummary
  anchor: SessionNavAnchor
}

type ConversationRowOf = Extract<SidebarRow, { kind: "conversation" }>

function isSession(
  row: SidebarRow,
  selection: SessionNavSelection
): row is ConversationRowOf {
  return (
    row.kind === "conversation" &&
    row.conversation.id === selection.id &&
    row.conversation.agent_type === selection.agentType
  )
}

/**
 * Where `anchor`'s row is now: the same copy (Recent or not) of the same
 * session, nearest to where it was. -1 when that copy is no longer listed.
 */
export function findAnchorRow(
  rows: readonly SidebarRow[],
  anchor: SessionNavAnchor
): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!isSession(row, anchor)) continue
    if (Boolean(row.recent) !== anchor.recent) continue
    const distance = Math.abs(i - anchor.index)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/**
 * The row the active session is shown in, or -1 when none on screen shows it
 * (a draft tab, or a session inside a collapsed folder or group).
 */
export function currentSessionRow(
  rows: readonly SidebarRow[],
  selection: SessionNavSelection | null,
  anchor: SessionNavAnchor | null
): number {
  if (!selection) return -1
  if (
    anchor &&
    anchor.id === selection.id &&
    anchor.agentType === selection.agentType
  ) {
    const index = findAnchorRow(rows, anchor)
    if (index >= 0) return index
  }
  return flatIndexOfConversation(rows, selection.id, selection.agentType)
}

/**
 * The session one step from the active one, in the order the sidebar lists
 * them. `rows` is what is on screen: sections, groups and folders that are
 * collapsed contribute only their header, and sessions folded behind a
 * "Show N more" row are not in it, so neither is ever stepped into.
 *
 * - Another copy of the active session (its Recent row) is passed over, so
 *   every step changes the session.
 * - The list does not wrap: past the first or last session there is no step.
 * - With nothing on screen selected, the first step enters the list at the
 *   top going down, or at the bottom going up.
 */
export function stepSession(
  rows: readonly SidebarRow[],
  selection: SessionNavSelection | null,
  direction: SessionNavDirection,
  anchor: SessionNavAnchor | null
): SessionNavStep | null {
  const current = currentSessionRow(rows, selection, anchor)
  let index =
    current >= 0 ? current + direction : direction === 1 ? 0 : rows.length - 1
  for (; index >= 0 && index < rows.length; index += direction) {
    const row = rows[index]
    if (row.kind !== "conversation") continue
    if (selection && isSession(row, selection)) continue
    return {
      index,
      conversation: row.conversation,
      anchor: {
        id: row.conversation.id,
        agentType: row.conversation.agent_type,
        recent: Boolean(row.recent),
        index,
      },
    }
  }
  return null
}

/** Which way the event steps, or null when it is not a session-step chord. */
export function sessionNavDirection(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  > & { code?: string },
  shortcuts: Pick<ShortcutSettings, "next_session" | "prev_session">
): SessionNavDirection | null {
  if (matchShortcutEvent(event, shortcuts.next_session)) return 1
  if (matchShortcutEvent(event, shortcuts.prev_session)) return -1
  return null
}

const TERMINAL_SELECTOR = '[data-terminal-panel-region="true"], .xterm'
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'

/**
 * Whether the chord belongs to something other than the sidebar: a terminal
 * (where it is the shell's), or a dialog or menu that is open over the window.
 *
 * `sidebar` is the sidebar's own element. An overlay that contains it — the
 * drawer the sidebar lives in on narrow windows — is the sidebar itself, not
 * something covering it.
 */
export function isSessionNavBlocked(
  target: EventTarget | null,
  doc: Document,
  sidebar: Element | null
): boolean {
  const hostsSidebar = (overlay: Element) =>
    sidebar != null && overlay.contains(sidebar)
  if (target instanceof Element) {
    if (target.closest(TERMINAL_SELECTOR)) return true
    const overlay = target.closest(OVERLAY_SELECTOR)
    if (overlay && !hostsSidebar(overlay)) return true
  }
  for (const overlay of doc.querySelectorAll(OPEN_OVERLAY_SELECTOR)) {
    if (!hostsSidebar(overlay)) return true
  }
  return false
}

/**
 * How to scroll a row into view, or null when it is already in full view.
 * `topInset` is the height of the folder header that sticks over the top of
 * the list: a row scrolled to the very top would sit under it, hidden.
 */
export function sessionRowScroll(args: {
  itemOffset: number
  itemSize: number
  scrollOffset: number
  viewportSize: number
  topInset: number
}): { align: "start"; offset: number } | { align: "end" } | null {
  const { itemOffset, itemSize, scrollOffset, viewportSize, topInset } = args
  if (itemOffset < scrollOffset + topInset) {
    return { align: "start", offset: -topInset }
  }
  if (itemOffset + itemSize > scrollOffset + viewportSize) {
    return { align: "end" }
  }
  return null
}
