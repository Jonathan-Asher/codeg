"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { toErrorMessage } from "@/lib/app-error"
import {
  forkConversation,
  forkRefusal,
  forkTabAnchor,
  type ConversationForkBlock,
} from "@/lib/fork-conversation"
import { notify } from "@/lib/notify"
import type { AgentType } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** Why a "Fork" can't run, in words: a disabled item's tooltip, and the
 *  notice when the backend refuses one. */
export function useForkBlockLabel(): (block: ConversationForkBlock) => string {
  const t = useTranslations("Folder.conversationCard")
  return useCallback(
    (block: ConversationForkBlock) => {
      switch (block) {
        case "unsupported":
          return t("forkUnsupported")
        case "no_reply":
          return t("forkNoReply")
        case "turn_running":
          return t("forkAfterReply")
        case "forking":
          return t("forking")
      }
    },
    [t]
  )
}

/**
 * "Fork" as the menus run it (`lib/fork-conversation`): a "Forking…" toast
 * stands beside the tab-strip placeholder while the fork is on its way. It
 * goes when the forked conversation's tab opens, or turns into why the fork
 * was refused (a passing notice) or failed (an error, kept in the alerts).
 */
export function useForkConversation(): (conversation: {
  id: number
  agent_type: AgentType
}) => void {
  const t = useTranslations("Folder.conversationCard")
  const blockLabel = useForkBlockLabel()
  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  return useCallback(
    (conversation: { id: number; agent_type: AgentType }) => {
      const key = `fork-conversation:${conversation.id}`
      toast.loading(t("forking"), { id: key })
      forkConversation({
        conversationId: conversation.id,
        agentType: conversation.agent_type,
        besideTabId: forkTabAnchor(conversation.id),
        onNewConversation: () => void refreshConversations(),
      })
        .then(() => toast.dismiss(key))
        .catch((err: unknown) => {
          const refusal = forkRefusal(err)
          notify({
            level: refusal ? "info" : "error",
            key,
            title: refusal
              ? blockLabel(refusal)
              : t("forkFailed", { error: toErrorMessage(err) }),
          })
        })
    },
    [t, blockLabel, refreshConversations]
  )
}
