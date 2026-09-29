import { describe, expect, it } from "vitest"

import { acceleratorFromEvent, formatAccelerator } from "./shortcut"

const press = (
  code: string,
  mods: Partial<{
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
  }> = {}
) => ({
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
})

describe("acceleratorFromEvent", () => {
  it("records Option+Space by key position, not by the typed character", () => {
    // On macOS, Option turns Space into a non-breaking space in `key`; the
    // physical `code` stays "Space".
    expect(acceleratorFromEvent(press("Space", { altKey: true }))).toBe(
      "Alt+Space"
    )
  })

  it("orders modifiers and keeps the key's code", () => {
    expect(
      acceleratorFromEvent(
        press("KeyK", { metaKey: true, shiftKey: true, ctrlKey: true })
      )
    ).toBe("Control+Shift+Super+KeyK")
    expect(acceleratorFromEvent(press("Digit1", { altKey: true }))).toBe(
      "Alt+Digit1"
    )
  })

  it("waits while only modifiers are held, and refuses bare keys", () => {
    expect(acceleratorFromEvent(press("AltLeft", { altKey: true }))).toBeNull()
    expect(acceleratorFromEvent(press("Space"))).toBeNull()
    expect(
      acceleratorFromEvent(press("IntlBackslash", { altKey: true }))
    ).toBeNull()
  })
})

describe("formatAccelerator", () => {
  it("uses symbols on macOS", () => {
    expect(formatAccelerator("Alt+Space", true)).toBe("⌥Space")
    expect(formatAccelerator("Control+Shift+Super+KeyK", true)).toBe("⌃⇧⌘K")
  })

  it("spells modifiers out elsewhere", () => {
    expect(formatAccelerator("Alt+Space", false)).toBe("Alt+Space")
    expect(formatAccelerator("Control+Super+Digit1", false)).toBe("Ctrl+Win+1")
  })
})
