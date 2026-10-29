import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  acpForkConversation: vi.fn(),
}))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

import { acpForkConversation } from "@/lib/api"
import type { ForkToNewConversationResult } from "@/lib/api"
import { resetCapabilitiesCacheForTests } from "@/lib/agent-capabilities"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import enMessages from "@/i18n/messages/en.json"
import { SidebarConversationCard } from "./sidebar-conversation-card"

const FORKED: ForkToNewConversationResult = {
  forkedSessionId: "session-S2",
  originalSessionId: "session-S1",
  conversationId: 42,
  folderId: 1,
  title: "[Fork] Topic",
}
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

function openMenu(c: DbConversationSummary) {
  const view = render(
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
  fireEvent.contextMenu(view.getByText("Topic"))
  return view
}

beforeEach(() => {
  localStorage.clear()
  resetCapabilitiesCacheForTests()
  resetTabStore()
  resetAppWorkspaceStore()
  const folder = { id: 1, name: "repo", path: "/repo" } as FolderDetail
  useAppWorkspaceStore.setState({
    folders: [folder],
    allFolders: [folder],
    refreshConversations: vi.fn(async () => {}),
  })
  vi.mocked(acpForkConversation).mockReset()
  vi.mocked(acpForkConversation).mockResolvedValue(FORKED)
})

afterEach(cleanup)

describe("SidebarConversationCard Fork", () => {
  it("forks a conversation nothing has open into a new, focused tab", async () => {
    const { getByText } = openMenu(conv())
    fireEvent.click(getByText("Fork"))
    expect(acpForkConversation).toHaveBeenCalledWith(7)
    await waitFor(() =>
      expect(useTabStore.getState().activeTabId).toBe("conv-1-claude_code-42")
    )
    expect(
      useAppWorkspaceStore.getState().refreshConversations
    ).toHaveBeenCalled()
  })

  it("forks a running Claude Code conversation (at its last finished reply)", () => {
    const { getByText } = openMenu(
      conv({ turn_state: "running", status: "in_progress" })
    )
    expect(getByText("Fork").closest('[role="menuitem"]')).not.toHaveAttribute(
      "data-disabled"
    )
    fireEvent.click(getByText("Fork"))
    expect(acpForkConversation).toHaveBeenCalledWith(7)
  })

  it.each([
    [
      "with no agent session yet",
      conv({ external_id: null }),
      "Nothing to fork yet: no reply has finished",
    ],
    [
      "for an agent that can't fork",
      conv({ agent_type: "gemini" }),
      "This agent can't fork conversations",
    ],
    [
      "while a turn runs on an agent that forks between turns",
      conv({
        agent_type: "codex",
        turn_state: "running",
        status: "in_progress",
      }),
      "Fork after the current reply finishes",
    ],
  ])("is disabled %s, saying why", (_, c, reason) => {
    const { getByText } = openMenu(c)
    const item = getByText("Fork").closest('[role="menuitem"]')
    expect(item).toHaveAttribute("data-disabled")
    expect(item?.closest("[title]")).toHaveAttribute("title", reason)
    fireEvent.click(getByText("Fork"))
    expect(acpForkConversation).not.toHaveBeenCalled()
  })
})
