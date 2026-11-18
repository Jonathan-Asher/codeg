"use client"

/**
 * A Claude Code sub-agent's whole thread, in a tab of its own.
 *
 * The thread is the sub-agent's own transcript, read by the backend into the
 * same detail a session has (`get_claude_subagent_thread`) and put in a
 * runtime session of this tab's, so it renders through the same
 * `MessageListView` as every session — messages, thinking, tool cards, diffs,
 * nested sub-agents. It keeps reading while the sub-agent works
 * (`useSubagentThread`). There is no composer: a sub-agent takes no messages
 * from the user, so its place holds the read-only line instead.
 */

import { memo, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { MessageListView } from "@/components/message/message-list-view"
import { TranscriptConversationProvider } from "@/components/message/transcript-conversation-context"
import { subagentRuntimeId } from "@/lib/claude-subagent"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import type { SubagentTabTarget } from "@/stores/tab-store"
import { showSubagentParent } from "./show-subagent-parent"
import { SubagentReadOnlyBar } from "./subagent-read-only-bar"
import {
  useSubagentThread,
  type SubagentThreadStatus,
} from "./use-subagent-thread"

const NO_COMMANDS: readonly never[] = []

export const SubagentTabView = memo(function SubagentTabView({
  tabId,
  target,
  folderId,
  folderPath,
  isActive,
  isVisible,
}: {
  tabId: string
  target: SubagentTabTarget
  folderId: number
  folderPath?: string
  isActive: boolean
  isVisible: boolean
}) {
  const runtimeId = useMemo(() => subagentRuntimeId(tabId), [tabId])
  const thread = useSubagentThread({
    tabId,
    target,
    runtimeId,
    visible: isVisible,
  })
  // The parent's title as the sidebar knows it now, else as the thread says.
  const listedParentTitle = useAppWorkspaceStore(
    (s) =>
      s.conversations.find((c) => c.id === target.parentConversationId)
        ?.title ?? null
  )
  const showParent = useCallback(
    () => showSubagentParent(target, folderId),
    [target, folderId]
  )

  return (
    <TranscriptConversationProvider value={target.parentConversationId}>
      <div className="flex h-full min-h-0 flex-col" data-subagent-tab={tabId}>
        <div className="relative min-h-0 flex-1">
          {thread.status === "ready" ? (
            <MessageListView
              conversationId={runtimeId}
              imageRoot={folderPath ?? null}
              agentType="claude_code"
              availableCommands={NO_COMMANDS}
              isActive={isActive}
              hideEmptyState={false}
            />
          ) : (
            <SubagentThreadPlaceholder
              status={thread.status}
              error={thread.error}
            />
          )}
        </div>
        <SubagentReadOnlyBar
          parentTitle={listedParentTitle ?? thread.parentTitle}
          subagentType={thread.subagentType ?? target.subagentType ?? null}
          running={thread.running}
          onShowParent={showParent}
        />
      </div>
    </TranscriptConversationProvider>
  )
})

function SubagentThreadPlaceholder({
  status,
  error,
}: {
  status: SubagentThreadStatus
  error: string | null
}) {
  const t = useTranslations("Folder.subagentTab")
  const busy = status === "loading" || status === "waiting"
  const text =
    status === "loading"
      ? t("loading")
      : status === "waiting"
        ? t("waiting")
        : status === "missing"
          ? t("missing")
          : t("failed", { message: error ?? "" })
  return (
    <div
      className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground"
      role={status === "error" ? "alert" : undefined}
    >
      {busy ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
      {text}
    </div>
  )
}
