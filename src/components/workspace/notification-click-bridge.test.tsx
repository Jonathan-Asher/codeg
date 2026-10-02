import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  openNotificationTargetFromClick,
  type NotificationTarget,
} from "@/lib/notification-target"
import {
  resetScrollToLatestIntents,
  takeScrollToLatest,
} from "@/lib/scroll-to-latest-intent"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import type { DbConversationSummary } from "@/lib/types"

const h = vi.hoisted(() => ({
  desktop: true,
  takePending: vi.fn<() => Promise<unknown[]>>(async () => []),
  pendingHandler: null as null | (() => void),
  toastInfo: vi.fn(),
  openConversations: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock("sonner", () => ({ toast: { info: h.toastInfo } }))
vi.mock("@/lib/transport", () => ({ isDesktop: () => h.desktop }))
vi.mock("@/lib/notification", () => ({
  takePendingNotificationOpens: () => h.takePending(),
  onNotificationOpenPending: async (cb: () => void) => {
    h.pendingHandler = cb
    return () => {
      h.pendingHandler = null
    }
  },
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => ({ openConversations: h.openConversations }),
}))

import { NotificationClickBridge } from "./notification-click-bridge"

const TARGET: NotificationTarget = {
  contextKey: "conv-4-claude_code-17",
  folderId: 4,
  conversationId: 17,
  agentType: "claude_code",
}

function conversation(id: number, folderId: number) {
  return {
    id,
    folder_id: folderId,
    agent_type: "claude_code",
    title: "t",
  } as unknown as DbConversationSummary
}

let openTab: ReturnType<typeof vi.fn>
let switchTab: ReturnType<typeof vi.fn>
let refreshConversations: ReturnType<typeof vi.fn>

function hydrate() {
  act(() => {
    useAppWorkspaceStore.setState({
      foldersHydrated: true,
      conversationsLoading: false,
    })
    useTabStore.setState({ tabsHydrated: true })
  })
}

beforeEach(() => {
  h.desktop = true
  h.takePending.mockReset()
  h.takePending.mockResolvedValue([])
  h.pendingHandler = null
  h.toastInfo.mockClear()
  h.openConversations.mockClear()
  resetScrollToLatestIntents()
  resetAppWorkspaceStore()
  resetTabStore()
  openTab = vi.fn()
  switchTab = vi.fn()
  refreshConversations = vi.fn(async () => {})
  useAppWorkspaceStore.setState({
    foldersHydrated: false,
    conversationsLoading: true,
    conversations: [conversation(17, 4)],
    refreshConversations,
  } as never)
  useTabStore.setState({
    tabsHydrated: false,
    tabs: [],
    openTab,
    switchTab,
  } as never)
})

afterEach(() => cleanup())

describe("NotificationClickBridge", () => {
  // The remote-workspace case end to end on this side: the backend rebuilt
  // the closed `remote-workspace-{id}` window for the click and parked the
  // session for it. The fresh window drains it on mount — before it has
  // loaded anything — and opens the conversation once it has.
  it("opens a session parked for a window that is still loading", async () => {
    h.takePending.mockResolvedValueOnce([TARGET])
    render(<NotificationClickBridge />)
    await waitFor(() => expect(h.takePending).toHaveBeenCalled())
    expect(openTab).not.toHaveBeenCalled()

    hydrate()

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(4, 17, "claude_code", true)
    )
    expect(h.openConversations).toHaveBeenCalled()
    expect(h.toastInfo).not.toHaveBeenCalled()
  })

  it("takes a click poked at a window that is already running", async () => {
    hydrate()
    useTabStore.setState({
      tabs: [{ id: TARGET.contextKey, conversationId: 17 }],
    } as never)
    render(<NotificationClickBridge />)
    await waitFor(() => expect(h.pendingHandler).not.toBeNull())

    h.takePending.mockResolvedValueOnce([TARGET])
    h.pendingHandler!()

    await waitFor(() =>
      expect(switchTab).toHaveBeenCalledWith("conv-4-claude_code-17")
    )
    expect(openTab).not.toHaveBeenCalled()
  })

  it("tells the user when the session no longer exists", async () => {
    hydrate()
    useAppWorkspaceStore.setState({ conversations: [] })
    h.takePending.mockResolvedValueOnce([TARGET])
    render(<NotificationClickBridge />)

    await waitFor(() =>
      expect(h.toastInfo).toHaveBeenCalledWith("sessionUnavailable")
    )
    // Looked again before giving up: a conversation made elsewhere since the
    // last refresh is not a deleted one.
    expect(refreshConversations).toHaveBeenCalledTimes(1)
    expect(openTab).not.toHaveBeenCalled()
    expect(switchTab).not.toHaveBeenCalled()
  })

  it("finds a conversation the refresh brings in", async () => {
    hydrate()
    useAppWorkspaceStore.setState({ conversations: [] })
    refreshConversations.mockImplementation(async () => {
      useAppWorkspaceStore.setState({ conversations: [conversation(17, 4)] })
    })
    h.takePending.mockResolvedValueOnce([TARGET])
    render(<NotificationClickBridge />)

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(4, 17, "claude_code", true)
    )
    expect(h.toastInfo).not.toHaveBeenCalled()
  })

  // A browser notification, or an in-app toast's title: the click happens in
  // this page and comes through the registered handler.
  it("answers a click raised in this page", async () => {
    h.desktop = false
    hydrate()
    useTabStore.setState({
      tabs: [{ id: TARGET.contextKey, conversationId: 17 }],
    } as never)
    render(<NotificationClickBridge />)

    act(() => openNotificationTargetFromClick(TARGET))

    await waitFor(() =>
      expect(switchTab).toHaveBeenCalledWith("conv-4-claude_code-17")
    )
    // No desktop backend to take parked clicks from.
    expect(h.takePending).not.toHaveBeenCalled()
  })

  // The session's own tab is open, maybe scrolled far up: its transcript is
  // asked for the latest message before the switch makes it the active one,
  // under its virtual runtime id too (a tab that began as a draft).
  it("asks an open tab's transcript for its latest message", async () => {
    h.desktop = false
    hydrate()
    useTabStore.setState({
      tabs: [
        {
          id: TARGET.contextKey,
          conversationId: 17,
          runtimeConversationId: -4,
        },
      ],
    } as never)
    let askedBeforeSwitch = false
    switchTab.mockImplementation(() => {
      askedBeforeSwitch = takeScrollToLatest([-4])
    })
    render(<NotificationClickBridge />)

    act(() => openNotificationTargetFromClick(TARGET))

    await waitFor(() => expect(switchTab).toHaveBeenCalled())
    expect(askedBeforeSwitch).toBe(true)
  })

  it("asks a reopened tab's transcript for its latest message", async () => {
    h.desktop = false
    hydrate()
    let askedBeforeOpen = false
    openTab.mockImplementation(() => {
      askedBeforeOpen = takeScrollToLatest([17])
    })
    render(<NotificationClickBridge />)

    act(() => openNotificationTargetFromClick(TARGET))

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(4, 17, "claude_code", true)
    )
    expect(askedBeforeOpen).toBe(true)
  })

  it("asks nothing of a session that is gone", async () => {
    hydrate()
    useAppWorkspaceStore.setState({ conversations: [] })
    h.takePending.mockResolvedValueOnce([TARGET])
    render(<NotificationClickBridge />)

    await waitFor(() => expect(h.toastInfo).toHaveBeenCalled())
    expect(takeScrollToLatest([17])).toBe(false)
  })

  it("stops answering clicks once unmounted", async () => {
    h.desktop = false
    hydrate()
    const { unmount } = render(<NotificationClickBridge />)
    unmount()

    openNotificationTargetFromClick(TARGET)
    await act(async () => {})
    expect(openTab).not.toHaveBeenCalled()
    expect(switchTab).not.toHaveBeenCalled()
  })
})
