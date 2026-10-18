/**
 * Turns an agent reply into text worth reading aloud, then into the pieces the
 * speech engine is fed.
 *
 * The rules follow the iPhone app's `SpeechText` so a reply sounds the same on
 * both: the prose is read with its Markdown stripped, fenced code is skipped,
 * every list item and heading reads as a sentence of its own, a link reads as
 * its text and a bare URL as "a link". On top of that the desktop skips what a
 * voice can only spell out: file paths, inline code that is a snippet rather
 * than a word, long tables and emoji.
 *
 * The output of {@link speechTextFromMarkdown} is one paragraph per line, each
 * ending in punctuation so the synthesizer pauses there.
 * {@link buildSpeechSegments} then cuts it sentence by sentence and splits each
 * sentence into runs by script, so a Hebrew sentence that quotes an English
 * term is read by the Hebrew voice and the term by the English one.
 */

import { detectTextDirection } from "@/lib/text-direction"

/** A table with more body rows than this is skipped rather than read. */
export const TABLE_ROW_LIMIT = 5

/**
 * The longest piece handed to the engine in one utterance. Chrome stops a
 * single utterance after about fifteen seconds of speech, and a long one also
 * delays the start, so longer runs are cut at a comma or a space.
 */
export const MAX_SEGMENT_CHARS = 160

/** Inline code longer than this is a snippet, not a word worth reading. */
const INLINE_CODE_MAX_CHARS = 40

/** What a bare URL is read as, by the language of the line it sits in. */
const LINK_CUE = { he: "קישור", ar: "رابط", other: "a link" } as const

const HEBREW_LETTER = /[\u0590-\u05FF\uFB1D-\uFB4F]/
const ARABIC_LETTER =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

function linkCue(line: string): string {
  if (detectTextDirection(line) !== "rtl") return LINK_CUE.other
  return ARABIC_LETTER.test(line) && !HEBREW_LETTER.test(line)
    ? LINK_CUE.ar
    : LINK_CUE.he
}

