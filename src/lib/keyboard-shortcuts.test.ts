import { beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_SHORTCUTS,
  canShareShortcut,
  SHORTCUTS_STORAGE_KEY,
  NUMBERED_TAB_ACTION_IDS,
  SHORTCUT_DEFINITIONS,
  formatShortcutLabel,
  matchShortcutEvent,
  normalizeShortcut,
  readShortcutSettings,
  resolveChatTextZoomAction,
  resolveWindowZoomAction,
  numberedTabIndexFromEvent,
  pickNumberedTabId,
  shortcutFromKeyboardEvent,
  shortcutMatchStrength,
  shortcutsConflict,
  writeShortcutSettings,
} from "./keyboard-shortcuts"

function keyEvent(
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
      code: string
    }
  > = {}
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe("tab cycling shortcuts", () => {
  it("registers next_tab and prev_tab with defaults", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("next_tab")
    expect(ids).toContain("prev_tab")
    expect(DEFAULT_SHORTCUTS.next_tab).toBe("mod+tab")
    expect(DEFAULT_SHORTCUTS.prev_tab).toBe("mod+shift+tab")
  })

  it("matches Ctrl+Tab against the next_tab default", () => {
    expect(
      matchShortcutEvent(keyEvent("Tab", { ctrlKey: true }), "mod+tab")
    ).toBe(true)
    expect(matchShortcutEvent(keyEvent("Tab"), "mod+tab")).toBe(false)
  })

  it("matches Ctrl+Shift+Tab against the prev_tab default", () => {
    expect(
      matchShortcutEvent(
        keyEvent("Tab", { ctrlKey: true, shiftKey: true }),
        "mod+shift+tab"
      )
    ).toBe(true)
    // Without Shift it must not match prev_tab, and with Shift it must not
    // match next_tab, so the two bindings stay distinct.
    expect(
      matchShortcutEvent(keyEvent("Tab", { ctrlKey: true }), "mod+shift+tab")
    ).toBe(false)
    expect(
      matchShortcutEvent(
        keyEvent("Tab", { ctrlKey: true, shiftKey: true }),
        "mod+tab"
      )
    ).toBe(false)
  })
})

describe("sidebar session stepping shortcuts", () => {
  it("registers next_session and prev_session on Cmd/Ctrl+Shift+Down/Up", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("next_session")
    expect(ids).toContain("prev_session")
    expect(DEFAULT_SHORTCUTS.next_session).toBe("mod+shift+arrowdown")
    expect(DEFAULT_SHORTCUTS.prev_session).toBe("mod+shift+arrowup")
  })

  it("collides with no other default", () => {
    for (const id of ["next_session", "prev_session"] as const) {
      const clashes = SHORTCUT_DEFINITIONS.filter(
        (definition) =>
          definition.id !== id &&
          shortcutsConflict(
            DEFAULT_SHORTCUTS[definition.id],
            DEFAULT_SHORTCUTS[id]
          )
      ).map((definition) => definition.id)
      expect(clashes).toEqual([])
    }
  })

  it("records the chord as pressed and labels it per platform", () => {
    expect(
      shortcutFromKeyboardEvent(
        keyEvent("ArrowDown", { metaKey: true, shiftKey: true })
      )
    ).toBe(DEFAULT_SHORTCUTS.next_session)
    expect(formatShortcutLabel(DEFAULT_SHORTCUTS.next_session, true)).toBe(
      "⌘⇧Down"
    )
    expect(formatShortcutLabel(DEFAULT_SHORTCUTS.prev_session, false)).toBe(
      "Ctrl+Shift+Up"
    )
  })

  it("arrives unbound when a stored binding already holds the chord", () => {
    // A profile from before these actions existed, with the chord on zoom.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ zoom_in: "mod+shift+arrowdown" })
    )
    const settings = readShortcutSettings()
    expect(settings.zoom_in).toBe("mod+shift+arrowdown")
    expect(settings.next_session).toBe("")
    expect(settings.prev_session).toBe(DEFAULT_SHORTCUTS.prev_session)
    localStorage.removeItem(SHORTCUTS_STORAGE_KEY)
  })
})

