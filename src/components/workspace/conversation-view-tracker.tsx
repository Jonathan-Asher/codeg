"use client"

import { useEffect } from "react"

import { startConversationViewTracking } from "@/lib/conversation-views"

/** Records the conversations the user opens in this window, so every
 *  client's session lists can order by them (see `lib/recent-sessions`). */
export function ConversationViewTracker() {
  useEffect(() => startConversationViewTracking(), [])
  return null
}
