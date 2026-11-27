import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  hasOpenMessageEdit,
  resetOpenMessageEditsForTests,
} from "@/lib/open-message-edits"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { useTrackOpenMessageEdit } from "./use-track-open-message-edit"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const TAB = "conv-1-claude_code-1"

function seed(isPinned: boolean) {
  useTabStore.setState({
    rawTabs: [
      {
        id: TAB,
        kind: "conversation",
        folderId: 1,
        conversationId: 1,
        agentType: "claude_code",
        title: "t1",
        isPinned,
      },
    ],
    activeTabId: TAB,
  })
}

beforeEach(() => {
  resetTabStore()
  resetOpenMessageEditsForTests()
})

describe("useTrackOpenMessageEdit", () => {
  it("records the tab while an editor is open in its list", () => {
    seed(true)
    const { result } = renderHook(() => useTrackOpenMessageEdit(TAB))
    act(() => result.current(true))
    expect(hasOpenMessageEdit(TAB)).toBe(true)
    act(() => result.current(false))
    expect(hasOpenMessageEdit(TAB)).toBe(false)
  })

  it("keeps a preview that opens an editor", () => {
    seed(false)
    const { result } = renderHook(() => useTrackOpenMessageEdit(TAB))
    act(() => result.current(true))
    expect(useTabStore.getState().rawTabs[0].isPinned).toBe(true)
  })

  it("holds the record while a second list of the tab still has one open", () => {
    seed(true)
    const first = renderHook(() => useTrackOpenMessageEdit(TAB))
    const second = renderHook(() => useTrackOpenMessageEdit(TAB))
    act(() => first.result.current(true))
    act(() => second.result.current(true))
    act(() => first.result.current(false))
    expect(hasOpenMessageEdit(TAB)).toBe(true)
    act(() => second.result.current(false))
    expect(hasOpenMessageEdit(TAB)).toBe(false)
  })
})
