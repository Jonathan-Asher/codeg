/**
 * Ask this window's workspace to open a conversation in a tab.
 *
 * Whoever asks — a session badge in a transcript, deep in the message tree —
 * is far from the tab state, so the workspace's `PetFocusBridge` registers the
 * handler and opens the tab the way a deep link does: once folders and tabs
 * have loaded, adding the folder when it is not open. A request made with no
 * workspace mounted does nothing.
 */

import type { AgentType } from "@/lib/types"

export interface ConversationFocusRequest {
  folderId: number
  conversationId: number
  agent: AgentType
}

type FocusHandler = (request: ConversationFocusRequest) => void

let handler: FocusHandler | null = null

/** Register what a focus request does in this window. */
export function setConversationFocusHandler(next: FocusHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/** Open the conversation in this window's workspace. Whether one listened. */
export function requestConversationFocus(
  request: ConversationFocusRequest
): boolean {
  if (!handler) return false
  handler(request)
  return true
}
