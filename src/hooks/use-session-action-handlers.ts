"use client"

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useTabActions } from "@/contexts/tab-context"
import { openConversationManager } from "@/components/conversations/conversation-manage-host"
import {
  conversationExportMarkdown,
  deleteConversation,
  updateConversationPinned,
  updateConversationStatus,
  updateConversationTitle,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { setConversationCritical } from "@/lib/critical-sessions"
import { setTalkMode } from "@/lib/talk-mode"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/**
 * What a session's menu does, wherever it is shown — a sidebar row or a
 * conversation tab (`SessionActionsMenuItems`). An action left out keeps its
 * item out of the menu.
 */
export interface SessionActionHandlers {
  onRename: (id: number, newTitle: string) => Promise<void>
  onDelete: (id: number, agentType: string, folderId: number) => Promise<void>
  onStatusChange: (id: number, status: ConversationStatus) => Promise<void>
  /** A new session in the folder the conversation is in. */
  onNewConversation?: (folderId: number) => void
  /** Pin to the sidebar's Pinned section, or take it out. */
  onTogglePin?: (id: number, nextPinned: boolean) => void
  /** Mark or unmark the conversation critical (alerts when it sits idle). */
  onToggleCritical?: (id: number, nextCritical: boolean) => void
  /** Turn the phone's Talk mode on or off for the conversation. */
  onToggleTalk?: (id: number, nextTalk: boolean) => void
  /** Export the conversation to a Markdown file (server-side serializer). */
  onExportMarkdown?: (id: number) => void
  /** Manage conversations on the folder the conversation is listed under. */
  onManageConversations?: (conversation: DbConversationSummary) => void
}

/**
 * The session actions, one implementation for every menu that offers them, so
 * a sidebar row and a tab cannot come to do different things. Each goes
 * through the same API the window's transport reaches, so in a window onto a
 * remote server they act on that server, as the sidebar there does.
 *
 * `openConversations` brings the conversation workspace back over a workbench
 * route (Automations, …) before a new session's tab opens; absent outside one.
 */
export function useSessionActionHandlers(
  openConversations?: () => void
): Required<SessionActionHandlers> {
  const t = useTranslations("Folder.sidebar")
  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  const updateConversationLocal = useAppWorkspaceStore(
    (s) => s.updateConversationLocal
  )
  const { closeConversationTab, openNewConversationTab } = useTabActions()

  const onRename = useCallback(
    async (id: number, newTitle: string) => {
      await updateConversationTitle(id, newTitle)
      // At once, not on the refresh: the tab and the row show it while the
      // list is fetched again.
      updateConversationLocal(id, { title: newTitle })
      refreshConversations()
    },
    [refreshConversations, updateConversationLocal]
  )

  const onDelete = useCallback(
    async (id: number, agentType: string, folderId: number) => {
      await deleteConversation(id)
      // No-op if no matching tab is open (the context guards on its tab ref).
      closeConversationTab(folderId, id, agentType as AgentType)
      refreshConversations()
    },
    [closeConversationTab, refreshConversations]
  )

  const onStatusChange = useCallback(
    async (id: number, status: ConversationStatus) => {
      updateConversationLocal(id, { status })
      await updateConversationStatus(id, status)
    },
    [updateConversationLocal]
  )

  const onTogglePin = useCallback(
    async (id: number, nextPinned: boolean) => {
      // Optimistic: instantly move the row into / out of the Pinned section. The
      // upsert echo (emit_conversation_upsert) reconciles the exact server
      // `pinned_at`; on failure the next refresh / WS reconnect corrects it
      // (mirrors onStatusChange's lenient pattern). Like the backend, a pin
      // toggle drops any manual Pinned-section position.
      updateConversationLocal(id, {
        pinned_at: nextPinned ? new Date().toISOString() : null,
        pin_order: null,
      })
      await updateConversationPinned(id, nextPinned)
    },
    [updateConversationLocal]
  )

  // Optimistic like the pin (the flag flips at once, and flips back if the
  // backend refuses). Stable: `t` only changes with the locale.
  const onToggleCritical = useCallback(
    async (id: number, nextCritical: boolean) => {
      try {
        await setConversationCritical(id, nextCritical)
      } catch (err) {
        toast.error(t("criticalToggleFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  // The same for Talk mode (held from the phone; turned off here for one a
  // phone left on).
  const onToggleTalk = useCallback(
    async (id: number, nextTalk: boolean) => {
      try {
        await setTalkMode(id, nextTalk)
      } catch (err) {
        toast.error(t("talkToggleFailed", { message: toErrorMessage(err) }))
      }
    },
    [t]
  )

  // The server serializes the transcript and writes it next to the
  // conversation's workspace; the path is all there is to say.
  const onExportMarkdown = useCallback(
    async (id: number) => {
      try {
        const path = await conversationExportMarkdown(id)
        toast.success(t("toasts.exportMarkdownDone", { path }))
      } catch (err) {
        toast.error(
          t("toasts.exportMarkdownFailed", {
            message: toErrorMessage(err),
          })
        )
      }
    },
    [t]
  )

  const onNewConversation = useCallback(
    (folderId: number) => {
      const folder = useAppWorkspaceStore
        .getState()
        .allFolders.find((f) => f.id === folderId)
      if (!folder) return
      // Starting a conversation returns to the conversation workspace if a
      // workbench route (e.g. Automations) was taking over the content region.
      openConversations?.()
      openNewConversationTab(folderId, folder.path)
    },
    [openConversations, openNewConversationTab]
  )

  const onManageConversations = useCallback(
    (conversation: DbConversationSummary) =>
      openConversationManager(conversation.folder_id),
    []
  )

  return useMemo(
    () => ({
      onRename,
      onDelete,
      onStatusChange,
      onNewConversation,
      onTogglePin,
      onToggleCritical,
      onToggleTalk,
      onExportMarkdown,
      onManageConversations,
    }),
    [
      onRename,
      onDelete,
      onStatusChange,
      onNewConversation,
      onTogglePin,
      onToggleCritical,
      onToggleTalk,
      onExportMarkdown,
      onManageConversations,
    ]
  )
}
