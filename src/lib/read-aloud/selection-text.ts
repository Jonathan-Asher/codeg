/**
 * The text of a page selection as it should be read aloud: what the user
 * selected, minus rendered code blocks and button labels, with a line break
 * between blocks so each paragraph or list item reads as its own sentence.
 */

// Links and file badges are buttons too (`markdown-link.tsx`); those keep
// their text, which the speech rules then read as "a link" or a file name.
const SKIP_SELECTOR =
  'pre, [data-streamdown="code-block"], button:not([data-streamdown="link"]):not([data-resource-kind]), script, style, [aria-hidden="true"]'

const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, figcaption"

function readRange(range: Range): string {
  const root = range.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement?.closest(SKIP_SELECTOR)) return ""
    return (root.textContent ?? "").slice(range.startOffset, range.endOffset)
  }
  const doc = root.ownerDocument ?? document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let out = ""
  let lastBlock: Element | null | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue
    const parent = node.parentElement
    if (!parent || parent.closest(SKIP_SELECTOR)) continue
    let text = node.textContent ?? ""
    if (node === range.endContainer) text = text.slice(0, range.endOffset)
    if (node === range.startContainer) text = text.slice(range.startOffset)
    const block = parent.closest(BLOCK_SELECTOR)
    if (lastBlock !== undefined && block !== lastBlock) out += "\n"
    lastBlock = block
    out += text
  }
  return out
}

/**
 * Empty when there is nothing outside code to read, or when the selection
 * can't be walked; the caller then falls back to `selection.toString()`.
 */
export function selectionSpeechText(selection: Selection | null): string {
  if (!selection || selection.rangeCount === 0) return ""
  try {
    const parts: string[] = []
    for (let i = 0; i < selection.rangeCount; i += 1) {
      parts.push(readRange(selection.getRangeAt(i)))
    }
    return parts.join("\n").trim()
  } catch {
    return ""
  }
}
