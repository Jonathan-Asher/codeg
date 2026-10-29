import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  acpForkConversation: vi.fn(),
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

import { acpForkConversation } from "@/lib/api"
import type { ForkToNewConversationResult } from "@/lib/api"
import {
  NO_CAPABILITIES,
  getRememberedCapabilities,
  resetCapabilitiesCacheForTests,
} from "@/lib/agent-capabilities"
import { ForkBetweenTurnsOnlyError } from "@/lib/fork-from-turn"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetForkPlaceholderStore,
  useForkPlaceholderStore,
} from "@/stores/fork-placeholder-store"
import {
  resetTabStore,
  useTabStore,
  type TabItemInternal,
} from "@/stores/tab-store"
import {
  conversationForkBlock,
  forkConversation,
  forkRefusal,
  forkTabAnchor,
  isForkingConversation,
  type ForkableConversation,
} from "./fork-conversation"

const FORKED: ForkToNewConversationResult = {
  forkedSessionId: "session-S2",
  originalSessionId: "session-S1",
  conversationId: 42,
  folderId: 1,
  title: "[Fork] Topic",
}

function summary(
  overrides: Partial<ForkableConversation> = {}
): ForkableConversation {
  return {
    id: 7,
    agent_type: "claude_code",
    external_id: "session-S1",
    turn_state: null,
    status: "pending",
    ...overrides,
  }
}

function tab(conversationId: number): TabItemInternal {
  return {
    id: `conv-1-claude_code-${conversationId}`,
    kind: "conversation",
    folderId: 1,
    conversationId,
    agentType: "claude_code",
    title: `t${conversationId}`,
    isPinned: true,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetCapabilitiesCacheForTests()
  resetForkPlaceholderStore()
  resetTabStore()
  resetAppWorkspaceStore()
  const folder = { id: 1, name: "repo", path: "/repo" } as FolderDetail
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  vi.mocked(acpForkConversation).mockReset()
  vi.mocked(acpForkConversation).mockResolvedValue(FORKED)
})

describe("conversationForkBlock", () => {
  it("offers Fork on a conversation with a reply, between turns", () => {
    expect(conversationForkBlock(summary())).toBeNull()
  })

  it("has nothing to fork before the agent has a session", () => {
    expect(conversationForkBlock(summary({ external_id: null }))).toBe(
      "no_reply"
    )
  })

  it("is unavailable for an agent that can't fork", () => {
    expect(conversationForkBlock(summary({ agent_type: "gemini" }))).toBe(
      "unsupported"
    )
    expect(
      conversationForkBlock(summary({ agent_type: "codex" }), NO_CAPABILITIES)
    ).toBe("unsupported")
  })

  it("waits for a running turn only on agents that fork between turns", () => {
    const running = { turn_state: "running" as const, status: "in_progress" }
    expect(conversationForkBlock(summary(running))).toBeNull()
    expect(
      conversationForkBlock(summary({ ...running, agent_type: "codex" }))
    ).toBe("turn_running")
    // What the agent's adapter said wins over the built-in expectation.
    expect(
      conversationForkBlock(summary({ ...running, agent_type: "pi" }), {
        supportsFork: true,
        forkStrictPoint: true,
        forkWhileRunning: true,
      })
    ).toBeNull()
  })
})

describe("forkRefusal", () => {
  it("names the backend's refusals, as text or as an error object", () => {
    expect(forkRefusal("this agent can only fork between turns")).toBe(
      "turn_running"
    )
    expect(forkRefusal(new ForkBetweenTurnsOnlyError())).toBe("turn_running")
    expect(
      forkRefusal({ message: "this agent cannot fork a conversation" })
    ).toBe("unsupported")
    expect(
      forkRefusal("this conversation has no finished reply to fork yet")
    ).toBe("no_reply")
  })

  it("leaves a failure a failure", () => {
    expect(forkRefusal(new Error("agent exited"))).toBeNull()
    expect(forkRefusal(null)).toBeNull()
  })
})

describe("forkTabAnchor", () => {
  it("is the conversation's own tab, else the active one", () => {
    useTabStore.setState({
      rawTabs: [tab(7), tab(9)],
      activeTabId: tab(9).id,
    })
    expect(forkTabAnchor(7)).toBe(tab(7).id)
    expect(forkTabAnchor(5)).toBe(tab(9).id)
  })
})

describe("forkConversation", () => {
  beforeEach(() => {
    useTabStore.setState({
      rawTabs: [tab(7), tab(9)],
      activeTabId: tab(9).id,
    })
  })

  it("forks by conversation id and opens the fork beside its tab, focused", async () => {
    let placeholdersDuring = -1
    let forkingDuring = false
    vi.mocked(acpForkConversation).mockImplementation(async () => {
      placeholdersDuring =
        useForkPlaceholderStore.getState().placeholders.length
      forkingDuring = isForkingConversation(7)
      return FORKED
    })
    const onNewConversation = vi.fn(() => {
      // The list refreshes before the tab opens.
      expect(useTabStore.getState().activeTabId).toBe(tab(9).id)
    })

    await forkConversation({
      conversationId: 7,
      agentType: "claude_code",
      besideTabId: tab(7).id,
      onNewConversation,
    })

    expect(acpForkConversation).toHaveBeenCalledWith(7)
    expect(placeholdersDuring).toBe(1)
    expect(forkingDuring).toBe(true)
    expect(onNewConversation).toHaveBeenCalledWith(FORKED)
    const { rawTabs, activeTabId } = useTabStore.getState()
    expect(rawTabs.map((t) => t.conversationId)).toEqual([7, 42, 9])
    expect(activeTabId).toBe("conv-1-claude_code-42")
    expect(useForkPlaceholderStore.getState().placeholders).toEqual([])
    expect(isForkingConversation(7)).toBe(false)
  })

  it("leaves nothing behind when the fork fails", async () => {
    vi.mocked(acpForkConversation).mockRejectedValue(new Error("boom"))
    await expect(
      forkConversation({
        conversationId: 7,
        agentType: "claude_code",
        besideTabId: tab(7).id,
      })
    ).rejects.toThrow("boom")
    expect(useTabStore.getState().rawTabs.map((t) => t.conversationId)).toEqual(
      [7, 9]
    )
    expect(useForkPlaceholderStore.getState().placeholders).toEqual([])
    expect(isForkingConversation(7)).toBe(false)
  })

  it("remembers an agent that answers it can't fork", async () => {
    vi.mocked(acpForkConversation).mockRejectedValue(
      "this agent cannot fork a conversation"
    )
    await expect(
      forkConversation({
        conversationId: 7,
        agentType: "codex",
        besideTabId: null,
      })
    ).rejects.toBe("this agent cannot fork a conversation")
    expect(getRememberedCapabilities("codex")).toEqual(NO_CAPABILITIES)
    expect(conversationForkBlock(summary({ agent_type: "codex" }))).toBe(
      "unsupported"
    )
  })
})