describe("numbered tab shortcuts", () => {
  it("registers Ctrl/Cmd+1 through 9 as switch_tab_N", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    for (const [index, actionId] of NUMBERED_TAB_ACTION_IDS.entries()) {
      expect(ids).toContain(actionId)
      expect(DEFAULT_SHORTCUTS[actionId]).toBe(`mod+${index + 1}`)
    }
  })

  it("maps Ctrl+1 to the first tab and ignores a missing ninth tab", () => {
    const tabs = ["conv-a", "conv-b", "conv-c"]
    expect(pickNumberedTabId(tabs, 0)).toBe("conv-a")
    expect(pickNumberedTabId(tabs, 2)).toBe("conv-c")
    expect(pickNumberedTabId(tabs, 8)).toBeNull()
    expect(pickNumberedTabId([], 0)).toBeNull()
  })

  it("resolves Ctrl+2 against the default numbered-tab bindings", () => {
    expect(
      numberedTabIndexFromEvent(
        keyEvent("2", { ctrlKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(1)
    expect(
      numberedTabIndexFromEvent(keyEvent("2"), DEFAULT_SHORTCUTS)
    ).toBeNull()
    expect(
      numberedTabIndexFromEvent(
        keyEvent("Tab", { ctrlKey: true }),
        DEFAULT_SHORTCUTS
      )
    ).toBeNull()
  })
})

describe("reopen last closed tab", () => {
  it("defaults to Ctrl/Cmd+Shift+T", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("reopen_last_closed_tab")
    expect(DEFAULT_SHORTCUTS.reopen_last_closed_tab).toBe("mod+shift+t")
    expect(
      matchShortcutEvent(
        keyEvent("t", { ctrlKey: true, shiftKey: true }),
        DEFAULT_SHORTCUTS.reopen_last_closed_tab
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("t", { ctrlKey: true }),
        DEFAULT_SHORTCUTS.reopen_last_closed_tab
      )
    ).toBe(false)
  })
})

describe("close window", () => {
  it("defaults to Ctrl/Cmd+Shift+W, shared with closing all file tabs", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("close_window")
    expect(DEFAULT_SHORTCUTS.close_window).toBe("mod+shift+w")
    expect(
      matchShortcutEvent(
        keyEvent("w", { ctrlKey: true, shiftKey: true }),
        DEFAULT_SHORTCUTS.close_window
      )
    ).toBe(true)
    // The file pane keeps its own use of the chord; everywhere else it is
    // the window's close. Sharing is allowed for exactly this pair.
    expect(DEFAULT_SHORTCUTS.close_all_file_tabs).toBe(
      DEFAULT_SHORTCUTS.close_window
    )
    expect(canShareShortcut("close_all_file_tabs", "close_window")).toBe(true)
    expect(canShareShortcut("close_window", "close_current_tab")).toBe(false)
  })
})

describe("alt combinations use event.code", () => {
  // macOS 上 ⌥S 报的 event.key 是 "ß"，不是 "s"。不看 event.code 的话，任何
  // 含 alt 的组合在 macOS 上都按不出来 —— 自定义样式的逃生舱正是这样一条。
  it("matches Cmd+Option+Shift+S even though the layout rewrote the key", () => {
    expect(
      matchShortcutEvent(
        keyEvent("ß", {
          metaKey: true,
          altKey: true,
          shiftKey: true,
          code: "KeyS",
        }),
        "mod+alt+shift+s"
      )
    ).toBe(true)
  })

  it("records the physical key rather than the rewritten character", () => {
    expect(
      shortcutFromKeyboardEvent(
        keyEvent("ß", {
          metaKey: true,
          altKey: true,
          shiftKey: true,
          code: "KeyS",
        })
      )
    ).toBe("mod+alt+shift+s")
  })

  it("leaves non-alt shortcuts on event.key", () => {
    // 没有 alt 时不改道：既有快捷键的行为必须逐字节不变。
    expect(
      matchShortcutEvent(
        keyEvent("k", { metaKey: true, code: "KeyK" }),
        "mod+k"
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("Dead", { metaKey: true, code: "KeyK" }),
        "mod+k"
      )
    ).toBe(false)
  })

  it("still resolves the escape hatch when the runtime omits event.code", () => {
    expect(
      matchShortcutEvent(
        keyEvent("s", { metaKey: true, altKey: true, shiftKey: true }),
        "mod+alt+shift+s"
      )
    ).toBe(true)
  })
})

const defaultZoom = {
  zoom_in: DEFAULT_SHORTCUTS.zoom_in,
  zoom_out: DEFAULT_SHORTCUTS.zoom_out,
  zoom_reset: DEFAULT_SHORTCUTS.zoom_reset,
}

describe("window zoom shortcuts", () => {
  it("registers zoom_in / zoom_out / zoom_reset defaults", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toContain("zoom_in")
    expect(ids).toContain("zoom_out")
    expect(ids).toContain("zoom_reset")
    expect(DEFAULT_SHORTCUTS.zoom_in).toBe("mod+=")
    expect(DEFAULT_SHORTCUTS.zoom_out).toBe("mod+-")
    expect(DEFAULT_SHORTCUTS.zoom_reset).toBe("mod+0")
  })

  it("lets + survive normalize so Ctrl/Cmd Shift = can be recorded", () => {
    expect(normalizeShortcut("mod++")).toBe("mod++")
    expect(normalizeShortcut("mod+shift++")).toBe("mod+shift++")
    expect(
      shortcutFromKeyboardEvent(
        keyEvent("+", { ctrlKey: true, shiftKey: true })
      )
    ).toBe("mod+shift++")
    expect(formatShortcutLabel("mod++", false)).toBe("Ctrl++")
    expect(formatShortcutLabel("mod++", true)).toBe("⌘+")
  })

  it("treats = and + as the same physical key on the bound zoom-in shortcut", () => {
    expect(matchShortcutEvent(keyEvent("=", { ctrlKey: true }), "mod+=")).toBe(
      true
    )
    // QWERTZ types + on its own key, without Shift.
    expect(
      matchShortcutEvent(
        keyEvent("+", { ctrlKey: true, code: "BracketRight" }),
        "mod+="
      )
    ).toBe(true)
    // Shift+= reaches it too, as long as no binding claims Shift+= outright
    // (the chat text size does by default — see below).
    expect(
      matchShortcutEvent(
        keyEvent("+", { ctrlKey: true, shiftKey: true }),
        "mod+=",
        []
      )
    ).toBe(true)
    expect(matchShortcutEvent(keyEvent("k", { ctrlKey: true }), "mod+=")).toBe(
      false
    )
  })

  it("treats - and _ as the same physical key on the bound zoom-out shortcut", () => {
    expect(matchShortcutEvent(keyEvent("-", { ctrlKey: true }), "mod+-")).toBe(
      true
    )
    expect(
      matchShortcutEvent(
        keyEvent("_", { ctrlKey: true, shiftKey: true }),
        "mod+-",
        []
      )
    ).toBe(true)
    expect(matchShortcutEvent(keyEvent("=", { ctrlKey: true }), "mod+-")).toBe(
      false
    )
  })

  it("follows a remapped zoom-in binding and ignores the old default", () => {
    const remapped = {
      ...defaultZoom,
      zoom_in: "mod+shift+z",
    }
    expect(
      resolveWindowZoomAction(
        keyEvent("z", { ctrlKey: true, shiftKey: true }),
        remapped
      )
    ).toBe("in")
    expect(
      resolveWindowZoomAction(keyEvent("=", { ctrlKey: true }), remapped)
    ).toBeNull()
    expect(
      resolveWindowZoomAction(
        keyEvent("+", { ctrlKey: true, shiftKey: true }),
        remapped
      )
    ).toBeNull()
  })

  it("still matches a repeat of the bound zoom key", () => {
    expect(
      resolveWindowZoomAction(keyEvent("=", { ctrlKey: true }), defaultZoom)
    ).toBe("in")
    expect(
      resolveWindowZoomAction(keyEvent("-", { ctrlKey: true }), defaultZoom)
    ).toBe("out")
    expect(
      resolveWindowZoomAction(keyEvent("0", { ctrlKey: true }), defaultZoom)
    ).toBe("reset")
  })

  it("does not treat AZERTY Ctrl+) as zoom out just because code is Minus", () => {
    expect(
      matchShortcutEvent(
        keyEvent(")", { ctrlKey: true, code: "Minus" }),
        "mod+-"
      )
    ).toBe(false)
  })

  it("still matches numpad + / - against the default zoom bindings", () => {
    expect(
      matchShortcutEvent(
        keyEvent("Add", { ctrlKey: true, code: "NumpadAdd" }),
        "mod+="
      )
    ).toBe(true)
    expect(
      matchShortcutEvent(
        keyEvent("Subtract", { ctrlKey: true, code: "NumpadSubtract" }),
        "mod+-"
      )
    ).toBe(true)
  })
})

