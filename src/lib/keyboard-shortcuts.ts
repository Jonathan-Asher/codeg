export type ShortcutActionId =
  | "toggle_search"
  | "switch_session_in_tab"
  | "toggle_sidebar"
  | "toggle_terminal"
  | "new_terminal_tab"
  | "close_current_terminal_tab"
  | "toggle_aux_panel"
  | "new_conversation"
  | "open_folder"
  | "open_settings"
  | "close_current_tab"
  | "reopen_last_closed_tab"
  | "close_all_file_tabs"
  | "close_window"
  | "next_tab"
  | "prev_tab"
  | "next_session"
  | "prev_session"
  | "switch_tab_1"
  | "switch_tab_2"
  | "switch_tab_3"
  | "switch_tab_4"
  | "switch_tab_5"
  | "switch_tab_6"
  | "switch_tab_7"
  | "switch_tab_8"
  | "switch_tab_9"
  | "send_message"
  | "newline_in_message"
  | "toggle_custom_style"
  | "zoom_in"
  | "zoom_out"
  | "zoom_reset"
  | "chat_text_zoom_in"
  | "chat_text_zoom_out"
  | "chat_text_zoom_reset"
  | "cycle_session_width"
  | "read_last_reply"
  | "search_settings"

/**
 * Where an action's key listener runs, which decides who else can hold the
 * same chord. Each one is read off the listener that dispatches it:
 *
 *   - `global`: `AppearanceProvider`, a capture listener on `window` in every
 *     window (the workspace, Settings, the rest). It never stops the event, so
 *     whatever else holds the chord runs too.
 *   - `workspace`: the workspace window's own shortcuts: the
 *     `WorkspaceChromeController` chain on `document`, the sidebar's session
 *     stepping and the transcript's read-aloud. They see a key wherever focus
 *     is in that window, the terminal and the message box included.
 *   - `terminal`: `TerminalProvider`, a capture listener on `window` that acts
 *     only while the terminal panel has focus (or the pointer) and then stops
 *     the event, so the workspace listeners on `document` never see it.
 *   - `composer`: the message box and the answer fields (`decideComposerKey`,
 *     the question and plan cards). They handle the key where it was typed and
 *     let it go on, so a workspace listener still sees it.
 *   - `settings`: the Settings window's own listeners.
 */
export type ShortcutContext =
  | "global"
  | "workspace"
  | "terminal"
  | "composer"
  | "settings"

export interface ShortcutDefinition {
  id: ShortcutActionId
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "toggle_search",
  },
  {
    id: "switch_session_in_tab",
  },
  {
    id: "toggle_sidebar",
  },
  {
    id: "toggle_terminal",
  },
  {
    id: "new_terminal_tab",
  },
  {
    id: "close_current_terminal_tab",
  },
  {
    id: "toggle_aux_panel",
  },
  {
    id: "new_conversation",
  },
  {
    id: "open_folder",
  },
  {
    id: "open_settings",
  },
  {
    id: "close_current_tab",
  },
  {
    id: "reopen_last_closed_tab",
  },
  {
    id: "close_all_file_tabs",
  },
  {
    id: "close_window",
  },
  {
    id: "next_tab",
  },
  {
    id: "prev_tab",
  },
  {
    id: "next_session",
  },
  {
    id: "prev_session",
  },
  { id: "switch_tab_1" },
  { id: "switch_tab_2" },
  { id: "switch_tab_3" },
  { id: "switch_tab_4" },
  { id: "switch_tab_5" },
  { id: "switch_tab_6" },
  { id: "switch_tab_7" },
  { id: "switch_tab_8" },
  { id: "switch_tab_9" },
  {
    id: "send_message",
  },
  {
    id: "newline_in_message",
  },
  {
    id: "toggle_custom_style",
  },
  {
    id: "zoom_in",
  },
  {
    id: "zoom_out",
  },
  {
    id: "zoom_reset",
  },
  {
    id: "chat_text_zoom_in",
  },
  {
    id: "chat_text_zoom_out",
  },
  {
    id: "chat_text_zoom_reset",
  },
  {
    id: "cycle_session_width",
  },
  {
    id: "read_last_reply",
  },
  {
    id: "search_settings",
  },
]

