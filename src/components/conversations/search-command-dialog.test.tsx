import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"
import type { MessageSearchHit } from "@/lib/api"
import { takePendingFind } from "@/lib/pending-find"
import {
  __resetQuickSwitchTypeaheadForTests,
  armQuickSwitchTypeahead,
  cancelQuickSwitchTypeahead,
} from "@/lib/quick-switch-typeahead"

const h = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  listAllConversations: vi.fn(),
  openTab: vi.fn(),
  openConversations: vi.fn(),
  resetFileTree: vi.fn(),
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

const warm = vi.hoisted(() => ({
  prefetchConversationDetail: vi.fn(),
  preconnectConversation: vi.fn(),
  cancelConversationPreconnect: vi.fn(),
}))

vi.mock("@/stores/conversation-runtime-store", () => ({
  prefetchConversationDetail: warm.prefetchConversationDetail,
  useConversationRuntimeStore: {
    getState: () => ({ byConversationId: new Map() }),
    subscribe: () => () => {},
  },
}))

vi.mock("@/lib/session-preconnect", () => ({
  preconnectConversation: warm.preconnectConversation,
  cancelConversationPreconnect: warm.cancelConversationPreconnect,
}))

vi.mock("@/lib/api", () => ({
  listAllConversations: h.listAllConversations,
  searchMessages: h.searchMessages,
}))

const tabState = vi.hoisted(() => ({
  tabs: [] as Array<{
    id: string
    kind: "conversation"
    folderId: number
    conversationId: number | null
    agentType: string
    title: string
    isPinned: boolean
  }>,
  activeTabId: null as string | null,
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: h.openTab }),
  useTabStore: (selector: (s: unknown) => unknown) => selector(tabState),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: h.openConversations }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: vi.fn() }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree: vi.fn() }),
}))

const folders = vi.hoisted(() => ({
  active: null as { id: number; name: string; path: string } | null,
  all: [
    { id: 3, name: "codeg", path: "/work/codeg" },
    { id: 5, name: "legalix", path: "/work/legalix" },
  ] as Array<{
    id: number
    name: string
    path: string
    archived?: boolean
    group_id?: number | null
  }>,
  groups: [] as Array<{ id: number; archived?: boolean }>,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: folders.active,
    activeFolderId: folders.active?.id ?? null,
  }),
}))

const store = vi.hoisted(() => ({ conversations: [] as unknown[] }))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      conversations: store.conversations,
      allFolders: folders.all,
      folderGroups: folders.groups,
    }),
}))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({ allFiles: [], loading: false, reset: h.resetFileTree }),
}))

function hit(over: Partial<MessageSearchHit> = {}): MessageSearchHit {
  return {
    conversation_id: 7,
    folder_id: 3,
    agent_type: "codex",
    title: "Upload fixes",
    turn_idx: 4,
    role: "assistant",
    snippet: "…the [[mark]]retry[[/mark]] [[mark]]loop[[/mark]] re-enters",
    rank: -1.5,
    ...over,
  }
}

/** A request whose resolution the test controls. */
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function openMessagesTab(onOpenChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SearchCommandDialog open onOpenChange={onOpenChange} />
    </NextIntlClientProvider>
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Messages" }))
  const input = screen.getByPlaceholderText("Search message content...")
  return { user, input }
}

