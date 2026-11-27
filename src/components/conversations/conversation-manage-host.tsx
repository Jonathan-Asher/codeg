"use client"

/**
 * "Manage conversations…" for a folder, opened from anywhere: a folder's menu
 * and a session's menu in the sidebar, and a conversation tab's menu. The
 * openers are menus that unmount as they close — and the sidebar itself is
 * unmounted while it is collapsed, when a tab's menu must still open it — so
 * the workspace mounts the one host that draws the dialog.
 */

import { useSyncExternalStore } from "react"
import { ConversationManageDialog } from "./conversation-manage-dialog"

interface ManageRequest {
  id: number
  folderId: number
}

let current: ManageRequest | null = null
let lastId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Open Manage conversations on `folderId` (it replaces one already open). */
export function openConversationManager(folderId: number): void {
  lastId += 1
  current = { id: lastId, folderId }
  notify()
}

function closeConversationManager(id: number): void {
  if (current?.id !== id) return
  current = null
  notify()
}

export function resetConversationManagerForTests(): void {
  current = null
  notify()
}

/** Mounted once in the workspace; draws the dialog while it is open. */
export function ConversationManageHost() {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
  if (!request) return null
  return (
    <ConversationManageDialog
      // Each opening starts on its own folder, never the last one's state.
      key={request.id}
      open
      onOpenChange={(open) => {
        if (!open) closeConversationManager(request.id)
      }}
      folderId={request.folderId}
    />
  )
}
