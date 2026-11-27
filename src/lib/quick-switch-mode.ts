import { create } from "zustand"

/**
 * Which way the ⌘K switcher is open. `replace` is its "switch this tab" mode
 * (its own shortcut): Enter loads the picked session into the tab in front
 * instead of following the "When you open a session" rule. Set by the
 * shortcuts that open it and back to the plain mode whenever it closes.
 */
interface QuickSwitchModeState {
  replace: boolean
}

export const useQuickSwitchMode = create<QuickSwitchModeState>(() => ({
  replace: false,
}))

export function setQuickSwitchReplaceMode(replace: boolean): void {
  if (useQuickSwitchMode.getState().replace === replace) return
  useQuickSwitchMode.setState({ replace })
}

export function isQuickSwitchReplaceMode(): boolean {
  return useQuickSwitchMode.getState().replace
}
