"use client"

/**
 * The session dialogs (rename, delete, details, move, new tag) for a session
 * menu that cannot hold them itself: a conversation tab's. A tab sits inside
 * the strip's drag list, so a dialog drawn there would hand its presses and
 * wheel turns to the strip (React events bubble through a portal to the
 * components around it) — a drag started from a text field, the strip
 * scrolling under a scrolled dialog. The workspace mounts this host once,
 * clear of the strip; a tab's menu opens it with `openSessionDialog`.
 */

import { useSyncExternalStore } from "react"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useSessionActionHandlers } from "@/hooks/use-session-action-handlers"
import type { DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import {
  SessionActionDialogs,
  type SessionDialogKind,
} from "./session-actions-menu"

interface DialogRequest {
  id: number
  conversationId: number
  /** Null once closed: the dialogs stay mounted so the closing one animates
   *  out, until the next request replaces them. */
  kind: SessionDialogKind | null
}

let current: DialogRequest | null = null
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

/** Open one of a session's dialogs over the workspace. */
export function openSessionDialog(
  conversationId: number,
  kind: SessionDialogKind
): void {
  lastId += 1
  current = { id: lastId, conversationId, kind }
  notify()
}

function setRequestKind(id: number, kind: SessionDialogKind | null): void {
  if (current?.id !== id) return
  current = { ...current, kind }
  notify()
}

export function resetSessionDialogHostForTests(): void {
  current = null
  notify()
}

/**
 * The summary of `conversationId` this window knows: a root from the sidebar
 * list, or a sub-session's summary seeded for its tab.
 */
export function useKnownConversationSummary(
  conversationId: number | null
): DbConversationSummary | null {
  const root = useAppWorkspaceStore((s) =>
    conversationId == null
      ? undefined
      : s.conversations.find((c) => c.id === conversationId)
  )
  const child = useTabStore((s) =>
    conversationId == null || root
      ? undefined
      : s.childSummaries.get(conversationId)
  )
  return root ?? child ?? null
}

function HostedSessionDialogs({ request }: { request: DialogRequest }) {
  const conversation = useKnownConversationSummary(request.conversationId)
  const route = useOptionalWorkbenchRoute()
  const { onRename, onDelete } = useSessionActionHandlers(
    route?.openConversations
  )
  if (!conversation) return null
  return (
    <SessionActionDialogs
      conversation={conversation}
      dialog={request.kind}
      onDialogChange={(kind) => setRequestKind(request.id, kind)}
      onRename={onRename}
      onDelete={onDelete}
    />
  )
}

/** Mounted once in the workspace; draws the dialog a tab's menu asked for. */
export function SessionDialogHost() {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
  if (!request) return null
  return <HostedSessionDialogs key={request.id} request={request} />
}
