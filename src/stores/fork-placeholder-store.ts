import { create } from "zustand"

/**
 * Forks on their way into a NEW tab ("Fork from here" while a turn runs — see
 * `lib/fork-from-turn`). Each one stands in the tab strip as a "Forking…"
 * placeholder right after the tab it was forked from, from the moment the fork
 * heads into a new conversation until the forked conversation's own tab takes
 * its place, or the fork fails and the placeholder goes away.
 *
 * Presentation only, and local to this window: a placeholder is not a tab. It
 * is never in `rawTabs`, so it is never saved to `opened_tabs`, never focused,
 * and nothing that walks the tabs sees it.
 */
export interface ForkPlaceholder {
  id: string
  /** The tab the fork was taken from; the placeholder stands right after it.
   *  A tab that is not on screen (closed meanwhile, or `null`) shows it
   *  nowhere — the forked tab still opens when the fork is ready. */
  sourceTabId: string | null
}

interface ForkPlaceholderState {
  placeholders: ForkPlaceholder[]
  /** Show a placeholder after `sourceTabId`; returns its id for `close`. */
  open: (sourceTabId: string | null) => string
  /** Take a placeholder away. Closing one that is gone is a no-op. */
  close: (id: string) => void
}

let serial = 0

export const useForkPlaceholderStore = create<ForkPlaceholderState>()(
  (set) => ({
    placeholders: [],
    open: (sourceTabId) => {
      serial += 1
      const id = `fork-placeholder-${serial}`
      set((state) => ({
        placeholders: [...state.placeholders, { id, sourceTabId }],
      }))
      return id
    },
    close: (id) =>
      set((state) =>
        state.placeholders.some((p) => p.id === id)
          ? { placeholders: state.placeholders.filter((p) => p.id !== id) }
          : state
      ),
  })
)

/** Test helper: drop every placeholder. */
export function resetForkPlaceholderStore(): void {
  useForkPlaceholderStore.setState({ placeholders: [] })
}
