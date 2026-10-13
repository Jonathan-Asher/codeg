import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { CHAT_TEXT_SCOPE_CLASS } from "@/lib/chat-text-scale"

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/app/globals.css"),
  "utf8"
).replace(/\/\*[\s\S]*?\*\//g, "")

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = globalsCss.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThan(-1)
  const open = globalsCss.indexOf("{", start)
  const close = globalsCss.indexOf("}", open)
  return globalsCss.slice(open + 1, close)
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of body.split(";")) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return out
}

const SCOPE = `.${CHAT_TEXT_SCOPE_CLASS}`

describe("chat text size CSS", () => {
  it("restates every text token inside the conversation scope", () => {
    const tokens = declarations(ruleBody(SCOPE))
    expect(tokens.get("--chat-rem")).toBe(
      "calc(var(--chat-text-unit, 1rem) * var(--chat-text-scale, 1))"
    )
    for (const size of [
      "3xs",
      "2xs",
      "xs",
      "sm",
      "base",
      "lg",
      "xl",
      "2xl",
      "3xl",
      "4xl",
    ]) {
      expect(tokens.get(`--text-${size}`), size).toMatch(/var\(--chat-rem\)/)
    }
    // At 100% the tokens are Tailwind's own sizes.
    expect(tokens.get("--text-sm")).toBe("calc(var(--chat-rem) * 0.875)")
    expect(tokens.get("--text-base")).toBe("var(--chat-rem)")
    // Unclassed text inside the scope scales from what it inherits.
    expect(tokens.get("font-size")).toBe(
      "calc(1em * var(--chat-text-scale, 1))"
    )
  })

  it("applies the scale nowhere but inside that scope", () => {
    // The scale is read in exactly one place, the scope's --chat-rem and
    // font-size; everything else follows through --chat-rem.
    const reads = globalsCss.match(/var\(--chat-text-scale/g) ?? []
    const scopeReads =
      ruleBody(SCOPE).match(/var\(--chat-text-scale/g)?.length ?? 0
    expect(reads.length).toBe(scopeReads)
    expect(scopeReads).toBe(2)

    // No global rule restates a text token in terms of the chat scale.
    const rootBody = ruleBody(":root")
    expect(rootBody).not.toMatch(/--chat-/)
  })

  it("lets a text utility on the scope element itself win", () => {
    // In `@layer components`, below `@layer utilities`.
    const layerStart = globalsCss.indexOf("@layer components {")
    expect(layerStart).toBeGreaterThan(-1)
    const scopeAt = globalsCss.indexOf(`${SCOPE} {`)
    expect(scopeAt).toBeGreaterThan(layerStart)
  })

  it("does not double-scale a nested scope", () => {
    expect(declarations(ruleBody(`${SCOPE} ${SCOPE}`)).get("font-size")).toBe(
      "inherit"
    )
  })

  it("measures 100% in board units inside a canvas card", () => {
    expect(
      declarations(ruleBody(".canvas-board-units")).get("--chat-text-unit")
    ).toBe("16px")
  })

  it("routes the two extra-small utilities through overridable tokens", () => {
    expect(globalsCss).toMatch(
      /@utility text-2xs \{\s*font-size: var\(--text-2xs, 0\.6875rem\);/
    )
    expect(globalsCss).toMatch(
      /@utility text-3xs \{\s*font-size: var\(--text-3xs, 0\.625rem\);/
    )
  })

  it("sizes the composer's own headings and code from the chat unit", () => {
    for (const selector of [
      ".codeg-composer .ProseMirror h1",
      ".codeg-composer .ProseMirror h2",
      ".codeg-composer .ProseMirror :is(h3, h4)",
      ".codeg-composer .ProseMirror pre code",
    ]) {
      expect(
        declarations(ruleBody(selector)).get("font-size"),
        selector
      ).toMatch(/var\(--chat-rem, 1rem\)/)
    }
  })
})