/** Each action's context, from the listener that dispatches it (see above). */
export const SHORTCUT_CONTEXTS: Record<ShortcutActionId, ShortcutContext> = {
  toggle_search: "workspace",
  switch_session_in_tab: "workspace",
  toggle_sidebar: "workspace",
  toggle_terminal: "workspace",
  new_terminal_tab: "terminal",
  close_current_terminal_tab: "terminal",
  toggle_aux_panel: "workspace",
  new_conversation: "workspace",
  open_folder: "workspace",
  open_settings: "workspace",
  close_current_tab: "workspace",
  reopen_last_closed_tab: "workspace",
  close_all_file_tabs: "workspace",
  close_window: "workspace",
  next_tab: "workspace",
  prev_tab: "workspace",
  next_session: "workspace",
  prev_session: "workspace",
  switch_tab_1: "workspace",
  switch_tab_2: "workspace",
  switch_tab_3: "workspace",
  switch_tab_4: "workspace",
  switch_tab_5: "workspace",
  switch_tab_6: "workspace",
  switch_tab_7: "workspace",
  switch_tab_8: "workspace",
  switch_tab_9: "workspace",
  send_message: "composer",
  newline_in_message: "composer",
  toggle_custom_style: "global",
  zoom_in: "global",
  zoom_out: "global",
  zoom_reset: "global",
  chat_text_zoom_in: "global",
  chat_text_zoom_out: "global",
  chat_text_zoom_reset: "global",
  cycle_session_width: "global",
  read_last_reply: "workspace",
  search_settings: "settings",
}

/** Actions that allow shortcuts without modifier keys (e.g. plain Enter). */
export const INPUT_SHORTCUT_IDS = new Set<ShortcutActionId>([
  "send_message",
  "newline_in_message",
])

/**
 * Where a key press can happen, as far as the listeners above can tell apart.
 * A context is active in some of them: the workspace's shortcuts hear a key
 * whether the terminal, the message box or anything else in that window has
 * focus; the terminal's only while the terminal has it.
 */
export type ShortcutFocus = "workspace" | "terminal" | "composer" | "settings"

const ACTIVE_IN: Record<ShortcutContext, readonly ShortcutFocus[]> = {
  global: ["workspace", "terminal", "composer", "settings"],
  workspace: ["workspace", "terminal", "composer"],
  terminal: ["terminal"],
  composer: ["composer"],
  settings: ["settings"],
}

/**
 * Where an action is for: the focus the user presses it in and expects it to
 * work. A workspace action that loses its chord while the terminal has focus
 * still does its job everywhere else in the window; one that loses it in the
 * workspace itself is broken.
 */
const HOME_OF: Record<ShortcutContext, readonly ShortcutFocus[]> = {
  global: ["workspace", "terminal", "composer", "settings"],
  workspace: ["workspace"],
  terminal: ["terminal"],
  composer: ["composer"],
  settings: ["settings"],
}

export function shortcutContextOf(id: ShortcutActionId): ShortcutContext {
  return SHORTCUT_CONTEXTS[id] ?? "global"
}

/**
 * Which of two contexts takes a chord they share, with `focus` holding the
 * keyboard: `a`, `b`, or `both` when neither stops the other.
 *
 * Only one pair has a winner. The terminal's capture listener on `window`
 * stops the event once it acts, so the workspace's listeners on `document`
 * never hear it. Every other pair runs both: the global listeners never stop
 * an event, the message box lets the key go on to the workspace, and two
 * actions of one context share one listener, where the first match shadows
 * the rest.
 */
function precedence(
  a: ShortcutContext,
  b: ShortcutContext
): "a" | "b" | "both" {
  if (a === "terminal" && b === "workspace") return "a"
  if (a === "workspace" && b === "terminal") return "b"
  return "both"
}

/** One focus where an action keeps a shared chord and another loses it. */
export interface ShortcutShadow {
  focus: ShortcutFocus
  winner: ShortcutActionId
  loser: ShortcutActionId
}

export interface ShortcutPairing {
  /** Some press would run both, or take one where it is meant to work. */
  collides: boolean
  /** Where one of the two loses the chord without being broken by it. */
  shadows: ShortcutShadow[]
}

/**
 * What it means for actions `a` and `b` to hold one chord, from where each
 * listens. They collide when a focus both are active in would run both, or
 * would hand the chord to one where the other is meant to work. Otherwise each
 * loss is a shadow worth saying: while the terminal has focus, the workspace's
 * action on the terminal's chord does not run.
 */
export function pairShortcutActions(
  a: ShortcutActionId,
  b: ShortcutActionId
): ShortcutPairing {
  const contextA = shortcutContextOf(a)
  const contextB = shortcutContextOf(b)
  const shared = ACTIVE_IN[contextA].filter((focus) =>
    ACTIVE_IN[contextB].includes(focus)
  )
  const shadows: ShortcutShadow[] = []
  for (const focus of shared) {
    const winner = precedence(contextA, contextB)
    if (winner === "both") return { collides: true, shadows: [] }
    const [kept, lost, lostContext] =
      winner === "a" ? [a, b, contextB] : [b, a, contextA]
    if (HOME_OF[lostContext].includes(focus)) {
      return { collides: true, shadows: [] }
    }
    shadows.push({ focus, winner: kept, loser: lost })
  }
  return { collides: false, shadows }
}

