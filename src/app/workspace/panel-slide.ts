"use client"

import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react"
import { useMediaQuery } from "@/hooks/use-media-query"

// Slide duration for panel show/hide; must match the CSS transition on
// `.panel-slide-animating > [data-panel]` in globals.css. The transition class
// is held a touch past this so the animation finishes before it's removed
// (removing it mid-transition would snap the final pixels).
export const PANEL_SLIDE_MS = 240
export const PANEL_SLIDE_CLEANUP_MS = PANEL_SLIDE_MS + 60

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/**
 * Returns `true` for a brief window after `open` flips, so the caller can add
 * the `.panel-slide-animating` class that animates the panel resize (a "push"
 * slide) on explicit show/hide toggles only — never on the initial mount, on
 * localStorage hydration, during resize-handle drags, or when the user asked
 * for reduced motion (the panel then snaps, and nothing is held still for a
 * slide that isn't running). The first settled `open` value (once `ready`)
 * establishes a baseline without animating.
 *
 * The toggle is detected during render (React's sanctioned "adjust state when a
 * prop changes" pattern) rather than in an effect: turning the class on in the
 * render that observes the flip lands it in the same commit as the panel
 * resize, so the browser has the transition in place before `flex-grow`
 * changes. Turn-off is deferred to a timer keyed on a per-toggle sequence, so a
 * fresh toggle mid-slide re-arms the timer instead of inheriting the old one.
 */
export function usePanelSlideOnToggle(open: boolean, ready: boolean): boolean {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY)
  const [animating, setAnimating] = useState(false)
  const [slideSeq, setSlideSeq] = useState(0)
  const [prevOpen, setPrevOpen] = useState<boolean | null>(null)

  if (ready) {
    if (prevOpen === null) {
      // Adopt the hydrated value as the baseline without animating.
      setPrevOpen(open)
    } else if (prevOpen !== open) {
      setPrevOpen(open)
      if (!reducedMotion) {
        setAnimating(true)
        setSlideSeq((seq) => seq + 1)
      }
    }
  }

  useEffect(() => {
    if (slideSeq === 0) return
    const timer = setTimeout(() => setAnimating(false), PANEL_SLIDE_CLEANUP_MS)
    return () => clearTimeout(timer)
  }, [slideSeq])

  return animating && !reducedMotion
}

/**
 * Inline style that holds a side panel's content at `width` (its final width)
 * while the panel slides open, pinned to the panel edge that meets the centre
 * column (`end` for the sidebar, `start` for the aux panel — logical, so it
 * follows an RTL locale), so the content slides in whole and the panel's
 * overflow clip uncovers it. Strict containment plus its own layer keep the
 * per-frame resize of the panel from re-laying out or repainting it.
 */
export function slideHoldStyle(
  edge: "start" | "end",
  width: number
): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    [edge === "start" ? "insetInlineStart" : "insetInlineEnd"]: 0,
    width: Math.max(0, Math.round(width)),
    contain: "strict",
    willChange: "transform",
  }
}

/**
 * Marks a region that keeps its width while a sidebar/aux panel slides:
 * - `center` — a conversation group's tab stack (the shown tab, and the hidden
 *   ones `absolute inset-0` in it). Held at its width and centred on its
 *   container, so the centred session column travels with the panel's centre
 *   exactly as it would re-laid out, and let go when the slide ends. Holding
 *   the stack rather than each tab touches no hidden tab's style: in WebKit
 *   that alone re-lays out the tab, and costs what it saves.
 * - `hold` — another kept-mounted HIDDEN subtree (the hidden file column, a
 *   covered conversation column or surface). Held while it stays hidden; let
 *   go one per frame after the slide — or at once when it is shown (its rule
 *   only applies while it is hidden).
 */
export const SLIDE_FREEZE_ATTR = "data-slide-freeze"
/** Set (to the region's kind) on a held region (see globals.css). */
export const SLIDE_FROZEN_ATTR = "data-slide-frozen"
/** The held width, read by the `[data-slide-frozen]` rules. */
export const SLIDE_FREEZE_WIDTH_VAR = "--slide-freeze-w"
const HIDDEN_SUBTREE_CLASS = "conversation-tab-hidden"

export type SlideFreezeKind = "center" | "hold"

// Bumped by every freeze, so the staggered release of an older slide stops
// as soon as a newer slide has taken hold of the same regions.
let freezeGeneration = 0

/**
 * Holds every `[data-slide-freeze]` region under `root` at the width it has
 * right now, until `releaseSlideFreeze` lets it go (see SLIDE_FREEZE_ATTR for
 * the two kinds). A held region keeps its computed width, so taking hold
 * re-lays out nothing; while it is held the panel's per-frame resize at most
 * moves it — no re-layout of its transcript and no ResizeObserver round
 * (virtua's row measuring, the composer's overflow hooks).
 *
 * All widths are read before any is written, so freezing costs one layout —
 * the one the commit that starts the slide needs anyway.
 */
export function freezeSlideRegions(root: ParentNode): HTMLElement[] {
  freezeGeneration += 1
  // A region inside a hidden subtree is held along with that subtree.
  const regions = Array.from(
    root.querySelectorAll<HTMLElement>(`[${SLIDE_FREEZE_ATTR}]`)
  ).filter((el) => !el.parentElement?.closest(`.${HIDDEN_SUBTREE_CLASS}`))
  const widths = regions.map((el) => el.getBoundingClientRect().width)
  const frozen: HTMLElement[] = []
  regions.forEach((el, index) => {
    const width = widths[index]
    if (!(width > 0)) return
    const kind: SlideFreezeKind =
      el.getAttribute(SLIDE_FREEZE_ATTR) === "hold" ? "hold" : "center"
    el.style.setProperty(SLIDE_FREEZE_WIDTH_VAR, `${width}px`)
    el.setAttribute(SLIDE_FROZEN_ATTR, kind)
    frozen.push(el)
  })
  return frozen
}

function letGo(el: HTMLElement): void {
  el.removeAttribute(SLIDE_FROZEN_ATTR)
  el.style.removeProperty(SLIDE_FREEZE_WIDTH_VAR)
}

/**
 * Lets the regions of a slide go: the shown one now (its one re-layout at the
 * final width), the ones still hidden one per animation frame — each then
 * re-lays out at the new width on its own frame, instead of all of them in the
 * frame after the slide. A newer slide's freeze ends the stagger; it holds
 * those regions again and lets them go itself.
 */
export function releaseSlideFreeze(frozen: readonly HTMLElement[]): void {
  const stillHidden: HTMLElement[] = []
  for (const el of frozen) {
    if (
      el.getAttribute(SLIDE_FROZEN_ATTR) === "hold" &&
      el.classList.contains(HIDDEN_SUBTREE_CLASS)
    ) {
      stillHidden.push(el)
    } else {
      letGo(el)
    }
  }
  if (stillHidden.length === 0) return
  const generation = freezeGeneration
  let next = 0
  const step = () => {
    if (generation !== freezeGeneration) return
    letGo(stillHidden[next])
    next += 1
    if (next < stillHidden.length) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/**
 * Freezes the `[data-slide-freeze]` regions under `rootRef` for as long as
 * `active` is true. A layout effect, so the widths are read in the commit that
 * starts the slide — before the panel group applies its new layout — and the
 * hold is in place before the first frame of the transition.
 */
export function useSlideFreeze(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean
): void {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!active || !root) return
    const frozen = freezeSlideRegions(root)
    return () => releaseSlideFreeze(frozen)
  }, [active, rootRef])
}
