import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
  parseLocalFileTarget: () => null,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { MessageResponse } from "./message"
import { rehypeBlockDirection } from "./rehype-block-direction"

// Drives the REAL Streamdown pipeline (parse → sanitize → harden → this
// plugin): `dir` added any earlier would be stripped by sanitize, so only an
// end-to-end render shows the attribute survives onto the DOM.
const HEBREW_REPLY = [
  "המחקר נכתב ל-workspace: `research/international-tax-structure-2026-10-12.md` (מקושר מהאינדקס).",
  "",
  "## ⚡ שני ממצאים קריטיים (מקורות ממשלתיים)",
  "",
  '1. **פטור ה-de minimis של ארה"ב** — בוטל.',
  "   - EO 14324 (אוגוסט 2025) → חוק → הושהה פעמיים (פברואר ואפריל 2026).",
  "   - משמעות: כל חבילה מסין משלמת מכס.",
  "2. **פטור ה-€150 בוטל** מ-1.7.2026.",
  "",
  "> הערה: זה לא סופי.",
  "",
  "| שם | ערך |",
  "| --- | --- |",
  "| מכס | 3 |",
  "",
  "```ts",
  "const rate = 0.09",
  "```",
  "",
  "The English summary stays left to right.",
].join("\n")

describe("MessageResponse block direction", () => {
  it("gives each block the direction of its own text", async () => {
    const { container } = render(
      <MessageResponse>{HEBREW_REPLY}</MessageResponse>
    )
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("const rate")
    )

    const paragraphs = Array.from(container.querySelectorAll("p"))
    const intro = paragraphs.find((p) =>
      p.textContent?.startsWith("המחקר נכתב")
    )
    expect(intro).toHaveAttribute("dir", "rtl")
    const english = paragraphs.find((p) =>
      p.textContent?.startsWith("The English summary")
    )
    expect(english).toHaveAttribute("dir", "ltr")

    expect(container.querySelector("h2")).toHaveAttribute("dir", "rtl")
    expect(container.querySelector("ol")).toHaveAttribute("dir", "rtl")
    const items = Array.from(container.querySelectorAll("li"))
    expect(items.length).toBeGreaterThanOrEqual(4)
    for (const item of items) expect(item).toHaveAttribute("dir", "rtl")
    // A Hebrew item that opens with a Latin term is still RTL.
    const eo = items.find((li) => li.textContent?.startsWith("EO 14324"))
    expect(eo).toHaveAttribute("dir", "rtl")

    expect(container.querySelector("blockquote")).toHaveAttribute("dir", "rtl")
    expect(container.querySelector("table")).toHaveAttribute("dir", "rtl")
    for (const cell of container.querySelectorAll("th, td")) {
      // "3" has no letters: the cell inherits the table's direction.
      if (cell.textContent === "3") expect(cell).not.toHaveAttribute("dir")
      else expect(cell).toHaveAttribute("dir", "rtl")
    }
  })

  it("keeps inline code and code blocks left to right", async () => {
    const { container } = render(
      <MessageResponse>{HEBREW_REPLY}</MessageResponse>
    )
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("const rate")
    )

    const inline = container.querySelector('[data-streamdown="inline-code"]')
    expect(inline).toHaveTextContent(
      "research/international-tax-structure-2026-10-12.md"
    )
    expect(inline).toHaveAttribute("dir", "ltr")

    const block = container.querySelector('[data-streamdown="code-block"]')
    expect(block).not.toBeNull()
    // The block itself carries no direction of its own (globals.css pins its
    // body LTR); nothing inside it was handed `dir="rtl"`.
    expect(block?.querySelector('[dir="rtl"]')).toBeNull()
  })

  it("leaves an English reply's blocks LTR and its markup otherwise unchanged", async () => {
    const { container } = render(
      <MessageResponse>
        {"# Title\n\nSome text with `code`.\n\n- one\n- two"}
      </MessageResponse>
    )
    await waitFor(() => expect(container.querySelector("li")).not.toBeNull())
    expect(container.querySelector("h1")).toHaveAttribute("dir", "ltr")
    expect(container.querySelector("p")).toHaveAttribute("dir", "ltr")
    expect(container.querySelector("ul")).toHaveAttribute("dir", "ltr")
    expect(container.querySelector('[dir="rtl"]')).toBeNull()
    // No path isolation spans outside a right-to-left block.
    expect(container.querySelector('span[dir="ltr"]')).toBeNull()
  })
})

type Node = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const el = (
  tagName: string,
  children: Node[],
  properties: Record<string, unknown> = {}
): Node => ({ type: "element", tagName, properties, children })
const text = (value: string): Node => ({ type: "text", value })

function run(tree: Node): Node {
  rehypeBlockDirection()(tree)
  return tree
}

describe("rehypeBlockDirection", () => {
  it("does not count a nested list's words for its item", () => {
    const nested = el("ul", [el("li", [text("one English item")])])
    const item = el("li", [text("פריט בעברית"), nested])
    const tree = run(el("root", [el("ul", [item])]))
    const list = tree.children![0]
    expect(list.properties?.dir).toBe("rtl")
    expect(item.properties?.dir).toBe("rtl")
    expect(nested.properties?.dir).toBe("ltr")
  })

  it("keeps a dir that is already there", () => {
    const p = el("p", [text("שלום")], { dir: "ltr" })
    run(el("root", [p]))
    expect(p.properties?.dir).toBe("ltr")
  })

  it("skips code, math and reference badges when deciding", () => {
    const p = el("p", [
      el("code", [text("some english code here")]),
      el("a", [text("@Codex CLI agent")], { href: "codeg://agent/codex" }),
      el("code", [text("x + y")], {
        className: ["language-math", "math-inline"],
      }),
      text(" זה המשפט"),
    ])
    run(el("root", [p]))
    expect(p.properties?.dir).toBe("rtl")
    // Inline code is pinned LTR; math is left to KaTeX.
    expect(p.children![0].properties?.dir).toBe("ltr")
    expect(p.children![2].properties?.dir).toBeUndefined()
  })

  it("isolates a bare path or URL inside a right-to-left block", () => {
    const p = el("p", [
      text("הקובץ ./scripts/run.sh נוצר, ראה https://example.com/docs."),
    ])
    run(el("root", [p]))
    const spans = p.children!.filter((child) => child.tagName === "span")
    expect(spans.map((span) => span.children![0].value)).toEqual([
      "./scripts/run.sh",
      "https://example.com/docs",
    ])
    for (const span of spans) expect(span.properties?.dir).toBe("ltr")
    // The text is unchanged.
    const flat = p
      .children!.map((child) =>
        child.type === "text" ? child.value : child.children![0].value
      )
      .join("")
    expect(flat).toBe(
      "הקובץ ./scripts/run.sh נוצר, ראה https://example.com/docs."
    )
  })

  it("does not treat a Hebrew slash or a hyphen prefix as part of a path", () => {
    const p = el("p", [text("כן/לא, ל-src/app.ts")])
    run(el("root", [p]))
    const spans = p.children!.filter((child) => child.tagName === "span")
    expect(spans.map((span) => span.children![0].value)).toEqual(["src/app.ts"])
  })

  it("leaves numbers with slashes alone", () => {
    const p = el("p", [text("הרווח נצבר שם (9%/0%) עד 12/10/2026, יחס 1/2")])
    run(el("root", [p]))
    expect(p.children).toHaveLength(1)
    expect(p.children![0].type).toBe("text")
  })
})