/** End with sentence punctuation so the synthesizer pauses. */
export function sentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return /[.!?:;…؟。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * A slashed token that names a file or directory: it starts at a root
 * (`/`, `~/`, `./`, `../`, `C:\`), has two or more slashes, or ends in a file
 * extension. `and/or`, `24/7`, `TCP/IP` and `ו/או` stay prose.
 */
function isPathLike(token: string): boolean {
  const bare = token.replace(/[.,;:!?)]+$/, "")
  if (/[\u0590-\u08FF]/.test(bare)) return false
  if (/^[A-Za-z]:\\/.test(bare)) return true
  if (!/[/\\]/.test(bare)) return false
  // A date or a fraction: 18/10/2026, 3/4.
  if (/^[\d/.\-]+$/.test(bare)) return false
  if (/^(?:~|\.{1,2})?[/\\]/.test(bare)) return true
  const slashes = bare.match(/[/\\]/g)?.length ?? 0
  if (slashes >= 2) return true
  return /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(bare)
}

/** Remove file paths from prose, leaving the punctuation after them. */
function dropPaths(text: string): string {
  return text.replace(
    /(^|[\s(])([^\s()]*[/\\][^\s()]*)/g,
    (whole, lead, token) => {
      if (!isPathLike(token)) return whole
      const trailing = /[.,;:!?]+$/.exec(token)?.[0] ?? ""
      return `${lead}${trailing}`
    }
  )
}

/**
 * What inline code reads as. A short word-like term (`pnpm test`,
 * `useState()`, `fork-from-here`) keeps its content, as on the iPhone; a path,
 * a URL or a snippet full of code punctuation is dropped.
 */
function inlineCode(content: string): string {
  const term = content.trim().replace(/\(\)$/, "")
  if (!term || term.length > INLINE_CODE_MAX_CHARS) return ""
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(term) || isPathLike(term)) return ""
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s._\-+#@':]*$/u.test(term)) return ""
  // `CODEG_PORT` reads as two words, not "underscore".
  return term.replace(/_+/g, " ")
}

/** A link's text, unless that text is itself a path or a URL. */
function linkLabel(label: string, cue: string): string {
  const text = label.trim().replace(/^[@$]/, "")
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(text)) return cue
  if (isPathLike(text)) return ""
  return text
}

// Emoji (with their joiners and variation selectors), flags, and the check
// and cross marks a voice would otherwise name aloud.
const PICTOGRAPH =
  /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*|[\u{1F1E6}-\u{1F1FF}\u2713\u2717\u2610-\u2612]/gu

/**
 * Inline Markdown: images and links keep their text, URLs become a short cue,
 * paths and code snippets drop, emphasis markers and HTML tags go.
 */
export function inline(text: string): string {
  const cue = linkCue(text)
  let s = text
  // Inline code first, so the rules below never see its content.
  s = s.replace(/(`+)([^`]+?)\1/g, (_, _ticks, content: string) =>
    inlineCode(content)
  )
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, (_, label: string) =>
    linkLabel(label, cue)
  )
  s = s.replace(/<(?:https?:\/\/|mailto:)[^>]+>/gi, "") // autolinks
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi, cue)
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, "$1$2") // *italic*
  s = s.replace(/(^|[^\w_])_(?!\s)([^_]+?)_(?![\w_])/g, "$1$2") // _italic_
  s = s.replace(/~~(.+?)~~/g, "$1") // strikethrough
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, " ") // HTML tags
  s = dropPaths(s)
  s = s.replace(PICTOGRAPH, " ")
  s = s.replace(/\s*[→⟶➜➔⇒←⟵⇐↔⇔]\s*/g, ", ")
  return tidy(s)
}

/** Collapse the gaps and stray punctuation the removals above leave behind. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+([,.;:!?…؟])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/[,;:]\s*([.!?…؟])/g, "$1")
    .replace(/^[\s,;:.]+/, "")
    .trim()
}

const FENCE_OPEN = /^(`{3,}|~{3,})/
const HORIZONTAL_RULE = /^([-*_])(\s*\1){2,}$/
const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
const HEADING = /^#{1,6}\s+/
const LIST_MARKER = /^([-*+]|\d{1,3}[.)])\s+/
const TASK_BOX = /^\[[ xX]\]\s+/

/**
 * Strip Markdown to readable prose, one paragraph per line; every paragraph
 * ends with punctuation so the synthesizer pauses there.
 */
export function speechTextFromMarkdown(markdown: string): string {
  const paragraphs: string[] = []
  let current: string[] = []
  let fence: string | null = null
  let table: string[] | null = null

  const flush = () => {
    const joined = tidy(current.join(" "))
    if (joined) paragraphs.push(sentence(joined))
    current = []
  }

  // A table is read row by row, cells joined by commas, unless it is long:
  // then it is skipped, since a voice reading a grid is noise.
  const flushTable = () => {
    if (!table) return
    const rows = table
    table = null
    if (rows.length - 1 > TABLE_ROW_LIMIT) return
    for (const row of rows) {
      const cells = row
        .split("|")
        .map((cell) => inline(cell.trim()))
        .filter(Boolean)
      if (cells.length) paragraphs.push(sentence(cells.join(", ")))
    }
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (fence) {
      if (line.startsWith(fence)) fence = null
      continue
    }
    const fenceOpen = FENCE_OPEN.exec(line)
    if (fenceOpen) {
      flush()
      flushTable()
      fence = fenceOpen[1]
      continue
    }
    if (line.startsWith("|")) {
      flush()
      if (!TABLE_SEPARATOR.test(line)) (table ??= []).push(line)
      continue
    }
    if (TABLE_SEPARATOR.test(line) && table) continue
    flushTable()
    if (!line) {
      flush()
      continue
    }
    if (HORIZONTAL_RULE.test(line)) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      current.push(inline(line.slice(heading[0].length).replace(/#+$/, "")))
      flush()
      continue
    }
    let text = line.replace(/^(>\s*)+/, "")
    const isListItem = LIST_MARKER.test(text)
    text = text.replace(LIST_MARKER, "").replace(TASK_BOX, "")
    if (isListItem) {
      // Each item reads as its own sentence.
      flush()
      current.push(inline(text))
      flush()
    } else {
      current.push(inline(text))
    }
  }
  // An unclosed fence is code to the end, and is skipped with the rest.
  flushTable()
  flush()
  return paragraphs.join("\n")
}

// ── Script runs ──

/** The writing system of a run, which decides the voice that reads it. */
export type SpeechScript =
  | "he"
  | "ar"
  | "latin"
  | "cjk"
  | "hangul"
  | "cyrillic"
  | "greek"
  | "thai"
  | "devanagari"
  | "other"

const SCRIPT_TESTS: ReadonlyArray<readonly [RegExp, SpeechScript]> = [
  [HEBREW_LETTER, "he"],
  [ARABIC_LETTER, "ar"],
  [/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF]/, "latin"],
  [
    /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,
    "cjk",
  ],
  [/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/, "hangul"],
  [/[\u0400-\u052F]/, "cyrillic"],
  [/[\u0370-\u03FF\u1F00-\u1FFF]/, "greek"],
  [/[\u0E00-\u0E7F]/, "thai"],
  [/[\u0900-\u097F]/, "devanagari"],
]

/** The script of one character, or null for digits, spaces and punctuation. */
export function scriptOf(ch: string): SpeechScript | null {
  for (const [test, script] of SCRIPT_TESTS) if (test.test(ch)) return script
  return /\p{L}/u.test(ch) ? "other" : null
}

/** A run of text in one script, for picking a voice per span. */
export interface ScriptRun {
  text: string
  script: SpeechScript
}

/**
 * Split into runs by script. Digits, spaces and punctuation stay with the run
 * they sit in, and a span only splits off when it holds a letter — so `3`
 * inside a Hebrew sentence is read in Hebrew. Text with no letters at all
 * takes `fallback`.
 */
export function scriptRuns(
  text: string,
  fallback: SpeechScript = "latin"
): ScriptRun[] {
  const runs: ScriptRun[] = []
  let current = ""
  let currentScript: SpeechScript | null = null
  for (const ch of text) {
    const script = scriptOf(ch)
    if (script === null) {
      current += ch
      continue
    }
    if (currentScript === null) {
      currentScript = script
    } else if (currentScript !== script) {
      // Trailing neutral characters stay with the run that ends.
      const piece = current.trim()
      if (piece) runs.push({ text: piece, script: currentScript })
      current = ""
      currentScript = script
    }
    current += ch
  }
  const piece = current.trim()
  if (piece) runs.push({ text: piece, script: currentScript ?? fallback })
  return runs
}

/** Whether any letter in the text is in `script`. */
export function containsScript(text: string, script: SpeechScript): boolean {
  for (const ch of text) if (scriptOf(ch) === script) return true
  return false
}

// ── Segments ──

/** One utterance: a sentence, or the part of one in a single script. */
export interface SpeechSegment {
  text: string
  script: SpeechScript
}

type SentenceSegmenter = {
  segment(input: string): Iterable<{ segment: string }>
}

let sentenceSegmenter: SentenceSegmenter | null | undefined

function getSentenceSegmenter(): SentenceSegmenter | null {
  if (sentenceSegmenter !== undefined) return sentenceSegmenter
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: "sentence" }
      ) => SentenceSegmenter
    }
  ).Segmenter
  try {
    sentenceSegmenter = Segmenter
      ? new Segmenter(undefined, { granularity: "sentence" })
      : null
  } catch {
    sentenceSegmenter = null
  }
  return sentenceSegmenter
}