describe("SearchCommandDialog messages tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    folders.active = null
    h.listAllConversations.mockResolvedValue([])
  })

  it("searches message content and highlights the matched words", async () => {
    h.searchMessages.mockResolvedValue([hit()])
    const { user, input } = await openMessagesTab()

    await user.type(input, "retry loop")

    expect(await screen.findByText("Upload fixes")).toBeTruthy()
    expect(h.searchMessages).toHaveBeenLastCalledWith("retry loop", 40)
    expect(screen.getByText("Assistant")).toBeTruthy()
    const marks = Array.from(document.querySelectorAll("mark"))
    expect(marks.map((mark) => mark.textContent)).toEqual(["retry", "loop"])
  })

  it("says the search failed instead of showing no results", async () => {
    h.searchMessages.mockRejectedValue(new Error("boom"))
    const { user, input } = await openMessagesTab()
    await user.type(input, "retry loop")
    expect(await screen.findByText("Search failed. Try again.")).toBeTruthy()

    // A request that never got an answer reads as offline.
    h.searchMessages.mockRejectedValue(new TypeError("Failed to fetch"))
    await user.type(input, "s")
    expect(
      await screen.findByText("Offline — search needs the server")
    ).toBeTruthy()
    expect(screen.queryByText("No results found.")).toBeNull()
  })

  it("keeps the cursor in the search box when the tab changes", async () => {
    h.searchMessages.mockResolvedValue([hit()])
    const { user, input } = await openMessagesTab()

    expect(input).toHaveFocus()
    await user.keyboard("retry")

    expect(input).toHaveValue("retry")
    expect(await screen.findByText("Upload fixes")).toBeTruthy()
  })

  it("opens the conversation of the picked hit with find prefilled", async () => {
    h.searchMessages.mockResolvedValue([hit()])
    const onOpenChange = vi.fn()
    const { user, input } = await openMessagesTab(onOpenChange)

    await user.type(input, "retry")
    await user.click(await screen.findByText("Upload fixes"))

    expect(h.openConversations).toHaveBeenCalled()
    expect(h.openTab).toHaveBeenCalledWith(3, 7, "codex", true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(takePendingFind(7)).toBe("retry")
  })

  it("keeps the newest query's hits when an earlier answer arrives late", async () => {
    const earlier = defer<MessageSearchHit[]>()
    h.searchMessages
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValueOnce([hit({ title: "Newer answer" })])
    const { user, input } = await openMessagesTab()

    await user.type(input, "retry")
    await waitFor(() => expect(h.searchMessages).toHaveBeenCalledTimes(1))
    await user.type(input, " loop")
    expect(await screen.findByText("Newer answer")).toBeTruthy()

    await act(async () => {
      earlier.resolve([hit({ title: "Older answer" })])
      await earlier.promise
    })

    expect(screen.queryByText("Older answer")).toBeNull()
    expect(screen.getByText("Newer answer")).toBeTruthy()
  })
})

function conv(
  id: number,
  folderId: number,
  title: string,
  over: Record<string, unknown> = {}
) {
  return {
    id,
    folder_id: folderId,
    title,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    parent_id: null,
    created_at: "2026-09-30T10:00:00Z",
    updated_at: "2026-09-30T10:00:00Z",
    ...over,
  }
}

describe("SearchCommandDialog conversations tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    folders.active = folders.all[0]
    store.conversations = []
    tabState.tabs = []
    tabState.activeTabId = null
  })

  function renderDialog() {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog open onOpenChange={vi.fn()} />
      </NextIntlClientProvider>
    )
    return userEvent.setup()
  }

  it("searches every folder by default and names each result's folder", async () => {
    h.listAllConversations.mockResolvedValue([
      conv(1, 3, "Upload fixes"),
      conv(2, 5, "Upload the brief"),
    ])
    const user = renderDialog()

    await user.type(
      screen.getByPlaceholderText("Search conversations..."),
      "upload"
    )

    expect(await screen.findByText("Upload the brief")).toBeTruthy()
    expect(h.listAllConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ folder_ids: null, search: "upload" })
    )
    expect(screen.getByText("legalix")).toBeTruthy()
  })

  it("narrows to the open folder on request", async () => {
    h.listAllConversations.mockResolvedValue([conv(1, 3, "Upload fixes")])
    const user = renderDialog()

    await user.click(screen.getByRole("button", { name: "Only codeg" }))
    await user.type(
      screen.getByPlaceholderText("Search conversations..."),
      "upload"
    )

    await waitFor(() =>
      expect(h.listAllConversations).toHaveBeenLastCalledWith(
        expect.objectContaining({ folder_ids: [3], search: "upload" })
      )
    )
  })
})

