"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react"

import { useOverlayHostHidden } from "@/components/ui/overlay-host-hidden"
import {
  canCardTakeFocus,
  focusCardEntry,
  handleComposerArrowUp,
  installCompositionTracker,
  isShown,
  isWindowFocused,
  releaseKeyboard,
  scopeOf,
} from "@/lib/card-focus"

/**
 * Move keyboard focus to a card's entry when its request arrives — each new
 * `arrivalKey` — and again when the card comes to the front: its conversation
 * becomes the active one (`enabled` turning on), or the surface it sits on is
 * shown again. Never from someone typing (see `canCardTakeFocus`), and never
 * in a window the user is not in: there it waits for the window to come back.
 * A card that goes off screen with the keyboard in it lets go of it.
 */
export function useCardArrivalFocus(
  cardRef: RefObject<HTMLElement | null>,
  arrivalKey: string | null,
  enabled: boolean
): void {
  // Kept mounted but not shown: a background tab, or a workspace under a
  // full-page route (see `OverlayHostHiddenProvider`).
  const hidden = useOverlayHostHidden()
  const inFront = enabled && !hidden
  useEffect(() => {
    installCompositionTracker()
  }, [])
  useEffect(() => {
    if (!inFront || arrivalKey === null) return
    const take = () => {
      const card = cardRef.current
      if (card && canCardTakeFocus(card)) focusCardEntry(card)
    }
    if (isWindowFocused()) {
      take()
      return
    }
    window.addEventListener("focus", take, { once: true })
    return () => window.removeEventListener("focus", take)
  }, [arrivalKey, inFront, cardRef])
  // A layout effect, so it runs before the passive effects of the same commit:
  // the card coming to the front finds the keyboard free.
  useLayoutEffect(() => {
    if (hidden) releaseKeyboard(cardRef.current)
  }, [hidden, cardRef])
}

/**
 * The capture-phase key handler for a card's root. A key typed at a card that
 * is off screen (focus left behind in a background tab) answers nothing: the
 * card lets go of the keyboard and the key goes no further into it. A plain
 * key's default is cancelled too (pressing a focused option, typing in a
 * field); a chord keeps its default so a menu shortcut still works, and its
 * modifier's own keydown has already let go of the card by the time it comes.
 */
export function useCardKeyGuard(
  cardRef: RefObject<HTMLElement | null>
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const card = cardRef.current
      if (!card || isShown(card)) return
      event.stopPropagation()
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
      }
      releaseKeyboard(card)
    },
    [cardRef]
  )
}

/**
 * While the card is pending, ↑ in its conversation's empty composer moves
 * into the nearest pending card. Every pending card registers; whichever runs
 * first picks the nearest one and stops the rest.
 */
export function useComposerHandoff(
  cardRef: RefObject<HTMLElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled) return
    const scope = scopeOf(cardRef.current)
    if (!scope) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (handleComposerArrowUp(event, scope)) event.stopImmediatePropagation()
    }
    scope.addEventListener("keydown", onKeyDown, true)
    return () => scope.removeEventListener("keydown", onKeyDown, true)
  }, [enabled, cardRef])
}
