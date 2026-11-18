import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * "Continue in another agent": the new session's draft remembers which
 * session it continues, and its row records that as the draft is sent. The
 * pieces have their own tests (`lib/continue-in-agent`, the dialog, the
 * backend's link); these pin the wiring in the conversation panel and the tab
 * store, which only mount under the whole workspace stack.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const PANEL = "src/components/conversations/conversation-detail-panel.tsx"
const TAB_STORE = "src/stores/tab-store.ts"

describe("the draft that continues another session", () => {
  const panel = read(PANEL)

  it("creates its row with the link, for a chat and for a folder", () => {
    expect(panel).toContain(
      "const continuedFromId = peekContinuationLink(tabId)"
    )
    const chat = panel.slice(panel.indexOf("await createChatConversation("))
    expect(chat.slice(0, chat.indexOf(")"))).toContain("continuedFromId")
    const regular = panel.slice(panel.indexOf("await createConversation("))
    expect(regular.slice(0, regular.indexOf(")"))).toContain("continuedFromId")
  })

  it("forgets the link once the row exists", () => {
    const created = panel.slice(panel.indexOf("await createConversation("))
    expect(created.indexOf("clearContinuationLink(tabId)")).toBeGreaterThan(0)
  })

  it("draws the banners at the thread's start and end", () => {
    expect(panel).toContain("threadHeader={continuationHeader}")
    expect(panel).toContain("threadFooter={continuationFooter}")
  })

  it("drops the link with a closed draft, or hands it to its replacement", () => {
    const store = read(TAB_STORE)
    expect(store).toContain(
      "moveContinuationLink(closingTab.id, replacementTab.id)"
    )
    expect(store).toContain("clearContinuationLink(closingTab.id)")
  })
})
