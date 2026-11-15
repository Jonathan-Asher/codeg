import {
  isShown,
  isTypingTarget,
  pendingCardEntry,
  scopeOf,
} from "@/lib/card-focus"

/**
 * When the keyboard goes to a conversation's composer without the user
 * clicking into it: they went to the chat (any route: a tab, a sidebar row,
 * search, a shortcut, a notification, a deep link), or brought its window
 * back to the front. The policy lives here as plain DOM, beside the card
 * hand-off in `card-focus`; the composer that acts on it is
 * `useComposerAutoFocus`.
 *
 * - A switch puts the caret in the composer, unless a card of that
 *   conversation is waiting (the card takes the keyboard, see
 *   `useCardArrivalFocus`) or the user is already typing in that conversation.
 * - A tab moved by another client (the phone, another window) moves nothing:
 *   see {@link noteTabActivation}.
 * - The window coming back moves the keyboard only off somewhere useless; see
 *   {@link refocusTarget}.
 *
 * Element focus only: nothing here raises or activates a window.
 */

/** Marks a conversation's transcript inside its composer scope. */
export const COMPOSER_THREAD_ATTR = "data-composer-thread"

const THREAD_SELECTOR = `[${COMPOSER_THREAD_ATTR}]`
// A layer that holds the keyboard while it is up: an open dialog, popover,
// menu or drawer, or the focus guards Radix and Base UI set out around a
// modal one (still there while it animates closed).
const FOCUS_GUARD_SELECTOR =
  "[data-radix-focus-guard], [data-base-ui-focus-guard]"
const OPEN_LAYER_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="dialog"][data-open]',
  FOCUS_GUARD_SELECTOR,
].join(", ")
const LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'
// Only a press this fresh is waited for. One whose release never reached the
// page (a native window drag from the title bar) must not hold a later switch.
const PRESS_WAIT_MS = 1000

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now()

// ── Who moved the tab in front ─────────────────────────────────────────────

let remoteActivation = false

/**
 * The tab store reports each change of the active tab: `remote` when it came
 * from another client's snapshot (focus is mirrored across clients). A switch
 * made there is not the user arriving here, so the composer it brings to the
 * front waits; the user's next press or key in this window ends that, as does
 * any switch made here.
 */
export function noteTabActivation(remote: boolean): void {
  remoteActivation = remote
}

/** Did the last change of the active tab come from another client? */
export function isRemoteActivation(): boolean {
  return remoteActivation
}

// ── Asking again for the tab in front ──────────────────────────────────────

const requestListeners = new Set<() => void>()

/**
 * The user asked for the tab that is already in front (its sidebar row, a
 * search pick, a notification): no tab change will hand its composer the
 * keyboard, so ask for it. Call it before the store writes, so it is heard by
 * the composer in front now, which is the one asked for.
 */
export function requestComposerFocus(): void {
  for (const listener of [...requestListeners]) listener()
}

export function onComposerFocusRequest(listener: () => void): () => void {
  requestListeners.add(listener)
  return () => {
    requestListeners.delete(listener)
  }
}

// ── Presses, and the window coming back ────────────────────────────────────

const refocusListeners = new Set<() => void>()
const releaseListeners = new Set<() => void>()
// A press since the window last lost focus: the click that brought it back
// (whichever of the two events an engine sends first).
let pressedSinceBlur = false
let pressing = false
let pressedAt = -Infinity
let trackersInstalled = false

function installTrackers(): void {
  if (trackersInstalled || typeof window === "undefined") return
  trackersInstalled = true
  document.addEventListener(
    "pointerdown",
    () => {
      pressedSinceBlur = true
      pressing = true
      pressedAt = now()
      remoteActivation = false
      // Waiting on a press that never came up (released outside the page):
      // that moment has passed.
      releaseListeners.clear()
    },
    true
  )
  const release = () => {
    pressing = false
    const waiting = [...releaseListeners]
    releaseListeners.clear()
    for (const listener of waiting) listener()
  }
  document.addEventListener("pointerup", release, true)
  document.addEventListener("pointercancel", release, true)
  document.addEventListener(
    "keydown",
    () => {
      remoteActivation = false
    },
    true
  )
  // Not in the capture phase: `blur` and `focus` don't bubble, so these see
  // only the window's own.
  window.addEventListener("blur", () => {
    pressedSinceBlur = false
    pressing = false
    releaseListeners.clear()
  })
  // Heard a frame later, once the press that may have come with it has
  // landed: a click that brings the window back points at what the user
  // wants, and is left to decide.
  window.addEventListener("focus", () => {
    requestAnimationFrame(() => {
      if (pressedSinceBlur) return
      for (const listener of [...refocusListeners]) listener()
    })
  })
}

