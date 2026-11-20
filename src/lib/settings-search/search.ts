import {
  SETTINGS_SEARCH_ENTRIES,
  type SettingsPageKey,
  type SettingsSearchEntry,
  type SettingsSearchPlatform,
  settingsSearchEntry,
} from "@/lib/settings-search/registry"

/** The active locale's messages, as next-intl's `useMessages()` hands them. */
type MessageTree = { [key: string]: unknown }

/**
 * The words of one message, for matching rather than display: placeholders
 * (`{name}`, `{count, plural, …}`) and rich-text tags come out, so a value
 * nobody typed never matches and the words around it still do.
 */
export function messageText(
  messages: MessageTree,
  path: string
): string | null {
  let node: unknown = messages
  for (const segment of path.split(".")) {
    if (!node || typeof node !== "object") return null
    node = (node as MessageTree)[segment]
  }
  if (typeof node !== "string") return null
  let text = node.replace(/<\/?[a-zA-Z][^>]*>/g, "")
  // Innermost first, so a plural's branches go before the plural itself.
  for (let guard = 0; guard < 8 && /\{[^{}]*\}/.test(text); guard += 1) {
    text = text.replace(/\{[^{}]*\}/g, "")
  }
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Lowercase, without diacritics or width variants, punctuation as spaces:
 * "Désactiver" finds "desactiver", full-width "ＧＩＴ" finds "git".
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** One entry with its text in the user's language. */
export interface SettingsSearchDoc {
  entry: SettingsSearchEntry
  title: string
  description: string
  pageLabel: string
  /** The section a setting sits in, by its title. */
  sectionTitle: string | null
  /** Normalized, each padded with spaces so a word start is `" " + token`. */
  fields: {
    title: string
    keywords: string
    section: string
    page: string
    description: string
  }
}

export interface SettingsSearchScope {
  /** The pages this runtime's nav shows. */
  pages: ReadonlySet<SettingsPageKey>
  desktop: boolean
  /** `unknown` keeps every platform's entries. */
  platform: SettingsSearchPlatform | "unknown"
}

function pad(text: string): string {
  return ` ${normalizeSearchText(text)} `
}

/**
 * The entries this window can show, with their text resolved from `messages`.
 * An entry whose title has no message (a renamed key) is left out rather than
 * shown blank; the registry test catches that before it ships.
 */
export function buildSettingsSearchIndex(
  messages: MessageTree,
  scope: SettingsSearchScope,
  entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_ENTRIES
): SettingsSearchDoc[] {
  const text = (path: string | undefined) =>
    path ? (messageText(messages, path) ?? "") : ""
  const docs: SettingsSearchDoc[] = []
  for (const entry of entries) {
    if (!scope.pages.has(entry.page)) continue
    if (entry.desktopOnly && !scope.desktop) continue
    if (
      entry.platforms &&
      scope.platform !== "unknown" &&
      !entry.platforms.includes(scope.platform)
    ) {
      continue
    }
    const title = text(entry.title)
    if (!title) continue
    const description = text(entry.description)
    const pageLabel = text(`SettingsShell.nav.${entry.page}`)
    const section = entry.section ? settingsSearchEntry(entry.section) : null
    const sectionTitle = section ? text(section.title) || null : null
    const keywords = [
      entry.keywords ? text(`SettingsSearch.keywords.${entry.keywords}`) : "",
      ...(entry.terms ?? []),
    ].join(" ")
    docs.push({
      entry,
      title,
      description,
      pageLabel,
      sectionTitle,
      fields: {
        title: pad(title),
        keywords: pad(keywords),
        section: pad(sectionTitle ?? ""),
        page: pad(pageLabel),
        description: pad(description),
      },
    })
  }
  return docs
}

/** How well one word of the query fits one doc; 0 is no match at all. */
function tokenScore(doc: SettingsSearchDoc, token: string): number {
  const { fields } = doc
  const wordStart = ` ${token}`
  if (fields.title.startsWith(wordStart)) return 100
  if (fields.title.includes(wordStart)) return 70
  if (fields.title.includes(token)) return 45
  if (fields.keywords.includes(wordStart)) return 40
  if (fields.keywords.includes(token)) return 30
  if (fields.section.includes(token)) return 15
  if (fields.page.includes(token)) return 12
  if (fields.description.includes(wordStart)) return 10
  if (fields.description.includes(token)) return 6
  return 0
}

/**
 * The docs that hold every word of `query`, best first: a title that starts
 * with a word beats one that contains it, which beats a synonym, the section
 * or page it sits in, and finally its explanation. Ties keep the registry's
 * order, which is the order of the pages.
 */
export function searchSettings(
  index: readonly SettingsSearchDoc[],
  query: string,
  limit = 50
): SettingsSearchDoc[] {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean)
  if (tokens.length === 0) return []
  const scored: Array<{ doc: SettingsSearchDoc; score: number; at: number }> =
    []
  index.forEach((doc, at) => {
    let score = 0
    for (const token of tokens) {
      const points = tokenScore(doc, token)
      if (points === 0) return
      score += points
    }
    scored.push({ doc, score, at })
  })
  scored.sort((a, b) => b.score - a.score || a.at - b.at)
  return scored.slice(0, limit).map(({ doc }) => doc)
}

/**
 * Where a result leads, most precise first: the setting's own anchor, then its
 * section's. Empty for a page, which opens at its top.
 */
export function revealAnchorsFor(entry: SettingsSearchEntry): string[] {
  const anchors: string[] = []
  if (entry.anchor) anchors.push(entry.anchor)
  const section = entry.section ? settingsSearchEntry(entry.section) : null
  if (section?.anchor && !anchors.includes(section.anchor)) {
    anchors.push(section.anchor)
  }
  return anchors
}
