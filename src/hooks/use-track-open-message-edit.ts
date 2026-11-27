"use client"

import { useCallback, useId } from "react"
import { useTabActions } from "@/contexts/tab-context"
import { setOpenMessageEdit } from "@/lib/open-message-edits"

/**
 * For a conversation tab's message list (`MessageListView`'s
 * `onEditingChange`): what is typed into an open "Edit message" exists only
 * in the list, so while one is open the tab is recorded as having it (see
 * `lib/open-message-edits`) and opening another session leaves the tab be.
 * A preview that opens one is kept, as sending from it keeps it, since a
 * preview is what the next session opened from the sidebar takes.
 */
export function useTrackOpenMessageEdit(
  tabId: string
): (open: boolean) => void {
  const { pinTab } = useTabActions()
  const instanceId = useId()
  return useCallback(
    (open: boolean) => {
      setOpenMessageEdit(tabId, instanceId, open)
      if (open) pinTab(tabId)
    },
    [tabId, instanceId, pinTab]
  )
}