/** Two actions can hold one chord: no press runs both or breaks either. */
export function canShareShortcut(
  a: ShortcutActionId,
  b: ShortcutActionId
): boolean {
  return a !== b && !pairShortcutActions(a, b).collides
}

export interface ShortcutAssignment {
  /** Actions on the chord that cannot keep it if `actionId` takes it. */
  clashes: ShortcutActionId[]
  /** Where the chord would do something else, with both keeping it. */
  shadows: ShortcutShadow[]
}

/**
 * What binding `chord` to `actionId` would do to the other bindings in
 * `shortcuts`, by matcher semantics (`shortcutsConflict`) and context.
 */
export function analyzeShortcutAssignment(
  actionId: ShortcutActionId,
  chord: string,
  shortcuts: ShortcutSettings
): ShortcutAssignment {
  const clashes: ShortcutActionId[] = []
  const shadows: ShortcutShadow[] = []
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.id === actionId) continue
    if (!shortcutsConflict(shortcuts[definition.id], chord)) continue
    const pairing = pairShortcutActions(actionId, definition.id)
    if (pairing.collides) clashes.push(definition.id)
    else shadows.push(...pairing.shadows)
  }
  return { clashes, shadows }
}

/**
 * The shadows an existing binding lives with, for the settings row to say:
 * every other action on its chord that it shares a focus with.
 */
export function shortcutShadowsOf(
  actionId: ShortcutActionId,
  shortcuts: ShortcutSettings
): ShortcutShadow[] {
  const chord = shortcuts[actionId]
  if (!chord) return []
  return analyzeShortcutAssignment(actionId, chord, shortcuts).shadows
}

/**
 * `chord` on `actionId`, and the actions it takes the chord from unassigned,
 * so no press runs two of them.
 */
export function withShortcutTakenOver(
  shortcuts: ShortcutSettings,
  actionId: ShortcutActionId,
  chord: string,
  from: readonly ShortcutActionId[]
): ShortcutSettings {
  const next: ShortcutSettings = { ...shortcuts, [actionId]: chord }
  for (const id of from) {
    if (id !== actionId) next[id] = ""
  }
  return next
}

export type ShortcutSettings = Record<ShortcutActionId, string>

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  toggle_search: "mod+k",
  // The same switcher, in its "switch this tab" mode: Enter loads the pick
  // into the tab in front. Search's own key with Shift, matched by position
  // like every letter binding, so ⌘⇧ + the Hebrew letter on K is this too.
  switch_session_in_tab: "mod+shift+k",
  toggle_sidebar: "mod+b",
  toggle_terminal: "mod+j",
  new_terminal_tab: "mod+t",
  close_current_terminal_tab: "mod+w",
  toggle_aux_panel: "mod+e",
  new_conversation: "mod+t",
  open_folder: "mod+o",
  open_settings: "mod+,",
  // ⌘W closes one tab and never the window; ⇧⌘W closes the window — the
  // native menu carries the same two (`app_menu.rs`). Closing every file tab
  // takes ⌥⌘W, the platform's "close all".
  close_current_tab: "mod+w",
  reopen_last_closed_tab: "mod+shift+t",
  close_all_file_tabs: "mod+alt+w",
  close_window: "mod+shift+w",
  next_tab: "mod+tab",
  prev_tab: "mod+shift+tab",
  // Step through the sidebar's sessions in the order they are listed. Inside a
  // text field this replaces the platform's "select to the start/end" chord.
  next_session: "mod+shift+arrowdown",
  prev_session: "mod+shift+arrowup",
  switch_tab_1: "mod+1",
  switch_tab_2: "mod+2",
  switch_tab_3: "mod+3",
  switch_tab_4: "mod+4",
  switch_tab_5: "mod+5",
  switch_tab_6: "mod+6",
  switch_tab_7: "mod+7",
  switch_tab_8: "mod+8",
  switch_tab_9: "mod+9",
  send_message: "enter",
  newline_in_message: "shift+enter",
  // 自定义样式的逃生舱：用户把界面改到不可用时，这一路必须仍然按得动，所以选一个
  // 三修饰键组合（不会与任何常用操作撞车），并在捕获阶段监听。
  toggle_custom_style: "mod+alt+shift+s",
  // Same rungs as Settings → Window zoom. `=` is what US keyboards fire for
  // Ctrl/+ without Shift; `+` is Shift+= and the numpad.
  zoom_in: "mod+=",
  zoom_out: "mod+-",
  zoom_reset: "mod+0",
  // The same three keys with Shift scale only the conversation text (Settings →
  // Appearance → Chat text size). Shift+= is how a US keyboard types "+", so
  // this is the "Cmd/Ctrl +" chord. A binding that names Shift outranks the
  // window zoom's surplus-Shift tolerance on these keys (`matchShortcutEvent`),
  // so one press never does both.
  chat_text_zoom_in: "mod+shift+=",
  chat_text_zoom_out: "mod+shift+-",
  chat_text_zoom_reset: "mod+shift+0",
  // Step the conversation column through Standard / Wide / Extra wide / Full
  // (Settings → Appearance → Session width). Unassigned: every natural chord
  // here is already some app's or the browser's, and the conversation ⋯ menu
  // switches the width without one.
  cycle_session_width: "",
  // Read the active conversation's newest reply aloud, or stop it. "L" for
  // listen: Cmd/Ctrl+Shift+R is the browsers' hard reload, which the web
  // build must leave alone.
  read_last_reply: "mod+shift+l",
  // Focus the Settings window's search box. Only that window listens, so it
  // takes the chord from no workspace binding; in the web build it stands in
  // for the browser's find on that page, which would only search the one page
  // on screen.
  search_settings: "mod+f",
}

