import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  moveConversationToFolder: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { toast } from "sonner"
import { moveConversationToFolder } from "@/lib/api"
import type { MoveConversationResult } from "@/lib/api"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import enMessages from "@/i18n/messages/en.json"
import { MoveToProjectDialog, canMoveToProject } from "./move-to-project-dialog"

const AT = new Date(1_700_000_000_000).toISOString()

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
    working_dir: "/work/app",
    ...overrides,
  }
}

function folder(overrides: Partial<FolderDetail>): FolderDetail {
  return {
    id: 0,
    name: "",
    path: "",
    git_branch: null,
    default_agent_type: null,
    last_opened_at: AT,
    sort_order: 0,
    color: "default",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    archived: false,
    ...overrides,
  } as FolderDetail
}

const APP = folder({ id: 1, name: "app", path: "/work/app" })
const SITE = folder({ id: 2, name: "site", path: "/work/site" })
const DOCS = folder({ id: 3, name: "docs", path: "/work/docs" })
const CHAT = folder({ id: 4, name: "Chat", path: "/chat/x", kind: "chat" })

function result(
  overrides: Partial<MoveConversationResult> = {}
): MoveConversationResult {
  return {
    conversation: conv(),
    mode: "full",
    moved_children: [],
    dry_run: true,
    ...overrides,
  }
}

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MoveToProjectDialog
        conversation={conv()}
        open
        onOpenChange={onOpenChange}
      />
    </NextIntlClientProvider>
  )
  return { onOpenChange, user: userEvent.setup() }
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: /Choose a project/ }))
  await user.click(await screen.findByText(name))
}

beforeEach(() => {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [APP, SITE, DOCS],
    allFolders: [APP, SITE, DOCS, CHAT],
  })
  vi.mocked(moveConversationToFolder).mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
})

afterEach(cleanup)

describe("MoveToProjectDialog", () => {
  it("lists the open projects, without its own and without chats", async () => {
    const { user } = renderDialog()
    await user.click(screen.getByRole("button", { name: /Choose a project/ }))
    expect(await screen.findByText("site")).toBeTruthy()
    expect(screen.getByText("docs")).toBeTruthy()
    expect(screen.queryByText("/work/app")).toBeNull()
    expect(screen.queryByText("Chat")).toBeNull()
  })

  it("checks the move first, says the files go along, then moves it", async () => {
    vi.mocked(moveConversationToFolder)
      .mockResolvedValueOnce(result({ moved_children: [8, 9] }))
      .mockResolvedValueOnce(
        result({
          dry_run: false,
          conversation: conv({ folder_id: 2, working_dir: "/work/site" }),
        })
      )
    const { user, onOpenChange } = renderDialog()
    const move = screen.getByRole("button", { name: "Move" })
    expect(move).toBeDisabled()

    await pick(user, "site")
    expect(moveConversationToFolder).toHaveBeenCalledWith(7, 2, {
      dryRun: true,
    })
    expect(
      await screen.findByText(/The session and its files move to site/)
    ).toBeTruthy()
    expect(screen.getByText("Its 2 sub-sessions move with it.")).toBeTruthy()

    await waitFor(() => expect(move).not.toBeDisabled())
    await user.click(move)
    expect(moveConversationToFolder).toHaveBeenLastCalledWith(7, 2)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toast.success).toHaveBeenCalledWith("Moved to site")
  })

  it("says when the agent can only be listed there, and where it keeps running", async () => {
    vi.mocked(moveConversationToFolder).mockResolvedValueOnce(
      result({
        mode: "listed_only",
        reason: "agent_unsupported",
        conversation: conv({ agent_type: "gemini" }),
      })
    )
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MoveToProjectDialog
          conversation={conv({ agent_type: "gemini" })}
          open
          onOpenChange={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    const user = userEvent.setup()
    await pick(user, "docs")
    const note = await screen.findByText(/can only be listed under docs/)
    expect(note.textContent).toContain("Gemini")
    expect(note.textContent).toContain("It keeps running in /work/app.")
    expect(screen.getByRole("button", { name: "Move" })).not.toBeDisabled()
  })

  it("shows a refusal in plain words and keeps Move off", async () => {
    vi.mocked(moveConversationToFolder).mockRejectedValueOnce({
      code: "turn_in_progress",
      message: "The session is working.",
      i18n_key: "errors.conversation_running",
      i18n_params: { code: "conversation_running" },
    })
    const { user } = renderDialog()
    await pick(user, "site")
    const refusal = await screen.findByTestId("move-refusal")
    expect(refusal.textContent).toBe(
      "The session is working. Move it once its reply has finished."
    )
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled()
  })

  it("keeps the dialog open and says why when the move itself is refused", async () => {
    vi.mocked(moveConversationToFolder)
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce({
        code: "session_running_elsewhere",
        message: "Claude Code is running this session outside codeg.",
        i18n_key: "errors.running_elsewhere",
        i18n_params: { code: "running_elsewhere" },
      })
    const { user, onOpenChange } = renderDialog()
    await pick(user, "site")
    const move = screen.getByRole("button", { name: "Move" })
    await waitFor(() => expect(move).not.toBeDisabled())
    await user.click(move)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't move the session: Claude Code is running this session outside codeg. Move it once that process has finished."
      )
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe("canMoveToProject", () => {
  it("offers a top-level session only", () => {
    expect(canMoveToProject(conv())).toBe(true)
    expect(canMoveToProject(conv({ kind: "chat" }))).toBe(false)
    expect(canMoveToProject(conv({ kind: "delegate", parent_id: 3 }))).toBe(
      false
    )
    expect(canMoveToProject(conv({ parent_id: 3 }))).toBe(false)
    expect(canMoveToProject(null)).toBe(false)
  })
})
