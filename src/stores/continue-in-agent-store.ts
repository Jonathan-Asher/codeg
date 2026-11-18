import { create } from "zustand"

/**
 * Which session the "Continue in another agent…" dialog is open for. One
 * dialog for the whole window (`ContinueInAgentHost`), opened from any menu
 * that offers the item: the tab's, the session header's and the sidebar
 * row's.
 */
interface ContinueInAgentState {
  conversationId: number | null
  open: (conversationId: number) => void
  close: () => void
}

export const useContinueInAgentStore = create<ContinueInAgentState>((set) => ({
  conversationId: null,
  open: (conversationId) => set({ conversationId }),
  close: () => set({ conversationId: null }),
}))

/** Open the dialog for `conversationId`. */
export function openContinueInAgent(conversationId: number): void {
  useContinueInAgentStore.getState().open(conversationId)
}