export const SHORTCUTS_STORAGE_KEY = "settings:shortcuts:v1"
export const SHORTCUTS_UPDATED_EVENT = "codeg:shortcuts-updated"

const FUNCTION_KEY_PATTERN = /^f\d{1,2}$/
const DIGIT_KEY_PATTERN = /^[0-9]$/
const MODIFIER_KEY_SET = new Set(["shift", "meta", "control", "alt"])

const SPECIAL_KEY_ALIASES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
}

/**
 * `=`/`+` and `-`/`_` are the same physical key (unshifted vs shifted).
 * Bindings on one should also fire for the other; extra Shift is ignored
 * only for these pairs, because Shift is how you type the sibling.
 */
const PHYSICAL_KEY_SIBLINGS: Record<string, string> = {
  "=": "+",
  "+": "=",
  "-": "_",
  _: "-",
}

/**
 * `{` and `}` are Shift + the bracket keys. Shift travels as a modifier, so a
 * shortcut names the key by its unshifted bracket: `mod+shift+{` is
 * `mod+shift+[`, and a press that typed `{` is the `[` key with Shift held.
 * Unlike `=`/`+`, the Shift state stays exact: `mod+[` and `mod+shift+[` are
 * two different chords.
 */
const SHIFTED_BRACKET_KEYS: Record<string, string> = {
  "{": "[",
  "}": "]",
}

const BRACKET_CHARACTERS = new Set(["[", "]", "{", "}"])

/** What a US layout types, unshifted, on the punctuation keys `event.code` names. */
const US_PUNCTUATION_BY_CODE = new Map<string, string>([
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Comma", ","],
  ["Period", "."],
  ["Slash", "/"],
  ["Backslash", "\\"],
  ["Backquote", "`"],
  ["Minus", "-"],
  ["Equal", "="],
])

/**
 * One character of a script other than Latin: Hebrew, Cyrillic, Greek,
 * Arabic, Thai and so on. Latin letters with diacritics (é, ü, ß, å) and the
 * symbols every script shares (§, £, °, №) do not count, so AZERTY, QWERTZ and
 * the Nordic layouts keep the characters they type.
 */
const NON_LATIN_SCRIPT_CHARACTER =
  /^[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]$/u

export interface ParsedShortcut {
  mod: boolean
  alt: boolean
  shift: boolean
  key: string
}

/**
 * Recording a shortcut in Settings and the global zoom listener are both
 * capture handlers on `window`. `stopPropagation()` does not stop a sibling
 * listener on the same target, so the recorder arms this flag instead.
 */
let shortcutRecorderArmed = false

export function setShortcutRecorderArmed(armed: boolean): void {
  shortcutRecorderArmed = armed
}

export function isShortcutRecorderArmed(): boolean {
  return shortcutRecorderArmed
}

const KEY_LABELS: Record<string, string> = {
  space: "Space",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  backspace: "Backspace",
  delete: "Delete",
}

function normalizeKeyToken(rawKey: string): string | null {
  const key = rawKey.toLowerCase()
  if (!key) return null

  if (key.length === 1) return SHIFTED_BRACKET_KEYS[key] ?? key
  if (FUNCTION_KEY_PATTERN.test(key)) return key

  const aliased = SPECIAL_KEY_ALIASES[key] ?? key
  if (aliased.length === 1 || FUNCTION_KEY_PATTERN.test(aliased)) return aliased

  if (
    aliased === "space" ||
    aliased === "escape" ||
    aliased === "enter" ||
    aliased === "tab" ||
    aliased === "backspace" ||
    aliased === "delete" ||
    aliased === "arrowup" ||
    aliased === "arrowdown" ||
    aliased === "arrowleft" ||
    aliased === "arrowright"
  ) {
    return aliased
  }

  return null
}

