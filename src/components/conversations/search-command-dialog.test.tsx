import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"
import type { MessageSearchHit } from "@/lib/api"
import { takePendingFind } from "@/lib/pending-find"

const h = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  listAllConversations: vi.fn(),
  openTab: vi.fn(),
  openConversations: vi.fn(),
  resetFileTree: vi.fn(),
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

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
  ],
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
    selector({ conversations: store.conversations, allFolders: folders.all }),
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

  it("opens on the current session, selected, with recent sessions below", async () => {
    renderDialog()

    await waitFor(() => expect(rows().selected).toBe(0))
    expect(rows().titles).toEqual([
      "Release prep",
      "Legal brief",
      "Older codeg work",
    ])
    expect(screen.getByText("Current")).toBeTruthy()
    expect(screen.getByText("Recent")).toBeTruthy()
    expect(screen.getByText("legalix")).toBeTruthy()
    expect(screen.queryByText("Delegated subtask")).toBeNull()
  })

  it("switches to the next session with one arrow down and Enter", async () => {
    const { user, onOpenChange } = renderDialog()
    await waitFor(() => expect(rows().selected).toBe(0))

    await user.keyboard("{ArrowDown}")
    await waitFor(() => expect(rows().selected).toBe(1))
    await user.keyboard("{Enter}")

    expect(h.openTab).toHaveBeenCalledWith(5, 2, "codex", true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("only closes the dialog when the current session is picked", async () => {
    const { user, onOpenChange } = renderDialog()
    await waitFor(() => expect(rows().selected).toBe(0))

    await user.keyboard("{Enter}")

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(h.openTab).not.toHaveBeenCalled()
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
    expect(rows().titles[0]).toBe("Release prep")
  })

  it("lists only the open folder's recent sessions when scoped", async () => {
    const { user } = renderDialog()
    await waitFor(() => expect(rows().titles).toContain("Legal brief"))

    await user.click(screen.getByRole("button", { name: "Only codeg" }))

    expect(rows().titles).toEqual(["Release prep", "Older codeg work"])
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
    expect(screen.queryByText("Current")).toBeNull()
  })
})
