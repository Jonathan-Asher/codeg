import { Editor } from "@tiptap/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { composerDirection } from "./composer-direction"
import { buildComposerExtensions } from "./editor-config"
import { textToSeededInlineContent } from "./plain-text-content"

describe("ComposerDirection", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: buildComposerExtensions(),
    })
  })

  afterEach(() => {
    editor?.destroy()
  })

  const dir = () => editor.view.dom.getAttribute("dir")

  it("keeps the UI's direction while the draft is empty", () => {
    expect(composerDirection(editor.state.doc)).toBeUndefined()
    expect(dir()).toBeNull()
  })

  it("switches to right to left as Hebrew is typed, and back", () => {
    editor.commands.insertContent("שלום")
    expect(dir()).toBe("rtl")

    editor.commands.setContent("")
    expect(dir()).toBeNull()

    editor.commands.insertContent("Hello there")
    expect(dir()).toBe("ltr")
  })

  it("reads a multi-line draft with an English opener as Hebrew", () => {
    editor.commands.insertContent(
      textToSeededInlineContent(
        "React Query היא ספרייה\nמחר נבדוק את זה עם הצוות"
      )
    )
    expect(dir()).toBe("rtl")
  })

  it("does not let a reference badge decide", () => {
    editor.commands.insertContent([
      {
        type: "reference",
        attrs: {
          refType: "file",
          id: "/repo/src/app/page.tsx",
          label: "page.tsx",
          uri: "/repo/src/app/page.tsx",
          meta: null,
        },
      },
      { type: "text", text: " תבדוק את הקובץ" },
    ])
    expect(dir()).toBe("rtl")
  })
})