describe("SearchCommandDialog recent sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    folders.active = folders.all[0]
    h.listAllConversations.mockResolvedValue([])
    store.conversations = [
      conv(1, 3, "Release prep", { updated_at: "2026-09-30T10:00:00Z" }),
      conv(2, 5, "Legal brief", {
        agent_type: "codex",
        updated_at: "2026-09-30T11:00:00Z",
      }),
      conv(3, 3, "Older codeg work", { updated_at: "2026-09-30T09:00:00Z" }),
      conv(4, 3, "Delegated subtask", {
        parent_id: 1,
        kind: "delegate",
        updated_at: "2026-09-30T12:00:00Z",
      }),
    ]
    tabState.tabs = [
      {
        id: "tab-1",
        kind: "conversation",
        folderId: 3,
        conversationId: 1,
        agentType: "claude_code",
        title: "Release prep",
        isPinned: true,
      },
    ]
    tabState.activeTabId = "tab-1"
  })

  function renderDialog(onOpenChange = vi.fn()) {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog open onOpenChange={onOpenChange} />
      </NextIntlClientProvider>
    )
    return { user: userEvent.setup(), onOpenChange }
  }

  /** Each listed row's title, top to bottom, and which one is selected. */
  function rows() {
    const options = screen.queryAllByRole("option")
    return {
      titles: options.map(
        (o) => o.querySelector("span.flex-1")?.textContent ?? ""
      ),
      selected: options.findIndex(
        (o) => o.getAttribute("aria-selected") === "true"
      ),
    }
  }

  it("leaves the current session out and selects the previous one", async () => {
    renderDialog()

    await waitFor(() => expect(rows().selected).toBe(0))
    expect(rows().titles).toEqual(["Legal brief", "Older codeg work"])
    expect(screen.queryByText("Release prep")).toBeNull()
    expect(screen.getByText("Recent")).toBeTruthy()
    expect(screen.getByText("legalix")).toBeTruthy()
    expect(screen.queryByText("Delegated subtask")).toBeNull()
  })

  it("switches back to the previous session with Enter alone", async () => {
    const { user, onOpenChange } = renderDialog()
    await waitFor(() => expect(rows().selected).toBe(0))

    await user.keyboard("{Enter}")

    expect(h.openTab).toHaveBeenCalledWith(5, 2, "codex", true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("reaches the next older session with one arrow down", async () => {
    const { user } = renderDialog()
    await waitFor(() => expect(rows().selected).toBe(0))

    await user.keyboard("{ArrowDown}")
    await waitFor(() => expect(rows().selected).toBe(1))
    await user.keyboard("{Enter}")

    expect(h.openTab).toHaveBeenCalledWith(3, 3, "claude_code", true)
  })

  it("keeps the current session out of search results too", async () => {
    h.listAllConversations.mockResolvedValue([
      conv(1, 3, "Release prep"),
      conv(7, 3, "Release notes"),
    ])
    const { user } = renderDialog()

    await user.type(
      screen.getByPlaceholderText("Search conversations..."),
      "release"
    )

    expect(await screen.findByText("Release notes")).toBeTruthy()
    expect(screen.queryByText("Release prep")).toBeNull()
    await waitFor(() => expect(rows().selected).toBe(0))
    expect(rows().titles).toEqual(["Release notes"])
  })

  it("shows no results when the current session is the only match", async () => {
    h.listAllConversations.mockResolvedValue([conv(1, 3, "Release prep")])
    const { user } = renderDialog()

    await user.type(
      screen.getByPlaceholderText("Search conversations..."),
      "release prep"
    )

    expect(await screen.findByText("No results found.")).toBeTruthy()
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })

  it("shows search results while typing and the recent list once cleared", async () => {
    h.listAllConversations.mockResolvedValue([conv(7, 3, "Upload fixes")])
    const { user } = renderDialog()
    const input = screen.getByPlaceholderText("Search conversations...")

    await user.type(input, "upload")
    expect(await screen.findByText("Upload fixes")).toBeTruthy()
    expect(screen.queryByText("Legal brief")).toBeNull()
    expect(screen.queryByText("Recent")).toBeNull()

    await user.clear(input)
    expect(await screen.findByText("Legal brief")).toBeTruthy()
    expect(screen.queryByText("Upload fixes")).toBeNull()
    await waitFor(() => expect(rows().selected).toBe(0))
    expect(rows().titles[0]).toBe("Legal brief")
  })

  it("lists only the open folder's recent sessions when scoped", async () => {
    const { user } = renderDialog()
    await waitFor(() => expect(rows().titles).toContain("Legal brief"))

    await user.click(screen.getByRole("button", { name: "Only codeg" }))

    expect(rows().titles).toEqual(["Older codeg work"])
  })

  it("waits for a query as before when the setting is off", async () => {
    localStorage.setItem("settings:search:show-recent", "false")
    renderDialog()

    expect(screen.getByText("Type to search conversations")).toBeTruthy()
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(screen.queryByText("Release prep")).toBeNull()
  })

  it("lists recent sessions alone, first selected, with no conversation tab active", async () => {
    tabState.activeTabId = null
    renderDialog()

    await waitFor(() => expect(rows().selected).toBe(0))
    expect(rows().titles).toEqual([
      "Legal brief",
      "Release prep",
      "Older codeg work",
    ])
  })
})

describe("SearchCommandDialog archived folders", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    folders.active = folders.all[0]
    // legalix is archived through its group.
    folders.all = [
      { id: 3, name: "codeg", path: "/work/codeg" },
      { id: 5, name: "legalix", path: "/work/legalix", group_id: 9 },
    ]
    folders.groups = [{ id: 9, archived: true }]
    h.listAllConversations.mockResolvedValue([])
    store.conversations = [
      conv(1, 3, "Release prep", { updated_at: "2026-09-30T10:00:00Z" }),
      conv(2, 5, "Legal brief", { updated_at: "2026-09-30T11:00:00Z" }),
    ]
    tabState.tabs = []
    tabState.activeTabId = null
  })

  afterEach(() => {
    folders.all = [
      { id: 3, name: "codeg", path: "/work/codeg" },
      { id: 5, name: "legalix", path: "/work/legalix" },
    ]
    folders.groups = []
  })

  function renderDialog() {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog open onOpenChange={vi.fn()} />
      </NextIntlClientProvider>
    )
    return userEvent.setup()
  }

  it("leaves archived folders' sessions out of the recent list", async () => {
    renderDialog()
    await waitFor(() =>
      expect(screen.queryAllByRole("option").length).toBeGreaterThan(0)
    )
    expect(screen.getByText("Release prep")).toBeTruthy()
    expect(screen.queryByText("Legal brief")).toBeNull()
  })

  it("still finds them when searched, marked Archived", async () => {
    h.listAllConversations.mockResolvedValue([
      conv(1, 3, "Upload fixes"),
      conv(2, 5, "Upload the brief"),
    ])
    const user = renderDialog()
    await user.type(
      screen.getByPlaceholderText("Search conversations..."),
      "upload"
    )

    const archivedRow = (await screen.findByText("Upload the brief")).closest(
      '[role="option"]'
    )
    expect(archivedRow?.textContent).toContain(
      enMessages.Folder.search.archivedBadge
    )
    const liveRow = screen.getByText("Upload fixes").closest('[role="option"]')
    expect(liveRow?.textContent).not.toContain(
      enMessages.Folder.search.archivedBadge
    )
  })
})

