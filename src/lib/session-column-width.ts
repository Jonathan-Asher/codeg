/**
 * Session width: how wide the conversation column may grow inside its panel —
 * the message list, the composer, the banners and cards docked above it and
 * the new-conversation welcome screen, which all share one centred column.
 *
 * Mechanism: one custom property on <html>, `--session-column-max-width`,
 * which every column wrapper reads as its `max-width`
 * (`max-w-(--session-column-max-width)`); globals.css gives it the standard
 * 48rem when nothing is written. Widths are in rem, so they follow the window
 * zoom the way the old fixed `max-w-3xl` did.
 *
 * One value per device, shared by every conversation on screen and every
 * window, like the chat text size.
 */

export const SESSION_COLUMN_WIDTH_PRESETS = [
  "standard",
  "wide",
  "extra-wide",
  "full",
] as const

export type SessionColumnWidthPreset =
  (typeof SESSION_COLUMN_WIDTH_PRESETS)[number]

/** A preset, or a custom width in CSS px at 100% window zoom. */
export type SessionColumnWidth = SessionColumnWidthPreset | number

export const DEFAULT_SESSION_COLUMN_WIDTH: SessionColumnWidth = "standard"

/** The fixed presets in px at 100% window zoom. Full has no fixed width. */
export const SESSION_COLUMN_PRESET_PX = {
  standard: 768,
  wide: 1024,
  "extra-wide": 1280,
} as const satisfies Record<Exclude<SessionColumnWidthPreset, "full">, number>

/** Bounds and step of a custom width, in px at 100% window zoom. */
export const MIN_CUSTOM_SESSION_COLUMN_WIDTH = 640
export const MAX_CUSTOM_SESSION_COLUMN_WIDTH = 2560
export const CUSTOM_SESSION_COLUMN_WIDTH_STEP = 32

/** localStorage key (per device, like the chat text size). */
export const STORAGE_KEY_SESSION_COLUMN_WIDTH = "codeg-session-column-width"

/** The custom property on <html> that every column wrapper reads. */
export const SESSION_COLUMN_MAX_WIDTH_PROPERTY = "--session-column-max-width"

/**
 * Full: the whole panel less a 1rem gutter on each side, on top of the
 * column's own padding, so text never runs into the panel edge.
 */
export const FULL_SESSION_COLUMN_MAX_WIDTH = "calc(100% - 2rem)"

export function isSessionColumnWidthPreset(
  value: unknown
): value is SessionColumnWidthPreset {
  return (
    typeof value === "string" &&
    (SESSION_COLUMN_WIDTH_PRESETS as readonly string[]).includes(value)
  )
}

/** A custom width clamped to the allowed range, in whole px. */
export function clampCustomSessionColumnWidth(px: number): number {
  if (!Number.isFinite(px)) return SESSION_COLUMN_PRESET_PX.standard
  return Math.round(
    Math.min(
      MAX_CUSTOM_SESSION_COLUMN_WIDTH,
      Math.max(MIN_CUSTOM_SESSION_COLUMN_WIDTH, px)
    )
  )
}

/**
 * Any stored or typed value to a width: a preset name stays as it is; a
 * number (or numeric string) is a custom width, clamped to the range and
 * folded into the preset it equals. Anything unreadable is the default.
 */
export function normalizeSessionColumnWidth(raw: unknown): SessionColumnWidth {
  if (isSessionColumnWidthPreset(raw)) return raw
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_SESSION_COLUMN_WIDTH
  const px = clampCustomSessionColumnWidth(n)
  for (const [preset, presetPx] of Object.entries(SESSION_COLUMN_PRESET_PX)) {
    if (presetPx === px) return preset as SessionColumnWidthPreset
  }
  return px
}

/** The width in px at 100% window zoom; null for Full (the panel decides). */
export function sessionColumnWidthPx(width: SessionColumnWidth): number | null {
  if (typeof width === "number") return width
  if (width === "full") return null
  return SESSION_COLUMN_PRESET_PX[width]
}

/** The CSS value for `--session-column-max-width`. */
export function sessionColumnMaxWidthCss(width: SessionColumnWidth): string {
  const px = sessionColumnWidthPx(width)
  return px === null ? FULL_SESSION_COLUMN_MAX_WIDTH : `${px / 16}rem`
}

/**
 * The next preset, for the quick toggle: Standard → Wide → Extra wide → Full
 * and round again. A custom width moves to the first preset wider than it.
 */
export function nextSessionColumnWidth(
  current: SessionColumnWidth
): SessionColumnWidthPreset {
  if (typeof current === "number") {
    for (const [preset, px] of Object.entries(SESSION_COLUMN_PRESET_PX)) {
      if (px > current) return preset as SessionColumnWidthPreset
    }
    return "full"
  }
  const index = SESSION_COLUMN_WIDTH_PRESETS.indexOf(current)
  return SESSION_COLUMN_WIDTH_PRESETS[
    (index + 1) % SESSION_COLUMN_WIDTH_PRESETS.length
  ]
}

export function readStoredSessionColumnWidth(): SessionColumnWidth {
  if (typeof window === "undefined") return DEFAULT_SESSION_COLUMN_WIDTH
  try {
    return normalizeSessionColumnWidth(
      window.localStorage.getItem(STORAGE_KEY_SESSION_COLUMN_WIDTH)
    )
  } catch {
    return DEFAULT_SESSION_COLUMN_WIDTH
  }
}

export function persistSessionColumnWidth(width: SessionColumnWidth): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_SESSION_COLUMN_WIDTH, String(width))
  } catch {
    // Private mode / disabled storage: the width still applies this session.
  }
}

/**
 * Write the width onto <html>. Standard removes the property instead, so a
 * profile that never touched the setting carries nothing extra (globals.css
 * holds the standard width).
 */
export function applySessionColumnWidth(
  root: HTMLElement,
  width: SessionColumnWidth
): void {
  if (width === DEFAULT_SESSION_COLUMN_WIDTH) {
    root.style.removeProperty(SESSION_COLUMN_MAX_WIDTH_PROPERTY)
  } else {
    root.style.setProperty(
      SESSION_COLUMN_MAX_WIDTH_PROPERTY,
      sessionColumnMaxWidthCss(width)
    )
  }
}