describe("chat text size shortcuts", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** Which zoom a press reaches under a profile: one at most. */
  function zoomFor(
    event: ReturnType<typeof keyEvent>,
    settings = DEFAULT_SHORTCUTS
  ): string | null {
    const rivals = Object.values(settings)
    const chat = resolveChatTextZoomAction(event, settings, rivals)
    const win = resolveWindowZoomAction(event, settings, rivals)
    expect(chat !== null && win !== null).toBe(false)
    if (chat) return `chat:${chat}`
    if (win) return `window:${win}`
    return null
  }

  it("registers the three actions on Shift + the window zoom keys", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "chat_text_zoom_in",
        "chat_text_zoom_out",
        "chat_text_zoom_reset",
      ])
    )
    expect(DEFAULT_SHORTCUTS.chat_text_zoom_in).toBe("mod+shift+=")
    expect(DEFAULT_SHORTCUTS.chat_text_zoom_out).toBe("mod+shift+-")
    expect(DEFAULT_SHORTCUTS.chat_text_zoom_reset).toBe("mod+shift+0")
    expect(formatShortcutLabel(DEFAULT_SHORTCUTS.chat_text_zoom_in, true)).toBe(
      "⌘⇧="
    )
    expect(
      formatShortcutLabel(DEFAULT_SHORTCUTS.chat_text_zoom_reset, false)
    ).toBe("Ctrl+Shift+0")
  })

  it("collides with no other default", () => {
    const chatIds = [
      "chat_text_zoom_in",
      "chat_text_zoom_out",
      "chat_text_zoom_reset",
    ] as const
    for (const id of chatIds) {
      const clashes = SHORTCUT_DEFINITIONS.filter(
        (definition) =>
          definition.id !== id &&
          shortcutsConflict(
            DEFAULT_SHORTCUTS[definition.id],
            DEFAULT_SHORTCUTS[id]
          )
      ).map((definition) => definition.id)
      expect(clashes).toEqual([])
    }
  })

  // US: Shift+= types "+", Shift+- types "_", Shift+0 types ")". The browser
  // reports the shifted character in `key` and the physical key in `code`.
  it("splits the US keys between the two zooms by Shift", () => {
    const mac = (key: string, code: string, shiftKey = false) =>
      keyEvent(key, { metaKey: true, shiftKey, code })

    expect(zoomFor(mac("+", "Equal", true))).toBe("chat:in")
    expect(zoomFor(mac("=", "Equal"))).toBe("window:in")
    expect(zoomFor(mac("_", "Minus", true))).toBe("chat:out")
    expect(zoomFor(mac("-", "Minus"))).toBe("window:out")
    expect(zoomFor(mac(")", "Digit0", true))).toBe("chat:reset")
    expect(zoomFor(mac("0", "Digit0"))).toBe("window:reset")
    // Some engines leave the unshifted character in `key` while Cmd is held.
    expect(zoomFor(mac("=", "Equal", true))).toBe("chat:in")
    expect(zoomFor(mac("0", "Digit0", true))).toBe("chat:reset")
  })

  it("does the same with Ctrl on Windows and Linux", () => {
    const ctrl = (key: string, code: string, shiftKey = false) =>
      keyEvent(key, { ctrlKey: true, shiftKey, code })

    expect(zoomFor(ctrl("+", "Equal", true))).toBe("chat:in")
    expect(zoomFor(ctrl("=", "Equal"))).toBe("window:in")
    expect(zoomFor(ctrl("_", "Minus", true))).toBe("chat:out")
    expect(zoomFor(ctrl(")", "Digit0", true))).toBe("chat:reset")
  })

  it("follows the numpad + and - with and without Shift", () => {
    expect(zoomFor(keyEvent("+", { ctrlKey: true, code: "NumpadAdd" }))).toBe(
      "window:in"
    )
    expect(
      zoomFor(
        keyEvent("+", { ctrlKey: true, shiftKey: true, code: "NumpadAdd" })
      )
    ).toBe("chat:in")
    expect(
      zoomFor(
        keyEvent("-", {
          ctrlKey: true,
          shiftKey: true,
          code: "NumpadSubtract",
        })
      )
    ).toBe("chat:out")
  })

  // French AZERTY: = sits on its own key (Slash on macOS, Equal on Windows)
  // with + on Shift, and the digit row needs Shift to type a digit.
  it("works on AZERTY, where the digits need Shift", () => {
    expect(
      zoomFor(keyEvent("+", { metaKey: true, shiftKey: true, code: "Slash" }))
    ).toBe("chat:in")
    expect(zoomFor(keyEvent("=", { metaKey: true, code: "Slash" }))).toBe(
      "window:in"
    )
    expect(
      zoomFor(keyEvent("0", { ctrlKey: true, shiftKey: true, code: "Digit0" }))
    ).toBe("chat:reset")
    // The unshifted zero key types "à" and stays the window reset.
    expect(zoomFor(keyEvent("à", { ctrlKey: true, code: "Digit0" }))).toBe(
      "window:reset"
    )
    // AZERTY ")" sits on the Minus position: neither zoom out, shifted or not.
    expect(
      zoomFor(keyEvent(")", { ctrlKey: true, shiftKey: true, code: "Minus" }))
    ).toBeNull()
  })

  it("hands Shift+= back to the window zoom once the chat key is unbound", () => {
    const shiftEquals = keyEvent("+", {
      metaKey: true,
      shiftKey: true,
      code: "Equal",
    })
    const unbound = { ...DEFAULT_SHORTCUTS, chat_text_zoom_in: "" }

    // Through explicit rivals…
    expect(zoomFor(shiftEquals, unbound)).toBe("window:in")

    // …and through the stored profile every listener reads by default.
    writeShortcutSettings(unbound)
    expect(resolveChatTextZoomAction(shiftEquals, unbound)).toBeNull()
    expect(resolveWindowZoomAction(shiftEquals, unbound)).toBe("in")
  })

  it("follows a rebound chat key, and the old chord stops working", () => {
    const rebound = { ...DEFAULT_SHORTCUTS, chat_text_zoom_in: "mod+alt+=" }
    writeShortcutSettings(rebound)

    expect(
      resolveChatTextZoomAction(
        keyEvent("=", { metaKey: true, altKey: true, code: "Equal" }),
        rebound
      )
    ).toBe("in")
    const shiftEquals = keyEvent("+", {
      metaKey: true,
      shiftKey: true,
      code: "Equal",
    })
    expect(resolveChatTextZoomAction(shiftEquals, rebound)).toBeNull()
    expect(resolveWindowZoomAction(shiftEquals, rebound)).toBe("in")
  })

  it("ranks a literal match above every tolerated one", () => {
    const shiftEquals = keyEvent("+", { ctrlKey: true, shiftKey: true })
    expect(shortcutMatchStrength(shiftEquals, "mod+shift+=")).toBe(4)
    expect(shortcutMatchStrength(shiftEquals, "mod+=")).toBe(2)
    expect(
      shortcutMatchStrength(
        keyEvent(")", { ctrlKey: true, shiftKey: true, code: "Digit0" }),
        "mod+shift+0"
      )
    ).toBe(3)
    expect(
      shortcutMatchStrength(
        keyEvent("à", { ctrlKey: true, code: "Digit0" }),
        "mod+0"
      )
    ).toBe(3)
    expect(
      shortcutMatchStrength(keyEvent("k", { ctrlKey: true }), "mod+=")
    ).toBe(0)
  })
})

