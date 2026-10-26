/**
 * Keys typed between the session switcher's shortcut and its search box
 * taking focus.
 *
 * ⌘K then Enter is one gesture, like Alt-Tab, so whatever is typed after the
 * shortcut belongs to the switcher: an Enter acts on the preselected session
 * and letters go into the search box — never into the composer that still
 * held focus when the shortcut was pressed, where an Enter would send the
 * draft. The switcher normally has its search box focused before the next key
 * is even dispatched; this is the guarantee for when it is not. The shortcut
 * arms it, and until the switcher takes the keys, any key it would understand
 * that is aimed anywhere else is held back here instead.
 */

export interface TypeaheadKey {
  key: string
  code: string
  shiftKey: boolean
}

/** Longest the switcher can take to claim the keys before they are dropped. */
export const TYPEAHEAD_TIMEOUT_MS = 1500

const SWITCHER_KEYS = new Set([
  "Enter",
  "Escape",
  "Backspace",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
])

let armed = false
let held: TypeaheadKey[] = []
let owner: Element | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function isSwitcherKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 || SWITCHER_KEYS.has(event.key)
}

function hold(event: KeyboardEvent): void {
  if (!armed) return
  const target = event.target
  if (owner && target instanceof Node && owner.contains(target)) return
  // An IME composition, a chord (shortcuts, a second ⌘K) and keys the
  // switcher has no use for go where they were going.
  if (event.isComposing || !isSwitcherKey(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  held.push({ key: event.key, code: event.code, shiftKey: event.shiftKey })
}

function disarm(): void {
  armed = false
  if (timer != null) clearTimeout(timer)
  timer = null
  if (typeof window !== "undefined") {
    window.removeEventListener("keydown", hold, true)
  }
}

/** The element whose keys are the switcher's own (its panel). */
export function setQuickSwitchTypeaheadOwner(element: Element | null): void {
  owner = element
}

/** The shortcut was pressed: hold keys aimed elsewhere for the switcher. */
export function armQuickSwitchTypeahead(): void {
  if (typeof window === "undefined") return
  disarm()
  armed = true
  held = []
  window.addEventListener("keydown", hold, true)
  timer = setTimeout(() => {
    disarm()
    held = []
  }, TYPEAHEAD_TIMEOUT_MS)
}

/** The switcher has focus: hand over what was held, in order, and stop. */
export function takeQuickSwitchTypeahead(): TypeaheadKey[] {
  disarm()
  const keys = held
  held = []
  return keys
}

/** The switcher closed (or never opened): drop anything held. */
export function cancelQuickSwitchTypeahead(): void {
  disarm()
  held = []
}

/** Test-only: forget all state. */
export function __resetQuickSwitchTypeaheadForTests(): void {
  cancelQuickSwitchTypeahead()
  owner = null
}
