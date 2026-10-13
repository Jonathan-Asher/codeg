/**
 * Chat text size: a second, narrower zoom that scales only the conversation's
 * own text — message bodies, code blocks, tool output, user bubbles and the
 * composer's input — and leaves the sidebar, tabs, status bar, settings and
 * every other panel alone. The window zoom (`theme-presets` ZOOM_LEVELS) scales
 * everything; the two compound.
 *
 * Mechanism: one number on <html>, `--chat-text-scale`, which a
 * `.chat-text-scope` element turns into scaled `--text-*` tokens for its own
 * subtree (see globals.css). Every Tailwind v4 text utility resolves through
 * those tokens, so the transcript reflows with real font sizes — no CSS
 * `zoom`, no transform — and the virtualizer measures true row heights.
 *
 * One value per device, shared by every conversation on screen (tabs, split
 * panes, Quick Ask, canvas cards) and every window, like the window zoom.
 */

/** Same idea as the window zoom rungs, capped where a transcript stays usable. */
export const CHAT_TEXT_SCALE_LEVELS = [
  80, 90, 100, 110, 125, 150, 175, 200,
] as const

export type ChatTextScaleLevel = (typeof CHAT_TEXT_SCALE_LEVELS)[number]

export const DEFAULT_CHAT_TEXT_SCALE: ChatTextScaleLevel = 100

export const MIN_CHAT_TEXT_SCALE: ChatTextScaleLevel = CHAT_TEXT_SCALE_LEVELS[0]
export const MAX_CHAT_TEXT_SCALE: ChatTextScaleLevel =
  CHAT_TEXT_SCALE_LEVELS[CHAT_TEXT_SCALE_LEVELS.length - 1]

/** localStorage key (per device, like the window zoom). */
export const STORAGE_KEY_CHAT_TEXT_SCALE = "codeg-chat-text-scale"

/** The custom property on <html> that `.chat-text-scope` reads. */
export const CHAT_TEXT_SCALE_PROPERTY = "--chat-text-scale"

/** Put on an element whose text should follow the chat text size. */
export const CHAT_TEXT_SCOPE_CLASS = "chat-text-scope"

/**
 * Fired on `window` synchronously right BEFORE the new scale is written, so a
 * scrolled transcript can note what the reader is looking at while the old
 * row heights are still in place, and put it back once the rows re-measure.
 */
export const CHAT_TEXT_SCALE_WILL_CHANGE_EVENT =
  "codeg:chat-text-scale-will-change"

export function isChatTextScaleLevel(
  value: unknown
): value is ChatTextScaleLevel {
  return (
    typeof value === "number" &&
    (CHAT_TEXT_SCALE_LEVELS as readonly number[]).includes(value)
  )
}

/**
 * Any stored or typed value to a rung: clamped to the range, then snapped to
 * the nearest rung (the lower one on a tie). Anything unreadable is 100%.
 */
export function normalizeChatTextScale(raw: unknown): ChatTextScaleLevel {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_CHAT_TEXT_SCALE
  const clamped = Math.min(
    MAX_CHAT_TEXT_SCALE,
    Math.max(MIN_CHAT_TEXT_SCALE, n)
  )
  let best: ChatTextScaleLevel = CHAT_TEXT_SCALE_LEVELS[0]
  for (const level of CHAT_TEXT_SCALE_LEVELS) {
    if (Math.abs(level - clamped) < Math.abs(best - clamped)) best = level
  }
  return best
}

/** Next rung up or down; stays put at either end. */
export function stepChatTextScale(
  current: ChatTextScaleLevel,
  direction: 1 | -1
): ChatTextScaleLevel {
  const index = CHAT_TEXT_SCALE_LEVELS.indexOf(normalizeChatTextScale(current))
  const next = Math.min(
    CHAT_TEXT_SCALE_LEVELS.length - 1,
    Math.max(0, index + direction)
  )
  return CHAT_TEXT_SCALE_LEVELS[next]
}

export function readStoredChatTextScale(): ChatTextScaleLevel {
  if (typeof window === "undefined") return DEFAULT_CHAT_TEXT_SCALE
  try {
    return normalizeChatTextScale(
      window.localStorage.getItem(STORAGE_KEY_CHAT_TEXT_SCALE)
    )
  } catch {
    return DEFAULT_CHAT_TEXT_SCALE
  }
}

export function persistChatTextScale(level: ChatTextScaleLevel): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_CHAT_TEXT_SCALE, String(level))
  } catch {
    // Private mode / disabled storage: the size still applies this session.
  }
}

/**
 * Write the scale onto <html>. 100% removes the property instead of writing 1,
 * so a profile that never touched the setting carries nothing extra (the CSS
 * falls back to 1).
 */
export function applyChatTextScale(
  root: HTMLElement,
  level: ChatTextScaleLevel
): void {
  if (level === DEFAULT_CHAT_TEXT_SCALE) {
    root.style.removeProperty(CHAT_TEXT_SCALE_PROPERTY)
  } else {
    root.style.setProperty(CHAT_TEXT_SCALE_PROPERTY, String(level / 100))
  }
}
