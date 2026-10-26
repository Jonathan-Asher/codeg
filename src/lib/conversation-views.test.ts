import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DbConversationSummary } from "@/lib/types"

const h = vi.hoisted(() => ({
  mark: vi.fn<(views: unknown) => Promise<void>>(async () => {}),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  markConversationsViewed: (views: unknown) => h.mark(views),
}))

const {
  flushConversationViews,
  noteConversationViewed,
  startConversationViewTracking,
  VIEW_REPORT_DELAY_MS,
} = await import("./conversation-views")
const { recentSessions } = await import("./recent-sessions")
const { selectRecentConversationsWithReuse } =
  await import("@/components/conversations/sidebar-conversation-grouping")
const { resetAppWorkspaceStore, useAppWorkspaceStore } =
  await import("@/stores/app-workspace-store")
const { useTabStore } = await import("@/stores/tab-store")

const T0 = Date.parse("2026-10-26T10:00:00.000Z")
const MIN = 60_000

function conv(
  id: number,
  updatedAt: number,
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `Session ${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
    pinned_at: null,
    parent_id: null,
    ...over,
  }
}

function seed(list: DbConversationSummary[]) {
  for (const c of [...list].reverse()) {
    useAppWorkspaceStore.getState().applyConversationUpsert(c)
  }
}

function row(id: number): DbConversationSummary {
  const found = useAppWorkspaceStore
    .getState()
    .conversations.find((c) => c.id === id)
  if (!found) throw new Error(`no row ${id}`)
  return found
}

const sidebarRecent = () =>
  selectRecentConversationsWithReuse(
    useAppWorkspaceStore.getState().conversations,
    true,
    "updated",
    new Set([1]),
    []
  ).map((c) => c.id)

const switcher = (current: number | null) =>
  recentSessions(useAppWorkspaceStore.getState().conversations, {
    knownFolderIds: new Set([1]),
    excludeId: current,
    limit: 10,
  }).map((c) => c.id)

function setTabs(activeConversationId: number | null, hydrated = true) {
  const tabs = [1, 2, 3].map((id) => ({
    id: `tab-${id}`,
    kind: "conversation",
    folderId: 1,
    agentType: "claude_code",
    conversationId: id,
  }))
  useTabStore.setState({
    tabsHydrated: hydrated,
    activeTabId:
      activeConversationId == null ? null : `tab-${activeConversationId}`,
    rawTabs: tabs,
    tabs,
  } as never)
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0 + 60 * MIN)
  await flushConversationViews()
  h.mark.mockClear()
  resetAppWorkspaceStore()
  useTabStore.setState({
    tabsHydrated: false,
    activeTabId: null,
    rawTabs: [],
    tabs: [],
  } as never)
  setVisibility("visible")
})

afterEach(() => {
  vi.useRealTimers()
})

describe("noteConversationViewed", () => {
  it("re-sorts this client's lists at once without touching activity", () => {
    // 3 is the freshest by activity; 1 is old.
    seed([conv(3, T0 + 30 * MIN), conv(2, T0 + 20 * MIN), conv(1, T0)])
    expect(sidebarRecent()).toEqual([3, 2, 1])

    noteConversationViewed(1, T0 + 50 * MIN)

    expect(row(1).updated_at).toBe(new Date(T0).toISOString())
    expect(row(1).last_viewed_at).toBe(new Date(T0 + 50 * MIN).toISOString())
    expect(sidebarRecent()).toEqual([1, 3, 2])
    expect(switcher(null)).toEqual([1, 3, 2])
  })

  it("reports a burst of views as one call, each as an age", async () => {
    seed([conv(1, T0), conv(2, T0)])
    const now = Date.now()
    noteConversationViewed(1, now)
    vi.advanceTimersByTime(200)
    noteConversationViewed(2, now + 200)
    vi.advanceTimersByTime(VIEW_REPORT_DELAY_MS - 1)
    expect(h.mark).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await vi.runAllTimersAsync()
    expect(h.mark).toHaveBeenCalledTimes(1)
    expect(h.mark).toHaveBeenCalledWith([
      { conversationId: 1, ageMs: 200 + VIEW_REPORT_DELAY_MS },
      { conversationId: 2, ageMs: VIEW_REPORT_DELAY_MS },
    ])
  })
})

describe("server rows and the local view", () => {
  it("keeps a local view newer than the row the server sent", () => {
    seed([conv(1, T0), conv(2, T0 + MIN)])
    noteConversationViewed(1, T0 + 10 * MIN)
    // An activity bump on 1 lands before this client's report did.
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(conv(1, T0 + 5 * MIN, { last_viewed_at: null }))
    expect(row(1).updated_at).toBe(new Date(T0 + 5 * MIN).toISOString())
    expect(row(1).last_viewed_at).toBe(new Date(T0 + 10 * MIN).toISOString())
  })

  it("re-sorts on another client's view and on new activity", () => {
    seed([conv(1, T0), conv(2, T0 + MIN), conv(3, T0 + 2 * MIN)])
    expect(sidebarRecent()).toEqual([3, 2, 1])

    // Opened on the phone.
    useAppWorkspaceStore.getState().applyConversationUpsert(
      conv(1, T0, {
        last_viewed_at: new Date(T0 + 10 * MIN).toISOString(),
      })
    )
    expect(sidebarRecent()).toEqual([1, 3, 2])
    expect(switcher(null)).toEqual([1, 3, 2])

    // A message from another session lands in 2.
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(conv(2, T0 + 20 * MIN))
    expect(sidebarRecent()).toEqual([2, 1, 3])
    // The switcher keeps the views first: 1 was opened, 2 never was.
    expect(switcher(null)).toEqual([1, 2, 3])
  })
})

describe("startConversationViewTracking", () => {
  const inline = { defer: (fn: () => void) => fn() }

  it("records a switch, not the tab restored when the tabs load", () => {
    seed([conv(1, T0), conv(2, T0), conv(3, T0)])
    const stop = startConversationViewTracking(inline)

    setTabs(1, false)
    setTabs(1) // hydrated with tab 1 restored
    expect(row(1).last_viewed_at).toBeUndefined()

    setTabs(2)
    expect(row(2).last_viewed_at).toBe(new Date(Date.now()).toISOString())
    stop()
  })

  it("records nothing while the active tab stays the same", () => {
    seed([conv(1, T0), conv(2, T0)])
    setTabs(1)
    const stop = startConversationViewTracking(inline)
    // Moving through the switcher's rows or hovering changes no tab; other
    // tab-store writes leave the active conversation where it was.
    useTabStore.setState({ previewReplacedTabIds: [] } as never)
    setTabs(1)
    expect(row(1).last_viewed_at).toBeUndefined()
    expect(row(2).last_viewed_at).toBeUndefined()
    stop()
  })

  it("Alt-Tab: the switcher's first row is the session viewed before", () => {
    seed([conv(1, T0), conv(2, T0), conv(3, T0)])
    setTabs(1)
    const stop = startConversationViewTracking(inline)

    setTabs(2)
    vi.advanceTimersByTime(MIN)
    setTabs(3)
    // A background agent touches 1 meanwhile.
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(conv(1, Date.now() + MIN))
    expect(switcher(3)[0]).toBe(2)

    vi.advanceTimersByTime(100)
    setTabs(2) // ⌘K, Enter
    expect(switcher(2)[0]).toBe(3)
    stop()
  })

  it("counts a switch made while hidden once the page is shown", () => {
    seed([conv(1, T0), conv(2, T0)])
    setTabs(1)
    const stop = startConversationViewTracking(inline)

    setVisibility("hidden")
    setTabs(2)
    expect(row(2).last_viewed_at).toBeUndefined()

    setVisibility("visible")
    expect(row(2).last_viewed_at).toBe(new Date(Date.now()).toISOString())
    stop()
  })

  it("reports what is queued when stopped", async () => {
    seed([conv(1, T0), conv(2, T0)])
    setTabs(1)
    const stop = startConversationViewTracking(inline)
    setTabs(2)
    stop()
    await vi.runAllTimersAsync()
    expect(h.mark).toHaveBeenCalledWith([{ conversationId: 2, ageMs: 0 }])
  })
})
