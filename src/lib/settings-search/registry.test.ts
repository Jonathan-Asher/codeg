import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { settingsNavItemsFor } from "@/components/settings/settings-shell"
import { SHORTCUT_DEFINITIONS } from "@/lib/keyboard-shortcuts"
import {
  SETTINGS_SEARCH_ENTRIES,
  settingsAnchorForShortcut,
} from "@/lib/settings-search/registry"
import { messageText } from "@/lib/settings-search/search"

const ROOT = process.cwd()

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path)
  }
  return out
}

/** The whole opening tag that starts at `start`, braces and all. */
function openingTag(source: string, start: number): string {
  let depth = 0
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source[i]
    if (c === "{") depth += 1
    else if (c === "}") depth -= 1
    else if (c === ">" && depth === 0 && source[i - 1] !== "=") {
      return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

interface Tag {
  file: string
  line: number
  text: string
  /** Up to the matching close, for a `<section>`'s heading check. */
  body: string
}

/**
 * A file's code without its comments, which may well spell `<section>` or an
 * attribute. Line numbers survive: a comment's newlines are kept.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "")
}

function tagsIn(files: string[], name: string): Tag[] {
  const out: Tag[] = []
  const pattern = new RegExp(`<${name}\\b`, "g")
  for (const file of files) {
    const source = codeOf(file)
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0
      const text = openingTag(source, start)
      const close = source.indexOf(`</${name}>`, start)
      out.push({
        file: relative(ROOT, file),
        line: source.slice(0, start).split("\n").length,
        text,
        body: source.slice(start + text.length, close < 0 ? undefined : close),
      })
    }
  }
  return out
}

function literal(tag: string, attribute: string): string | null {
  const match = new RegExp(`\\b${attribute}="([^"]*)"`).exec(tag)
  return match ? match[1] : null
}

const componentFiles = sourceFiles(resolve(ROOT, "src/components"))
const settingsFiles = componentFiles.filter((file) =>
  relative(ROOT, file).startsWith("src/components/settings/")
)

const registeredAnchors = new Set(
  SETTINGS_SEARCH_ENTRIES.flatMap((entry) =>
    entry.anchor ? [entry.anchor] : []
  )
)
const shortcutAnchors = new Set(
  SHORTCUT_DEFINITIONS.map((definition) =>
    settingsAnchorForShortcut(definition.id)
  )
)

/**
 * A settings section, as a page draws one: a `SettingsSection`, or a bare
 * `<section>` in a settings component that is a titled card — the house
 * `bg-card` shell, or one whose first heading is an `h2` (a section's title;
 * page titles are `h1`, sub-headings `h3`).
 */
function isSettingsSectionElement(tag: Tag): boolean {
  if (/className="[^"]*\bbg-card\b/.test(tag.text)) return true
  const heading = tag.body.search(/<h[1-3]\b/)
  const nested = tag.body.search(/<section\b/)
  return (
    heading >= 0 &&
    tag.body.slice(heading, heading + 3) === "<h2" &&
    (nested < 0 || heading < nested)
  )
}

describe("settings search registry", () => {
  it("gives every settings section an anchor the registry knows", () => {
    const missing: string[] = []
    for (const tag of tagsIn(componentFiles, "SettingsSection")) {
      const anchor = literal(tag.text, "anchor")
      if (!anchor || !registeredAnchors.has(anchor)) {
        missing.push(`${tag.file}:${tag.line} ${anchor ?? "(no anchor)"}`)
      }
    }
    for (const tag of tagsIn(settingsFiles, "section")) {
      if (!isSettingsSectionElement(tag)) continue
      const anchor = literal(tag.text, "data-settings-anchor")
      if (!anchor || !registeredAnchors.has(anchor)) {
        missing.push(`${tag.file}:${tag.line} ${anchor ?? "(no anchor)"}`)
      }
    }
    // A section added to a page without an entry here can't be searched for:
    // add it to `settings-search/registry.ts` and pass its id as `anchor`.
    expect(missing).toEqual([])
  })

  it("only names anchors the registry knows", () => {
    const unknown: string[] = []
    for (const name of ["SettingsSection", "SettingRow"]) {
      for (const tag of tagsIn(componentFiles, name)) {
        const anchor = literal(tag.text, "anchor")
        if (anchor !== null && !registeredAnchors.has(anchor)) {
          unknown.push(`${tag.file}:${tag.line} ${anchor}`)
        }
      }
    }
    for (const file of componentFiles) {
      for (const match of codeOf(file).matchAll(
        /\bdata-settings-anchor="([^"]*)"/g
      )) {
        if (!registeredAnchors.has(match[1])) {
          unknown.push(`${relative(ROOT, file)} ${match[1]}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  it("has every registered anchor on some element", () => {
    const sources = componentFiles.map((file) => readFileSync(file, "utf8"))
    const unplaced = [...registeredAnchors].filter(
      (anchor) =>
        !shortcutAnchors.has(anchor) &&
        !sources.some(
          (source) =>
            source.includes(`anchor="${anchor}"`) ||
            source.includes(`data-settings-anchor="${anchor}"`)
        )
    )
    expect(unplaced).toEqual([])
    // The Shortcuts rows are drawn from the action list, so their anchors come
    // from the one function both sides use.
    const shortcutPage = readFileSync(
      resolve(ROOT, "src/components/settings/shortcut-settings.tsx"),
      "utf8"
    )
    expect(shortcutPage).toContain("data-settings-anchor={settingsAnchorFor")
  })

  it("keeps ids unique and anchors plain enough for a selector", () => {
    const ids = SETTINGS_SEARCH_ENTRIES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const anchor of registeredAnchors) {
      expect(anchor).toMatch(/^[a-z0-9_.-]+$/)
    }
  })

  it("resolves every title, description and synonym in English", () => {
    const messages = enMessages as unknown as Record<string, unknown>
    const broken: string[] = []
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      for (const path of [entry.title, entry.description]) {
        if (path && !messageText(messages, path)) {
          broken.push(`${entry.id}: ${path}`)
        }
      }
      if (
        entry.keywords &&
        !messageText(messages, `SettingsSearch.keywords.${entry.keywords}`)
      ) {
        broken.push(`${entry.id}: keywords ${entry.keywords}`)
      }
    }
    expect(broken).toEqual([])
  })

  it("leaves no synonym list without its entry", () => {
    const used = new Set(
      SETTINGS_SEARCH_ENTRIES.flatMap((entry) =>
        entry.keywords ? [entry.keywords] : []
      )
    )
    const declared = Object.keys(enMessages.SettingsSearch.keywords)
    expect(declared.filter((key) => !used.has(key))).toEqual([])
  })

  it("covers exactly the pages of the nav, each with an entry of its own", () => {
    const navPages = settingsNavItemsFor("tauri").map((item) => item.labelKey)
    const entryPages = new Set(SETTINGS_SEARCH_ENTRIES.map((e) => e.page))
    expect([...entryPages].sort()).toEqual([...navPages].sort())
    for (const page of navPages) {
      expect(
        SETTINGS_SEARCH_ENTRIES.some(
          (entry) => entry.page === page && entry.kind === "page"
        )
      ).toBe(true)
    }
  })

  it("puts each setting in a section of its own page", () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (!entry.section) continue
      const section = SETTINGS_SEARCH_ENTRIES.find(
        (other) => other.id === entry.section
      )
      expect(section?.kind, entry.id).toBe("section")
      expect(section?.page, entry.id).toBe(entry.page)
    }
  })

  it("lists every shortcut action on the Shortcuts page", () => {
    for (const definition of SHORTCUT_DEFINITIONS) {
      expect(
        SETTINGS_SEARCH_ENTRIES.some(
          (entry) => entry.anchor === settingsAnchorForShortcut(definition.id)
        )
      ).toBe(true)
    }
  })
})
