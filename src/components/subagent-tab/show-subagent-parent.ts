import { requestToolCallJump } from "@/lib/pending-tool-call-jump"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore, type SubagentTabTarget } from "@/stores/tab-store"

/** Bring the session a sub-agent tab came from to the front, at its Agent
 *  card. */
export function showSubagentParent(
  target: SubagentTabTarget,
  fallbackFolderId: number
): void {
  requestToolCallJump(target.parentConversationId, target.toolCallId)
  const st = useTabStore.getState()
  const parentTab = st.rawTabs.find(
    (t) =>
      t.kind === "conversation" &&
      t.conversationId === target.parentConversationId
  )
  if (parentTab) {
    st.switchTab(parentTab.id)
    return
  }
  const row = useAppWorkspaceStore
    .getState()
    .conversations.find((c) => c.id === target.parentConversationId)
  // Pinned: the sub-agent's tab, often the group's preview, stays open.
  st.openTab(
    row?.folder_id ?? fallbackFolderId,
    target.parentConversationId,
    "claude_code",
    true,
    row?.title ?? undefined
  )
}
