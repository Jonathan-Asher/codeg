import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  moveConversationToFolder: vi.fn(),
}))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

import { resetCapabilitiesCacheForTests } from "@/lib/agent-capabilities"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore } from "@/stores/tab-store"
import enMessages from "@/i18n/messages/en.json"
import { SidebarConversationCard } from "./sidebar-conversation-card"

const AT = new Date(1_700_000_000_000).toISOString()
const noop = vi.fn()
const asyncNoop = vi.fn(async () => {})

function conv(
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 1,
    title: "Topic",
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: "session-S1",
    message_count: 0,
    child_count: 0,
    created_at: AT,
    updated_at: AT,
    pinned_at: null,
    ...overrides,
  }
}

function renderCard(c: DbConversationSummary) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        timeLabel=""
        onSelect={noop}
        onDoubleClick={noop}
        onRename={asyncNoop}
        onDelete={asyncNoop}
        onStatusChange={asyncNoop}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  resetCapabilitiesCacheForTests()
  resetTabStore()
  resetAppWorkspaceStore()
  const app = { id: 1, name: "app", path: "/work/app" } as FolderDetail
  const site = { id: 2, name: "site", path: "/work/site" } as FolderDetail
  useAppWorkspaceStore.setState({
    folders: [app, site],
    allFolders: [app, site],
  })
})

afterEach(cleanup)

describe("SidebarConversationCard Move to project", () => {
  it("offers the move in the context menu and opens the picker", () => {
    const view = renderCard(conv())
    fireEvent.contextMenu(view.getByText("Topic"))
    fireEvent.click(view.getByText("Move to project…"))
    expect(screen.getByTestId("move-to-project-dialog")).toBeTruthy()
    expect(
      screen.getByText("Move “Topic” to another project.", { exact: false })
    ).toBeTruthy()
  })

  it.each([
    ["a chat", conv({ kind: "chat" })],
    ["a sub-session", conv({ kind: "delegate", parent_id: 3 })],
  ])("is not offered for %s", (_, c) => {
    const view = renderCard(c)
    fireEvent.contextMenu(view.getByText("Topic"))
    expect(view.queryByText("Move to project…")).toBeNull()
  })

  it("says where a session moved without its files keeps running", () => {
    const view = renderCard(
      conv({ origin_cwd: "/work/old", working_dir: "/work/old" })
    )
    const badge = view.getByTestId("runs-in-badge")
    expect(badge.getAttribute("title")).toBe("Runs in /work/old")
    expect(view.queryByText("Source worktree removed")).toBeNull()
  })

  it("keeps the removed-worktree badge when that folder is gone", () => {
    const view = renderCard(
      conv({ origin_cwd: "/work/gone", working_dir: "/work/app" })
    )
    expect(view.queryByTestId("runs-in-badge")).toBeNull()
    expect(view.getByText("Source worktree removed")).toBeTruthy()
  })
})
