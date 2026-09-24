/**
 * "Edit message" in the transcript: which user messages offer Edit, when it is
 * greyed out, and how the in-place editor saves and cancels.
 *
 * Renders the real `MessageListView` over a seeded runtime store. What it
 * mounts around the thread — the virtualizer, the scroll container, the
 * overlays, the per-reply footer — is stubbed: none of it takes part in
 * editing, and in jsdom it only adds noise.
 */
import type { ComponentProps, ReactNode } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getFolderConversation: vi.fn(),
}))
vi.mock("./use-create-task-from-message", () => ({
  useCreateTaskFromMessage: () => () => {},
}))
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom: () => {} }),
}))
vi.mock("@/components/ai-elements/message-thread", () => ({
  MessageThread: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageThreadScrollButton: () => null,
}))
vi.mock("@/components/message/virtualized-message-thread", () => ({
  VirtualizedMessageThread: <T,>({
    items,
    getItemKey,
    renderItem,
  }: {
    items: T[]
    getItemKey: (item: T, index: number) => string
    renderItem: (item: T, index: number) => ReactNode
  }) => (
    <div>
      {items.map((item, index) => (
        <div key={getItemKey(item, index)}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}))
vi.mock("@/components/message/session-viewer-host", () => ({
  SessionViewerHost: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/chat/agent-plan-overlay", () => ({
  AgentPlanOverlay: () => null,
}))
vi.mock("@/components/chat/sub-agent-overlay", () => ({
  SubAgentOverlay: () => null,
}))
vi.mock("@/components/message/selection-action-bubble", () => ({
  SelectionActionBubble: () => null,
}))
vi.mock("./completed-turn-content", () => ({
  CompletedTurnContent: () => <div>reply</div>,
}))
vi.mock("./reply-artifacts", () => ({ ReplyArtifacts: () => null }))
vi.mock("./turn-stats", () => ({ TurnStats: () => null }))
vi.mock("./collapsible-user-message", () => ({
  CollapsibleUserMessage: ({
    parts,
  }: {
    parts: { type: string; text?: string }[]
  }) => <div>{parts.map((part) => part.text ?? "").join("")}</div>,
}))

import { getFolderConversation } from "@/lib/api"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { RETRY_NUDGE_TEXT } from "@/lib/retry-nudge"
import type { UserMessageEditRequest } from "@/lib/edit-message"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
const L = enMessages.Folder.chat.messageList
const CONVERSATION = 7

function userTurn(id: string, text: string, extra: Partial<MessageTurn> = {}) {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: "2026-09-24T10:00:00.000Z",
    ...extra,
  } satisfies MessageTurn
}

function replyTurn(id: string, text: string) {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: "2026-09-24T10:00:01.000Z",
  } satisfies MessageTurn
}

function detail(turns: MessageTurn[]): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "sess-1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-09-24T10:00:00.000Z",
      updated_at: "2026-09-24T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
  }
}

/** Load `turns` into the store the way a detail fetch would. */
async function seed(turns: MessageTurn[]) {
  mockGetFolderConversation.mockResolvedValue(detail(turns))
  const applied = await useConversationRuntimeStore
    .getState()
    .actions.refetchDetail(CONVERSATION)
  expect(applied).toBe(true)
}

/** A first message, a reply, then the message an edit usually targets. */
const HISTORY = [
  userTurn("turn-0", "first question"),
  replyTurn("turn-1", "first answer"),
  userTurn("turn-2", "second question"),
  replyTurn("turn-3", "second answer"),
]

type ListProps = Partial<ComponentProps<typeof MessageListView>>

function renderList(props: ListProps = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageListView
        conversationId={CONVERSATION}
        agentType="claude_code"
        connStatus="connected"
        showMessageNav={false}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

/** The rendered row of the user message with this id. */
function row(container: HTMLElement, turnId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `[data-find-key="persisted-user-${turnId}"]`
  )
  if (!el) throw new Error(`no row for ${turnId}`)
  return el
}

