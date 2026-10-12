import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"

import { detectTextDirection, type TextDirection } from "@/lib/text-direction"

export const composerDirectionKey = new PluginKey("composerDirection")

/**
 * The direction the draft reads in, from its own text — the composer's
 * `dir="auto"`, with the same rules a sent message's bubble uses
 * ({@link detectTextDirection}). Reference badges are names and paths, not the
 * sentence, so each counts as a space; a hard break is a line break.
 * `undefined` for an empty or letterless draft, which keeps the UI's direction
 * (and the placeholder where it was).
 */
export function composerDirection(
  doc: ProseMirrorNode
): TextDirection | undefined {
  const text = doc.textBetween(0, doc.content.size, "\n", (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : " "
  )
  return detectTextDirection(text)
}

/**
 * Sets `dir` on the editable element as the draft changes, so typing Hebrew in
 * the English UI flips the composer to right to left — alignment, caret side
 * and the bidi base of every line — and back when the draft is English again.
 */
export const ComposerDirection = Extension.create({
  name: "composerDirection",

  addProseMirrorPlugins() {
    // `attributes` is read on every view update; only re-scan a changed doc.
    let lastDoc: ProseMirrorNode | null = null
    let lastDir: TextDirection | undefined
    return [
      new Plugin({
        key: composerDirectionKey,
        props: {
          attributes: (state): Record<string, string> => {
            if (state.doc !== lastDoc) {
              lastDoc = state.doc
              lastDir = composerDirection(state.doc)
            }
            return lastDir ? { dir: lastDir } : {}
          },
        },
      }),
    ]
  },
})
