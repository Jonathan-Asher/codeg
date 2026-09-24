"use client"

import { useEffect } from "react"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_ATTENTION_EVENT,
  type ConversationAttentionChange,
} from "@/lib/types"
import {
  applyLiveAttentionChange,
  refreshConversationAttention,
} from "@/stores/conversation-attention-store"

/**
 * Keep the sidebar's "waiting on you" indicator in sync with the backend:
 * snapshot on mount and after every transport reconnect, live events in
 * between. Mounted once per window, next to the other cross-client
 * side-channel subscriptions (`AppWorkspaceProvider`).
 */
export function useConversationAttentionSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void refreshConversationAttention()

    void (async () => {
      const dispose = await subscribe<ConversationAttentionChange>(
        CONVERSATION_ATTENTION_EVENT,
        (change) => applyLiveAttentionChange(change)
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    // Returns null on desktop IPC (no disconnect window) → no-op there.
    const offReconnect = onTransportReconnect(() => {
      void refreshConversationAttention()
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}
