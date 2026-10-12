import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { PlainTextWithBadges } from "./plain-text-with-badges"

const badge = (c: HTMLElement, kind: string) =>
  c.querySelector(`[data-reference-badge][data-ref-type='${kind}']`)

describe("PlainTextWithBadges", () => {
  it("renders plain prose as text with no badge", () => {
    const { container } = render(<PlainTextWithBadges text="just some text" />)
    expect(container.textContent).toBe("just some text")
    expect(container.querySelector("[data-reference-badge]")).toBeNull()
  })

  it("renders Markdown syntax verbatim (no formatting elements)", () => {
    const { container } = render(
      <PlainTextWithBadges text={"# Heading\n**bold**\n- item"} />
    )
    expect(container.querySelector("h1")).toBeNull()
    expect(container.querySelector("strong")).toBeNull()
    expect(container.querySelector("li")).toBeNull()
    expect(container.textContent).toContain("# Heading")
    expect(container.textContent).toContain("**bold**")
    expect(container.textContent).toContain("- item")
  })

  it("renders each reference kind as its badge, in place", () => {
    const { container: file } = render(
      <PlainTextWithBadges text="edit [app.ts](file:///repo/app.ts) here" />
    )
    expect(badge(file, "file")).not.toBeNull()
    expect(file.textContent).toContain("edit")
    expect(file.textContent).toContain("here")

    const { container: agent } = render(
      <PlainTextWithBadges text="[@Codex](codeg://agent/codex)" />
    )
    expect(badge(agent, "agent")).not.toBeNull()

    const { container: session } = render(
      <PlainTextWithBadges text="[#42](codeg://session/42)" />
    )
    expect(badge(session, "session")).not.toBeNull()

    const { container: commit } = render(
      <PlainTextWithBadges text="[a1b2c3d](codeg://commit/%2Frepo@a1b2c3ddeadbeef)" />
    )
    expect(badge(commit, "commit")).not.toBeNull()
  })

  it("badges a bare /command token but not a path", () => {
    const { container: cmd } = render(
      <PlainTextWithBadges text="run /review please" />
    )
    expect(badge(cmd, "skill")).not.toBeNull()
    // The badge shows the bare name (no `/` prefix), matching the composer.
    expect(cmd.textContent).toContain("review")
    expect(cmd.textContent).not.toContain("/review")

    const { container: path } = render(
      <PlainTextWithBadges text="see /usr/bin for it" />
    )
    expect(badge(path, "skill")).toBeNull()
    expect(path.textContent).toContain("/usr/bin")
  })

  it("gives a file badge — and only a file badge — the hover-actions anchor", () => {
    const { container: file } = render(
      <PlainTextWithBadges text="edit [app.ts](file:///repo/app.ts) here" />
    )
    const hoverAnchor = file.querySelector("[data-file-actions]")
    expect(hoverAnchor).not.toBeNull()
    expect(hoverAnchor?.contains(badge(file, "file"))).toBe(true)

    // A path-less embedded attachment renders as a file badge too, but there is
    // nothing to reveal or copy — no anchor.
    const { container: embedded } = render(
      <PlainTextWithBadges text="[report.pdf](codeg://embedded/abc-123)" />
    )
    expect(badge(embedded, "file")).not.toBeNull()
    expect(embedded.querySelector("[data-file-actions]")).toBeNull()

    const { container: session } = render(
      <PlainTextWithBadges text="[#42](codeg://session/42)" />
    )
    expect(session.querySelector("[data-file-actions]")).toBeNull()
  })

  it("does NOT badge a non-reference http link", () => {
    const { container } = render(
      <PlainTextWithBadges text="[docs](https://example.com)" />
    )
    expect(container.querySelector("[data-reference-badge]")).toBeNull()
    expect(container.textContent).toBe("[docs](https://example.com)")
  })

  it("preserves newlines via pre-wrap", () => {
    const { container } = render(<PlainTextWithBadges text={"a\nb"} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain("whitespace-pre-wrap")
    expect(container.textContent).toBe("a\nb")
  })

  describe("quote blocks", () => {
    const quotes = (c: HTMLElement) =>
      Array.from(c.querySelectorAll("[data-testid='user-message-quote']"))

    it("renders a quoted run as a rule block with the markers dropped", () => {
      const { container } = render(
        <PlainTextWithBadges text={"> first\n> second"} />
      )
      const [quote] = quotes(container)
      expect(quote).toBeDefined()
      // Logical: the rule is on the left for left-to-right text.
      expect(quote.className).toContain("border-s-2")
      expect(quote).toHaveAttribute("dir", "ltr")
      expect(quote.textContent).toBe("first\nsecond")
      // No stray marker anywhere in the bubble.
      expect(container.textContent).not.toContain(">")
    })

    it("keeps the prose after a quote as its own block", () => {
      // The shape the quote action produces: quote, blank separator, question.
      const { container } = render(
        <PlainTextWithBadges text={"> quoted\n\nmy question"} />
      )
      expect(quotes(container)).toHaveLength(1)
      expect(quotes(container)[0].textContent).toBe("quoted")
      // The separator blank line is structure, not content — it must not also
      // survive as a literal newline on top of the block gap.
      expect(container.textContent).toBe("quotedmy question")
    })

    it("nests a doubly-marked quote", () => {
      const { container } = render(<PlainTextWithBadges text="> > deep" />)
      const found = quotes(container)
      expect(found).toHaveLength(2)
      expect(found[0].contains(found[1])).toBe(true)
      expect(found[1].textContent).toBe("deep")
    })

    it("still badges references inside a quote", () => {
      const { container } = render(
        <PlainTextWithBadges text="> edit [app.ts](file:///repo/app.ts) now" />
      )
      const [quote] = quotes(container)
      expect(quote.querySelector("[data-reference-badge]")).not.toBeNull()
      expect(quote.textContent).toContain("now")
    })

    it("does NOT widen Markdown rendering beyond the quote marker", () => {
      const { container } = render(
        <PlainTextWithBadges text={"> # Heading\n> **bold**\n> - item"} />
      )
      expect(container.querySelector("h1")).toBeNull()
      expect(container.querySelector("strong")).toBeNull()
      expect(container.querySelector("li")).toBeNull()
      expect(quotes(container)[0].textContent).toBe(
        "# Heading\n**bold**\n- item"
      )
    })

    it("leaves a `>` that is not line-leading literal", () => {
      const { container } = render(<PlainTextWithBadges text="2 > 1 is true" />)
      expect(quotes(container)).toHaveLength(0)
      expect(container.textContent).toBe("2 > 1 is true")
    })
  })

  describe("direction", () => {
    it("gives a Hebrew message one right-to-left block", () => {
      const text =
        "אני מעוניין במחקר של מיסוי בין לאומי\nמחר יש שיחה עם PayPal ו Fulfillment center's בסין"
      const { container } = render(<PlainTextWithBadges text={text} />)
      const root = container.firstElementChild as HTMLElement
      expect(root).toHaveAttribute("dir", "rtl")
      expect(root.className).toContain("whitespace-pre-wrap")
      expect(root.querySelectorAll("div")).toHaveLength(0)
      expect(container.textContent).toBe(text)
    })

    it("keeps an English message's markup, now with dir=ltr", () => {
      const { container } = render(<PlainTextWithBadges text={"a\nb"} />)
      const root = container.firstElementChild as HTMLElement
      expect(root).toHaveAttribute("dir", "ltr")
      expect(container.querySelectorAll("div")).toHaveLength(1)
    })

    it("gives each run of lines its own block when the direction changes", () => {
      const text = "Fix this please:\n\nהבאג נמצא בטופס\nשורה שנייה"
      const { container } = render(<PlainTextWithBadges text={text} />)
      const blocks = Array.from(
        container.querySelectorAll<HTMLElement>(".whitespace-pre-wrap")
      )
      expect(blocks.map((block) => block.getAttribute("dir"))).toEqual([
        "ltr",
        "rtl",
      ])
      expect(blocks[0].textContent).toBe("Fix this please:")
      expect(blocks[1].textContent).toBe("\nהבאג נמצא בטופס\nשורה שנייה")
    })

    it("does not let a reference badge decide the direction", () => {
      const { container } = render(
        <PlainTextWithBadges
          text={
            "[@src/app/page.tsx](file:///repo/src/app/page.tsx) תבדוק את הקובץ"
          }
        />
      )
      expect(container.firstElementChild).toHaveAttribute("dir", "rtl")
    })

    it("draws a Hebrew quote's rule on its own side", () => {
      const { container } = render(
        <PlainTextWithBadges text={"> ציטוט בעברית\n\nושאלה"} />
      )
      const quote = container.querySelector(
        "[data-testid='user-message-quote']"
      )
      expect(quote).toHaveAttribute("dir", "rtl")
      expect(quote?.className).toContain("ps-3")
    })
  })
})