function normalizeSettings(input: unknown): ShortcutSettings {
  const next: ShortcutSettings = { ...DEFAULT_SHORTCUTS }
  if (!input || typeof input !== "object") return next

  const record = input as Record<string, unknown>
  const stored = new Set<ShortcutActionId>()
  for (const definition of SHORTCUT_DEFINITIONS) {
    const rawValue = record[definition.id]
    if (typeof rawValue !== "string") continue

    // An empty string is a real state, not a missing key: it is what an action
    // holds once its default lost to a stored binding below. Reseeding the
    // default here would put the collision straight back on the next write.
    if (!rawValue.trim()) {
      next[definition.id] = ""
      stored.add(definition.id)
      continue
    }

    const normalized = normalizeShortcut(rawValue)
    if (!normalized) continue
    next[definition.id] = normalized
    stored.add(definition.id)
  }

  // A default added after this profile was written can land on a chord the user
  // already assigned. Both actions would then fire, with nothing on screen to
  // say so, so the stored binding keeps the chord and the new action arrives
  // unbound for the user to place.
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (stored.has(definition.id)) continue

    const seeded = next[definition.id]
    if (!seeded) continue

    const taken = SHORTCUT_DEFINITIONS.some(
      (other) =>
        other.id !== definition.id &&
        stored.has(other.id) &&
        !canShareShortcut(other.id, definition.id) &&
        shortcutsConflict(next[other.id], seeded)
    )
    if (taken) next[definition.id] = ""
  }

  return next
}

/**
 * Split a shortcut string without treating a trailing `+` key as a delimiter.
 * `mod++` and `mod+shift++` are how Ctrl/Cmd+Shift+= serializes.
 */
export function parseShortcut(rawShortcut: string): ParsedShortcut | null {
  const lowered = rawShortcut.toLowerCase().trim()
  if (!lowered) return null

  let keyRaw: string
  let prefix: string
  if (lowered === "+" || lowered.endsWith("++")) {
    keyRaw = "+"
    prefix = lowered === "+" ? "" : lowered.slice(0, -2)
  } else {
    const lastPlus = lowered.lastIndexOf("+")
    if (lastPlus === -1) {
      keyRaw = lowered
      prefix = ""
    } else {
      keyRaw = lowered.slice(lastPlus + 1)
      prefix = lowered.slice(0, lastPlus)
    }
  }

  const keyToken = normalizeKeyToken(keyRaw.trim())
  if (!keyToken || MODIFIER_KEY_SET.has(keyToken)) return null

  let mod = false
  let alt = false
  let shift = false
  if (prefix) {
    const parts = prefix
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean)
    for (const part of parts) {
      if (
        part === "mod" ||
        part === "cmd" ||
        part === "command" ||
        part === "meta" ||
        part === "ctrl" ||
        part === "control"
      ) {
        mod = true
        continue
      }
      if (part === "alt" || part === "option") {
        alt = true
        continue
      }
      if (part === "shift") {
        shift = true
        continue
      }
      return null
    }
  }

  return { mod, alt, shift, key: keyToken }
}

export function normalizeShortcut(rawShortcut: string): string | null {
  const parsed = parseShortcut(rawShortcut)
  if (!parsed) return null

  const normalizedParts: string[] = []
  if (parsed.mod) normalizedParts.push("mod")
  if (parsed.alt) normalizedParts.push("alt")
  if (parsed.shift) normalizedParts.push("shift")
  normalizedParts.push(parsed.key)
  return normalizedParts.join("+")
}

/**
 * 键盘事件里我们真正读的那几个字段。`code` 是可选的，因为部分调用点（含测试）
 * 构造的是精简对象。
 */
type ShortcutEventLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> & { code?: string }

