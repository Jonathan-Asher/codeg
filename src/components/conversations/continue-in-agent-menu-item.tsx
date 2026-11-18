"use client"

import { useCallback, type ComponentType, type ReactNode } from "react"
import { Forward } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  continueInAgentBlock,
  type ContinueInAgentBlock,
} from "@/lib/continue-in-agent-block"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationAttention } from "@/stores/conversation-attention-store"
import { useConversationBackground } from "@/stores/conversation-background-store"
import { openContinueInAgent } from "@/stores/continue-in-agent-store"

/** Why "Continue in another agent…" can't run, in words: the disabled
 *  item's tooltip, and the dialog's note. */
export function useContinueInAgentBlockLabel(): (
  block: ContinueInAgentBlock
) => string {
  const t = useTranslations("ContinueInAgent")
  return useCallback(
    (block: ContinueInAgentBlock) => {
      switch (block) {
        case "no_session":
          return t("blockNoSession")
        case "subsession":
          return t("blockSubsession")
        case "turn_running":
          return t("blockTurnRunning")
        case "needs_you":
          return t("blockNeedsYou")
        case "in_progress":
          return t("blockInProgress")
      }
    },
    [t]
  )
}

/** Why the item is disabled for `conversationId` right now, kept current
 *  while the menu (or dialog) showing it is open. */
export function useContinueInAgentBlock(
  conversationId: number
): ContinueInAgentBlock | null {
  const conversation = useAppWorkspaceStore((s) =>
    s.conversations.find((c) => c.id === conversationId)
  )
  const attention = useConversationAttention(conversationId)
  const background = useConversationBackground(conversationId)
  return continueInAgentBlock(conversation ?? null, attention, background)
}

/** The menu item component a menu brings (its context-menu or dropdown
 *  flavour): both take `disabled`, `onSelect` and children. */
type MenuItemComponent = ComponentType<{
  disabled?: boolean
  onSelect?: (event: Event) => void
  children?: ReactNode
}>

/**
 * "Continue in another agent…" in a session's menu. Disabled, with the
 * reason as its tooltip, while a turn runs or the session waits for the
 * user; otherwise it opens the window's dialog for the session.
 */
export function ContinueInAgentMenuItem({
  conversationId,
  item: Item,
}: {
  conversationId: number
  item: MenuItemComponent
}) {
  const t = useTranslations("ContinueInAgent")
  const block = useContinueInAgentBlock(conversationId)
  const blockLabel = useContinueInAgentBlockLabel()
  const label = (
    <>
      <Forward className="h-4 w-4" />
      {t("menuLabel")}
    </>
  )
  // A disabled item takes no pointer, so its wrapper carries the reason (as
  // "Fork" does).
  if (block) {
    return (
      <div title={blockLabel(block)} data-continue-block={block}>
        <Item disabled>{label}</Item>
      </div>
    )
  }
  return (
    <Item onSelect={() => openContinueInAgent(conversationId)}>{label}</Item>
  )
}
