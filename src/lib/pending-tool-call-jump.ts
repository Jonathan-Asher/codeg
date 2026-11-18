/**
 * One-shot bridge: "show me where this came from". A sub-agent's tab links
 * back to the Agent card in its parent session; the link brings the parent's
 * tab to the front and leaves the call here for that transcript, which scrolls
 * to the card once it is showing and has the card's turn loaded.
 *
 * Module scope, like `pending-find`: the parent's transcript may be mounted
 * already (kept alive in a background tab), so it subscribes rather than only
 * looking when it first renders. A newer request replaces an older one.
 */

let pending: { conversationId: number; toolCallId: string } | null = null
let version = 0
const listeners = new Set<() => void>()

export function requestToolCallJump(
  conversationId: number,
  toolCallId: string
): void {
  pending = { conversationId, toolCallId }
  version += 1
  for (const listener of listeners) listener()
}

/** The call waiting to be shown in `conversationId`'s transcript, if any. */
export function peekToolCallJump(conversationId: number): string | null {
  return pending && pending.conversationId === conversationId
    ? pending.toolCallId
    : null
}

/** Done: the transcript showed the card. */
export function takeToolCallJump(conversationId: number): void {
  if (pending && pending.conversationId === conversationId) pending = null
}

export function subscribeToolCallJump(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getToolCallJumpVersion(): number {
  return version
}
