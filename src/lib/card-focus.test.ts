import { afterEach, describe, expect, it, vi } from "vitest"

import {
  canCardTakeFocus,
  focusCardEntry,
  handleComposerArrowUp,
  isShown,
  isWindowFocused,
  releaseKeyboard,
} from "./card-focus"

function mount(html: string) {
  document.body.innerHTML = html
}

const byId = (id: string) => document.getElementById(id)!

afterEach(() => {
  document.body.innerHTML = ""
  window.dispatchEvent(new FocusEvent("focus"))
})

describe("isShown", () => {
  it("is false inside every surface the app keeps mounted but hidden", () => {
    mount(`
      <div class="conversation-tab-hidden"><div id="tab"></div></div>
      <div inert><div id="route"></div></div>
      <div hidden><div id="palette"></div></div>
      <div id="shown"></div>
    `)
    expect(isShown(byId("tab"))).toBe(false)
    expect(isShown(byId("route"))).toBe(false)
    expect(isShown(byId("palette"))).toBe(false)
    expect(isShown(byId("shown"))).toBe(true)
  })

  it("is false for no element or a detached one", () => {
    expect(isShown(null)).toBe(false)
    expect(isShown(document.createElement("div"))).toBe(false)
  })

  it("asks the engine where it can tell", () => {
    mount(`<div id="card"></div>`)
    const card = byId("card")
    Object.defineProperty(card, "checkVisibility", { value: () => false })
    expect(isShown(card)).toBe(false)
  })
})

describe("canCardTakeFocus", () => {
  it("never into a card off screen, even with focus nowhere", () => {
    mount(`
      <div class="conversation-tab-hidden">
        <div data-composer-scope=""><div id="card"><button data-card-entry="">Allow</button></div></div>
      </div>
    `)
    expect(canCardTakeFocus(byId("card"))).toBe(false)
    expect(focusCardEntry(byId("card"))).toBe(false)
    expect(document.body).toHaveFocus()
  })

  it("takes focus left behind off screen, even in a field with text", () => {
    mount(`
      <div class="conversation-tab-hidden">
        <div data-composer-scope=""><input id="left-behind" value="draft" /></div>
      </div>
      <div data-composer-scope=""><div id="card"><button data-card-entry="">Allow</button></div></div>
    `)
    byId("left-behind").focus()
    expect(canCardTakeFocus(byId("card"))).toBe(true)
  })

  it("still never out of another conversation on screen", () => {
    mount(`
      <div data-composer-scope=""><button id="other">Retry</button></div>
      <div data-composer-scope=""><div id="card"><button data-card-entry="">Allow</button></div></div>
    `)
    byId("other").focus()
    expect(canCardTakeFocus(byId("card"))).toBe(false)
  })
})

describe("releaseKeyboard", () => {
  it("lets go only of focus inside the card", () => {
    mount(`
      <div id="card"><button id="in">Allow</button></div>
      <button id="out">Elsewhere</button>
    `)
    byId("out").focus()
    releaseKeyboard(byId("card"))
    expect(byId("out")).toHaveFocus()

    byId("in").focus()
    releaseKeyboard(byId("card"))
    expect(document.body).toHaveFocus()
  })
})

describe("handleComposerArrowUp", () => {
  it("never moves into a card off screen", () => {
    mount(`
      <div class="conversation-tab-hidden">
        <div id="scope" data-composer-scope="">
          <div><button data-card-entry="">Allow</button></div>
          <textarea id="composer" data-composer-input=""></textarea>
        </div>
      </div>
    `)
    const scope = byId("scope")
    let handled: boolean | null = null
    scope.addEventListener(
      "keydown",
      (event) => {
        handled = handleComposerArrowUp(event, scope)
      },
      true
    )
    byId("composer").focus()
    byId("composer").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      })
    )
    expect(handled).toBe(false)
    expect(byId("composer")).toHaveFocus()
  })
})

describe("focusing a card's entry", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const card = `
    <div id="scope" data-composer-scope="">
      <div id="card">
        <div id="list" tabindex="0" data-card-entry="" data-card-entry-keep-scroll=""></div>
      </div>
      <textarea id="composer" data-composer-input=""></textarea>
    </div>
  `

  it("leaves the scroll alone for an entry in the card's own body", () => {
    mount(card)
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    expect(focusCardEntry(byId("card"))).toBe(true)
    expect(byId("list")).toHaveFocus()
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  })

  it("does the same for ↑ from the composer", () => {
    mount(card)
    const scope = byId("scope")
    scope.addEventListener("keydown", (event) => {
      handleComposerArrowUp(event, scope)
    })
    byId("composer").focus()
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    byId("composer").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      })
    )
    expect(byId("list")).toHaveFocus()
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  })

  it("focuses any other entry as before", () => {
    mount(`<div id="card"><button data-card-entry="">Allow</button></div>`)
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    expect(focusCardEntry(byId("card"))).toBe(true)
    expect(focus).toHaveBeenLastCalledWith()
  })
})

describe("isWindowFocused", () => {
  it("follows the window leaving and coming back", () => {
    expect(isWindowFocused()).toBe(true)
    window.dispatchEvent(new FocusEvent("blur"))
    expect(isWindowFocused()).toBe(false)
    window.dispatchEvent(new FocusEvent("focus"))
    expect(isWindowFocused()).toBe(true)
  })

  it("is back on any key or press in the page, whatever event was missed", () => {
    window.dispatchEvent(new FocusEvent("blur"))
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Shift", bubbles: true })
    )
    expect(isWindowFocused()).toBe(true)

    window.dispatchEvent(new FocusEvent("blur"))
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    expect(isWindowFocused()).toBe(true)
  })

  it("ignores focus moving between elements", () => {
    mount(`<button id="a">A</button><button id="b">B</button>`)
    byId("a").focus()
    byId("b").focus()
    expect(isWindowFocused()).toBe(true)
  })
})