/**
 * Alt/Option 会改写 `event.key`：macOS 上 ⌥S 报的是 "ß" 而不是 "s"（其它布局同理）。
 * 按住 Alt 时改用与键盘布局无关的 `event.code`，否则**任何含 alt 的组合在 macOS 上
 * 都按不出来**，录制时记下的也会是那个变音字符。
 *
 * 只在 altKey 为真时改道，所以不含 alt 的既有快捷键行为完全不变。
 *
 * Two more cases read the key's position instead of the character it typed:
 *
 *   - The bracket keys. When `event.code` is BracketLeft/BracketRight and the
 *     key typed any bracket, the code decides: Hebrew mirrors the pair (the
 *     physical `[` key types `]`), so the character would point the wrong way.
 *     Other characters on those keys (QWERTZ `ü`/`+`, Dvorak `/`/`=`, AZERTY
 *     `^`/`$`) stay on `event.key`. The one layout this misreads is ABNT2,
 *     whose `[` really is on BracketRight; its `]` sits on Backslash.
 *   - Non-Latin layouts. A character from another script (Hebrew, Russian,
 *     Greek, Arabic…) can never spell a binding, so on a key with a US
 *     position it reads as what US types there: ⌘ + the Hebrew letter on the W
 *     key is ⌘W.
 *
 * Both yield one token per press, so no press reaches two bindings this way.
 * Latin layouts with no bracket typed are untouched.
 */
function eventKeyToken(event: ShortcutEventLike): string | null {
  const code = typeof event.code === "string" ? event.code : ""
  if (
    (code === "BracketLeft" || code === "BracketRight") &&
    BRACKET_CHARACTERS.has(event.key)
  ) {
    return code === "BracketLeft" ? "[" : "]"
  }
  if (event.altKey) {
    const letterOrDigit = usLetterOrDigitAtCode(code)
    if (letterOrDigit) return letterOrDigit
  }
  if (NON_LATIN_SCRIPT_CHARACTER.test(event.key)) {
    const usKey =
      usLetterOrDigitAtCode(code) ?? US_PUNCTUATION_BY_CODE.get(code) ?? null
    if (usKey) return usKey
  }
  return normalizeKeyToken(event.key)
}

/** The letter or digit a US layout types on the key `code` names, if any. */
function usLetterOrDigitAtCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  return null
}

export function readShortcutSettings(): ShortcutSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SHORTCUTS }

  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SHORTCUTS }
    const parsed: unknown = JSON.parse(raw)
    return normalizeSettings(parsed)
  } catch {
    return { ...DEFAULT_SHORTCUTS }
  }
}

export function writeShortcutSettings(settings: ShortcutSettings): void {
  if (typeof window === "undefined") return

  const normalized = normalizeSettings(settings)

  try {
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify(normalized)
    )
    window.dispatchEvent(new Event(SHORTCUTS_UPDATED_EVENT))
  } catch {
    // Ignore storage failures so UI shortcuts still work in memory.
  }
}

export function shortcutFromKeyboardEvent(
  event: ShortcutEventLike,
  /** When true, allow shortcuts without modifier keys (e.g. plain Enter). */
  allowNoModifier = false
): string | null {
  const keyToken = eventKeyToken(event)
  if (!keyToken || MODIFIER_KEY_SET.has(keyToken)) return null

  if (!allowNoModifier && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return null
  }

  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push("mod")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  parts.push(keyToken)

  return parts.join("+")
}

function siblingKeys(keyToken: string): Set<string> {
  const sibling = PHYSICAL_KEY_SIBLINGS[keyToken]
  return sibling ? new Set([keyToken, sibling]) : new Set([keyToken])
}

function matchesNumpadCode(
  event: ShortcutEventLike,
  boundKey: string
): boolean {
  if (boundKey === "=" || boundKey === "+") {
    return event.code === "NumpadAdd"
  }
  if (boundKey === "-" || boundKey === "_") {
    return event.code === "NumpadSubtract"
  }
  return false
}

/**
 * A digit binding must also fire from its own digit-row key on layouts that
 * shift that row. On AZERTY unshifted `Digit0` types `à` and the digit needs
 * Shift, so `mod+0` matches neither spelling on `event.key` alone.
 *
 * `Digit<N>` names one physical key, so this cannot mis-fire the way a bare
 * `Minus`/`Equal` fallback would.
 */
function matchesDigitRowCode(
  event: ShortcutEventLike,
  bound: ParsedShortcut
): boolean {
  if (!DIGIT_KEY_PATTERN.test(bound.key)) return false
  // A binding without Shift claims the position unshifted only: with Shift the
  // digit row yields a character that belongs to someone else — ")" on US, "="
  // on QWERTZ — and claiming it by position makes one press satisfy two
  // bindings. A binding that names Shift (`mod+shift+0`) means exactly that
  // shifted key, which on US reports ")" and is otherwise unreachable.
  if (event.shiftKey && !bound.shift) return false
  // Same reason, for the unshifted half: AZERTY puts `-` on Digit6 and `_` on
  // Digit8, so a bare positional match would let one `Ctrl+-` press satisfy
  // both `mod+-` (by key) and `mod+6` (by code) — and `shortcutsConflict`
  // cannot warn about it, because the recorder serialises from `key` while
  // this matches by `code`. The zoom listener preventDefaults but does not
  // stopPropagation, so both handlers really would run. Decline the position
  // whenever the key typed a character some binding owns by name; `mod+6` is
  // still reachable there as Shift + the digit row, which the surplus-Shift
  // tolerance for digits in `shortcutMatchStrength` already accepts. The same
  // holds shifted: QWERTZ Shift+Digit0 types "=", which `mod+shift+=` owns.
  const typed = eventKeyToken(event)
  if (typed !== null && typed in PHYSICAL_KEY_SIBLINGS) return false
  return event.code === `Digit${bound.key}`
}

