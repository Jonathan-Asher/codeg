import { afterEach, describe, expect, it } from "vitest"
import { sessionNotificationPayload } from "./notification-session"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

function folder(id: number, name: string, alias: string | null = null) {
  return { id, name, alias } as unknown as FolderDetail
}

function conversation(id: number, folderId: number, title: string | null) {
  return {
    id,
    folder_id: folderId,
    title,
  } as unknown as DbConversationSummary
}

function seed({
  tab,
}: {
  tab: {
    id: string
    folderId: number
    conversationId: number | null
    title: string
  }
}) {
  useAppWorkspaceStore.setState({
    folders: [folder(1, "codeg"), folder(2, "legalix", "Legalix API")],
    conversations: [
      conversation(10, 1, "Fix the stale transcript after wake"),
      conversation(20, 2, "Refactor [README.md](file:///x/README.md) intro"),
    ],
  })
  // Tabs derive from the conversation list, so they go in last.
  useTabStore.setState({
    tabs: [
      {
        kind: "conversation",
        agentType: "claude_code",
        isPinned: false,
        ...tab,
      },
    ] as never,
  })
}

afterEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
})

describe("sessionNotificationPayload", () => {
  it("titles the banner with the session and names ITS folder", () => {
    seed({
      tab: { id: "t1", folderId: 1, conversationId: 10, title: "tab label" },
    })
    // The window's active folder is a different one — it must not win.
    const p = sessionNotificationPayload("t1", "some-other-folder", {
      body: "Claude Code is waiting for your answer",
    })
    expect(p.title).toBe("Fix the stale transcript after wake")
    expect(p.body).toBe("codeg · Claude Code is waiting for your answer")
    // "Hide notification contents" must not leak the user's own words.
    expect(p.redactedTitle).toBe("codeg - Codeg")
    expect(p.redactedBody).toBeUndefined()
  })

  it("prefers the folder alias and folds reference links in the title", () => {
    seed({
      tab: { id: "t2", folderId: 2, conversationId: 20, title: "tab label" },
    })
    const p = sessionNotificationPayload("t2", null, {
      body: "Claude Code error: boom",
      redactedBody: "Claude Code ran into an error",
    })
    expect(p.title).toBe("Refactor README.md intro")
    expect(p.body).toBe("Legalix API · Claude Code error: boom")
    expect(p.redactedBody).toBe("Legalix API · Claude Code ran into an error")
  })

  it("falls back to the tab's label for a draft with no row yet", () => {
    seed({
      tab: { id: "t3", folderId: 1, conversationId: null, title: "New chat" },
    })
    const p = sessionNotificationPayload("t3", null, { body: "done" })
    expect(p.title).toBe("New chat")
    expect(p.body).toBe("codeg · done")
  })

  it("keeps the old folder title when the session can't be found", () => {
    const p = sessionNotificationPayload("unknown-key", "codeg", {
      body: "done",
    })
    expect(p.title).toBe("codeg - Codeg")
    expect(p.body).toBe("done")
  })
})
