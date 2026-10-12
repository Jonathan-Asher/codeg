import { describe, expect, it } from "vitest"

import {
  detectTextDirection,
  hasRtlLetter,
  splitLinesByDirection,
} from "./text-direction"

describe("detectTextDirection", () => {
  it("reads plain Hebrew, Arabic and English", () => {
    expect(detectTextDirection("שלום עולם")).toBe("rtl")
    expect(detectTextDirection("مرحبا بالعالم")).toBe("rtl")
    expect(detectTextDirection("Hello world")).toBe("ltr")
    // Persian and Urdu are Arabic script.
    expect(detectTextDirection("سلام دنیا")).toBe("rtl")
  })

  it("has no direction without letters", () => {
    expect(detectTextDirection("")).toBeUndefined()
    expect(detectTextDirection(null)).toBeUndefined()
    expect(detectTextDirection(undefined)).toBeUndefined()
    expect(detectTextDirection("1. 2026-10-12 — 42%")).toBeUndefined()
    expect(detectTextDirection("⚡🏗️ ✅")).toBeUndefined()
    expect(detectTextDirection("`src/app/page.tsx`")).toBeUndefined()
  })

  it("skips leading numbers, punctuation, markdown syntax and emoji", () => {
    expect(detectTextDirection('1. פטור ה de minimis של ארה"ב')).toBe("rtl")
    expect(detectTextDirection("24.6.2026: השעיה בלתי מוגבלת")).toBe("rtl")
    expect(detectTextDirection("## ⚡ שני ממצאים קריטיים")).toBe("rtl")
    expect(detectTextDirection("- **€3 מכס לפריט** על חבילות")).toBe("rtl")
    expect(detectTextDirection("> (הערה) זה חשוב")).toBe("rtl")
    expect(detectTextDirection("🏗️ השערת המבנה")).toBe("rtl")
    expect(detectTextDirection("1. Install the CLI")).toBe("ltr")
  })

  it("keeps a Hebrew sentence that opens with a Latin term RTL", () => {
    expect(
      detectTextDirection(
        "EO 14324 (אוגוסט 2025) → חוק → הושהה פעמיים (פברואר ואפריל 2026), CBP כולל דואר (Federal Register 2026-12670)."
      )
    ).toBe("rtl")
    expect(detectTextDirection("React Query היא ספרייה לניהול state")).toBe(
      "rtl"
    )
    expect(
      detectTextDirection("Claude Code עם GLM model ב-BaseTen עובד טוב")
    ).toBe("rtl")
  })

  it("keeps an English sentence with a few Hebrew words LTR", () => {
    expect(
      detectTextDirection("The Hebrew word for settings is הגדרות here")
    ).toBe("ltr")
  })

  it("does not let code spans, URLs, paths and handles vote", () => {
    expect(
      detectTextDirection(
        "`research/international-tax-structure.md` נכתב ל-workspace"
      )
    ).toBe("rtl")
    expect(
      detectTextDirection(
        "https://example.com/some/long/english/path תבדוק את הקישור"
      )
    ).toBe("rtl")
    expect(
      detectTextDirection("src/components/message/plain-text.tsx תבדוק")
    ).toBe("rtl")
    expect(detectTextDirection("@Codex @src/app.ts תריץ את הבדיקות")).toBe(
      "rtl"
    )
    expect(
      detectTextDirection("```ts\nconst a = 1\nconst b = 2\n```\nזה הקוד")
    ).toBe("rtl")
    expect(
      detectTextDirection(
        "[@page.tsx](codeg://file/x) [Codex](codeg://agent/codex) תבדוק"
      )
    ).toBe("rtl")
    // A web link's label is prose; its target is not.
    expect(
      detectTextDirection("ראה [the docs](https://example.com/docs/guide)")
    ).toBe("rtl")
    // A slash between Hebrew words is Hebrew prose.
    expect(detectTextDirection("כן/לא")).toBe("rtl")
  })

  it("ignores quoted material unless it is all there is", () => {
    expect(
      detectTextDirection(
        "Changed the title to 'כתב תביעה' and the subtitle to 'טיוטה ראשונה לעיון'"
      )
    ).toBe("ltr")
    expect(
      detectTextDirection('הכפתור "Save all pending changes now" לא עובד')
    ).toBe("rtl")
    expect(detectTextDirection('"שלום עולם"')).toBe("rtl")
    // Gershayim and geresh sit between letters and are not quotes.
    expect(detectTextDirection('ארה"ב ועו"ד, צ\'יפס')).toBe("rtl")
    // An English apostrophe is not a quote either.
    expect(
      detectTextDirection("מחר יש שיחה עם PayPal ו Fulfillment center's בסין")
    ).toBe("rtl")
    expect(detectTextDirection("It's the center's 'main' office")).toBe("ltr")
  })
})

describe("hasRtlLetter", () => {
  it("finds Hebrew and Arabic letters only", () => {
    expect(hasRtlLetter("abc א")).toBe(true)
    expect(hasRtlLetter("abc ب")).toBe(true)
    expect(hasRtlLetter("abc 123")).toBe(false)
  })
})

describe("splitLinesByDirection", () => {
  it("keeps a single-language message as one run", () => {
    const text = "אני מעוניין במחקר\nהמוצרים מיוצרים בסין\n\nמחר יש שיחה"
    expect(splitLinesByDirection(text)).toEqual([{ text, dir: "rtl" }])
    expect(splitLinesByDirection("one\ntwo")).toEqual([
      { text: "one\ntwo", dir: "ltr" },
    ])
  })

  it("splits where the direction changes and moves the gap forward", () => {
    const text = "Fix this please:\n\nהבאג נמצא בטופס\nשורה שנייה\n42\nThanks"
    const runs = splitLinesByDirection(text)
    expect(runs).toEqual([
      { text: "Fix this please:", dir: "ltr" },
      { text: "\nהבאג נמצא בטופס\nשורה שנייה\n42", dir: "rtl" },
      { text: "Thanks", dir: "ltr" },
    ])
    expect(runs.map((run) => run.text).join("\n")).toBe(text)
  })

  it("gives a letterless leading line to the first direction", () => {
    expect(splitLinesByDirection("123\nשלום")).toEqual([
      { text: "123\nשלום", dir: "rtl" },
    ])
    expect(splitLinesByDirection("😀")).toEqual([
      { text: "😀", dir: undefined },
    ])
  })
})
