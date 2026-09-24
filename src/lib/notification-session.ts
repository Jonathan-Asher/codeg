import { formatConversationTitle } from "@/lib/conversation-title"
import type { NotifyPayload } from "@/lib/desktop-notification"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useTabStore } from "@/stores/tab-store"

/**
 * Which session an OS notification is about, in words a user recognises.
 *
 * A banner used to be titled with the window's ACTIVE folder — not the folder
 * of the session that raised it — and to name only the agent, so with several
 * sessions running a "Claude Code needs permission" banner pointed at nothing
 * (and could name the wrong folder outright). The connection's context key is
 * its tab id; from the tab we reach the persisted conversation (its title, its
 * own folder), falling back to the tab's label for a draft that has no row yet.
 */
export function describeNotificationSession(
  contextKey: string,
  activeFolderName?: string | null
): { sessionTitle: string | null; folderName: string | null } {
  const tab = useTabStore.getState().tabs.find((t) => t.id === contextKey)
  const workspace = useAppWorkspaceStore.getState()

  let conversationId = tab?.conversationId ?? null
  if (conversationId == null && tab?.runtimeConversationId != null) {
    conversationId =
      useConversationRuntimeStore
        .getState()
        .byConversationId.get(tab.runtimeConversationId)?.dbConversationId ??
      null
  }
  const conversation =
    conversationId != null
      ? workspace.conversations.find((c) => c.id === conversationId)
      : undefined

  const folderId = conversation?.folder_id ?? tab?.folderId ?? null
  const folder =
    folderId != null
      ? workspace.folders.find((f) => f.id === folderId)
      : undefined

  const title =
    formatConversationTitle(conversation?.title).trim() ||
    tab?.title?.trim() ||
    null
  return {
    sessionTitle: title,
    folderName: folder?.alias || folder?.name || activeFolderName || null,
  }
}

/**
 * Build an event notification that says which session it is about: the
 * session's title as the banner title, its folder ahead of the message.
 *
 * With "hide notification contents" on, the title falls back to the old
 * `<folder> - Codeg` form — a session title is the user's own words (often the
 * first line of their prompt), exactly what that setting exists to keep out of
 * the notification centre.
 */
export function sessionNotificationPayload(
  contextKey: string,
  activeFolderName: string | null | undefined,
  content: { body: string; redactedBody?: string }
): NotifyPayload {
  const { sessionTitle, folderName } = describeNotificationSession(
    contextKey,
    activeFolderName
  )
  const folderTitle = folderName ? `${folderName} - Codeg` : "Codeg"
  // The folder moves into the body only when the title no longer carries it.
  const withFolder = (text: string) =>
    sessionTitle && folderName ? `${folderName} · ${text}` : text
  return {
    title: sessionTitle ?? folderTitle,
    redactedTitle: folderTitle,
    body: withFolder(content.body),
    ...(content.redactedBody !== undefined
      ? { redactedBody: withFolder(content.redactedBody) }
      : {}),
  }
}
