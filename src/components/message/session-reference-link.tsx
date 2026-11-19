"use client"

import { useCallback, type MouseEvent } from "react"

import { ReferenceBadge } from "@/components/chat/composer/badges/reference-badge"
import type { ReferenceAttrs } from "@/components/chat/composer/types"
import { requestConversationFocus } from "@/lib/conversation-focus"
import {
  notifySessionLink,
  openSessionLink,
  sessionLinkUri,
} from "@/lib/session-link"

/**
 * A session reference badge in a transcript, clickable: its session opens in
 * this window when it lives on this window's server (or the link names no
 * server), and in the workspace window of the server it names otherwise —
 * the same way a `codeg://` link clicked in another app opens.
 *
 * No translator here: a transcript can hold hundreds of badges. What a click
 * has to say goes to the workspace's bridge ({@link notifySessionLink}).
 */
export function SessionReferenceLink({ data }: { data: ReferenceAttrs }) {
  const uri = data.uri ?? sessionLinkUri(data.id, null)

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      void openSessionLink(uri, {
        openHere: (target) => {
          requestConversationFocus(target)
        },
        notify: notifySessionLink,
      })
    },
    [uri]
  )

  // The same button metrics as a file badge (`markdown-link.tsx`): a bare
  // `<button>` lays out taller than the span badge beside it and sits low.
  return (
    <button
      type="button"
      data-session-link=""
      title={uri}
      onClick={handleClick}
      className="inline-flex max-w-full -translate-y-[1.5px] cursor-pointer appearance-none items-center align-middle leading-none hover:opacity-80"
    >
      <ReferenceBadge data={data} />
    </button>
  )
}
