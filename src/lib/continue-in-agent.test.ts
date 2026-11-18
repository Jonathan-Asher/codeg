import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildContinuationPrefill,
  continuationPlacement,
  continueInAgentBlock,
  openContinuation,
  setContinuationInProgress,
  writeHandoff,
  type ContinuableConversation,
} from "@/lib/continue-in-agent"
import {
  clearContinuationLink,
  moveContinuationLink,
  parkContinuationLink,
  peekContinuationLink,
} from "@/lib/continuation-links"
import {
  resetComposerPrefillsForTests,
  takeComposerPrefill,
} from "@/lib/composer-prefill-handoff"
import type { ContinuationHandoff } from "@/lib/api"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { singleGroupLayout } from "@/lib/tab-group-layout"

function conv(
  overrides: Partial<ContinuableConversation> = {}
): ContinuableConversation {
  return {
    id: 7,
    external_id: "session-S1",
    turn_state: null,
    status: "pending_review",
    parent_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetComposerPrefillsForTests()
})

afterEach(() => {
  setContinuationInProgress(7, false)
})

describe("when Continue in another agent can run", () => {
  it("runs on an idle session that has replied", () => {
    expect(continueInAgentBlock(conv())).toBeNull()
  })

  it("waits for a running turn", () => {
    expect(continueInAgentBlock(conv({ turn_state: "running" }))).toBe(
      "turn_running"
    )
    // The agent working on a turn of its own counts too.
    expect(
      continueInAgentBlock(conv(), null, {
        task_count: 0,
        out_of_turn: true,
        held_open: false,
      })
    ).toBe("turn_running")
  })

  it("waits for a pending permission or question", () => {
    expect(continueInAgentBlock(conv(), "permission")).toBe("needs_you")
    expect(continueInAgentBlock(conv(), "question")).toBe("needs_you")
  })

  it("needs a session with a reply, and not a sub-session", () => {
    expect(continueInAgentBlock(conv({ external_id: null }))).toBe("no_session")
    expect(continueInAgentBlock(conv({ parent_id: 3 }))).toBe("subsession")
    expect(continueInAgentBlock(null)).toBe("no_session")
  })

  it("waits for a handoff already being written", () => {
    setContinuationInProgress(7, true)
    expect(continueInAgentBlock(conv())).toBe("in_progress")
  })
})

describe("the new session's composer text", () => {
  it("is a line linking the old session, then the handoff", () => {
    expect(
      buildContinuationPrefill({
        title: "Fix the login",
        conversationId: 42,
        agentLabel: "Claude Code",
        handoff: "\n## Goal\nShip the login fix.\n",
      })
    ).toBe(
      "Continuing [Fix the login](codeg://session/42) from Claude Code.\n\n## Goal\nShip the login fix."
    )
  })

  it("keeps a title from breaking out of the link", () => {
    expect(
      buildContinuationPrefill({
        title: "a [b]\n(c)",
        conversationId: 3,
        agentLabel: "Codex",
        handoff: "x",
      }).split("\n")[0]
    ).toBe("Continuing [a \\[b\\] \\(c\\)](codeg://session/3) from Codex.")
  })
})

describe("the handoff turn", () => {
  it("captures the turn's final text", async () => {
    const request = vi.fn(
      async (): Promise<ContinuationHandoff> => ({
        text: "  ## Goal\nDone.  ",
        failure: null,
      })
    )
    await expect(writeHandoff(7, request)).resolves.toEqual({
      ok: true,
      text: "## Goal\nDone.",
    })
    expect(request).toHaveBeenCalledWith(7)
  })

  it("marks the session while the handoff is written", async () => {
    let seen: string | null = "unset"
    const request = vi.fn(async (): Promise<ContinuationHandoff> => {
      seen = continueInAgentBlock(conv())
      return { text: "x", failure: null }
    })
    await writeHandoff(7, request)
    expect(seen).toBe("in_progress")
    expect(continueInAgentBlock(conv())).toBeNull()
  })

  it("says why there is no handoff", async () => {
    await expect(
      writeHandoff(7, async () => ({
        text: null,
        failure: { kind: "usage_limit", message: "You've hit your limit" },
      }))
    ).resolves.toEqual({
      ok: false,
      kind: "usage_limit",
      message: "You've hit your limit",
    })
    await expect(
      writeHandoff(7, async () => {
        throw new Error("network down")
      })
    ).resolves.toEqual({ ok: false, kind: "request", message: "network down" })
  })
})

