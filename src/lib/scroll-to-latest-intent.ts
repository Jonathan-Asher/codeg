/**
 * One-shot "show the latest message" intent: a notification click opens a
 * session, and its transcript lands on the newest message and follows new
 * output from there — however far up it had been scrolled, and even when the
 * transcript is still loading.
 *
 * Module-scope, like `pending-find`: the notification click route posts it
 * right before it switches to (or opens) the session's tab; the transcript
 * showing that conversation takes it once it is the active one AND has its
 * content, so a tab that mounts fresh and loads its history asynchronously
 * scrolls after the history is there, not before. Nothing else posts one, so
 * an ordinary tab switch keeps whatever scroll position the tab had.
 *
 * Keyed by conversation, under every id its transcript may know it by: a tab
 * that started as a draft keeps its virtual runtime id for life while the
 * notification names the persisted one. Subscribable, because the transcript
 * may already be mounted and active (a click on the notification of the
 * session that is on screen), and then has to hear about the request.
 */

/** Each entry: the ids one conversation goes by. */
let pending: number[][] = []
let version = 0
const listeners = new Set<() => void>()

function idsOf(ids: ReadonlyArray<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => typeof id === "number"))]
}

function overlaps(entry: number[], ids: number[]): boolean {
  return entry.some((id) => ids.includes(id))
}

/** Ask the transcript of this conversation to show its latest message. */
export function requestScrollToLatest(
  ids: ReadonlyArray<number | null | undefined>
): void {
  const keys = idsOf(ids)
  if (keys.length === 0) return
  // A newer request for the same conversation replaces the older one.
  pending = [...pending.filter((entry) => !overlaps(entry, keys)), keys]
  version += 1
  for (const listener of listeners) listener()
}

/**
 * Take the request for the conversation a transcript shows (by any of its
 * ids). `true` once, then the request is gone.
 */
export function takeScrollToLatest(
  ids: ReadonlyArray<number | null | undefined>
): boolean {
  const keys = idsOf(ids)
  const index = pending.findIndex((entry) => overlaps(entry, keys))
  if (index < 0) return false
  pending = pending.filter((_, i) => i !== index)
  return true
}

/** `useSyncExternalStore` plumbing: bumps on every request. */
export function subscribeScrollToLatest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getScrollToLatestVersion(): number {
  return version
}

/** Test-only: forget every request. */
export function resetScrollToLatestIntents(): void {
  pending = []
}
