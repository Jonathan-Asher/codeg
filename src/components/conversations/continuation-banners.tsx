"use client"

import { memo, useCallback } from "react"
import { useTranslations } from "next-intl"

import { formatConversationTitle } from "@/lib/conversation-title"
import { getAgentLabel } from "@/lib/custom-agents"
import type { DbConversationSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"

type LinkedConversation = Pick<
  DbConversationSummary,
  "id" | "folder_id" | "agent_type" | "title"
>

/**
 * The conversations a "Continue in another agent…" linked to this one: the
 * one it continues (`from`), and the newest one that continues it (`into`).
 * Either is null when there is none — or when that conversation is gone, as
 * a banner pointing nowhere helps no one. Read off the conversation list, so
 * both follow renames and new rows as they arrive.
 */
export function useContinuationLinks(conversationId: number | null): {
  from: LinkedConversation | null
  into: LinkedConversation | null
} {
  const fromId = useAppWorkspaceStore((s) =>
    conversationId == null
      ? null
      : (s.conversations.find((c) => c.id === conversationId)
          ?.continued_from_id ?? null)
  )
  const from = useAppWorkspaceStore((s) =>
    fromId == null
      ? null
      : (s.conversations.find((c) => c.id === fromId) ?? null)
  )
  const into = useAppWorkspaceStore((s) => {
    if (conversationId == null) return null
    let newest: DbConversationSummary | null = null
    for (const c of s.conversations) {
      if (c.continued_from_id !== conversationId) continue
      if (!newest || c.created_at > newest.created_at) newest = c
    }
    return newest
  })
  return { from, into }
}

function useOpenLinked(): (conversation: LinkedConversation) => void {
  return useCallback((conversation: LinkedConversation) => {
    useTabStore
      .getState()
      .openTab(
        conversation.folder_id,
        conversation.id,
        conversation.agent_type,
        true,
        conversation.title ?? undefined
      )
  }, [])
}

function useLinkTitle(): (conversation: LinkedConversation) => string {
  const t = useTranslations("Folder.conversationCard")
  return useCallback(
    (conversation: LinkedConversation) =>
      formatConversationTitle(conversation.title ?? "") ||
      t("untitledConversation"),
    [t]
  )
}

/** "← Continued from <agent>: <old title>", at the top of a conversation
 *  that continues another; opens the old one. */
export const ContinuedFromBanner = memo(function ContinuedFromBanner({
  conversation,
}: {
  conversation: LinkedConversation
}) {
  const t = useTranslations("ContinueInAgent")
  const open = useOpenLinked()
  const linkTitle = useLinkTitle()
  const title = linkTitle(conversation)
  return (
    <div className="flex justify-center">
      <button
        type="button"
        data-testid="continued-from-banner"
        onClick={() => open(conversation)}
        title={t("openSession", { title })}
        className={cn(
          "flex min-w-0 max-w-full items-center rounded-full border border-border bg-muted/40 px-3 py-1",
          "text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        )}
      >
        <span className="truncate">
          {t("continuedFrom", {
            agent: getAgentLabel(conversation.agent_type),
            title,
          })}
        </span>
      </button>
    </div>
  )
})

/** "Continued in <agent> → <new title>", a divider at the end of a
 *  conversation another one continues; opens the new one. */
export const ContinuedInBanner = memo(function ContinuedInBanner({
  conversation,
}: {
  conversation: LinkedConversation
}) {
  const t = useTranslations("ContinueInAgent")
  const open = useOpenLinked()
  const linkTitle = useLinkTitle()
  const title = linkTitle(conversation)
  return (
    <div className="flex items-center gap-3 py-1">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <button
        type="button"
        data-testid="continued-in-banner"
        onClick={() => open(conversation)}
        title={t("openSession", { title })}
        className={cn(
          "min-w-0 max-w-[80%] truncate rounded-full px-2 py-0.5 text-xs text-muted-foreground",
          "transition-colors hover:bg-muted hover:text-foreground"
        )}
      >
        {t("continuedIn", {
          agent: getAgentLabel(conversation.agent_type),
          title,
        })}
      </button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
})
