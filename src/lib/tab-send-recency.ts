/**
 * When the user last sent a message from each conversation tab, by tab id (a
 * draft keeps its id when it becomes a session). Read by the "where does a
 * session open" rule: a tab he wrote in a few minutes ago is one he is working
 * in, even once its turn has ended. In memory only — after a restart no tab
 * counts as recently written in, which errs towards keeping tabs.
 */

const lastSendByTab = new Map<string, number>()

/** Record a message the user sent from `tabId` (not a queued one going out
 *  by itself later). */
export function noteTabSend(tabId: string, at: number = Date.now()): void {
  lastSendByTab.set(tabId, at)
}

export function lastTabSendAt(tabId: string): number | null {
  return lastSendByTab.get(tabId) ?? null
}

export function resetTabSendRecencyForTests(): void {
  lastSendByTab.clear()
}
