import { describe, expect, it, vi } from "vitest"

import {
  notificationGroupKey,
  openNotificationTarget,
  openNotificationTargetFromClick,
  parseNotificationTarget,
  setNotificationClickHandler,
  type NotificationOpenDeps,
  type NotificationTarget,
} from "./notification-target"

const TARGET: NotificationTarget = {
  contextKey: "conv-4-claude_code-17",
  folderId: 4,
  conversationId: 17,
  agentType: "claude_code",
}

function deps(
  overrides: Partial<NotificationOpenDeps> & {
    tabs?: Record<string, { conversationId: number | null }>
  } = {}
) {
  const tabs = overrides.tabs ?? {}
  return {
    findTab: vi.fn((id: string) => tabs[id] ?? null),
    switchTab: vi.fn(),
    conversationExists: vi.fn(async () => true),
    openConversation: vi.fn(),
    onMissing: vi.fn(),
    ...overrides,
  }
}

describe("openNotificationTarget", () => {
  it("switches to the session's own tab when it is still open", async () => {
    const d = deps({ tabs: { [TARGET.contextKey!]: { conversationId: 17 } } })
    await expect(openNotificationTarget(TARGET, d)).resolves.toBe("tab")
    expect(d.switchTab).toHaveBeenCalledWith("conv-4-claude_code-17")
    expect(d.openConversation).not.toHaveBeenCalled()
    expect(d.onMissing).not.toHaveBeenCalled()
  })

  it("switches to a draft's tab, which has no conversation yet", async () => {
    const draft = { ...TARGET, contextKey: "new-1", conversationId: null }
    const d = deps({ tabs: { "new-1": { conversationId: null } } })
    await expect(openNotificationTarget(draft, d)).resolves.toBe("tab")
    expect(d.switchTab).toHaveBeenCalledWith("new-1")
  })

  it("reopens the conversation when its tab was closed", async () => {
    const d = deps()
    await expect(openNotificationTarget(TARGET, d)).resolves.toBe(
      "conversation"
    )
    expect(d.conversationExists).toHaveBeenCalledWith(17)
    expect(d.openConversation).toHaveBeenCalledWith(4, 17, "claude_code")
    expect(d.switchTab).not.toHaveBeenCalled()
  })

  // The remote-workspace case: the backend rebuilt the closed remote window
  // for the click, so none of the old tabs exist — the conversation still
  // opens there.
  it("opens the conversation in a rebuilt window whose tabs are all new", async () => {
    const d = deps({ tabs: { "conv-1-codex-3": { conversationId: 3 } } })
    await expect(openNotificationTarget(TARGET, d)).resolves.toBe(
      "conversation"
    )
    expect(d.openConversation).toHaveBeenCalledWith(4, 17, "claude_code")
  })

  it("does not trust a tab that shows another conversation now", async () => {
    const d = deps({ tabs: { [TARGET.contextKey!]: { conversationId: 99 } } })
    await expect(openNotificationTarget(TARGET, d)).resolves.toBe(
      "conversation"
    )
    expect(d.switchTab).not.toHaveBeenCalled()
  })

  it("says so when the conversation was deleted since", async () => {
    const d = deps({ conversationExists: vi.fn(async () => false) })
    await expect(openNotificationTarget(TARGET, d)).resolves.toBe("missing")
    expect(d.onMissing).toHaveBeenCalledTimes(1)
    expect(d.openConversation).not.toHaveBeenCalled()
  })

  it("says so when a draft's tab was closed", async () => {
    const draft = { ...TARGET, contextKey: "new-1", conversationId: null }
    const d = deps()
    await expect(openNotificationTarget(draft, d)).resolves.toBe("missing")
    expect(d.onMissing).toHaveBeenCalledTimes(1)
    expect(d.conversationExists).not.toHaveBeenCalled()
  })
})

describe("parseNotificationTarget", () => {
  it("reads what the backend hands back", () => {
    expect(parseNotificationTarget({ ...TARGET })).toEqual(TARGET)
    expect(
      parseNotificationTarget({ conversationId: 5, folderId: null })
    ).toEqual({
      contextKey: null,
      folderId: null,
      conversationId: 5,
      agentType: null,
    })
  })

  it("rejects anything that names no session", () => {
    expect(parseNotificationTarget(null)).toBeNull()
    expect(parseNotificationTarget("conv-1")).toBeNull()
    expect(parseNotificationTarget({ folderId: 4 })).toBeNull()
    expect(
      parseNotificationTarget({ contextKey: "", conversationId: "17" })
    ).toBeNull()
  })
})

describe("notificationGroupKey", () => {
  it("is one key per session", () => {
    expect(notificationGroupKey(TARGET)).toBe(
      notificationGroupKey({ ...TARGET, contextKey: "canvas-card-2" })
    )
    expect(notificationGroupKey(TARGET)).not.toBe(
      notificationGroupKey({ ...TARGET, conversationId: 18 })
    )
    expect(
      notificationGroupKey({
        ...TARGET,
        contextKey: "new-1",
        conversationId: null,
      })
    ).toBe("codeg-session-knew-1")
  })
})

describe("click dispatch", () => {
  it("reaches the registered handler, and nothing after it unregisters", () => {
    const handler = vi.fn()
    const off = setNotificationClickHandler(handler)
    openNotificationTargetFromClick(TARGET)
    expect(handler).toHaveBeenCalledWith(TARGET)

    off()
    openNotificationTargetFromClick(TARGET)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("an older bridge unmounting does not drop a newer one's handler", () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = setNotificationClickHandler(first)
    const offSecond = setNotificationClickHandler(second)
    offFirst()
    openNotificationTargetFromClick(TARGET)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    offSecond()
  })
})
