"use client"

import { useEffect } from "react"

import { setShownConversations } from "@/lib/presence"
import { useTabStore } from "@/stores/tab-store"

function activeConversationIds(): number[] {
  const { activeTabId, tabs } = useTabStore.getState()
  const id = tabs.find((tab) => tab.id === activeTabId)?.conversationId
  return id == null ? [] : [id]
}

/** Feeds the session in this window's active tab to the presence reports,
 *  so nothing is pushed to the iPhone about a session the user is looking
 *  at. */
export function ShownSessionPresence() {
  useEffect(() => {
    setShownConversations(activeConversationIds())
    const unsubscribe = useTabStore.subscribe(() =>
      setShownConversations(activeConversationIds())
    )
    return () => {
      unsubscribe()
      setShownConversations([])
    }
  }, [])
  return null
}
