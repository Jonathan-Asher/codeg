import { afterEach, describe, expect, it, vi } from "vitest"

// The action's export goes through the server; every test hands its own.
vi.mock("@/lib/api", () => ({ exportConversationSavedHistory: vi.fn() }))

import {
  buildSavedHistoryPrefill,
  startSessionFromSavedHistory,
} from "./saved-history"
import {
  COMPOSER_PREFILL_PARKED_EVENT,
  discardComposerPrefill,
  parkComposerPrefill,
  resetComposerPrefillsForTests,
  takeComposerPrefill,
} from "./composer-prefill-handoff"

const INLINE = "This continues an earlier session. Below is the text."
const ATTACHED = "This continues an earlier session. The file holds the text."

describe("buildSavedHistoryPrefill", () => {
  it("puts a short export under the preamble", () => {
    expect(
      buildSavedHistoryPrefill({
        exported: {
          markdown: "# Higgsfield alternatives\n\n## User\n\nDo research\n",
          chars: 48,
          turns: 1,
        },
        inlinePreamble: INLINE,
        attachedPreamble: ATTACHED,
      })
    ).toEqual({
      text: `${INLINE}\n\n# Higgsfield alternatives\n\n## User\n\nDo research`,
    })
  })

  it("attaches a long export's file instead of pasting it", () => {
    expect(
      buildSavedHistoryPrefill({
        exported: {
          path: "/data/saved-history/conversation-76.md",
          chars: 14_169,
          turns: 28,
        },
        inlinePreamble: INLINE,
        attachedPreamble: ATTACHED,
      })
    ).toEqual({
      text: ATTACHED,
      files: ["/data/saved-history/conversation-76.md"],
    })
  })

  it("keeps the preamble alone when nothing was saved", () => {
    expect(
      buildSavedHistoryPrefill({
        exported: { markdown: "   ", chars: 3, turns: 0 },
        inlinePreamble: INLINE,
        attachedPreamble: ATTACHED,
      })
    ).toEqual({ text: INLINE })
  })
})

describe("composer prefill hand-off", () => {
  afterEach(() => resetComposerPrefillsForTests())

  const target = { agentType: "claude_code" as const, folderId: 14 }

  it("hands the text to the tab it was parked for, once", () => {
    const nudged = vi.fn()
    const onParked = (event: Event) =>
      nudged((event as CustomEvent<{ tabId: string }>).detail.tabId)
    window.addEventListener(COMPOSER_PREFILL_PARKED_EVENT, onParked)
    try {
      parkComposerPrefill("draft-1", { text: "saved text", ...target })
    } finally {
      window.removeEventListener(COMPOSER_PREFILL_PARKED_EVENT, onParked)
    }
    expect(nudged).toHaveBeenCalledWith("draft-1")

    expect(takeComposerPrefill("draft-2", target)).toBeNull()
    expect(takeComposerPrefill("draft-1", target)).toEqual({
      text: "saved text",
      ...target,
    })
    expect(takeComposerPrefill("draft-1", target)).toBeNull()
  })

  it("waits until a reused draft has been re-pointed at the agent and folder", () => {
    parkComposerPrefill("draft-1", { text: "saved text", ...target })
    // Still the old folder's draft: not yet.
    expect(
      takeComposerPrefill("draft-1", { agentType: "claude_code", folderId: 8 })
    ).toBeNull()
    expect(
      takeComposerPrefill("draft-1", { agentType: "codex", folderId: 14 })
    ).toBeNull()
    expect(takeComposerPrefill("draft-1", target)?.text).toBe("saved text")
  })

  it("keeps only the latest text for a tab, and drops it with the tab", () => {
    parkComposerPrefill("draft-1", { text: "first", ...target })
    parkComposerPrefill("draft-1", {
      text: "second",
      files: ["/data/saved-history/conversation-76.md"],
      ...target,
    })
    expect(takeComposerPrefill("draft-1", target)).toEqual({
      text: "second",
      files: ["/data/saved-history/conversation-76.md"],
      ...target,
    })

    parkComposerPrefill("draft-1", { text: "third", ...target })
    discardComposerPrefill("draft-1")
    expect(takeComposerPrefill("draft-1", target)).toBeNull()
  })
})

describe("startSessionFromSavedHistory", () => {
  afterEach(() => resetComposerPrefillsForTests())

  const request = {
    conversationId: 76,
    folderId: 14,
    workingDir: "/Users/me/Work/slop",
    agentType: "claude_code" as const,
    targetGroup: "group-1",
    inlinePreamble: INLINE,
    attachedPreamble: ATTACHED,
  }

  it("opens a new session on the same agent and folder with the text in its composer", async () => {
    const openNewConversationTab = vi.fn(() => ({
      tabId: "draft-9",
      agentType: "claude_code" as const,
      folderId: 14,
    }))
    const exportSaved = vi.fn(async () => ({
      path: "/data/saved-history/conversation-76.md",
      chars: 14_169,
      turns: 28,
    }))

    const target = await startSessionFromSavedHistory(request, {
      openNewConversationTab,
      exportSaved,
    })

    expect(exportSaved).toHaveBeenCalledWith(76)
    expect(openNewConversationTab).toHaveBeenCalledWith(
      14,
      "/Users/me/Work/slop",
      { targetGroup: "group-1", forceAgent: "claude_code" }
    )
    expect(target.tabId).toBe("draft-9")
    // Waiting in the new draft's composer — nothing sent anywhere.
    expect(
      takeComposerPrefill("draft-9", { agentType: "claude_code", folderId: 14 })
    ).toEqual({
      text: ATTACHED,
      files: ["/data/saved-history/conversation-76.md"],
      agentType: "claude_code",
      folderId: 14,
    })
  })

  it("leaves no new session behind when the export fails", async () => {
    const openNewConversationTab = vi.fn()
    const park = vi.fn()
    await expect(
      startSessionFromSavedHistory(request, {
        openNewConversationTab,
        exportSaved: async () => {
          throw new Error("server gone")
        },
        park,
      })
    ).rejects.toThrow("server gone")
    expect(openNewConversationTab).not.toHaveBeenCalled()
    expect(park).not.toHaveBeenCalled()
  })
})
