/**
 * "Continue in another agent": which conversation a new-session draft
 * continues, from the moment it opens until it is sent — its row records the
 * link as it is created (`createConversation`'s `continuedFromId`) — or
 * closed. Kept in storage, keyed by the draft's tab id, so a restart in
 * between (an update, say) does not lose it, the way the draft's own text
 * survives one. See `lib/continue-in-agent.ts`.
 */

const LINKS_STORAGE_KEY = "codeg:continuation-links:v1"
/** A draft left unsent this long forgets what it continues. */
const LINK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

type StoredLinks = Record<string, { from: number; at: number }>

function readLinks(): StoredLinks {
  try {
    const raw = localStorage.getItem(LINKS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as StoredLinks) : {}
  } catch {
    return {}
  }
}

function writeLinks(links: StoredLinks): void {
  try {
    if (Object.keys(links).length === 0) {
      localStorage.removeItem(LINKS_STORAGE_KEY)
    } else {
      localStorage.setItem(LINKS_STORAGE_KEY, JSON.stringify(links))
    }
  } catch {
    // Storage unavailable: the link only lives as long as this write did.
  }
}

/**
 * Remember that the draft tab `tabId` continues `fromConversationId`, until
 * it is sent (its row records the link then) or closed. Kept in storage so a
 * restart in between — an update, say — does not lose it, the way the
 * draft's text survives one.
 */
export function parkContinuationLink(
  tabId: string,
  fromConversationId: number,
  now: number = Date.now()
): void {
  const links = readLinks()
  for (const [key, link] of Object.entries(links)) {
    if (now - link.at > LINK_MAX_AGE_MS) delete links[key]
  }
  links[tabId] = { from: fromConversationId, at: now }
  writeLinks(links)
}

/** The conversation the draft tab `tabId` continues, if any. */
export function peekContinuationLink(
  tabId: string,
  now: number = Date.now()
): number | null {
  const link = readLinks()[tabId]
  if (!link || typeof link.from !== "number") return null
  if (now - link.at > LINK_MAX_AGE_MS) return null
  return link.from
}

/** Forget what the draft tab `tabId` continues: it was sent, or closed. */
export function clearContinuationLink(tabId: string): void {
  const links = readLinks()
  if (!(tabId in links)) return
  delete links[tabId]
  writeLinks(links)
}

/** The draft `fromTabId` was replaced by `toTabId` (closing the last tab
 *  spawns a replacement that keeps its text): the link goes with it. */
export function moveContinuationLink(fromTabId: string, toTabId: string): void {
  const links = readLinks()
  const link = links[fromTabId]
  if (!link) return
  delete links[fromTabId]
  links[toTabId] = link
  writeLinks(links)
}
