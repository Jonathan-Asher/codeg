/**
 * Which session a notification is about, and what a click on it does.
 *
 * Every notification that names a session — an OS notification, a browser
 * notification, an in-app toast — carries a {@link NotificationTarget}. A
 * click hands it to {@link openNotificationTarget} in the window that owns
 * the session (on desktop the backend brings that window forward first; see
 * `notification.rs`), which switches to the session's tab, or reopens it.
 */

import type { AgentType } from "@/lib/types"

export interface NotificationTarget {
  /**
   * The tab in the window that raised the notification — a connection's
   * context key is its tab id. Tried first: it also covers a draft that has
   * no conversation row yet. Means nothing in any other window.
   */
  contextKey: string | null
  folderId: number | null
  /** The conversation behind the tab: what survives the tab being closed, or
   *  its window being rebuilt. */
  conversationId: number | null
  agentType: AgentType | null
}

function asId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Read a target that crossed a process boundary; `null` if it names nothing. */
export function parseNotificationTarget(
  raw: unknown
): NotificationTarget | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const target: NotificationTarget = {
    contextKey: asText(r.contextKey),
    folderId: asId(r.folderId),
    conversationId: asId(r.conversationId),
    agentType: asText(r.agentType) as AgentType | null,
  }
  if (target.contextKey == null && target.conversationId == null) return null
  return target
}

/**
 * One key per session, so a newer notification about it replaces the older
 * one instead of stacking (the browser's `tag`; the desktop backend builds
 * the same identity for Notification Center).
 */
export function notificationGroupKey(
  target: NotificationTarget
): string | null {
  if (target.conversationId != null) {
    return `codeg-session-c${target.conversationId}`
  }
  if (target.contextKey) return `codeg-session-k${target.contextKey}`
  return null
}

export type NotificationOpenOutcome = "tab" | "conversation" | "missing"

/** What {@link openNotificationTarget} acts on — the workspace's stores in
 *  the app, fakes in tests. */
export interface NotificationOpenDeps {
  /** The open tab with this id, if any. */
  findTab: (tabId: string) => { conversationId: number | null } | null
  switchTab: (tabId: string) => void
  /** Whether the conversation still exists. */
  conversationExists: (conversationId: number) => Promise<boolean>
  openConversation: (
    folderId: number,
    conversationId: number,
    agentType: AgentType
  ) => void
  /** Tell the user the session is gone. */
  onMissing: () => void
}

/**
 * Bring the user to the session a notification is about.
 *
 * Its own tab first, when it is still open and still shows that session.
 * Otherwise the conversation, opened the way search opens one. A draft whose
 * tab was closed, or a conversation deleted since, is gone: the user is told
 * so.
 */
export async function openNotificationTarget(
  target: NotificationTarget,
  deps: NotificationOpenDeps
): Promise<NotificationOpenOutcome> {
  if (target.contextKey) {
    const tab = deps.findTab(target.contextKey)
    if (
      tab &&
      (target.conversationId == null ||
        tab.conversationId == null ||
        tab.conversationId === target.conversationId)
    ) {
      deps.switchTab(target.contextKey)
      return "tab"
    }
  }
  const { folderId, conversationId, agentType } = target
  if (
    folderId != null &&
    conversationId != null &&
    agentType != null &&
    (await deps.conversationExists(conversationId))
  ) {
    deps.openConversation(folderId, conversationId, agentType)
    return "conversation"
  }
  deps.onMissing()
  return "missing"
}

// ── Click dispatch ──
//
// A notification is built far from React (the ACP event pump, the platform
// layer), but opening a tab needs the workspace mounted. The workspace's
// bridge registers the handler; a click that arrives with no workspace
// mounted (a window with no tabs to open) does nothing.

type ClickHandler = (target: NotificationTarget) => void

let clickHandler: ClickHandler | null = null

/** Register what a click on a session's notification does in this window. */
export function setNotificationClickHandler(handler: ClickHandler): () => void {
  clickHandler = handler
  return () => {
    if (clickHandler === handler) clickHandler = null
  }
}

/** A notification (or toast) about `target` was clicked in this window. */
export function openNotificationTargetFromClick(
  target: NotificationTarget
): void {
  clickHandler?.(target)
}