export const NUMBERED_TAB_ACTION_IDS = [
  "switch_tab_1",
  "switch_tab_2",
  "switch_tab_3",
  "switch_tab_4",
  "switch_tab_5",
  "switch_tab_6",
  "switch_tab_7",
  "switch_tab_8",
  "switch_tab_9",
] as const satisfies readonly ShortcutActionId[]

/** 0-based index into the visible tab strip, or null when that tab does not exist. */
export function pickNumberedTabId(
  tabIds: readonly string[],
  index: number
): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= tabIds.length) {
    return null
  }
  return tabIds[index] ?? null
}

export function numberedTabIndexFromEvent(
  event: ShortcutEventLike,
  shortcuts: ShortcutSettings
): number | null {
  for (let index = 0; index < NUMBERED_TAB_ACTION_IDS.length; index += 1) {
    const actionId = NUMBERED_TAB_ACTION_IDS[index]
    if (matchShortcutEvent(event, shortcuts[actionId])) {
      return index
    }
  }
  return null
}

/**
 * How literally a press spells a binding, or 0 when it does not match at all.
 *
 * The matcher has tolerances: a surplus Shift on `=`/`-` (Shift is how `=`
 * becomes `+`) and on digits (AZERTY needs Shift to type one), and positional
 * fallbacks on the digit row and the numpad. A tolerance lets one press reach a
 * binding that does not spell it, so two bindings can both accept the same
 * press: `mod+=` (through the surplus Shift) and `mod+shift+=` (exactly) both
 * accept Ctrl/Cmd+Shift+=. Ranking the matches lets the literal one win instead
 * of both firing:
 *
 *   - the Shift state is exactly the binding's   (+2)
 *   - the press typed the bound key itself        (+1, vs a digit-row or numpad
 *     position)
 *
 * so 4 is a press that spells the binding outright and 1 the loosest match.
 */
export function shortcutMatchStrength(
  event: ShortcutEventLike,
  shortcut: string
): number {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return 0

  const keys = siblingKeys(parsed.key)
  const actualKey = eventKeyToken(event)
  const matchesKey = actualKey !== null && keys.has(actualKey)
  if (
    !matchesKey &&
    !matchesDigitRowCode(event, parsed) &&
    !matchesNumpadCode(event, parsed.key)
  ) {
    return 0
  }

  const hasMod = event.metaKey || event.ctrlKey
  if (hasMod !== parsed.mod) return 0
  if (event.altKey !== parsed.alt) return 0

  // Extra Shift is how `=` becomes `+` (and `-` becomes `_`), and on a shifted
  // digit row it is how you type the digit at all. Require Shift when the
  // binding asked for it; ignore a surplus Shift only in those cases.
  if (parsed.shift) {
    if (!event.shiftKey) return 0
  } else if (
    event.shiftKey &&
    keys.size === 1 &&
    !DIGIT_KEY_PATTERN.test(parsed.key)
  ) {
    return 0
  }

  return 1 + (event.shiftKey === parsed.shift ? 2 : 0) + (matchesKey ? 1 : 0)
}

const EXACT_MATCH_STRENGTH = 4

/**
 * The bindings in force, for `matchShortcutEvent` to weigh a tolerated match
 * against. Read through localStorage — one string compare per call, re-parsed
 * only when the stored profile changed — so every listener sees the same
 * profile without each call site threading it through.
 */
let activeBindingsCache: { raw: string | null; bindings: string[] } | null =
  null

function activeShortcutBindings(): string[] {
  let raw: string | null = null
  if (typeof window !== "undefined") {
    try {
      raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    } catch {
      raw = null
    }
  }
  if (activeBindingsCache && activeBindingsCache.raw === raw) {
    return activeBindingsCache.bindings
  }
  const bindings = Object.values(readShortcutSettings()).filter(Boolean)
  activeBindingsCache = { raw, bindings }
  return bindings
}

