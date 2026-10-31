/**
 * Talk is bound to its conversation's tab: closing the tab ends the Talk. A
 * tab moved to another split group keeps its id (and its Talk); the panel
 * unmounting is not the signal, the tab leaving the store is.
 */

export interface TabsStoreLike {
  getState(): { rawTabs: readonly { id: string }[] }
  subscribe(listener: () => void): () => void
}

/** Call `onClosed` once the tab `contextKey()` names is no longer open. */
export function watchTabClosed(
  tabs: TabsStoreLike,
  contextKey: () => string | null,
  onClosed: () => void
): () => void {
  return tabs.subscribe(() => {
    const key = contextKey()
    if (key === null) return
    if (!tabs.getState().rawTabs.some((tab) => tab.id === key)) onClosed()
  })
}
