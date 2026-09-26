import type { DbConversationSummary } from "@/lib/types"
import { parkAskSelectionPrompt } from "@/lib/ask-selection-handoff"
import { CONTINUE_PROMPT } from "@/lib/session-activity"
import { useTabStore } from "@/contexts/tab-context"

/**
 * Pick an interrupted session back up from anywhere (the sidebar, the Session
 * Details view): open the conversation — or focus its tab — and hand
 * "continue" to that tab's composer queue.
 *
 * Going through the tab rather than calling the send API directly is the
 * point: the tab resumes the agent's session on its own (the same auto-connect
 * as opening it by hand), and the queue sends the prompt the moment that
 * connection is ready, through the normal send path — optimistic turn,
 * busy-retry and all — so it works for every agent that can resume a session.
 * Until then the prompt sits visibly in the queue above the composer, where
 * the user can still edit or drop it.
 */
export function continueInterruptedSession(
  summary: Pick<DbConversationSummary, "id" | "folder_id" | "agent_type">
): void {
  const { id, folder_id: folderId, agent_type: agentType } = summary
  useTabStore.getState().openTab(folderId, id, agentType, true)
  const tab = useTabStore
    .getState()
    .rawTabs.find(
      (t) =>
        t.conversationId === id &&
        t.folderId === folderId &&
        t.agentType === agentType
    )
  if (!tab) return
  // The ask-selection hand-off is exactly "send this prompt in that tab as soon
  // as it can": parked by tab id, drained by the panel on mount (a freshly
  // opened tab) or on its event (one already open), and matched against the
  // tab's agent and folder so it can never reach another session.
  parkAskSelectionPrompt(tab.id, {
    prompt: CONTINUE_PROMPT,
    agentType,
    folderId,
  })
}