/**
 * Does this press fire `shortcut`?
 *
 * A press that spells the binding outright always does. One that reaches it
 * only through a tolerance (see `shortcutMatchStrength`) does unless another
 * binding in force spells that press more literally; that binding takes it.
 * This is how Ctrl/Cmd+Shift+= enlarges the chat text while Ctrl/Cmd+= still
 * zooms the window, and why unbinding the chat chord hands Shift+= back to the
 * window zoom.
 *
 * `rivals` defaults to the stored shortcut profile; tests pass their own.
 */
export function matchShortcutEvent(
  event: ShortcutEventLike,
  shortcut: string,
  rivals?: Iterable<string>
): boolean {
  const strength = shortcutMatchStrength(event, shortcut)
  if (strength === 0) return false
  if (strength >= EXACT_MATCH_STRENGTH) return true

  for (const rival of rivals ?? activeShortcutBindings()) {
    if (!rival || rival === shortcut) continue
    if (shortcutMatchStrength(event, rival) > strength) return false
  }
  return true
}

/**
 * Two bindings collide when some press fires both. String equality misses
 * that: `mod+=` and `mod++` are different strings for one chord. So probe each
 * side's canonical press through the real matcher, and weigh it the way the
 * matcher does: `mod+=` and `mod+shift+=` both accept Ctrl/Cmd+Shift+=, but
 * only the Shift binding fires on it, so the two coexist. A collision is a
 * press both accept equally literally.
 */
export function shortcutsConflict(a: string, b: string): boolean {
  const parsedA = parseShortcut(a)
  const parsedB = parseShortcut(b)
  if (!parsedA || !parsedB) return false

  for (const event of [syntheticEvent(parsedA), syntheticEvent(parsedB)]) {
    const strengthA = shortcutMatchStrength(event, a)
    if (strengthA > 0 && strengthA === shortcutMatchStrength(event, b)) {
      return true
    }
  }
  return false
}

/** The canonical event a binding describes, as the matcher would see it. */
function syntheticEvent(parsed: ParsedShortcut): ShortcutEventLike {
  return {
    key: parsed.key,
    metaKey: parsed.mod,
    ctrlKey: false,
    altKey: parsed.alt,
    shiftKey: parsed.shift,
    // Carry the physical key for digits so the shifted-digit-row tolerance
    // above is visible to conflict checks too.
    ...(DIGIT_KEY_PATTERN.test(parsed.key)
      ? { code: `Digit${parsed.key}` }
      : {}),
  }
}

export type ZoomShortcutAction = "in" | "out" | "reset"

export function resolveWindowZoomAction(
  event: ShortcutEventLike,
  shortcuts: Pick<ShortcutSettings, "zoom_in" | "zoom_out" | "zoom_reset">,
  rivals?: Iterable<string>
): ZoomShortcutAction | null {
  if (matchShortcutEvent(event, shortcuts.zoom_in, rivals)) return "in"
  if (matchShortcutEvent(event, shortcuts.zoom_out, rivals)) return "out"
  if (matchShortcutEvent(event, shortcuts.zoom_reset, rivals)) return "reset"
  return null
}

/** Settings → Appearance → Chat text size, from the keyboard. */
export function resolveChatTextZoomAction(
  event: ShortcutEventLike,
  shortcuts: Pick<
    ShortcutSettings,
    "chat_text_zoom_in" | "chat_text_zoom_out" | "chat_text_zoom_reset"
  >,
  rivals?: Iterable<string>
): ZoomShortcutAction | null {
  if (matchShortcutEvent(event, shortcuts.chat_text_zoom_in, rivals)) {
    return "in"
  }
  if (matchShortcutEvent(event, shortcuts.chat_text_zoom_out, rivals)) {
    return "out"
  }
  if (matchShortcutEvent(event, shortcuts.chat_text_zoom_reset, rivals)) {
    return "reset"
  }
  return null
}

function toKeyLabel(keyToken: string): string {
  const common = KEY_LABELS[keyToken]
  if (common) return common

  if (keyToken.length === 1) return keyToken.toUpperCase()
  if (FUNCTION_KEY_PATTERN.test(keyToken)) return keyToken.toUpperCase()

  return keyToken
}

export function formatShortcutLabel(shortcut: string, isMac: boolean): string {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return shortcut

  const modifiers: string[] = []
  if (parsed.mod) modifiers.push(isMac ? "⌘" : "Ctrl")
  if (parsed.alt) modifiers.push(isMac ? "⌥" : "Alt")
  if (parsed.shift) modifiers.push(isMac ? "⇧" : "Shift")

  const keyLabel = toKeyLabel(parsed.key)

  if (isMac) {
    return `${modifiers.join("")}${keyLabel}`
  }

  if (modifiers.length === 0) return keyLabel
  return `${modifiers.join("+")}+${keyLabel}`
}
