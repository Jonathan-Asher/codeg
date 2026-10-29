"use client"

import { useEffect, type RefObject } from "react"

import {
  canCardTakeFocus,
  focusCardEntry,
  handleComposerArrowUp,
  installCompositionTracker,
  scopeOf,
} from "@/lib/card-focus"

/**
 * Move keyboard focus to a card's entry when its request arrives — each new
 * `arrivalKey` — and again when the card's conversation becomes the active
 * one (`enabled` turning on). Never from someone typing: see
 * `canCardTakeFocus`.
 */
export function useCardArrivalFocus(
  cardRef: RefObject<HTMLElement | null>,
  arrivalKey: string | null,
  enabled: boolean
): void {
  useEffect(() => {
    installCompositionTracker()
  }, [])
  useEffect(() => {
    if (!enabled || arrivalKey === null) return
    const card = cardRef.current
    if (card && canCardTakeFocus(card)) focusCardEntry(card)
  }, [arrivalKey, enabled, cardRef])
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
