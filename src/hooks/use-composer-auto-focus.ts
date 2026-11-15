"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import { useOverlayHostHidden } from "@/components/ui/overlay-host-hidden"
import { composerInputIn, focusPendingCard, scopeOf } from "@/lib/card-focus"
import {
  composerTakesSwitch,
  isRemoteActivation,
  onComposerFocusRequest,
  onWindowRefocus,
  refocusTarget,
  whenPointerReleased,
} from "@/lib/composer-focus"

/**
 * Hand a conversation's composer the keyboard when the user goes to the chat
 * and when its window comes back to the front (see `lib/composer-focus` for
 * the rules).
 *
 * "Goes to the chat" is the conversation coming to the front: it becomes the
 * active one (`active` turning on), the surface it sits on is shown again (a
 * full-page route closing), or its composer first exists while it is active
 * (a tab just opened); and the tab in front being asked for again. A reply
 * finishing, a connection coming up or a tab moved by another client is none
 * of these, and moves nothing.
 *
 * `rootRef` holds the composer's input; `focus` puts the caret at the end of
 * the draft without scrolling anything outside the composer.
 */
export function useComposerAutoFocus(
  rootRef: RefObject<HTMLElement | null>,
  {
    active,
    ready,
    focus,
  }: {
    active: boolean
    /** The composer's input exists (the rich editor is built a tick after
     *  mount). */
    ready: boolean
    focus: () => void
  }
): void {
  // Kept mounted but not shown: a background tab, or a workspace under a
  // full-page route (see `OverlayHostHiddenProvider`).
  const hidden = useOverlayHostHidden()
  const inFront = active && !hidden
  const focusRef = useRef(focus)
  useLayoutEffect(() => {
    focusRef.current = focus
  })

  useEffect(() => {
    if (!inFront || !ready) return
    const composer = () => composerInputIn(rootRef.current)
    // A frame later: after the restored draft is in (the caret lands at its
    // end), and after the cards of this commit have taken the keyboard. A
    // switch made by a press waits for the press to end.
    let frame: number | null = null
    let cancelWait = () => {}
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      cancelWait()
      cancelWait = () => {}
    }
    const takeSwitch = () => {
      cancel()
      frame = requestAnimationFrame(() => {
        frame = null
        cancelWait = whenPointerReleased(() => {
          const input = composer()
          if (input && composerTakesSwitch(input)) focusRef.current()
        })
      })
    }
    if (!isRemoteActivation()) takeSwitch()
    const offRequest = onComposerFocusRequest(takeSwitch)
    const offRefocus = onWindowRefocus(() => {
      const input = composer()
      if (!input) return
      const target = refocusTarget(input)
      if (target === "composer") focusRef.current()
      else if (target === "card") focusPendingCard(scopeOf(input))
    })
    return () => {
      cancel()
      offRequest()
      offRefocus()
    }
  }, [inFront, ready, rootRef])
}
