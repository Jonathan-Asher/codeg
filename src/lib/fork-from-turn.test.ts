import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  acpFork: vi.fn(),
  acpForkToNewConversation: vi.fn(),
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

import { acpFork, acpForkToNewConversation } from "@/lib/api"
import type { ForkToNewConversationResult } from "@/lib/api"
import { TurnBusyError } from "@/lib/turn-busy"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetTabStore,
  useTabStore,
  type TabItemInternal,
} from "@/stores/tab-store"
import {
  ForkBetweenTurnsOnlyError,
  forkFromTurn,
  isForkNeedsIdleRejection,
  openForkedConversationTab,
  supportsForkWhileRunning,
} from "./fork-from-turn"

const FORKED: ForkToNewConversationResult = {
  forkedSessionId: "session-S2",
  originalSessionId: "session-S1",
  conversationId: 42,
  folderId: 1,
  title: "[Fork] Topic",
}

const base = {
  connectionId: "conn-1",
  conversationId: 7,
  folderId: 1,
  turnId: "turn-1",
} as const

beforeEach(() => {
  vi.mocked(acpFork).mockReset()
  vi.mocked(acpFork).mockResolvedValue({
    forkedSessionId: "session-S2",
    originalSessionId: "session-S1",
    siblingConversationId: 8,
  })
  vi.mocked(acpForkToNewConversation).mockReset()
  vi.mocked(acpForkToNewConversation).mockResolvedValue(FORKED)
})

describe("which agents fork while a turn runs", () => {
  it("is Claude Code only, mirroring forks_while_running", () => {
    expect(supportsForkWhileRunning("claude_code")).toBe(true)
    for (const agent of ["codex", "deepseek", "pi", "gemini"] as const) {
      expect(supportsForkWhileRunning(agent)).toBe(false)
    }
  })
})

describe("forkFromTurn", () => {
  it("forks in place between turns, exactly as before", async () => {
    const outcome = await forkFromTurn({
      ...base,
      agentType: "claude_code",
      turnRunning: false,
    })
    expect(outcome).toEqual({ kind: "in_place", forkedSessionId: "session-S2" })
    expect(acpFork).toHaveBeenCalledWith("conn-1", 7, 1, "turn-1")
    expect(acpForkToNewConversation).not.toHaveBeenCalled()
  })

  it("forks a running Claude Code session into a new conversation", async () => {
    const outcome = await forkFromTurn({
      ...base,
      agentType: "claude_code",
      turnRunning: true,
    })
    expect(outcome).toEqual({ kind: "new_conversation", result: FORKED })
    expect(acpForkToNewConversation).toHaveBeenCalledWith("conn-1", 7, "turn-1")
    // The in-place fork would have to wait for the turn — never tried.
    expect(acpFork).not.toHaveBeenCalled()
  })

  it("tells an agent that forks only between turns to wait", async () => {
    await expect(
      forkFromTurn({ ...base, agentType: "codex", turnRunning: true })
    ).rejects.toBeInstanceOf(ForkBetweenTurnsOnlyError)
    expect(acpFork).not.toHaveBeenCalled()
    expect(acpForkToNewConversation).not.toHaveBeenCalled()
  })

  it("forks into a new conversation when a turn started under the click", async () => {
    // The surface saw no turn, the backend did: the in-place fork bounces,
    // and the click lands where a mid-turn click would have.
    vi.mocked(acpFork).mockRejectedValueOnce(new TurnBusyError())
    const outcome = await forkFromTurn({
      ...base,
      agentType: "claude_code",
      turnRunning: false,
    })
    expect(outcome).toEqual({ kind: "new_conversation", result: FORKED })
  })

  it("and says why when that agent has to wait", async () => {
    vi.mocked(acpFork).mockRejectedValueOnce(new TurnBusyError())
    await expect(
      forkFromTurn({ ...base, agentType: "deepseek", turnRunning: false })
    ).rejects.toBeInstanceOf(ForkBetweenTurnsOnlyError)
    expect(acpForkToNewConversation).not.toHaveBeenCalled()
  })

  it("reads the backend's own refusal the same way", async () => {
    // Tauri rejects with the error's Display string.
    vi.mocked(acpForkToNewConversation).mockRejectedValueOnce(
      "this agent can only fork between turns"
    )
    await expect(
      forkFromTurn({ ...base, agentType: "claude_code", turnRunning: true })
    ).rejects.toBeInstanceOf(ForkBetweenTurnsOnlyError)
  })

  it("passes any other failure through", async () => {
    const failure = new Error("this reply is still being written")
    vi.mocked(acpForkToNewConversation).mockRejectedValueOnce(failure)
    await expect(
      forkFromTurn({ ...base, agentType: "claude_code", turnRunning: true })
    ).rejects.toBe(failure)
  })
})

describe("isForkNeedsIdleRejection", () => {
  it("matches both transports' shapes and nothing else", () => {
    expect(
      isForkNeedsIdleRejection("this agent can only fork between turns")
    ).toBe(true)
    expect(
      isForkNeedsIdleRejection({
        code: "invalid_input",
        message: "this agent can only fork between turns",
      })
    ).toBe(true)
    expect(isForkNeedsIdleRejection(new TurnBusyError())).toBe(false)
    expect(isForkNeedsIdleRejection(null)).toBe(false)
  })
})

describe("openForkedConversationTab", () => {
  const folder = { id: 1, name: "repo", path: "/repo" } as FolderDetail

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
    resetTabStore()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
    useTabStore.setState({
      rawTabs: [tab(7), tab(9)],
      activeTabId: tab(7).id,
    })
  })

  it("opens the fork in a new tab right beside the one it came from", () => {
    openForkedConversationTab(FORKED, "claude_code", tab(7).id)
    const { rawTabs, activeTabId } = useTabStore.getState()
    expect(rawTabs.map((t) => t.id)).toEqual([
      tab(7).id,
      "conv-1-claude_code-42",
      tab(9).id,
    ])
    const opened = rawTabs[1]
    expect(opened).toMatchObject({
      conversationId: 42,
      folderId: 1,
      agentType: "claude_code",
      title: "[Fork] Topic",
      isPinned: true,
    })
    // The fork takes focus; the running conversation keeps its own tab.
    expect(activeTabId).toBe("conv-1-claude_code-42")
  })

  it("appends it when the source tab is gone", () => {
    openForkedConversationTab(FORKED, "claude_code", "conv-1-claude_code-99")
    expect(useTabStore.getState().rawTabs.map((t) => t.id)).toEqual([
      tab(7).id,
      tab(9).id,
      "conv-1-claude_code-42",
    ])
  })
})
