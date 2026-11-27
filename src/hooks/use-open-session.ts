"use client"

import { useCallback } from "react"
import type { ConnectionStoreApi } from "@/contexts/acp-connections-context"
import { useOptionalConnectionStore } from "@/contexts/acp-connection-contexts"
import { useTabActions } from "@/contexts/tab-context"
import {
  buildConversationDraftStorageKey,
  buildNewConversationDraftStorageKey,
  hasLiveComposerContent,
  loadMessageInputDraftV2,
} from "@/lib/message-input-draft"
import { hasOpenMessageEdit } from "@/lib/open-message-edits"
import { loadOutbox, outboxStorageKey } from "@/lib/outbox-storage"
import { deriveSessionActivity } from "@/lib/session-activity"
import {
  decideSessionOpen,
  type CurrentTabState,
  type SessionOpenDecision,
  type SessionOpenIntent,
} from "@/lib/session-open-decision"
import { lastTabSendAt } from "@/lib/tab-send-recency"
import type { AgentType } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationAttentionStore } from "@/stores/conversation-attention-store"
import { useConversationBackgroundStore } from "@/stores/conversation-background-store"
import { folderScope, useFolderTabsStore } from "@/stores/folder-tabs-store"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import { isDraftTab, useTabStore, type TabItem } from "@/stores/tab-store"

/** The session being opened. */
export interface SessionOpenTarget {
  id: number
  folderId: number
  agentType: AgentType
}

/** Where the pick was made: a sidebar row previews by default, the ⌘K
 *  switcher opens a tab that stays. */
export type SessionOpenSource = "sidebar" | "switcher"

type ConnectionReader = Pick<ConnectionStoreApi, "getConnection"> | null

/**
 * How long after a click showed a session in place of the tab in front a
 * double-click on the same row still takes that back. The double-click itself
 * comes within the system's double-click time of its first click; this only
 * bounds how stale the remembered replacement may be. Taking it back too late
 * costs nothing: it is what a double-click always did.
 */
export const KEEP_UNDO_WINDOW_MS = 2_000

/** The latest replacement the Smart rule made (not one asked for), for
 *  {@link useKeepOpenedSession}. */
let lastSmartReplace: {
  id: number
  agentType: AgentType
  at: number
} | null = null

export function resetOpenSessionForTests(): void {
  lastSmartReplace = null
}

/** The composer key a conversation-strip tab keeps its draft and outbox
 *  under; a sub-agent's read-only thread has none. */
function composerKeyOf(tab: TabItem): string | null {
  if (tab.kind === "subagent") return null
  return tab.conversationId != null
    ? buildConversationDraftStorageKey(tab.conversationId)
    : buildNewConversationDraftStorageKey(tab.id)
}

/**
 * Everything about the tab in front that the open rule weighs, read from the
 * stores as they are now: the review state and turn state of its session,
 * this client's live connection to it (first-hand, so a turn streaming here
 * counts before the server says so), what waits on the user, its composer,
 * draft and queue, a message being edited, and when he last sent from it.
 */
export function readCurrentTabState(
  tab: TabItem,
  target: Pick<SessionOpenTarget, "folderId">,
  connections: ConnectionReader
): CurrentTabState {
  const kind =
    tab.kind === "subagent"
      ? "subagent"
      : isDraftTab(tab)
        ? "draft"
        : "conversation"
  const key = composerKeyOf(tab)
  const composerHasContent =
    key != null &&
    (loadMessageInputDraftV2(key) != null || hasLiveComposerContent(key))
  const queued = key != null && loadOutbox(outboxStorageKey(key)) != null
  const connection = connections?.getConnection(tab.id)
  const id = tab.conversationId
  const summary =
    id == null
      ? undefined
      : (useAppWorkspaceStore
          .getState()
          .conversations.find((c) => c.id === id) ??
        useTabStore.getState().childSummaries.get(id))
  const attention =
    id == null
      ? undefined
      : useConversationAttentionStore.getState().byConversationId.get(id)
  const background =
    id == null
      ? undefined
      : useConversationBackgroundStore.getState().byConversationId.get(id)
  const activity = deriveSessionActivity({
    attention,
    turnState: summary?.turn_state,
    status: summary?.status,
    connectionStatus: connection?.status ?? null,
    awaitingBackground: connection?.awaitingBackground === true,
    background,
  })
  const followsFolder = useFolderTabsStore.getState().enabled
  return {
    tabId: tab.id,
    kind,
    anchored: tab.isAnchored === true,
    composerHasContent,
    messageEditOpen: hasOpenMessageEdit(tab.id),
    queued,
    working:
      activity === "working" ||
      activity === "background" ||
      connection?.status === "prompting",
    waitingOnUser:
      activity === "needs_you" ||
      connection?.pendingPermission != null ||
      connection?.pendingQuestion != null,
    lastSentAt: lastTabSendAt(tab.id),
    sameScope:
      !followsFolder ||
      folderScope(tab.folderId) === folderScope(target.folderId),
  }
}