function editButton(container: HTMLElement, turnId: string) {
  return within(row(container, turnId)).queryByRole("button", {
    name: L.editMessage,
  })
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("MessageListView: where Edit is offered", () => {
  it("offers nothing where the host can't run an edit", async () => {
    // Read-only surfaces (sub-agent dialog, task transcripts) and sessions
    // without a live, strictly-forking agent pass no handler.
    await seed(HISTORY)
    renderList()
    expect(
      screen.queryByRole("button", { name: L.editMessage })
    ).not.toBeInTheDocument()
  })

  it("offers it on every settled user message", async () => {
    await seed(HISTORY)
    const { container } = renderList({ onEditUserMessage: vi.fn() })
    for (const id of ["turn-0", "turn-2"]) {
      const button = editButton(container, id)
      expect(button).toBeInTheDocument()
      expect(button).not.toHaveAttribute("aria-disabled")
    }
  })

  it("leaves out a Retry marker — codeg wrote it, not the user", async () => {
    await seed([
      userTurn("turn-0", "question"),
      replyTurn("turn-1", "answer"),
      userTurn("turn-2", RETRY_NUDGE_TEXT),
      replyTurn("turn-3", "answer again"),
    ])
    const { container } = renderList({ onEditUserMessage: vi.fn() })
    expect(container.querySelector("[data-retry-marker]")).toBeInTheDocument()
    expect(editButton(container, "turn-2")).toBeNull()
  })

  it("leaves out a message still on its way", async () => {
    await seed(HISTORY)
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(
        CONVERSATION,
        userTurn("optimistic-1", "just sent"),
        "optimistic-1"
      )
    const { container } = renderList({ onEditUserMessage: vi.fn() })
    const pending = container.querySelector<HTMLElement>(
      '[data-find-key="optimistic-user-optimistic-1"]'
    )!
    expect(within(pending).getByText("just sent")).toBeInTheDocument()
    expect(
      within(pending).queryByRole("button", { name: L.editMessage })
    ).toBeNull()
    // …while the settled ones keep theirs — greyed out until that send has
    // become a turn: forking under it would carry it into the new branch.
    expect(editButton(container, "turn-2")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("leaves out a message that doesn't follow a reply", async () => {
    // The first of two messages in a row got no answer. Forking at the reply
    // above would drop it from the history the edit continues from.
    await seed([
      userTurn("turn-0", "question"),
      replyTurn("turn-1", "answer"),
      userTurn("turn-2", "unanswered"),
      userTurn("turn-3", "follow-up"),
      replyTurn("turn-4", "late answer"),
    ])
    const { container } = renderList({ onEditUserMessage: vi.fn() })
    expect(editButton(container, "turn-2")).toBeInTheDocument()
    expect(editButton(container, "turn-3")).toBeNull()
  })
})

describe("MessageListView: when Edit is greyed out", () => {
  it.each([
    ["a turn is running", { connStatus: "prompting" as const }, L.editBusy],
    [
      "messages are waiting in the queue",
      { hasQueuedMessages: true },
      L.editQueued,
    ],
  ])("while %s", async (_label, props, reason) => {
    await seed(HISTORY)
    const onEditUserMessage = vi.fn()
    const { container } = renderList({ onEditUserMessage, ...props })
    const button = editButton(container, "turn-2")!
    expect(button).toHaveAttribute("aria-disabled", "true")
    await userEvent.hover(button)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason)
    // `aria-disabled` keeps it hoverable; the click is what's withheld.
    await userEvent.click(button)
    expect(screen.queryByRole("group", { name: L.editMessage })).toBeNull()
  })

  it("but not when the reply before it was never given its parser id", async () => {
    // A reply this session streamed is `live-…` until the post-turn reparse
    // names it, and a follow-up sent within seconds cancels that reparse for
    // good. Edit doesn't wait on it: the live id goes to the host, which looks
    // the parser's name up in a fresh read before forking.
    await seed([
      userTurn("turn-0", "question"),
      replyTurn("live-7-lm-1", "streamed answer"),
      userTurn("turn-2", "next question"),
      replyTurn("turn-3", "next answer"),
    ])
    const onEditUserMessage = vi.fn<
      (request: UserMessageEditRequest) => Promise<boolean>
    >(() => Promise.resolve(true))
    const { container } = renderList({ onEditUserMessage })
    const button = editButton(container, "turn-2")!
    expect(button).not.toHaveAttribute("aria-disabled")

    await userEvent.click(button)
    await userEvent.click(screen.getByRole("button", { name: L.editSave }))
    expect(onEditUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        forkFromTurnId: "live-7-lm-1",
        text: "next question",
      })
    )
  })
})

describe("MessageListView: the in-place editor", () => {
  async function openEditor(turnId: string, props: ListProps = {}) {
    await seed(HISTORY)
    // Every save is recorded; unless a test supplies its own outcome, the
    // edit goes out.
    const onEditUserMessage = vi.fn<
      (request: UserMessageEditRequest) => Promise<boolean>
    >(props.onEditUserMessage ?? (() => Promise.resolve(true)))
    const view = renderList({ ...props, onEditUserMessage })
    await userEvent.click(editButton(view.container, turnId)!)
    const editor = screen.getByRole("group", { name: L.editMessage })
    const field = within(editor).getByRole("textbox", { name: L.editMessage })
    return { ...view, editor, field, onEditUserMessage }
  }

  it("opens on the message's text, with the caret at the end", async () => {
    const { field } = await openEditor("turn-2")
    expect(field).toHaveValue("second question")
    expect(field).toHaveFocus()
    expect((field as HTMLTextAreaElement).selectionStart).toBe(
      "second question".length
    )
    expect(screen.getByText(L.editHint)).toBeInTheDocument()
  })

  it("saves with the reply before the message as the fork point", async () => {
    const { field, onEditUserMessage } = await openEditor("turn-2")
    await userEvent.clear(field)
    await userEvent.type(field, "second question, sharper")
    await userEvent.click(screen.getByRole("button", { name: L.editSave }))
    expect(onEditUserMessage).toHaveBeenCalledTimes(1)
    const request = onEditUserMessage.mock.calls[0][0]
    // The REPLY before the message — never the message itself, which a fork
    // would keep.
    expect(request.forkFromTurnId).toBe("turn-1")
    expect(request.text).toBe("second question, sharper")
    expect(request.sourceTurn.id).toBe("turn-2")
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: L.editMessage })).toBeNull()
    )
  })

  it("saves the first message with no fork point: it opens a new conversation", async () => {
    const { onEditUserMessage } = await openEditor("turn-0")
    expect(screen.getByText(L.editHintNewConversation)).toBeInTheDocument()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    expect(onEditUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ forkFromTurnId: null, text: "first question" })
    )
  })

  it("saves on Ctrl+Enter too, and a plain Enter is a newline", async () => {
    const { field, onEditUserMessage } = await openEditor("turn-2")
    await userEvent.type(field, "{Enter}more")
    expect(onEditUserMessage).not.toHaveBeenCalled()
    expect(field).toHaveValue("second question\nmore")
    await userEvent.keyboard("{Control>}{Enter}{/Control}")
    expect(onEditUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second question\nmore" })
    )
  })

  it("cancels on Escape, leaving the message as it was", async () => {
    const { field, container, onEditUserMessage } = await openEditor("turn-2")
    await userEvent.type(field, " edited")
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("group", { name: L.editMessage })).toBeNull()
    expect(onEditUserMessage).not.toHaveBeenCalled()
    expect(
      within(row(container, "turn-2")).getByText("second question")
    ).toBeInTheDocument()
    // Opening it again starts from the message, not the abandoned draft.
    await userEvent.click(editButton(container, "turn-2")!)
    expect(screen.getByRole("textbox", { name: L.editMessage })).toHaveValue(
      "second question"
    )
  })

  it("cancels on the Cancel button", async () => {
    await openEditor("turn-2")
    await userEvent.click(screen.getByRole("button", { name: L.editCancel }))
    expect(screen.queryByRole("group", { name: L.editMessage })).toBeNull()
  })

  it("stays open with the text when the edit doesn't go out", async () => {
    // The host has already said why (a toast); the user's text must survive.
    let settle: (sent: boolean) => void = () => {}
    const onEditUserMessage = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const { field } = await openEditor("turn-2", { onEditUserMessage })
    await userEvent.type(field, "!")
    await userEvent.click(screen.getByRole("button", { name: L.editSave }))

    // While it runs: locked, and saying what it's doing.
    const saving = await screen.findByRole("button", { name: L.editSaving })
    expect(saving).toBeDisabled()
    expect(field).toHaveAttribute("readonly")
    // A second save can't start a second edit.
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    expect(onEditUserMessage).toHaveBeenCalledTimes(1)

    settle(false)
    const retry = await screen.findByRole("button", { name: L.editSave })
    expect(retry).toBeEnabled()
    expect(screen.getByRole("textbox", { name: L.editMessage })).toHaveValue(
      "second question!"
    )
  })

  it("greys Save out, saying why, while a turn is running", async () => {
    const view = await openEditor("turn-2")
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageListView
          conversationId={CONVERSATION}
          agentType="claude_code"
          connStatus="prompting"
          showMessageNav={false}
          onEditUserMessage={view.onEditUserMessage}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("button", { name: L.editSave })).toBeDisabled()
    expect(within(view.editor).getByText(L.editBusy)).toBeInTheDocument()
  })
})
