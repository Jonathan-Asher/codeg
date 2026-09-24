/**
 * One-shot bridge: a cross-conversation search hit opens a conversation and
 * hands the pre-written find query to its transcript (⌘F opens prefilled, so
 * the matched turn is highlighted in context even when it is pages deep in
 * an older window).
 *
 * Module-scope singleton — set by the search dialog right before
 * `openTab`, consumed (taken) once by the MessageListView whose
 * conversationId matches. Subscribable, because the target transcript may
 * already be mounted (the hit is in a conversation that is open right now):
 * it has to hear about a new query, not only look once when it first renders.
 * Any race (tab closed before load) leaves the value for the next open of the
 * SAME conversation, the only consumer keyed to it.
 */
let pending: { conversationId: number; query: string } | null = null
let version = 0
const listeners = new Set<() => void>()

export function setPendingFind(conversationId: number, query: string) {
  pending = { conversationId, query }
  version += 1
  for (const listener of listeners) listener()
}

export function takePendingFind(conversationId: number): string | null {
  if (pending && pending.conversationId === conversationId) {
    const { query } = pending
    pending = null
    return query
  }
  return null
}

/** `useSyncExternalStore` plumbing: bumps on every `setPendingFind`. */
export function subscribePendingFind(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPendingFindVersion(): number {
  return version
}
