import { detectTextDirection, hasRtlLetter } from "@/lib/text-direction"

/**
 * Give every block of rendered Markdown the direction of its own text.
 *
 * Runs at the END of the rehype pipeline — after sanitize, which would drop
 * attributes added earlier, and before the math plugin Streamdown appends, so
 * math is still `code.language-math` here — and only adds `dir` attributes
 * (plus `<span dir="ltr">` around a bare path or URL in a right-to-left block).
 * Streamdown's element overrides spread their props onto the DOM element, so
 * `dir` reaches the `<p>`, `<li>`, `<th>` it was computed for.
 *
 * - Paragraphs, headings, list items, lists, blockquotes, tables and cells each
 *   get `dir` from {@link detectTextDirection} over their own text. With it the
 *   bidi algorithm resolves punctuation and mixed Hebrew/English runs against
 *   the right base direction, and the logical CSS around (`text-align: start`,
 *   `padding-inline-start`, the list marker's side) follows on its own.
 * - A list item does not count its nested lists' words; a list counts its
 *   items'. A block with no letters (a number, a code span) gets no `dir` and
 *   inherits its container's.
 * - Inline code is `dir="ltr"`: an identifier, a flag or a path reads left to
 *   right in any sentence, and the attribute isolates it so `--force` or
 *   `./run.sh` does not lose its leading punctuation to the far side.
 * - A `dir` already on an element (raw HTML that survived sanitize) is kept.
 */
type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ul",
  "ol",
  "blockquote",
  "table",
  "th",
  "td",
  "dl",
  "dt",
  "dd",
  "caption",
  "figcaption",
  "summary",
  "details",
])

const LISTS = new Set(["ul", "ol"])

// Elements whose text is not prose: it never votes for a block's direction.
const NON_PROSE = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "math",
  "svg",
  "script",
  "style",
  "img",
  "input",
  "button",
  "textarea",
  "select",
])

const NON_PROSE_CLASSES = ["katex", "math-inline", "math-display"]

function classNames(node: HastNode): string[] {
  const value = node.properties?.className
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === "string") return value.split(/\s+/)
  return []
}

function isNonProse(node: HastNode): boolean {
  const tag = node.tagName ?? ""
  if (NON_PROSE.has(tag)) return true
  if (classNames(node).some((name) => NON_PROSE_CLASSES.includes(name))) {
    return true
  }
  // A `codeg://` reference or a local file link renders as a badge whose label
  // is a name or a path, not part of the sentence. A web link's label is.
  if (tag !== "a") return false
  const href = node.properties?.href
  if (typeof href !== "string") return false
  return /^(?:codeg|file):/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href)
}

function collectText(
  node: HastNode,
  out: string[],
  skipNestedLists: boolean
): void {
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      out.push(child.value ?? "")
    } else if (child.type === "element") {
      if (
        isNonProse(child) ||
        (skipNestedLists && LISTS.has(child.tagName ?? ""))
      ) {
        out.push(" ")
        continue
      }
      // Blocks are separate runs of text: never glue their words together.
      if (BLOCKS.has(child.tagName ?? "")) out.push("\n")
      collectText(child, out, skipNestedLists)
    }
  }
}

/** The text that decides `node`'s direction. */
function ownText(node: HastNode): string {
  const out: string[] = []
  const tag = node.tagName ?? ""
  if (LISTS.has(tag)) {
    // A list reads in its items' direction; nested lists decide their own.
    for (const item of node.children ?? []) {
      if (item.type === "element") {
        collectText(item, out, true)
        out.push("\n")
      }
    }
  } else {
    collectText(node, out, tag === "li")
  }
  return out.join("")
}

// A bare path or URL in prose: a scheme or `www.` address, or path segments
// joined by `/` or `\` — `~/`, `./`, `../` or `/` led, or starting with a name.
// Trailing sentence punctuation is not part of it, and neither is a leading
// hyphen (`ל-src/a.ts`: the hyphen belongs to the Hebrew prefix).
const PATH_OR_URL =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s<>"]*[^\s<>".,;:!?)\]]|(?:(?:~|\.{1,2})?(?:[\\/][\w.@~+-]+)+|[\w@~+][\w.@~+-]*(?:[\\/][\w.@~+-]+)+)[\\/]?(?<![.,;:!?])/gi

/**
 * Split a text node that sits in a right-to-left block so each path or URL in
 * it becomes `<span dir="ltr">`: its leading `./`, `/` or `~` and trailing `/`
 * are neutral characters that would otherwise resolve to RTL and jump to the
 * far end of it.
 */
function isolatePaths(value: string): HastNode[] | null {
  PATH_OR_URL.lastIndex = 0
  let match: RegExpExecArray | null
  let last = 0
  const parts: HastNode[] = []
  while ((match = PATH_OR_URL.exec(value))) {
    const token = match[0]
    // A slash between Hebrew words (`ו/או`) is prose, not a path.
    if (hasRtlLetter(token)) continue
    if (match.index > last) {
      parts.push({ type: "text", value: value.slice(last, match.index) })
    }
    parts.push({
      type: "element",
      tagName: "span",
      properties: { dir: "ltr" },
      children: [{ type: "text", value: token }],
    })
    last = match.index + token.length
  }
  if (parts.length === 0) return null
  if (last < value.length) {
    parts.push({ type: "text", value: value.slice(last) })
  }
  return parts
}

function walk(node: HastNode, rtlContext: boolean): void {
  let rtl = rtlContext
  if (node.type === "element") {
    const tag = node.tagName ?? ""
    const properties = (node.properties ??= {})
    // Inline code only: a code block's `<code>` sits in a `<pre>`, which
    // returns below before its children are walked, and math (`code.language-
    // math`) is left to the KaTeX plugin and the `.katex` rule in globals.css.
    if (tag === "code") {
      if (
        properties.dir == null &&
        !classNames(node).includes("language-math")
      ) {
        properties.dir = "ltr"
      }
      return
    }
    if (BLOCKS.has(tag)) {
      if (properties.dir == null) {
        const dir = detectTextDirection(ownText(node))
        if (dir) properties.dir = dir
      }
    }
    if (properties.dir === "rtl") rtl = true
    else if (properties.dir === "ltr") rtl = false
    // Code blocks, math, badges and links lay out on their own.
    if (isNonProse(node) || tag === "a") return
  }
  const children = node.children
  if (!children) return
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]
    if (child.type === "text" && rtl) {
      const parts = isolatePaths(child.value ?? "")
      if (parts) {
        children.splice(i, 1, ...parts)
        i += parts.length - 1
      }
      continue
    }
    walk(child, rtl)
  }
}

export function rehypeBlockDirection() {
  return (tree: unknown) => {
    walk(tree as HastNode, false)
  }
}

/**
 * Streamdown's own blockquote styling — `border-l-4 pl-4` — restated in
 * logical properties, for the hosts that keep it (reasoning, the Markdown file
 * preview). Left to right it is the same 4px rule and 1rem indent on the left
 * and nothing on the right; a right-to-left quote gets them on the right. The
 * descendant selector outranks Streamdown's plain utilities, which is what
 * clears the physical left edge (`border-e-0`, `pe-0`) on a right-to-left
 * quote.
 */
export const STREAMDOWN_LOGICAL_QUOTE_CLASSES =
  "[&_blockquote]:border-s-4 [&_blockquote]:border-e-0 [&_blockquote]:ps-4 [&_blockquote]:pe-0"
