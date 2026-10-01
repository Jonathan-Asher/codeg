// Whether the search dialog opens on recent sessions.
//
// On by default: with nothing typed, the Conversations tab lists the current
// session (selected) and the most recently active sessions below it, so ⌘K, ↓,
// Enter switches to the last session you were in. Off, it waits for a query,
// as it always used to.
//
// Persisted in localStorage, same shape as `edit-message-prefs`: the Settings
// window writes it, and the workspace window follows it live.

import { useEffect, useState } from "react"

const SHOW_RECENT_KEY = "settings:search:show-recent"
const SHOW_RECENT_EVENT = "codeg:search-show-recent-changed"

export function loadShowRecentOnSearch(): boolean {
  if (typeof window === "undefined") return true
  try {
    // Default ON: only an explicit "false" turns it off.
    return localStorage.getItem(SHOW_RECENT_KEY) !== "false"
  } catch {
    return true
  }
}

export function saveShowRecentOnSearch(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SHOW_RECENT_KEY, String(value))
  } catch {
    /* ignore */
  }
  // Same-window listeners (settings and workspace may share a window);
  // other windows/tabs get the native `storage` event.
  window.dispatchEvent(new CustomEvent(SHOW_RECENT_EVENT, { detail: value }))
}

/** Reactive read of the preference, plus the setter that persists it. */
export function useShowRecentOnSearch(): [boolean, (value: boolean) => void] {
  const [show, setShow] = useState<boolean>(loadShowRecentOnSearch)
  useEffect(() => {
    const sync = () => setShow(loadShowRecentOnSearch())
    window.addEventListener(SHOW_RECENT_EVENT, sync)
    window.addEventListener("storage", sync)
    return () => {
      window.removeEventListener(SHOW_RECENT_EVENT, sync)
      window.removeEventListener("storage", sync)
    }
  }, [])
  return [show, saveShowRecentOnSearch]
}