describe("the link until the draft is sent", () => {
  it("is kept per draft tab, moves with it and goes when cleared", () => {
    parkContinuationLink("draft-1", 42)
    expect(peekContinuationLink("draft-1")).toBe(42)
    expect(peekContinuationLink("draft-2")).toBeNull()
    moveContinuationLink("draft-1", "draft-2")
    expect(peekContinuationLink("draft-1")).toBeNull()
    expect(peekContinuationLink("draft-2")).toBe(42)
    clearContinuationLink("draft-2")
    expect(peekContinuationLink("draft-2")).toBeNull()
  })

  it("is forgotten after a month unsent", () => {
    parkContinuationLink("draft-1", 42, 1_000)
    expect(peekContinuationLink("draft-1", 1_000 + 29 * 86_400_000)).toBe(42)
    expect(peekContinuationLink("draft-1", 1_000 + 31 * 86_400_000)).toBeNull()
  })
})

describe("opening the new session", () => {
  const source = {
    id: 42,
    folder_id: 5,
    working_dir: "/work/app-worktree",
    origin_cwd: null,
  }

  it("opens a draft beside the old tab with the handoff in its composer", () => {
    const calls: string[] = []
    const openNewConversationTab = vi.fn(() => {
      calls.push("open")
      return { tabId: "draft-9", agentType: "codex" as const, folderId: 5 }
    })
    const savePicks = vi.fn(() => calls.push("picks"))
    const opened = openContinuation(
      {
        source,
        sourceTitle: "Fix the login",
        sourceAgentLabel: "Claude Code",
        agentType: "codex",
        picks: {
          modeId: null,
          configValues: { model: "gpt-6", effort: "high" },
        },
        handoff: "## Goal\nShip it.",
      },
      {
        openNewConversationTab,
        placement: () => ({ targetGroup: "g2", index: 3 }),
        savePicks,
        focusComposer: () => calls.push("focus"),
      }
    )

    expect(opened.tabId).toBe("draft-9")
    // Same folder and the old session's own working directory (its
    // worktree), on the chosen agent, next to its tab.
    expect(openNewConversationTab).toHaveBeenCalledWith(
      5,
      "/work/app-worktree",
      { targetGroup: "g2", index: 3, forceAgent: "codex" }
    )
    // The picks are saved before the draft's session starts.
    expect(savePicks).toHaveBeenCalledWith("codex", {
      modeId: null,
      configValues: { model: "gpt-6", effort: "high" },
    })
    expect(calls).toEqual(["picks", "focus", "open"])
    expect(
      takeComposerPrefill("draft-9", { agentType: "codex", folderId: 5 })
    ).toEqual({
      text: "Continuing [Fix the login](codeg://session/42) from Claude Code.\n\n## Goal\nShip it.",
      agentType: "codex",
      folderId: 5,
    })
    expect(peekContinuationLink("draft-9")).toBe(42)
  })

  it("falls back to the folder's path for a server without working_dir", () => {
    const openNewConversationTab = vi.fn(() => ({
      tabId: "draft-1",
      agentType: "codex" as const,
      folderId: 5,
    }))
    openContinuation(
      {
        source: { ...source, working_dir: undefined },
        sourceTitle: "t",
        sourceAgentLabel: "Claude Code",
        agentType: "codex",
        picks: { modeId: null, configValues: {} },
        handoff: "h",
      },
      {
        openNewConversationTab,
        placement: () => ({}),
        folderPath: () => "/work/app",
        savePicks: () => {},
        focusComposer: () => {},
      }
    )
    expect(openNewConversationTab).toHaveBeenCalledWith(5, "/work/app", {
      forceAgent: "codex",
    })
  })
})

describe("where the new session's tab goes", () => {
  beforeEach(() => resetTabStore())

  it("is right after the old tab, in its group", () => {
    const layout = singleGroupLayout()
    const group = layout.id
    useTabStore.setState({
      rawTabs: [
        {
          id: "a",
          kind: "conversation",
          folderId: 5,
          conversationId: 1,
          agentType: "codex",
          title: "a",
          isPinned: true,
        },
        {
          id: "b",
          kind: "conversation",
          folderId: 5,
          conversationId: 42,
          agentType: "claude_code",
          title: "b",
          isPinned: true,
        },
        {
          id: "c",
          kind: "conversation",
          folderId: 5,
          conversationId: 3,
          agentType: "codex",
          title: "c",
          isPinned: true,
        },
      ],
      groupLayout: layout,
      groupOf: {},
    })
    expect(continuationPlacement(42)).toEqual({ targetGroup: group, index: 2 })
    expect(continuationPlacement(999)).toEqual({})
  })

  it("counts the slot without the group's own draft, which moves there", () => {
    const layout = singleGroupLayout()
    useTabStore.setState({
      rawTabs: [
        {
          id: "draft",
          kind: "conversation",
          folderId: 5,
          conversationId: null,
          agentType: "codex",
          title: "New",
          isPinned: true,
        },
        {
          id: "b",
          kind: "conversation",
          folderId: 5,
          conversationId: 42,
          agentType: "claude_code",
          title: "b",
          isPinned: true,
        },
      ],
      groupLayout: layout,
      groupOf: {},
    })
    expect(continuationPlacement(42).index).toBe(1)
  })
})
