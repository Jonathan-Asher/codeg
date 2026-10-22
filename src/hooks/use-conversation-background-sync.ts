"use client"

import { useEffect } from "react"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_BACKGROUND_EVENT,
  type ConversationBackgroundChange,
} from "@/lib/types"
import {
  applyLiveBackgroundChange,
  refreshConversationBackground,
} from "@/stores/conversation-background-store"

/**
 * Keep every session row's background status in sync with the backend:
 * snapshot on mount and after every transport reconnect, live events in
 * between. Mounted once per window, beside the attention sync.
 */
export function useConversationBackgroundSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void refreshConversationBackground()

    void (async () => {
      const dispose = await subscribe<ConversationBackgroundChange>(
        CONVERSATION_BACKGROUND_EVENT,
        (change) => applyLiveBackgroundChange(change)
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    // Returns null on desktop IPC (no disconnect window) → no-op there.
    const offReconnect = onTransportReconnect(
      () => refreshConversationBackground(),
      { priority: "status", key: "background" }
    )

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}
