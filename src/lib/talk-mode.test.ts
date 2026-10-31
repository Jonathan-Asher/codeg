import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ setConversationTalkMode: vi.fn() }))

vi.mock("@/lib/api", () => ({
  setConversationTalkMode: h.setConversationTalkMode,
}))

import { setTalkMode } from "./talk-mode"
import type { DbConversationSummary } from "./types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

function row(over: Partial<DbConversationSummary> = {}): DbConversationSummary {
  return {
    id: 7,
    folder_id: 3,
    title: "Deploy fix",
    title_locked: false,
    agent_type: "open_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:30:00.000Z",
    pinned_at: null,
    ...over,
  }
}

const stored = () => useAppWorkspaceStore.getState().conversations[0]

beforeEach(() => {
  h.setConversationTalkMode.mockReset()
})

afterEach(() => {
  useAppWorkspaceStore.setState({ conversations: [] })
})

describe("setTalkMode", () => {
  it("turns Talk on at once and calls the backend", async () => {
    useAppWorkspaceStore.setState({ conversations: [row()] })
    h.setConversationTalkMode.mockResolvedValue(undefined)
    const pending = setTalkMode(7, true)
    expect(stored().talk_mode).toBe(true)
    await pending
    expect(h.setConversationTalkMode).toHaveBeenCalledWith(7, true)
    // Not activity: the row keeps its place in an updated-sorted list.
    expect(stored().updated_at).toBe("2026-10-01T09:30:00.000Z")
  })

  it("turns off a Talk a phone left on", async () => {
    useAppWorkspaceStore.setState({ conversations: [row({ talk_mode: true })] })
    h.setConversationTalkMode.mockResolvedValue(undefined)
    await setTalkMode(7, false)
    expect(stored().talk_mode).toBe(false)
    expect(h.setConversationTalkMode).toHaveBeenCalledWith(7, false)
  })

  it("puts the row back when the backend refuses", async () => {
    useAppWorkspaceStore.setState({ conversations: [row({ talk_mode: true })] })
    h.setConversationTalkMode.mockRejectedValue(new Error("not_found"))
    const pending = setTalkMode(7, false)
    expect(stored().talk_mode).toBe(false)
    await expect(pending).rejects.toThrow("not_found")
    expect(stored().talk_mode).toBe(true)
  })

  it("reads a row from an older server, which has no field, as off", async () => {
    useAppWorkspaceStore.setState({ conversations: [row()] })
    h.setConversationTalkMode.mockRejectedValue(new Error("unknown command"))
    await expect(setTalkMode(7, true)).rejects.toThrow("unknown command")
    expect(stored().talk_mode).toBe(false)
  })

  it("still asks the backend for a conversation this window has no row for", async () => {
    h.setConversationTalkMode.mockResolvedValue(undefined)
    await setTalkMode(9, true)
    expect(h.setConversationTalkMode).toHaveBeenCalledWith(9, true)
    expect(useAppWorkspaceStore.getState().conversations).toEqual([])
  })
})
