/**
 * One-shot bridge: a cross-conversation search hit opens a conversation and
 * hands the pre-written find query to its transcript (⌘F opens prefilled, so
 * the matched turn is highlighted in context even when it is pages deep in
 * an older window).
 *
 * Module-scope singleton — set by the search dialog right before
 * `openTab`, consumed (taken) once by the MessageListView whose
 * conversationId matches. Any race (tab closed before load) simply leaves
 * the value stale for the next open of the SAME conversation, which is the
 * only consumer keyed to it.
 */
let pending: { conversationId: number; query: string } | null = null

export function setPendingFind(conversationId: number, query: string) {
  pending = { conversationId, query }
}

export function takePendingFind(conversationId: number): string | null {
  if (pending && pending.conversationId === conversationId) {
    const { query } = pending
    pending = null
    return query
  }
  return null
}
