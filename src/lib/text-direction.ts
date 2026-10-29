/**
 * Which way a block of prose reads.
 *
 * The UI language sets the page direction, but a message's text does not care:
 * a Hebrew reply in the English UI, or an English one in the Arabic UI, must lay
 * out in its own direction — alignment, list markers and indents on the right
 * side, and the bidi algorithm resolving punctuation and mixed runs against the
 * right base direction. Every block picks that direction from its own text.
 *
 * The browser's `dir="auto"` reads the first strong character, which is right
 * for a plain sentence but wrong for the text an agent writes: a Hebrew list
 * item that opens with a Latin term (`EO 14324 (אוגוסט 2025) → חוק → …`), a
 * Hebrew line that opens with a file path or an inline code span. So this
 * counts words instead:
 *
 * - Code spans, fenced code, URLs, file paths, e-mail addresses and `@handles`
 *   never vote: they are LTR in every language. Neither does quoted material
 *   (`'כתב תביעה'` inside an English sentence, `"Save changes"` inside a Hebrew
 *   one) — unless the text is nothing but a quote.
 * - Digits, punctuation, markdown syntax and emoji carry no direction.
 * - Text that opens with a right-to-left word is RTL — `dir="auto"`'s answer.
 * - Text that opens with a left-to-right word is still RTL when at least 40% of
 *   its words are right-to-left: a Hebrew sentence that happens to start with
 *   a Latin term. Below that it is an LTR sentence quoting a few RTL words.
 * - Text with no letters at all has no direction of its own (`undefined`), so
 *   the element inherits its container's.
 */
export type TextDirection = "ltr" | "rtl"

/** The writing direction of a UI locale — what the app puts on `<html dir>`. */
export function localeDirection(locale: string): TextDirection {
  return locale === "ar" || locale.startsWith("ar-") ? "rtl" : "ltr"
}

/** Share of RTL words that makes an LTR-opening text RTL. */
export const RTL_WORD_SHARE = 0.4

// The right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan,
// Mandaic and the Arabic supplements (U+0590–U+08FF), the Hebrew and Arabic
// presentation forms, and the supplementary-plane RTL blocks.
const RTL_LETTER =
  /^(?:[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}])/u

// A word: a letter followed by letters, combining marks (niqqud, harakat),
// joiners, and apostrophes between letters (`center's`, `צ'יפס` are one word).
// Digits and punctuation split words and are never counted.
const WORD = /\p{L}(?:[\p{L}\p{M}\u200C\u200D]|['\u2019](?=\p{L}))*/gu

// Spans that are LTR whatever language surrounds them.
const FENCED_CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g
const INLINE_CODE = /(`+)[^`]*?\1/g
const URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)\S+/gi
// A file or codeg reference — `[a.ts](file:///…)`, `[@Codex](codeg://…)` — is a
// badge whose label is a name; another link keeps its label as prose.
const REFERENCE_LINK = /\[[^\]\n]*\]\((?:file|codeg):[^)\s]*\)/gi
const MARKDOWN_LINK_TARGET = /\]\([^)\s]*\)/g
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
// `@file`, `@agent` mentions and `$skill` invocations.
const HANDLE = /(^|\s)[@$]\S+/g
// A token with a slash or backslash in it: a path, a ratio, `and/or`. Kept when
// it holds an RTL letter (`ו/או` is Hebrew prose).
const SLASHED_TOKEN = /\S*[/\\]\S*/g

