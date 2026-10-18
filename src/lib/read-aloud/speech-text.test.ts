import { describe, expect, it } from "vitest"

import {
  MAX_SEGMENT_CHARS,
  TABLE_ROW_LIMIT,
  buildSpeechSegments,
  chunkText,
  containsScript,
  inline,
  scriptRuns,
  sentence,
  speechTextFromMarkdown,
  splitSentences,
} from "./speech-text"

describe("speechTextFromMarkdown", () => {
  it("strips emphasis and keeps headings as sentences of their own", () => {
    expect(
      speechTextFromMarkdown(
        "## Summary\nThe **build** is _green_ and ~~red~~ *fixed*\nsecond line"
      )
    ).toBe("Summary.\nThe build is green and red fixed second line.")
  })

  it("skips fenced code, whatever the fence, and an unclosed one to the end", () => {
    const markdown = [
      "Run this:",
      "```bash",
      "pnpm test",
      "```",
      "Then this:",
      "~~~",
      "rm -rf out",
      "~~~",
      "Done.",
      "````ts",
      "const a = 1",
    ].join("\n")
    expect(speechTextFromMarkdown(markdown)).toBe(
      "Run this:\nThen this:\nDone."
    )
  })

  it("reads short inline code as words and drops snippets and paths", () => {
    expect(
      speechTextFromMarkdown(
        "Run `pnpm test`, call `useState()` and set `CODEG_PORT`."
      )
    ).toBe("Run pnpm test, call useState and set CODEG PORT.")
    expect(
      speechTextFromMarkdown(
        "Edit `src/lib/read-aloud/player.ts` and add `const x = { a: 1 }` now."
      )
    ).toBe("Edit and add now.")
  })

  it("reads each list item as its own sentence, without markers", () => {
    const markdown = [
      "Steps:",
      "- first step",
      "* second step",
      "1. numbered item",
      "2) another one",
      "- [x] done task",
      "  - nested item",
    ].join("\n")
    expect(speechTextFromMarkdown(markdown)).toBe(
      [
        "Steps:",
        "first step.",
        "second step.",
        "numbered item.",
        "another one.",
        "done task.",
        "nested item.",
      ].join("\n")
    )
  })

  it("reads a link as its text and a bare URL as a cue in the line's language", () => {
    expect(
      speechTextFromMarkdown(
        "See [the docs](https://example.com/docs) or https://example.com/x?y=1."
      )
    ).toBe("See the docs or a link.")
    expect(speechTextFromMarkdown("ראה https://example.com לפרטים")).toBe(
      "ראה קישור לפרטים."
    )
    expect(speechTextFromMarkdown("Autolink <https://example.com> here")).toBe(
      "Autolink here."
    )
  })

  it("reads file-reference badges by name and drops path labels", () => {
    expect(
      speechTextFromMarkdown(
        "Changed [player.ts](file:///repo/src/player.ts), asked [@Codex](codeg://agent/codex), see [src/a/b.ts](file:///repo/src/a/b.ts)."
      )
    ).toBe("Changed player.ts, asked Codex, see.")
  })

  it("drops file paths in prose but keeps and/or, dates and fractions", () => {
    expect(
      speechTextFromMarkdown(
        "Look in /Users/me/project and ~/notes, edit src/app/page.tsx and C:\\temp\\x.txt."
      )
    ).toBe("Look in and, edit and.")
    expect(
      speechTextFromMarkdown("Yes and/or no, on 18/10/2026, 3/4 done, ו/או כן")
    ).toBe("Yes and/or no, on 18/10/2026, 3/4 done, ו/או כן.")
  })

  it("reads a short table row by row and skips a long one", () => {
    const short = ["| Name | Value |", "|---|---:|", "| a | 1 |", "| b | 2 |"]
    expect(speechTextFromMarkdown(short.join("\n"))).toBe(
      "Name, Value.\na, 1.\nb, 2."
    )
    const long = [
      "Before.",
      "| n |",
      "|---|",
      ...Array.from({ length: TABLE_ROW_LIMIT + 1 }, (_, i) => `| ${i} |`),
      "After.",
    ]
    expect(speechTextFromMarkdown(long.join("\n"))).toBe("Before.\nAfter.")
  })

  it("drops emoji, check marks, HTML tags, rules and quote markers", () => {
    expect(
      speechTextFromMarkdown(
        "✅ Tests pass 🎉\n\n---\n\n> quoted <b>bold</b> text\n✓ done → next"
      )
    ).toBe("Tests pass.\nquoted bold text done, next.")
  })

  it("returns nothing for a reply that is only code", () => {
    expect(speechTextFromMarkdown("```\nconst a = 1\n```")).toBe("")
  })
})

