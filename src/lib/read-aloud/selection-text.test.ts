import { afterEach, describe, expect, it } from "vitest"

import { selectionSpeechText } from "./selection-text"

function selectContents(element: Element): Selection {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ""
})

describe("selectionSpeechText", () => {
  it("leaves rendered code blocks and buttons out, one line per block", () => {
    document.body.innerHTML = `
      <div id="reply">
        <p>First paragraph.</p>
        <div data-streamdown="code-block">
          <div>ts <button>Copy</button></div>
          <pre><code>const hidden = true</code></pre>
        </div>
        <ul><li>Item one</li><li>Item <code>two</code></li></ul>
      </div>`
    const text = selectionSpeechText(
      selectContents(document.getElementById("reply")!)
    )
    expect(text).not.toContain("hidden")
    expect(text).not.toContain("Copy")
    expect(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    ).toEqual(["First paragraph.", "Item one", "Item two"])
  })

  it("keeps links and file badges, which render as buttons", () => {
    document.body.innerHTML = `
      <p id="p">See <button data-streamdown="link">https://example.com</button>
      and <button data-resource-kind="file">notes.md</button>
      <button aria-label="Copy"><svg></svg>Copy</button></p>`
    expect(
      selectionSpeechText(selectContents(document.getElementById("p")!))
        .replace(/\s+/g, " ")
        .trim()
    ).toBe("See https://example.com and notes.md")
  })

  it("reads part of a single text node", () => {
    document.body.innerHTML = `<p id="p">Hello there world</p>`
    const node = document.getElementById("p")!.firstChild!
    const range = document.createRange()
    range.setStart(node, 6)
    range.setEnd(node, 11)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionSpeechText(selection)).toBe("there")
  })

  it("is empty for a selection inside code, and for no selection", () => {
    document.body.innerHTML = `<pre id="code">npm run build</pre>`
    expect(
      selectionSpeechText(selectContents(document.getElementById("code")!))
    ).toBe("")
    expect(selectionSpeechText(null)).toBe("")
  })
})
