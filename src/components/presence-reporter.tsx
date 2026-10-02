"use client"

import { useEffect } from "react"

import { shownConversations, startPresenceReporting } from "@/lib/presence"

/** Tells the backend whether the user is looking at this window (see
 *  `src/lib/presence.ts`). Mounted once per window. */
export function PresenceReporter() {
  useEffect(() => startPresenceReporting(shownConversations), [])
  return null
}