describe("inline", () => {
  it("keeps image alt text", () => {
    expect(inline("![a diagram](x.png) shows it")).toBe("a diagram shows it")
  })
})

describe("sentence", () => {
  it("adds a full stop unless the text already ends a sentence", () => {
    expect(sentence("hello")).toBe("hello.")
    expect(sentence("hello?")).toBe("hello?")
    expect(sentence("שלום!")).toBe("שלום!")
    expect(sentence("مرحبا؟")).toBe("مرحبا؟")
    expect(sentence("  ")).toBe("")
  })
})

describe("scriptRuns", () => {
  it("splits a Hebrew sentence around an English term", () => {
    expect(scriptRuns("הרצתי את pnpm test והכל עבר.")).toEqual([
      { text: "הרצתי את", script: "he" },
      { text: "pnpm test", script: "latin" },
      { text: "והכל עבר.", script: "he" },
    ])
  })

  it("keeps digits and punctuation with the run they sit in", () => {
    expect(scriptRuns("יש 3 קבצים, 2 חדשים.")).toEqual([
      { text: "יש 3 קבצים, 2 חדשים.", script: "he" },
    ])
    expect(scriptRuns("Version 2.1 (שלום) ok")).toEqual([
      { text: "Version 2.1 (", script: "latin" },
      { text: "שלום)", script: "he" },
      { text: "ok", script: "latin" },
    ])
  })

  it("tells Arabic from Hebrew and Latin", () => {
    expect(scriptRuns("مرحبا world שלום")).toEqual([
      { text: "مرحبا", script: "ar" },
      { text: "world", script: "latin" },
      { text: "שלום", script: "he" },
    ])
  })

  it("reads niqqud as part of the Hebrew word", () => {
    expect(scriptRuns("שָׁלוֹם")).toEqual([{ text: "שָׁלוֹם", script: "he" }])
  })

  it("gives text without letters the fallback script", () => {
    expect(scriptRuns("42.", "he")).toEqual([{ text: "42.", script: "he" }])
    expect(scriptRuns("  ")).toEqual([])
  })

  it("recognises CJK and Hangul", () => {
    expect(scriptRuns("你好 hello 안녕")).toEqual([
      { text: "你好", script: "cjk" },
      { text: "hello", script: "latin" },
      { text: "안녕", script: "hangul" },
    ])
  })
})

describe("containsScript", () => {
  it("finds a script anywhere in the text", () => {
    expect(containsScript("hello שלום", "he")).toBe(true)
    expect(containsScript("hello", "he")).toBe(false)
  })
})

describe("splitSentences", () => {
  it("cuts a paragraph into sentences", () => {
    expect(splitSentences("First one. Second one! Third?")).toEqual([
      "First one.",
      "Second one!",
      "Third?",
    ])
    expect(splitSentences("משפט ראשון. משפט שני.")).toEqual([
      "משפט ראשון.",
      "משפט שני.",
    ])
  })
})

describe("chunkText", () => {
  it("leaves short text alone", () => {
    expect(chunkText("short text")).toEqual(["short text"])
  })

  it("cuts long text at a clause boundary, or a space, under the limit", () => {
    const clause = "word ".repeat(30).trim()
    const text = `${clause}, ${clause}, ${clause}`
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS + 1)
    }
    expect(chunks.join(" ")).toBe(text)
  })

  it("hard-cuts a run with no spaces", () => {
    const chunks = chunkText("x".repeat(400), 100)
    expect(chunks).toHaveLength(4)
    expect(chunks.every((chunk) => chunk.length === 100)).toBe(true)
  })
})

describe("buildSpeechSegments", () => {
  it("queues sentence by sentence and run by run", () => {
    const text = speechTextFromMarkdown(
      [
        "שלום! הרצתי את `pnpm test` והכל עבר.",
        "",
        "```ts",
        "const skipped = true",
        "```",
        "",
        "- All **green** now.",
      ].join("\n")
    )
    expect(buildSpeechSegments(text)).toEqual([
      { text: "שלום!", script: "he" },
      { text: "הרצתי את", script: "he" },
      { text: "pnpm test", script: "latin" },
      { text: "והכל עבר.", script: "he" },
      { text: "All green now.", script: "latin" },
    ])
  })

  it("keeps every segment under the engine-friendly length", () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `clause number ${i}`
    ).join(", ")
    const segments = buildSpeechSegments(sentence(long))
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS + 1)
    }
  })
})
