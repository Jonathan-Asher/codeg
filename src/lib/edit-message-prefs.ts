// Whether "Edit message" keeps the original as a separate conversation.
//
// Off by default: an edit continues the SAME conversation from the edited
// message — same tab, same sidebar row, same name — and the version before the
// edit is hidden (the backend soft-deletes the row holding it, so it can still
// be restored from Import sessions). On, the original stays in the sidebar as
// its own conversation named "… (before edit)", as edits always used to.
//
// Persisted in localStorage, same shape as `office-preview-prefs`: the
// Settings window writes it, and the workspace window reads it at the moment an
// edit is saved — and live, for the editor's wording.

import { useEffect, useState } from "react"

const KEEP_ORIGINAL_KEY = "settings:edit-message:keep-original"
const KEEP_ORIGINAL_EVENT = "codeg:edit-message-keep-original-changed"

export function loadKeepOriginalOnEdit(): boolean {
  if (typeof window === "undefined") return false
  try {
    // Default OFF: only an explicit "true" keeps the original.
    return localStorage.getItem(KEEP_ORIGINAL_KEY) === "true"
  } catch {
    return false
  }
}

export function saveKeepOriginalOnEdit(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(KEEP_ORIGINAL_KEY, String(value))
  } catch {
    /* ignore */
  }
  // Same-window listeners (settings and workspace may share a window);
  // other windows/tabs get the native `storage` event.
  window.dispatchEvent(new CustomEvent(KEEP_ORIGINAL_EVENT, { detail: value }))
}

/**
 * Reactive read of the preference, plus the setter that persists it. Follows
 * changes made in this window and in any other, so flipping it in Settings
 * rewords an editor that is already open.
 */
export function useKeepOriginalOnEdit(): [boolean, (value: boolean) => void] {
  const [keep, setKeep] = useState<boolean>(loadKeepOriginalOnEdit)
  useEffect(() => {
    const sync = () => setKeep(loadKeepOriginalOnEdit())
    window.addEventListener(KEEP_ORIGINAL_EVENT, sync)
    window.addEventListener("storage", sync)
    return () => {
      window.removeEventListener(KEEP_ORIGINAL_EVENT, sync)
      window.removeEventListener("storage", sync)
    }
  }, [])
  return [keep, saveKeepOriginalOnEdit]
}
