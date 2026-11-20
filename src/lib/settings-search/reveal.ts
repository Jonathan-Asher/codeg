/**
 * Taking a settings search result to its place on the page: scroll the
 * setting into view and mark it for a moment (`[data-settings-highlight]` in
 * globals.css).
 *
 * The page may not be there yet. A result on another page navigates first,
 * and the setting turns up once that page has mounted and loaded what it
 * shows, so the target is waited for. Windows reloads the document to change
 * page (see `SettingsShell`), so the pending target goes through
 * sessionStorage rather than memory.
 */

export const SETTINGS_ANCHOR_ATTRIBUTE = "data-settings-anchor"
export const SETTINGS_HIGHLIGHT_ATTRIBUTE = "data-settings-highlight"

const PENDING_REVEAL_KEY = "settings:search-reveal"
/** How long a target may take to appear: the slowest pages load over IPC. */
const REVEAL_TIMEOUT_MS = 5000
/**
 * How long the section may stand in before the setting itself turns up. A row
 * renders with its section, so one still missing after this is hidden (a
 * folded section, an option this machine does not offer).
 */
const FALLBACK_GRACE_MS = 400
const HIGHLIGHT_MS = 1800
const POLL_MS = 50

interface PendingReveal {
  path: string
  anchors: string[]
}

let pendingInMemory: PendingReveal | null = null

/** Remember where to go once `path` has opened. */
export function setPendingSettingsReveal(
  path: string,
  anchors: readonly string[]
): void {
  const pending = { path, anchors: [...anchors] }
  pendingInMemory = pending
  try {
    window.sessionStorage.setItem(PENDING_REVEAL_KEY, JSON.stringify(pending))
  } catch {
    // Storage unavailable: the in-memory copy covers a client-side navigation.
  }
}

/** The anchors waiting for `path`, once; anything left for another page is dropped. */
export function takePendingSettingsReveal(path: string): string[] | null {
  let pending = pendingInMemory
  pendingInMemory = null
  try {
    const raw = window.sessionStorage.getItem(PENDING_REVEAL_KEY)
    window.sessionStorage.removeItem(PENDING_REVEAL_KEY)
    if (!pending && raw) pending = JSON.parse(raw) as PendingReveal
  } catch {
    // Unreadable: whatever memory holds is all there is.
  }
  if (!pending || pending.path !== path || !Array.isArray(pending.anchors)) {
    return null
  }
  return pending.anchors.filter((anchor) => typeof anchor === "string")
}

function findAnchor(anchor: string): HTMLElement | null {
  // Anchors are dotted lowercase ids (the registry test holds them to it), so
  // they sit in the attribute selector as they are.
  return document.querySelector<HTMLElement>(
    `[${SETTINGS_ANCHOR_ATTRIBUTE}="${anchor}"]`
  )
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

function land(element: HTMLElement): void {
  element.scrollIntoView?.({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  })
  // Re-armed, so picking the same result twice flashes it twice.
  element.removeAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE)
  void element.offsetWidth
  element.setAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE, "")
  window.setTimeout(
    () => element.removeAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE),
    HIGHLIGHT_MS
  )
}

/**
 * Scroll to the first of `anchors` that shows, most precise first, waiting for
 * it to appear. Returns a cancel for a page that changes again meanwhile.
 */
export function revealSettingsAnchor(anchors: readonly string[]): () => void {
  if (anchors.length === 0) return () => {}
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const started = Date.now()
  let fallbackSince: number | null = null

  const tick = () => {
    timer = null
    if (cancelled) return
    const [primary, ...rest] = anchors.map(findAnchor)
    if (primary) {
      land(primary)
      return
    }
    const fallback = rest.find((element) => element !== null) ?? null
    const now = Date.now()
    if (fallback) {
      fallbackSince ??= now
      if (now - fallbackSince >= FALLBACK_GRACE_MS) {
        land(fallback)
        return
      }
    }
    if (now - started >= REVEAL_TIMEOUT_MS) return
    timer = setTimeout(tick, POLL_MS)
  }

  tick()
  return () => {
    cancelled = true
    if (timer !== null) clearTimeout(timer)
  }
}