// A quoted span: the opener follows a space, an opening bracket or the start
// of the text, and the closer is followed by one of those or by punctuation.
// That keeps Hebrew gershayim and geresh (`ארה"ב`, `צ'יפס`) and English
// apostrophes (`center's`), which sit between letters, out of it.
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["\u201C", "\u201D"],
  ["\u201E", "\u201C"],
  ["\u2018", "\u2019"],
  ["\u00AB", "\u00BB"],
]
const QUOTED: RegExp[] = QUOTE_PAIRS.map(([open, close]) => {
  const o = escapeRegExp(open)
  const c = escapeRegExp(close)
  return new RegExp(
    `(^|[\\s([{\u2014\u2013-])${o}[^\\n${o}${c}]+?${c}(?=$|[\\s.,;:!?)\\]}\u2026\u2014\u2013-])`,
    "g"
  )
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Remove everything that is LTR in every language. */
function stripLtrSpans(text: string): string {
  return text
    .replace(FENCED_CODE, " ")
    .replace(INLINE_CODE, " ")
    .replace(REFERENCE_LINK, " ")
    .replace(MARKDOWN_LINK_TARGET, "] ")
    .replace(URL, " ")
    .replace(EMAIL, " ")
    .replace(HANDLE, "$1 ")
    .replace(SLASHED_TOKEN, (token) => (hasRtlLetter(token) ? token : " "))
}

function stripQuoted(text: string): string {
  let out = text
  for (const quoted of QUOTED) out = out.replace(quoted, "$1 ")
  return out
}

/** Whether the text holds at least one letter of a right-to-left script. */
export function hasRtlLetter(text: string): boolean {
  for (const ch of text) if (RTL_LETTER.test(ch)) return true
  return false
}

function decide(text: string): TextDirection | undefined {
  let rtl = 0
  let ltr = 0
  let firstRtl: boolean | undefined
  for (const match of text.matchAll(WORD)) {
    const isRtl = RTL_LETTER.test(match[0])
    if (firstRtl === undefined) firstRtl = isRtl
    if (isRtl) rtl += 1
    else ltr += 1
  }
  if (rtl === 0 && ltr === 0) return undefined
  if (rtl === 0) return "ltr"
  if (ltr === 0 || firstRtl) return "rtl"
  return rtl / (rtl + ltr) >= RTL_WORD_SHARE ? "rtl" : "ltr"
}

/**
 * The direction a block of prose reads in, or `undefined` when it has no
 * letters to tell (numbers, punctuation, emoji, code only) and should inherit.
 *
 * Takes rendered text or raw message text alike: Markdown syntax carries no
 * direction, and code spans, links' targets, URLs and paths are dropped before
 * the words are counted.
 */
export function detectTextDirection(
  text: string | null | undefined
): TextDirection | undefined {
  if (!text) return undefined
  const prose = stripLtrSpans(text)
  return decide(stripQuoted(prose)) ?? decide(prose)
}

/** A run of consecutive lines that read in the same direction. */
export interface DirectionRun {
  text: string
  dir: TextDirection | undefined
}

/**
 * Split plain multi-line text (a user message, a note) into runs of lines that
 * share a direction, so each run can be its own block: a Hebrew paragraph
 * under an English one keeps its own alignment. A line with no letters (a
 * number, an emoji) stays with the run it follows; blank lines between two
 * runs open the second one, so the gap still shows. Joining the runs' `text`
 * with `\n` gives back the input.
 */
export function splitLinesByDirection(text: string): DirectionRun[] {
  const runs: { lines: string[]; dir: TextDirection | undefined }[] = []
  // Blank lines at the end of the current run, which move to the next run if
  // the direction changes.
  let trailingBlank = 0
  for (const line of text.split("\n")) {
    const dir = detectTextDirection(line)
    const blank = line.trim() === ""
    const current = runs[runs.length - 1]
    if (!current) {
      runs.push({ lines: [line], dir })
      trailingBlank = blank ? 1 : 0
    } else if (!dir) {
      current.lines.push(line)
      trailingBlank = blank ? trailingBlank + 1 : 0
    } else if (!current.dir || current.dir === dir) {
      current.lines.push(line)
      current.dir = dir
      trailingBlank = 0
    } else {
      const moved = current.lines.splice(
        current.lines.length - trailingBlank,
        trailingBlank
      )
      runs.push({ lines: [...moved, line], dir })
      trailingBlank = 0
    }
  }
  return runs.map((run) => ({ text: run.lines.join("\n"), dir: run.dir }))
}
