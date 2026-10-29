import { isImeCompositionKey } from "@/lib/ime-composition"

/**
 * Keyboard hand-off between a conversation's composer and the cards that hold
 * its turn open (ask-question, permission, plan approval, question dialog).
 *
 * The conversation's root carries {@link COMPOSER_SCOPE_ATTR}. Inside it the
 * composer input is the rich composer's editable (`.codeg-composer-content`) or
 * any element marked `data-composer-input` (quick ask's textarea). Each live
 * card marks the one element keyboard focus lands on with
 * {@link CARD_ENTRY_ATTR}.
 *
 * Plain DOM on purpose: the composer and the cards are siblings that share no
 * state, the same pieces mount in a tab, a canvas card, the web client and a
 * remote-workspace window, and a capture listener on the scope sees the
 * composer's keys before ProseMirror does.
 */

export const COMPOSER_SCOPE_ATTR = "data-composer-scope"
export const CARD_ENTRY_ATTR = "data-card-entry"

const SCOPE_SELECTOR = `[${COMPOSER_SCOPE_ATTR}]`
const ENTRY_SELECTOR = `[${CARD_ENTRY_ATTR}]`
const COMPOSER_SELECTOR = ".codeg-composer-content, [data-composer-input]"
const POPUP_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]'
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
])

// The element an IME is composing in, anywhere on the page. A capture listener
// on the document sees every composition, including the rich composer's,
// whose ProseMirror flag is out of reach from here.
let composingEl: Element | null = null
let trackerInstalled = false

export function installCompositionTracker(): void {
  if (trackerInstalled || typeof document === "undefined") return
  trackerInstalled = true
  document.addEventListener(
    "compositionstart",
    (event) => {
      composingEl = event.target instanceof Element ? event.target : null
    },
    true
  )
  document.addEventListener(
    "compositionend",
    () => {
      composingEl = null
    },
    true
  )
}

function isComposing(): boolean {
  // A control removed mid-composition never fires `compositionend`.
  if (composingEl && !composingEl.isConnected) composingEl = null
  return composingEl !== null
}

function isEditable(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true
  }
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type)
  if (el instanceof HTMLElement && el.isContentEditable) return true
  // jsdom has no `isContentEditable`; the attribute says the same thing.
  return (
    el.closest('[contenteditable]:not([contenteditable="false"]), .xterm') !==
    null
  )
}

function isComposerEmpty(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value === ""
  }
  // The placeholder is CSS; an inline badge or image is an atom with no text.
  return (
    (el.textContent ?? "") === "" &&
    el.querySelector('img, [contenteditable="false"]') === null
  )
}

export function scopeOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>(SCOPE_SELECTOR) ?? null
}

/**
 * May a card that just arrived take keyboard focus? Yes from nowhere, from
 * inside itself, from its own conversation's EMPTY composer, or from a plain
 * control of its own conversation. Never from someone typing — a composer with
 * text, an IME composition, any other field — and never out of another
 * conversation, a dialog or a menu.
 */
export function canCardTakeFocus(card: Element): boolean {
  if (typeof document === "undefined") return false
  const active = document.activeElement
  if (
    !active ||
    active === document.body ||
    active === document.documentElement
  ) {
    return true
  }
  if (card.contains(active)) return true
  if (isComposing()) return false
  const scope = scopeOf(card)
  const composer = active.closest(COMPOSER_SELECTOR)
  if (composer) {
    return (
      scope !== null && scope.contains(composer) && isComposerEmpty(composer)
    )
  }
  if (isEditable(active)) return false
  const activeScope = scopeOf(active)
  if (activeScope && activeScope !== scope) return false
  const popup = active.closest(POPUP_SELECTOR)
  return !popup || popup.contains(card)
}

/** Focus the card's entry element. Returns false when it has none. */
export function focusCardEntry(card: Element | null): boolean {
  const entry = card?.querySelector<HTMLElement>(ENTRY_SELECTOR)
  if (!entry) return false
  entry.focus()
  return true
}

/** The composer input of the card's conversation, if it has one. */
export function composerFor(card: Element | null): HTMLElement | null {
  return scopeOf(card)?.querySelector<HTMLElement>(COMPOSER_SELECTOR) ?? null
}

/** Esc from a card: hand the keyboard back to its conversation's composer.
 *  Returns false when there is no composer to go to. */
export function focusComposerFrom(card: Element | null): boolean {
  const composer = composerFor(card)
  if (!composer) return false
  composer.focus()
  return true
}

/**
 * Call before a card sends its answer; call what it returns once the answer
 * has landed. When the keyboard was in the card it goes back to the composer —
 * the card is about to go inert and unmount, which would drop focus on the
 * page body — unless the user has moved it somewhere else meanwhile.
 */
export function focusComposerAfterAnswer(card: Element | null): () => void {
  const composer =
    card !== null && card.contains(document.activeElement)
      ? composerFor(card)
      : null
  return () => {
    if (!composer?.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body && !card?.contains(active)) return
    composer.focus()
  }
}

/**
 * ↑ in an empty composer moves into the nearest pending card above it (the
 * last entry in document order). Consumes the key — before the composer's own
 * prompt-history recall sees it — and returns true when it did.
 */
export function handleComposerArrowUp(
  event: KeyboardEvent,
  scope: Element
): boolean {
  if (event.key !== "ArrowUp") return false
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false
  }
  if (isImeCompositionKey(event) || isComposing()) return false
  const target = event.target instanceof Element ? event.target : null
  const composer = target?.closest(COMPOSER_SELECTOR)
  if (!composer || !scope.contains(composer) || !isComposerEmpty(composer)) {
    return false
  }
  const entries = scope.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)
  const entry = entries[entries.length - 1]
  if (!entry) return false
  event.preventDefault()
  event.stopPropagation()
  entry.focus()
  return true
}

/** True for a keydown aimed at a text field, where letters and Enter type. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && isEditable(target)
}
