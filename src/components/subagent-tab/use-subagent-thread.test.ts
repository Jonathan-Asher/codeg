import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as api from "@/lib/api"
import type { ClaudeSubagentThread, DbConversationSummary } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import {
  makeSubagentTabId,
  resetTabStore,
  useTabStore,
  type SubagentTabTarget,
} from "@/stores/tab-store"
import {
  SUBAGENT_FILE_WAIT_MS,
  SUBAGENT_REFRESH_MS,
  useSubagentThread,
} from "./use-subagent-thread"

vi.mock("@/lib/api", () => ({
  getClaudeSubagentThread: vi.fn(),
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const TARGET: SubagentTabTarget = {
  parentConversationId: 7,
  toolCallId: "toolu_01",
  subagentType: "Explore",
}
const TAB = makeSubagentTabId(7, "toolu_01")
const RUNTIME = -4242
const AT = new Date(1_700_000_000_000).toISOString()

function thread(running: boolean, turns: number): ClaudeSubagentThread {
  return {
    agent_id: "a1b2c3d4",
    subagent_type: "Explore",
    description: "Find the bug",
    running,
    parent_title: "Parent session",
    detail: {
      summary: {
        id: 7,
        folder_id: 1,
        title: "Find the bug",
        agent_type: "claude_code",
        status: running ? "in_progress" : "completed",
        external_id: null,
        message_count: turns,
        created_at: AT,
        updated_at: AT,
      } as unknown as DbConversationSummary,
      turns: Array.from({ length: turns }, (_, i) => ({
        id: `t${i}`,
        role: i === 0 ? ("user" as const) : ("assistant" as const),
        blocks: [{ type: "text" as const, text: `turn ${i}` }],
        timestamp: AT,
      })),
    },
  }
}

const calls = () => vi.mocked(api.getClaudeSubagentThread).mock.calls

/** Let the pending read land. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(api.getClaudeSubagentThread).mockReset()
  resetConversationRuntimeStore()
  resetTabStore()
  useTabStore.setState({
    rawTabs: [
      {
        id: TAB,
        kind: "subagent",
        folderId: 1,
        conversationId: null,
        agentType: "claude_code",
        title: "Explore",
        isPinned: false,
        subagent: TARGET,
      },
    ],
    activeTabId: TAB,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("reading a sub-agent's thread for its tab", () => {
  it("shows the thread and keeps reading while it runs, then stops", async () => {
    vi.mocked(api.getClaudeSubagentThread)
      .mockResolvedValueOnce(thread(true, 2))
      .mockResolvedValueOnce(thread(true, 3))
      .mockResolvedValue(thread(false, 4))
    const { result } = renderHook(() =>
      useSubagentThread({
        tabId: TAB,
        target: TARGET,
        runtimeId: RUNTIME,
        visible: true,
      })
    )
    await settle()
    expect(result.current).toMatchObject({
      status: "ready",
      running: true,
      parentTitle: "Parent session",
      subagentType: "Explore",
    })
    const session = () =>
      useConversationRuntimeStore.getState().byConversationId.get(RUNTIME)
    expect(session()?.detail?.turns).toHaveLength(2)
    // The tab learned its sub-agent's id, title and state.
    expect(useTabStore.getState().rawTabs[0]).toMatchObject({
      title: "Find the bug",
      status: "in_progress",
      subagent: { agentId: "a1b2c3d4" },
    })

    await settle(SUBAGENT_REFRESH_MS)
    expect(session()?.detail?.turns).toHaveLength(3)
    // The id the first read learned goes straight to the file.
    expect(calls()[1]).toEqual([7, "toolu_01", "a1b2c3d4"])

    await settle(SUBAGENT_REFRESH_MS)
    expect(result.current.running).toBe(false)
    expect(session()?.detail?.turns).toHaveLength(4)
    expect(useTabStore.getState().rawTabs[0].status).toBe("completed")
    const settledReads = calls().length
    await settle(SUBAGENT_REFRESH_MS * 3)
    expect(calls()).toHaveLength(settledReads)
  })

  it("waits for a transcript not written yet, and says when none came", async () => {
    vi.mocked(api.getClaudeSubagentThread).mockResolvedValue(null)
    const { result } = renderHook(() =>
      useSubagentThread({
        tabId: TAB,
        target: TARGET,
        runtimeId: RUNTIME,
        visible: true,
      })
    )
    await settle()
    expect(result.current.status).toBe("waiting")
    await settle(SUBAGENT_FILE_WAIT_MS + SUBAGENT_REFRESH_MS)
    expect(result.current.status).toBe("missing")
    const reads = calls().length
    await settle(SUBAGENT_REFRESH_MS * 3)
    expect(calls()).toHaveLength(reads)
  })

  it("reads nothing while its tab is hidden, and reads once it shows", async () => {
    vi.mocked(api.getClaudeSubagentThread).mockResolvedValue(thread(false, 1))
    const { rerender, result } = renderHook(
      ({ visible }) =>
        useSubagentThread({
          tabId: TAB,
          target: TARGET,
          runtimeId: RUNTIME,
          visible,
        }),
      { initialProps: { visible: false } }
    )
    await settle(SUBAGENT_REFRESH_MS * 2)
    expect(calls()).toHaveLength(0)
    rerender({ visible: true })
    await settle()
    expect(calls()).toHaveLength(1)
    expect(result.current.status).toBe("ready")
  })

  it("drops its session when the tab goes", async () => {
    vi.mocked(api.getClaudeSubagentThread).mockResolvedValue(thread(false, 1))
    const { unmount } = renderHook(() =>
      useSubagentThread({
        tabId: TAB,
        target: TARGET,
        runtimeId: RUNTIME,
        visible: true,
      })
    )
    await settle()
    expect(
      useConversationRuntimeStore.getState().byConversationId.has(RUNTIME)
    ).toBe(true)
    unmount()
    expect(
      useConversationRuntimeStore.getState().byConversationId.has(RUNTIME)
    ).toBe(false)
  })
})