/** Split a paragraph into sentences. */
export function splitSentences(paragraph: string): string[] {
  const segmenter = getSentenceSegmenter()
  const pieces = segmenter
    ? Array.from(segmenter.segment(paragraph), (s) => s.segment)
    : (paragraph.match(/[^.!?…؟。！？]+(?:[.!?…؟。！？]+|$)/g) ?? [paragraph])
  return pieces.map((piece) => piece.trim()).filter(Boolean)
}

/** Cut a long run at a clause boundary, or a space, near the limit. */
export function chunkText(text: string, max = MAX_SEGMENT_CHARS): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max + 1)
    let cut = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(": "),
      window.lastIndexOf("، ")
    )
    if (cut < max / 2) cut = window.lastIndexOf(" ")
    if (cut <= 0) cut = max
    else cut += 1
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * The utterances for already-prepared speech text, in order: paragraph by
 * paragraph, sentence by sentence, run by run. Speaking these one at a time
 * starts the first sentence at once, however long the reply.
 */
export function buildSpeechSegments(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) continue
    const fallback = scriptRuns(paragraph)[0]?.script ?? "latin"
    for (const s of splitSentences(paragraph)) {
      for (const run of scriptRuns(s, fallback)) {
        for (const chunk of chunkText(run.text)) {
          segments.push({ text: chunk, script: run.script })
        }
      }
    }
  }
  return segments
}
