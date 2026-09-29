/**
 * The Quick Ask global shortcut, in the accelerator syntax the Rust side
 * registers (`Alt+Space`, `Control+Shift+KeyK`): modifiers first, then one
 * key named by its `KeyboardEvent.code`. Recording by `code` rather than `key`
 * matters on macOS, where Option turns Space into a non-breaking space and
 * letters into symbols.
 */

export const DEFAULT_QUICK_ASK_SHORTCUT = "Alt+Space"

/** Modifiers, always written in this order. */
type Modifier = "Control" | "Alt" | "Shift" | "Super"

/** Every key the shortcut registrar can parse (see `global-hotkey`). */
const KEY_CODE_RE =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad[A-Za-z0-9]+|Space|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Insert|Arrow(Up|Down|Left|Right)|Backquote|Backslash|BracketLeft|BracketRight|Comma|Period|Minus|Equal|Quote|Semicolon|Slash)$/

export interface ShortcutKeyEvent {
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * The accelerator a key press spells, or `null` when it is not (yet) a usable
 * global shortcut: a bare modifier still being held, a key the registrar does
 * not know, or no modifier at all (a bare key would be stolen from every other
 * app).
 */
export function acceleratorFromEvent(event: ShortcutKeyEvent): string | null {
  if (!KEY_CODE_RE.test(event.code)) return null
  const modifiers: Modifier[] = []
  if (event.ctrlKey) modifiers.push("Control")
  if (event.altKey) modifiers.push("Alt")
  if (event.shiftKey) modifiers.push("Shift")
  if (event.metaKey) modifiers.push("Super")
  if (modifiers.length === 0) return null
  return [...modifiers, event.code].join("+")
}

const MAC_SYMBOLS: Record<string, string> = {
  Control: "⌃",
  Ctrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
  Super: "⌘",
  Command: "⌘",
  Cmd: "⌘",
  Meta: "⌘",
}

const OTHER_NAMES: Record<string, string> = {
  Super: "Win",
  Command: "Win",
  Cmd: "Win",
  Meta: "Win",
  Control: "Ctrl",
}

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: "↵",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Minus: "-",
  Equal: "=",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
}

function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return code
}

/** Human form: `⌥Space` on macOS, `Alt+Space` elsewhere. */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return ""
  const key = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  if (isMac) {
    return modifiers.map((m) => MAC_SYMBOLS[m] ?? m).join("") + keyLabel(key)
  }
  return [...modifiers.map((m) => OTHER_NAMES[m] ?? m), keyLabel(key)].join("+")
}