installTrackers()

/** Called a frame after the window comes back to the front, unless a press
 *  brought it back. */
export function onWindowRefocus(listener: () => void): () => void {
  installTrackers()
  refocusListeners.add(listener)
  return () => {
    refocusListeners.delete(listener)
  }
}

/**
 * Run `run` once no pointer is held down: now, or when the press ends. A
 * switch made by pressing into a conversation (a split pane's transcript)
 * waits for the press to finish, so a drag selecting text is not cut short
 * and what it selected is still there to see. Returns a cancel.
 */
export function whenPointerReleased(run: () => void): () => void {
  installTrackers()
  if (!pressing || now() - pressedAt > PRESS_WAIT_MS) {
    run()
    return () => {}
  }
  releaseListeners.add(run)
  return () => {
    releaseListeners.delete(run)
  }
}

// ── Where the keyboard goes ────────────────────────────────────────────────

/** Nowhere, the page itself, or an element no longer on screen (the tab just
 *  left, a closed palette): a place nobody is typing. */
function isAway(active: Element | null): boolean {
  return (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    !isShown(active)
  )
}

/** Is a dialog, menu or popover up over the conversation of `composer`? One
 *  the composer itself sits in (a drawer holding the chat) is its surface, not
 *  a layer over it. */
function layerOver(composer: Element): boolean {
  const inLayer = composer.closest(LAYER_SELECTOR) !== null
  const over = (layer: Element) => isShown(layer) && !layer.contains(composer)
  for (const layer of document.querySelectorAll(OPEN_LAYER_SELECTOR)) {
    // The guards of the layer the composer sits in; one stacked over it is
    // still seen by its own role.
    if (inLayer && layer.matches(FOCUS_GUARD_SELECTOR)) continue
    if (over(layer)) return true
  }
  const activeLayer = document.activeElement?.closest(LAYER_SELECTOR)
  return activeLayer != null && over(activeLayer)
}

/** Text selected on screen (inside `within`, when given): the user is reading
 *  or copying it, and a focus move would drop the selection. */
function selectingText(within?: Element | null): boolean {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false
  }
  const node = selection.anchorNode
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  if (within !== undefined && !(el && within?.contains(el))) return false
  return isShown(el)
}

/**
 * Should a switch to the conversation of `composer` put the caret in it? Not
 * while one of its cards is waiting (the card has the keyboard), not when the
 * user is already typing in that conversation (its composer, its find bar),
 * and not over text selected in it. From anywhere else, yes: the switch is
 * the user's.
 */
export function composerTakesSwitch(composer: Element): boolean {
  if (typeof document === "undefined" || !isShown(composer)) return false
  const scope = scopeOf(composer)
  if (pendingCardEntry(scope)) return false
  const active = document.activeElement
  if (
    active &&
    !isAway(active) &&
    scope?.contains(active) &&
    isTypingTarget(active)
  ) {
    return false
  }
  return !selectingText(scope)
}

export type RefocusTarget = "composer" | "card" | null

/**
 * The window came back to the front with `composer`'s conversation in it:
 * where should the keyboard go? Somewhere only when it is somewhere useless —
 * nowhere, off screen, a button, a sidebar or tab row, the transcript — and
 * then to the card waiting there, else the composer. Left alone in a text
 * field (the composer itself, the terminal, a search box, a settings field, a
 * card's own field) or an embedded page, in a waiting card's controls, under
 * an open dialog, menu or popover, and while text on screen is selected.
 */
export function refocusTarget(composer: Element): RefocusTarget {
  if (typeof document === "undefined" || !isShown(composer)) return null
  if (layerOver(composer)) return null
  const scope = scopeOf(composer)
  const card = pendingCardEntry(scope)
  const active = document.activeElement
  if (active && !isAway(active)) {
    // A frame (a page preview) keeps its own focus, typing included.
    if (isTypingTarget(active) || active instanceof HTMLIFrameElement) {
      return null
    }
    if (card && scope?.contains(active) && !active.closest(THREAD_SELECTOR)) {
      return null
    }
  }
  if (selectingText()) return null
  return card ? "card" : "composer"
}
