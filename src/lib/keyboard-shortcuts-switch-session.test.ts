import { describe, expect, it } from "vitest"

import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  analyzeShortcutAssignment,
  matchShortcutEvent,
  shortcutContextOf,
} from "./keyboard-shortcuts"

function press(key: string, code: string) {
  return {
    key,
    code,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
  }
}

/** Every default binding a press fires. */
function fired(event: ReturnType<typeof press>) {
  return SHORTCUT_DEFINITIONS.filter((definition) =>
    matchShortcutEvent(
      event,
      DEFAULT_SHORTCUTS[definition.id],
      Object.values(DEFAULT_SHORTCUTS)
    )
  ).map((definition) => definition.id)
}

describe("switch_session_in_tab", () => {
  it("is ⌘⇧K by default, a workspace shortcut listed with the rest", () => {
    expect(DEFAULT_SHORTCUTS.switch_session_in_tab).toBe("mod+shift+k")
    expect(shortcutContextOf("switch_session_in_tab")).toBe("workspace")
    expect(SHORTCUT_DEFINITIONS.map((d) => d.id)).toContain(
      "switch_session_in_tab"
    )
  })

  it("takes the chord from no other default", () => {
    expect(
      analyzeShortcutAssignment(
        "switch_session_in_tab",
        "mod+shift+k",
        DEFAULT_SHORTCUTS
      ).clashes
    ).toEqual([])
  })

  it("fires alone, and by the key's position on a Hebrew layout too", () => {
    expect(fired(press("K", "KeyK"))).toEqual(["switch_session_in_tab"])
    // SI-1452 puts ל on K.
    expect(fired(press("ל", "KeyK"))).toEqual(["switch_session_in_tab"])
  })

  it("leaves ⌘K (no Shift) to Search", () => {
    expect(fired({ ...press("k", "KeyK"), shiftKey: false })).toEqual([
      "toggle_search",
    ])
  })
})
