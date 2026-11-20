import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  SHORTCUTS_STORAGE_KEY,
  analyzeShortcutAssignment,
  canShareShortcut,
  readShortcutSettings,
  shortcutContextOf,
  shortcutShadowsOf,
  withShortcutTakenOver,
  type ShortcutContext,
} from "./keyboard-shortcuts"

describe("shortcut contexts", () => {
  it("places every action where its listener runs", () => {
    // Read off the dispatchers: AppearanceProvider (every window),
    // WorkspaceChromeController / the sidebar's session stepping / the
    // transcript's read-aloud (the workspace window), TerminalProvider (the
    // terminal with focus), the composer and answer fields, and the Settings
    // window's search.
    const byContext: Record<ShortcutContext, string[]> = {
      global: [],
      workspace: [],
      terminal: [],
      composer: [],
      settings: [],
    }
    for (const definition of SHORTCUT_DEFINITIONS) {
      byContext[shortcutContextOf(definition.id)].push(definition.id)
    }
    expect(byContext.terminal).toEqual([
      "new_terminal_tab",
      "close_current_terminal_tab",
    ])
    expect(byContext.composer).toEqual(["send_message", "newline_in_message"])
    expect(byContext.settings).toEqual(["search_settings"])
    expect(byContext.global).toEqual([
      "toggle_custom_style",
      "zoom_in",
      "zoom_out",
      "zoom_reset",
      "chat_text_zoom_in",
      "chat_text_zoom_out",
      "chat_text_zoom_reset",
      "cycle_session_width",
    ])
    expect(byContext.workspace).toContain("toggle_search")
    expect(byContext.workspace).toContain("new_conversation")
    expect(byContext.workspace).toContain("next_session")
    expect(byContext.workspace).toContain("read_last_reply")
  })

  it("lets a terminal action and a workspace action share a chord", () => {
    // The two pairs the old whitelist named, now from where they listen.
    expect(canShareShortcut("new_terminal_tab", "new_conversation")).toBe(true)
    expect(
      canShareShortcut("close_current_terminal_tab", "close_current_tab")
    ).toBe(true)
    // And any other such pair.
    expect(canShareShortcut("new_terminal_tab", "toggle_search")).toBe(true)
  })

  it("lets actions of windows that never meet share one", () => {
    expect(canShareShortcut("search_settings", "toggle_search")).toBe(true)
    expect(canShareShortcut("search_settings", "new_terminal_tab")).toBe(true)
    // The terminal and the message box never hold focus together.
    expect(canShareShortcut("send_message", "new_terminal_tab")).toBe(true)
  })

  it("keeps a chord to one action wherever both would hear it", () => {
    // One listener, first match wins: the other never runs.
    expect(canShareShortcut("toggle_search", "new_conversation")).toBe(false)
    expect(
      canShareShortcut("new_terminal_tab", "close_current_terminal_tab")
    ).toBe(false)
    // The message box lets the key go on to the workspace: both would run.
    expect(canShareShortcut("send_message", "toggle_search")).toBe(false)
    // The global listeners never stop a key.
    expect(canShareShortcut("zoom_in", "toggle_search")).toBe(false)
    expect(canShareShortcut("zoom_in", "new_terminal_tab")).toBe(false)
    expect(canShareShortcut("zoom_in", "search_settings")).toBe(false)
    expect(canShareShortcut("zoom_in", "zoom_out")).toBe(false)
  })

  it("names where the terminal takes the chord from the workspace", () => {
    expect(shortcutContextOf("new_terminal_tab")).toBe("terminal")
    expect(shortcutShadowsOf("new_conversation", DEFAULT_SHORTCUTS)).toEqual([
      {
        focus: "terminal",
        winner: "new_terminal_tab",
        loser: "new_conversation",
      },
    ])
    expect(shortcutShadowsOf("close_current_tab", DEFAULT_SHORTCUTS)).toEqual([
      {
        focus: "terminal",
        winner: "close_current_terminal_tab",
        loser: "close_current_tab",
      },
    ])
    expect(shortcutShadowsOf("toggle_search", DEFAULT_SHORTCUTS)).toEqual([])
  })

  it("leaves no two defaults clashing", () => {
    const clashes: string[] = []
    for (const definition of SHORTCUT_DEFINITIONS) {
      const chord = DEFAULT_SHORTCUTS[definition.id]
      if (!chord) continue
      for (const other of analyzeShortcutAssignment(
        definition.id,
        chord,
        DEFAULT_SHORTCUTS
      ).clashes) {
        clashes.push(`${definition.id} / ${other}`)
      }
    }
    expect(clashes).toEqual([])
  })
})

describe("assigning ⌘T to Search (the reported case)", () => {
  it("is not blocked by New Terminal, which only listens in the terminal", () => {
    const { clashes, shadows } = analyzeShortcutAssignment(
      "toggle_search",
      "mod+t",
      DEFAULT_SHORTCUTS
    )
    expect(clashes).not.toContain("new_terminal_tab")
    // It does say where ⌘T keeps doing the terminal's job.
    expect(shadows).toEqual([
      { focus: "terminal", winner: "new_terminal_tab", loser: "toggle_search" },
    ])
  })

  it("clashes with New Conversation, which listens in the same place", () => {
    expect(
      analyzeShortcutAssignment("toggle_search", "mod+t", DEFAULT_SHORTCUTS)
        .clashes
    ).toEqual(["new_conversation"])
  })

  it("takes the chord over: New Conversation is unassigned, the terminal keeps it", () => {
    const { clashes } = analyzeShortcutAssignment(
      "toggle_search",
      "mod+t",
      DEFAULT_SHORTCUTS
    )
    const next = withShortcutTakenOver(
      DEFAULT_SHORTCUTS,
      "toggle_search",
      "mod+t",
      clashes
    )
    expect(next.toggle_search).toBe("mod+t")
    expect(next.new_conversation).toBe("")
    expect(next.new_terminal_tab).toBe("mod+t")
    expect(
      analyzeShortcutAssignment("toggle_search", "mod+t", next).clashes
    ).toEqual([])
  })
})

describe("stored profiles", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("reads a profile saved before contexts existed unchanged", () => {
    // What the previous build wrote: every action but the new one.
    const previous = Object.fromEntries(
      Object.entries({
        ...DEFAULT_SHORTCUTS,
        toggle_search: "mod+shift+k",
        new_conversation: "mod+n",
      }).filter(([id]) => id !== "search_settings")
    )
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(previous))

    const settings = readShortcutSettings()
    expect(settings.toggle_search).toBe("mod+shift+k")
    expect(settings.new_conversation).toBe("mod+n")
    expect(settings.new_terminal_tab).toBe("mod+t")
    expect(settings.search_settings).toBe("mod+f")
  })

  it("seeds ⌘F for Settings even where the workspace already uses it", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+f" })
    )
    expect(readShortcutSettings().search_settings).toBe("mod+f")
  })

  it("leaves it unbound where an every-window action holds ⌘F", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ zoom_in: "mod+f" })
    )
    const settings = readShortcutSettings()
    expect(settings.zoom_in).toBe("mod+f")
    expect(settings.search_settings).toBe("")
  })
})
