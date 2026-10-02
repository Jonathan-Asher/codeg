"use client"

import { memo, useEffect, useRef, useSyncExternalStore } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"

import {
  getScrollToLatestVersion,
  subscribeScrollToLatest,
  takeScrollToLatest,
} from "@/lib/scroll-to-latest-intent"

/**
 * Answers a "show the latest message" request (see
 * `lib/scroll-to-latest-intent`) for the conversation this thread shows:
 * jumps to the bottom and re-pins it there, so streaming output keeps it at
 * the newest message — what the scroll-to-bottom button does, on the user's
 * behalf.
 *
 * Takes the request only while its transcript is the active one and has its
 * content (`ready`): a thread still loading leaves it waiting and takes it
 * when the history lands, so the jump measures the real transcript rather
 * than a placeholder. Mounted inside `MessageThread`, whose stick-to-bottom
 * context it drives.
 */
export const ScrollToLatestOnRequest = memo(function ScrollToLatestOnRequest({
  conversationId,
  dbConversationId,
  active,
  ready,
}: {
  /** The transcript's runtime key (virtual for a tab that began as a draft). */
  conversationId: number
  /** The persisted conversation behind it, once there is one. */
  dbConversationId: number | null
  active: boolean
  ready: boolean
}) {
  const { scrollToBottom } = useStickToBottomContext()
  const requestVersion = useSyncExternalStore(
    subscribeScrollToLatest,
    getScrollToLatestVersion,
    getScrollToLatestVersion
  )
  // The follow-up frame outlives a re-run of the effect below (a request for
  // another conversation re-runs it too); only unmounting cancels it.
  const frameRef = useRef({ id: 0 })

  // `requestVersion` is a dependency so a request posted while this thread is
  // already active and loaded is heard; the take decides whether it is ours.
  useEffect(() => {
    if (!active || !ready) return
    if (!takeScrollToLatest([conversationId, dbConversationId])) return
    scrollToBottom("instant")
    // Once more after the virtualizer has measured the rows the jump
    // revealed; from then on the stick-to-bottom lock follows on its own.
    const frame = frameRef.current
    cancelAnimationFrame(frame.id)
    frame.id = requestAnimationFrame(() => {
      scrollToBottom("instant")
    })
  }, [
    active,
    ready,
    requestVersion,
    conversationId,
    dbConversationId,
    scrollToBottom,
  ])

  useEffect(() => {
    const frame = frameRef.current
    return () => cancelAnimationFrame(frame.id)
  }, [])

  return null
})