/**
 * Opens a session picked in the sidebar or the ⌘K switcher where the "When you
 * open a session" rule says (see `lib/session-open-decision`): the tab that
 * holds it, in place of the tab in front, or as before. Only these two pickers
 * use it; notification clicks, deep links, forks and automations open as they
 * always have.
 */
export function useOpenSession(): (
  target: SessionOpenTarget,
  options: { source: SessionOpenSource; intent?: SessionOpenIntent }
) => SessionOpenDecision {
  const { openTab, replaceTabWithConversation } = useTabActions()
  const connections = useOptionalConnectionStore()
  return useCallback(
    (target, { source, intent = "auto" }) => {
      const arrange = useTabArrangeStore.getState()
      arrange.hydrate()
      const mode = useTabArrangeStore.getState().sessionOpenMode
      const st = useTabStore.getState()
      const open = st.rawTabs.find(
        (tab) =>
          tab.conversationId === target.id && tab.agentType === target.agentType
      )
      const front = st.rawTabs.find((tab) => tab.id === st.activeTabId) ?? null
      const decision = decideSessionOpen({
        openTabId: open?.id ?? null,
        current: front ? readCurrentTabState(front, target, connections) : null,
        intent,
        mode,
        now: Date.now(),
      })
      const keep = source === "switcher"
      // A switch leaves it: the second click of a double-click lands on the
      // tab the first one just filled.
      if (decision.action !== "switch") {
        lastSmartReplace =
          decision.action === "replace" && intent === "auto" && mode === "smart"
            ? { id: target.id, agentType: target.agentType, at: Date.now() }
            : null
      }
      switch (decision.action) {
        case "replace":
          replaceTabWithConversation(
            decision.tabId,
            target.folderId,
            target.id,
            target.agentType,
            // The switcher's tabs stay; a sidebar click keeps what the tab
            // was, so a preview stays a preview and a kept tab stays kept.
            { pin: keep || front?.isPinned === true }
          )
          break
        case "new_tab":
          openTab(target.folderId, target.id, target.agentType, true)
          break
        default:
          openTab(target.folderId, target.id, target.agentType, keep)
      }
      return decision
    },
    [openTab, replaceTabWithConversation, connections]
  )
}

/**
 * A double-click on a sidebar row: the session in a tab that stays, beside
 * the tab that was in front, as a double-click always opened it. Its first
 * click may already have shown the session in place of that tab by the Smart
 * rule; that is taken back first, so the tab comes back where it was (see
 * `undoTabReplacement`).
 */
export function useKeepOpenedSession(): (target: SessionOpenTarget) => void {
  const { openTab } = useTabActions()
  return useCallback(
    (target) => {
      const last = lastSmartReplace
      lastSmartReplace = null
      if (
        last &&
        last.id === target.id &&
        last.agentType === target.agentType &&
        Date.now() - last.at <= KEEP_UNDO_WINDOW_MS
      ) {
        useTabStore.getState().undoTabReplacement(target.id, target.agentType)
      }
      openTab(target.folderId, target.id, target.agentType, true)
    },
    [openTab]
  )
}