describe("SearchCommandDialog as an instant session switcher", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    __resetQuickSwitchTypeaheadForTests()
    folders.active = folders.all[0]
    h.listAllConversations.mockResolvedValue([])
    store.conversations = [
      conv(1, 3, "Release prep", { updated_at: "2026-09-30T10:00:00Z" }),
      conv(2, 5, "Legal brief", {
        agent_type: "codex",
        external_id: "session-2",
        updated_at: "2026-09-30T11:00:00Z",
      }),
      conv(3, 3, "Older codeg work", { updated_at: "2026-09-30T09:00:00Z" }),
    ]
    tabState.tabs = [
      {
        id: "tab-1",
        kind: "conversation",
        folderId: 3,
        conversationId: 1,
        agentType: "claude_code",
        title: "Release prep",
        isPinned: true,
      },
    ]
    tabState.activeTabId = "tab-1"
  })

  function dialog(open: boolean, onOpenChange = vi.fn()) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SearchCommandDialog open={open} onOpenChange={onOpenChange} />
      </NextIntlClientProvider>
    )
  }

  /** The listed rows (hidden or not), top to bottom, and the selected one. */
  function listed() {
    const items = Array.from(document.querySelectorAll("[cmdk-item]"))
    return {
      items,
      titles: items.map((o) => o.querySelector("span.flex-1")?.textContent),
      selected: items.findIndex(
        (o) => o.getAttribute("aria-selected") === "true"
      ),
    }
  }

  /** A composer that held focus when the shortcut was pressed. */
  function focusedComposer() {
    const composer = document.createElement("textarea")
    document.body.appendChild(composer)
    composer.focus()
    const keys = vi.fn()
    composer.addEventListener("keydown", keys)
    return { composer, keys }
  }

  function keydown(target: EventTarget, key: string) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(event)
    return event
  }

  it("keeps the switcher rendered while hidden, so opening only reveals it", async () => {
    const { rerender } = render(dialog(false))
    await waitFor(() => expect(listed().titles).toHaveLength(2))
    // Hidden: rendered, the previous session first and selected, but out of
    // sight and out of the accessibility tree.
    expect(listed().titles).toEqual(["Legal brief", "Older codeg work"])
    expect(listed().selected).toBe(0)
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    const firstRow = listed().items[0]

    rerender(dialog(true))

    // Shown at once, the same rows (nothing remounted), the caret in the box.
    expect(screen.getAllByRole("option")[0]).toBe(firstRow)
    expect(listed().selected).toBe(0)
    expect(screen.getByPlaceholderText("Search conversations...")).toHaveFocus()
    expect(
      document.querySelector('[role="dialog"][data-state="open"]')
    ).not.toBeNull()
  })

  it("tracks the session in front while hidden", async () => {
    const { rerender } = render(dialog(false))
    await waitFor(() => expect(listed().titles).toHaveLength(2))

    // Another tab comes to the front while the switcher is closed.
    tabState.tabs = [
      ...tabState.tabs,
      {
        id: "tab-2",
        kind: "conversation",
        folderId: 5,
        conversationId: 2,
        agentType: "codex",
        title: "Legal brief",
        isPinned: true,
      },
    ]
    tabState.activeTabId = "tab-2"
    rerender(dialog(false))
    rerender(dialog(true))

    expect(listed().titles).toEqual(["Release prep", "Older codeg work"])
    expect(listed().selected).toBe(0)
  })

  it("takes an Enter typed before its search box had focus, never the composer", async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(dialog(false, onOpenChange))
    await waitFor(() => expect(listed().titles).toHaveLength(2))
    const { composer, keys } = focusedComposer()

    // ⌘K arms the buffer; Enter arrives before the dialog has opened.
    armQuickSwitchTypeahead()
    const enter = keydown(composer, "Enter")
    expect(enter.defaultPrevented).toBe(true)
    expect(keys).not.toHaveBeenCalled()

    rerender(dialog(true, onOpenChange))

    await waitFor(() =>
      expect(h.openTab).toHaveBeenCalledWith(5, 2, "codex", true)
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(keys).not.toHaveBeenCalled()
    composer.remove()
  })

  it("puts letters typed before its search box had focus into the box", async () => {
    const { rerender } = render(dialog(false))
    await waitFor(() => expect(listed().titles).toHaveLength(2))
    const { composer, keys } = focusedComposer()

    armQuickSwitchTypeahead()
    for (const key of ["u", "p", "x", "Backspace"]) keydown(composer, key)
    rerender(dialog(true))

    const input = screen.getByPlaceholderText("Search conversations...")
    await waitFor(() => expect(input).toHaveValue("up"))
    expect(input).toHaveFocus()
    expect(keys).not.toHaveBeenCalled()
    expect(composer.value).toBe("")
    composer.remove()
  })

  it("leaves shortcuts and keys typed into the switcher alone", async () => {
    render(dialog(true))
    const input = screen.getByPlaceholderText("Search conversations...")
    const { composer, keys } = focusedComposer()
    armQuickSwitchTypeahead()

    // A chord is another shortcut's (a second ⌘K closes the switcher).
    const chord = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    composer.dispatchEvent(chord)
    expect(keys).toHaveBeenCalledTimes(1)
    expect(chord.defaultPrevented).toBe(false)

    // Its own search box is not held back.
    const typed = keydown(input, "a")
    expect(typed.defaultPrevented).toBe(false)
    cancelQuickSwitchTypeahead()
    composer.remove()
  })

  it("starts the next open fresh: query cleared, the first session selected", async () => {
    h.listAllConversations.mockResolvedValue([conv(7, 3, "Upload fixes")])
    const { rerender } = render(dialog(true))
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText("Search conversations...")
    await user.type(input, "upload")
    expect(await screen.findByText("Upload fixes")).toBeTruthy()

    rerender(dialog(false))
    rerender(dialog(true))

    expect(input).toHaveValue("")
    expect(listed().titles).toEqual(["Legal brief", "Older codeg work"])
    expect(listed().selected).toBe(0)
    expect(input).toHaveFocus()
  })

  it("gives focus back on Escape", async () => {
    const before = document.createElement("button")
    document.body.appendChild(before)
    before.focus()
    const onOpenChange = vi.fn()
    const { rerender } = render(dialog(false, onOpenChange))
    rerender(dialog(true, onOpenChange))
    expect(screen.getByPlaceholderText("Search conversations...")).toHaveFocus()

    const escape = keydown(document.activeElement!, "Escape")
    expect(escape.defaultPrevented).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)

    rerender(dialog(false, onOpenChange))
    expect(before).toHaveFocus()
    before.remove()
  })

  it("warms the preselected session when it is not open in a tab", async () => {
    render(dialog(true))
    await waitFor(() =>
      expect(warm.prefetchConversationDetail).toHaveBeenCalledWith(2)
    )
    expect(warm.preconnectConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, external_id: "session-2" })
    )
  })

  it("does not warm a session that is open in a tab already", async () => {
    tabState.tabs = [
      ...tabState.tabs,
      {
        id: "tab-2",
        kind: "conversation",
        folderId: 5,
        conversationId: 2,
        agentType: "codex",
        title: "Legal brief",
        isPinned: false,
      },
    ]
    render(dialog(true))
    await waitFor(() => expect(listed().selected).toBe(0))
    expect(warm.prefetchConversationDetail).not.toHaveBeenCalled()
    expect(warm.preconnectConversation).not.toHaveBeenCalled()
  })

  it("does not warm anything while hidden", async () => {
    render(dialog(false))
    await waitFor(() => expect(listed().titles).toHaveLength(2))
    expect(warm.prefetchConversationDetail).not.toHaveBeenCalled()
    expect(warm.preconnectConversation).not.toHaveBeenCalled()
  })

  it("opens as the modal dialog over a layer that holds focus", async () => {
    const guard = document.createElement("span")
    guard.setAttribute("data-radix-focus-guard", "")
    document.body.appendChild(guard)
    const { rerender } = render(dialog(false))
    rerender(dialog(true))

    expect(
      document.querySelector('[data-slot="dialog-content"]')
    ).not.toBeNull()
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2))
    const user = userEvent.setup()
    await user.keyboard("{Enter}")
    expect(h.openTab).toHaveBeenCalledWith(5, 2, "codex", true)
    guard.remove()
  })
})