describe("digit bindings on a shifted digit row", () => {
  // AZERTY shifts the digit row: unshifted Digit0 types "à", and "0" needs
  // Shift. Both spellings used to miss `mod+0`, leaving reset unpressable.
  it("resolves reset from the unshifted AZERTY zero key", () => {
    expect(
      resolveWindowZoomAction(
        keyEvent("à", { ctrlKey: true, code: "Digit0" }),
        defaultZoom
      )
    ).toBe("reset")
  })

  it("resolves reset from the shifted AZERTY spelling that actually types 0", () => {
    // Ctrl+Shift+0 is the chat text reset by default, which spells this press
    // outright; the window reset only reaches it through the surplus-Shift
    // tolerance, so it yields. Unbind the chat reset and the window gets it.
    const shiftedZero = keyEvent("0", {
      ctrlKey: true,
      shiftKey: true,
      code: "Digit0",
    })
    expect(resolveWindowZoomAction(shiftedZero, defaultZoom)).toBeNull()
    expect(resolveChatTextZoomAction(shiftedZero, DEFAULT_SHORTCUTS)).toBe(
      "reset"
    )
    expect(
      resolveWindowZoomAction(
        shiftedZero,
        defaultZoom,
        Object.values(defaultZoom)
      )
    ).toBe("reset")
  })

  it("keeps QWERTY Ctrl+0 working, with or without event.code", () => {
    expect(
      resolveWindowZoomAction(
        keyEvent("0", { ctrlKey: true, code: "Digit0" }),
        defaultZoom
      )
    ).toBe("reset")
    expect(
      resolveWindowZoomAction(keyEvent("0", { ctrlKey: true }), defaultZoom)
    ).toBe("reset")
  })

  // The positional fallback must not claim a SHIFTED digit key: with Shift that
  // key types a character that belongs to another binding, so matching by
  // position would make one press satisfy two.
  it("leaves shifted US Digit0 to whoever owns the character it types", () => {
    expect(
      matchShortcutEvent(
        keyEvent(")", { metaKey: true, shiftKey: true, code: "Digit0" }),
        "mod+0"
      )
    ).toBe(false)
  })

  it("gives QWERTZ Ctrl+Shift+0 to one zoom-in only, not also to a reset", () => {
    // On German QWERTZ that keypress types "=" with Shift held: exactly the
    // chat text zoom-in, and the window zoom-in only through a surplus Shift.
    const event = keyEvent("=", {
      ctrlKey: true,
      shiftKey: true,
      code: "Digit0",
    })
    expect(matchShortcutEvent(event, "mod+0")).toBe(false)
    expect(matchShortcutEvent(event, "mod+shift+0")).toBe(false)
    expect(matchShortcutEvent(event, "mod+shift+=")).toBe(true)
    expect(matchShortcutEvent(event, "mod+=")).toBe(false)
    expect(resolveChatTextZoomAction(event, DEFAULT_SHORTCUTS)).toBe("in")
    expect(resolveWindowZoomAction(event, defaultZoom)).toBeNull()
    // With the chat chord unbound, it is the window's again.
    expect(
      resolveWindowZoomAction(event, defaultZoom, Object.values(defaultZoom))
    ).toBe("in")
  })

  // AZERTY puts `-` on Digit6 and `_` on Digit8. Binding the digits 1-9 to tab
  // jumps put those two physical keys in reach of the positional fallback, so
  // one Ctrl+- press would have matched `mod+-` by key AND `mod+6` by code —
  // and the zoom listener preventDefaults without stopping propagation, so the
  // window would zoom out *and* the app would jump to tab 6. `shortcutsConflict`
  // cannot see the pair, so Settings shows no warning either.
  it("leaves the AZERTY minus/underscore keys to the zoom bindings", () => {
    const minus = keyEvent("-", { ctrlKey: true, code: "Digit6" })
    expect(matchShortcutEvent(minus, "mod+6")).toBe(false)
    expect(numberedTabIndexFromEvent(minus, DEFAULT_SHORTCUTS)).toBeNull()
    expect(resolveWindowZoomAction(minus, defaultZoom)).toBe("out")

    const underscore = keyEvent("_", { ctrlKey: true, code: "Digit8" })
    expect(matchShortcutEvent(underscore, "mod+8")).toBe(false)
    expect(numberedTabIndexFromEvent(underscore, DEFAULT_SHORTCUTS)).toBeNull()
  })

  it("still reaches tab 6 from the AZERTY spelling that types the digit", () => {
    // Shift is how you type "6" there, and the surplus-Shift tolerance for
    // digits already accepts it — so declining the position costs nothing.
    expect(
      numberedTabIndexFromEvent(
        keyEvent("6", { ctrlKey: true, shiftKey: true, code: "Digit6" }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(5)
  })

  it("keeps the positional fallback for AZERTY digits nobody else claims", () => {
    // Unshifted Digit1 types "&", which no binding owns by name.
    expect(
      numberedTabIndexFromEvent(
        keyEvent("&", { ctrlKey: true, code: "Digit1" }),
        DEFAULT_SHORTCUTS
      )
    ).toBe(0)
  })

  it("only accepts the bound digit's own physical key", () => {
    expect(
      matchShortcutEvent(
        keyEvent("à", { ctrlKey: true, code: "Digit0" }),
        "mod+1"
      )
    ).toBe(false)
    expect(
      matchShortcutEvent(
        keyEvent("&", { ctrlKey: true, code: "Digit1" }),
        "mod+0"
      )
    ).toBe(false)
  })

  it("leaves the surplus-Shift rule exact for non-digit keys", () => {
    // The tolerance is scoped to the digit row; a letter must still be exact,
    // or every mod+shift+X binding would start firing its mod+X neighbour.
    expect(
      matchShortcutEvent(
        keyEvent("k", { ctrlKey: true, shiftKey: true, code: "KeyK" }),
        "mod+k"
      )
    ).toBe(false)
    expect(
      matchShortcutEvent(
        keyEvent("Enter", { shiftKey: true, code: "Enter" }),
        "enter"
      )
    ).toBe(false)
  })
})

describe("binding conflicts use matcher semantics", () => {
  it("catches two different strings that fire on the same event", () => {
    // One chord, two spellings: string equality reports no conflict while
    // both actions run.
    expect(shortcutsConflict("mod+=", "mod++")).toBe(true)
    expect(shortcutsConflict("mod+shift+=", "mod+shift++")).toBe(true)
    expect(shortcutsConflict("mod+-", "mod+_")).toBe(true)
  })

  it("lets a Shift binding coexist with the one that only tolerates Shift", () => {
    // Both accept Ctrl/Cmd+Shift+=, but only the binding that names Shift
    // fires on it (the other yields), so no press fires both.
    const shiftEquals = keyEvent("+", { ctrlKey: true, shiftKey: true })
    const both = ["mod+=", "mod+shift++"]
    expect(matchShortcutEvent(shiftEquals, "mod+shift++", both)).toBe(true)
    expect(matchShortcutEvent(shiftEquals, "mod+=", both)).toBe(false)
    expect(shortcutsConflict("mod+=", "mod+shift++")).toBe(false)
    expect(shortcutsConflict("mod+=", "mod+shift+=")).toBe(false)
    expect(shortcutsConflict("mod+-", "mod+shift+-")).toBe(false)
  })

  it("does the same for a digit and its own shifted spelling", () => {
    expect(shortcutsConflict("mod+0", "mod+shift+0")).toBe(false)
    expect(shortcutsConflict("mod+shift+0", "mod+shift+0")).toBe(true)
  })

  it("does not invent a conflict between genuinely distinct chords", () => {
    expect(shortcutsConflict("mod+k", "mod+shift+k")).toBe(false)
    expect(shortcutsConflict("mod+k", "mod+j")).toBe(false)
    expect(shortcutsConflict("enter", "shift+enter")).toBe(false)
    expect(shortcutsConflict("mod+=", "mod+-")).toBe(false)
  })

  it("still reports an exact duplicate", () => {
    expect(shortcutsConflict("mod+b", "mod+b")).toBe(true)
  })

  it("treats an unparseable or unbound side as no conflict", () => {
    expect(shortcutsConflict("", "mod+b")).toBe(false)
    expect(shortcutsConflict("mod+b", "")).toBe(false)
  })
})

describe("a new default never steals a stored binding", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("leaves the new action unbound when the chord is already claimed", () => {
    // Exactly the payload the previously shipped app could have written: the
    // zoom keys are new, so they are absent and get seeded on top.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+-", toggle_sidebar: "mod+0" })
    )

    const settings = readShortcutSettings()

    expect(settings.toggle_search).toBe("mod+-")
    expect(settings.toggle_sidebar).toBe("mod+0")
    expect(settings.zoom_out).toBe("")
    expect(settings.zoom_reset).toBe("")
    // The one that does not collide still arrives on its default.
    expect(settings.zoom_in).toBe(DEFAULT_SHORTCUTS.zoom_in)
  })

  it("compares with matcher semantics, not string equality", () => {
    // `mod+shift++` is not the string `mod+shift+=`, but it is the same chord,
    // so the new chat text default arrives unbound. The window zoom-in stays:
    // the stored Shift binding outranks its surplus-Shift tolerance instead.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+shift++" })
    )

    const settings = readShortcutSettings()
    expect(settings.chat_text_zoom_in).toBe("")
    expect(settings.zoom_in).toBe(DEFAULT_SHORTCUTS.zoom_in)
  })

  it("seeds the chat text keys on a profile saved before they existed", () => {
    // What every earlier build wrote back: the full set minus the new actions.
    const previous = Object.fromEntries(
      Object.entries(DEFAULT_SHORTCUTS).filter(
        ([id]) => !id.startsWith("chat_text_zoom_")
      )
    )
    expect(Object.keys(previous)).not.toContain("chat_text_zoom_in")
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(previous))

    const settings = readShortcutSettings()
    expect(settings.chat_text_zoom_in).toBe("mod+shift+=")
    expect(settings.chat_text_zoom_out).toBe("mod+shift+-")
    expect(settings.chat_text_zoom_reset).toBe("mod+shift+0")
    expect(settings.zoom_in).toBe("mod+=")
  })

  it("survives a later write instead of reseeding the collision", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_sidebar: "mod+0" })
    )

    const settings = readShortcutSettings()
    expect(settings.zoom_reset).toBe("")

    // Changing something unrelated writes the whole object back. The unbound
    // action has to stay unbound, or the collision returns on the next read.
    writeShortcutSettings({ ...settings, toggle_terminal: "mod+shift+j" })

    const reread = readShortcutSettings()
    expect(reread.zoom_reset).toBe("")
    expect(reread.toggle_sidebar).toBe("mod+0")
    expect(reread.toggle_terminal).toBe("mod+shift+j")
  })

  it("still seeds every default for a profile that never stored anything", () => {
    expect(readShortcutSettings()).toEqual(DEFAULT_SHORTCUTS)
  })

  it("keeps the pairs that are meant to share a chord", () => {
    // new_terminal_tab and new_conversation ship on the same chord on purpose,
    // so a stored copy of one must not unbind the other.
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ new_terminal_tab: "mod+t" })
    )

    const settings = readShortcutSettings()
    expect(settings.new_terminal_tab).toBe("mod+t")
    expect(settings.new_conversation).toBe(DEFAULT_SHORTCUTS.new_conversation)
  })

  it("does not unbind a default over a collision between two defaults", () => {
    localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ toggle_search: "mod+shift+f" })
    )

    const settings = readShortcutSettings()
    for (const definition of SHORTCUT_DEFINITIONS) {
      if (definition.id === "toggle_search") continue
      expect(settings[definition.id]).toBe(DEFAULT_SHORTCUTS[definition.id])
    }
  })
})
