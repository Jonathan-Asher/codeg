import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  __resetQuickSwitchTypeaheadForTests,
  armQuickSwitchTypeahead,
  cancelQuickSwitchTypeahead,
  setQuickSwitchTypeaheadOwner,
  takeQuickSwitchTypeahead,
  TYPEAHEAD_TIMEOUT_MS,
} from "./quick-switch-typeahead"

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe("quick switch typeahead", () => {
  let composer: HTMLTextAreaElement
  let switcher: HTMLDivElement
  let switcherInput: HTMLInputElement
  let composerKeys: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetQuickSwitchTypeaheadForTests()
    composer = document.createElement("textarea")
    switcher = document.createElement("div")
    switcherInput = document.createElement("input")
    switcher.appendChild(switcherInput)
    document.body.append(composer, switcher)
    setQuickSwitchTypeaheadOwner(switcher)
    composerKeys = vi.fn()
    composer.addEventListener("keydown", composerKeys)
    // Anything listening on the page (the composer's keymap, global
    // shortcuts) must not see a held key either.
    document.addEventListener("keydown", composerKeys)
  })

  afterEach(() => {
    document.removeEventListener("keydown", composerKeys)
    composer.remove()
    switcher.remove()
    __resetQuickSwitchTypeaheadForTests()
    vi.useRealTimers()
  })

  it("lets keys through when not armed", () => {
    const event = press(composer, { key: "Enter" })
    expect(event.defaultPrevented).toBe(false)
    expect(composerKeys).toHaveBeenCalledTimes(2)
    expect(takeQuickSwitchTypeahead()).toEqual([])
  })

  it("holds keys aimed elsewhere once armed and hands them over in order", () => {
    armQuickSwitchTypeahead()
    const keys = ["s", "p", "Backspace", "ArrowDown", "Enter"]
    const events = keys.map((key) => press(composer, { key }))

    expect(events.every((event) => event.defaultPrevented)).toBe(true)
    expect(composerKeys).not.toHaveBeenCalled()
    expect(takeQuickSwitchTypeahead().map((k) => k.key)).toEqual(keys)

    // Taken: disarmed, so later keys go where they are aimed again.
    press(composer, { key: "x" })
    expect(composerKeys).toHaveBeenCalled()
    expect(takeQuickSwitchTypeahead()).toEqual([])
  })

  it("never holds the switcher's own keys", () => {
    armQuickSwitchTypeahead()
    const event = press(switcherInput, { key: "a" })
    expect(event.defaultPrevented).toBe(false)
    expect(takeQuickSwitchTypeahead()).toEqual([])
  })

  it("leaves chords, keys it has no use for and IME composition alone", () => {
    armQuickSwitchTypeahead()
    press(composer, { key: "k", metaKey: true })
    press(composer, { key: "w", ctrlKey: true })
    press(composer, { key: "F5" })
    press(composer, { key: "Tab" })
    press(composer, { key: "a", isComposing: true })
    expect(composerKeys).toHaveBeenCalledTimes(10)
    expect(takeQuickSwitchTypeahead()).toEqual([])
  })

  it("drops what it held when the switcher closes instead", () => {
    armQuickSwitchTypeahead()
    press(composer, { key: "Enter" })
    cancelQuickSwitchTypeahead()
    expect(takeQuickSwitchTypeahead()).toEqual([])
    press(composer, { key: "Enter" })
    expect(composerKeys).toHaveBeenCalledTimes(2)
  })

  it("gives up if the switcher never takes the keys", () => {
    vi.useFakeTimers()
    armQuickSwitchTypeahead()
    press(composer, { key: "Enter" })
    vi.advanceTimersByTime(TYPEAHEAD_TIMEOUT_MS)
    expect(takeQuickSwitchTypeahead()).toEqual([])
    const late = press(composer, { key: "Enter" })
    expect(late.defaultPrevented).toBe(false)
  })

  it("starts over on a second arm", () => {
    armQuickSwitchTypeahead()
    press(composer, { key: "a" })
    armQuickSwitchTypeahead()
    press(composer, { key: "b" })
    expect(takeQuickSwitchTypeahead().map((k) => k.key)).toEqual(["b"])
  })
})
