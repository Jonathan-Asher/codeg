/**
 * Continue turns in the transcript: a user message that is exactly
 * CONTINUE_PROMPT reads as a slim "Continued" divider instead of a user
 * bubble — while it is on its way (the optimistic turn a click appends) and
 * once it comes back from the agent's own session file (every reload) —
 * while a real message that merely says "continue" stays a bubble.
 *
 * Renders the real `MessageListView` over a seeded runtime store; what it
 * mounts around the thread is stubbed, as in the Edit suite.
 */
import type { ComponentProps, ReactNode } from "react"
import { render, within } from "@testing-library/react"
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
  }) => (
    <div data-testid="user-bubble">
      {parts.map((part) => part.text ?? "").join("")}
    </div>
  ),
}))

import { getFolderConversation } from "@/lib/api"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { CONTINUE_PROMPT } from "@/lib/session-activity"
import type {
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
} from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
const L = enMessages.Folder.chat.messageList
const CONVERSATION = 9

function userTurn(
  id: string,
  blocks: ContentBlock[] | string,
  extra: Partial<MessageTurn> = {}
) {
  return {
    id,
    role: "user",
    blocks:
      typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks,
    timestamp: "2026-09-28T10:00:00.000Z",
    ...extra,
  } satisfies MessageTurn
}

function replyTurn(id: string, text: string) {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: "2026-09-28T10:00:01.000Z",
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
      created_at: "2026-09-28T10:00:00.000Z",
      updated_at: "2026-09-28T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
  }
}

/** Load `turns` the way a detail fetch does — i.e. as the parser read them
 *  back from the agent's session file, which is all a reload has. */
async function seed(turns: MessageTurn[]) {
  mockGetFolderConversation.mockResolvedValue(detail(turns))
  const applied = await useConversationRuntimeStore
    .getState()
    .actions.refetchDetail(CONVERSATION)
  expect(applied).toBe(true)
}

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

function rowFor(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-find-key="${key}"]`)
  if (!el) throw new Error(`no row ${key}`)
  return el
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("MessageListView: Continue turns", () => {
  it("renders a Continue turn read back from the session file as a divider", async () => {
    await seed([
      userTurn("turn-0", "write the migration"),
      replyTurn("turn-1", "first half done"),
      userTurn("turn-2", CONTINUE_PROMPT),
      replyTurn("turn-3", "second half done"),
    ])
    const { container } = renderList({ onEditUserMessage: vi.fn() })

    const row = rowFor(container, "persisted-user-turn-2")
    const divider = row.querySelector("[data-continue-marker]")
    expect(divider).toBeInTheDocument()
    expect(within(row).getByText(L.continued)).toBeInTheDocument()
    expect(within(row).getByTitle(L.continuedHint)).toBeInTheDocument()
    // Not a user bubble, and nothing to edit or copy on it.
    expect(within(row).queryByTestId("user-bubble")).toBeNull()
    expect(
      within(row).queryByRole("button", { name: L.editMessage })
    ).toBeNull()
    // The message before it is still an ordinary bubble.
    const first = rowFor(container, "persisted-user-turn-0")
    expect(within(first).getByTestId("user-bubble")).toHaveTextContent(
      "write the migration"
    )
    expect(container.querySelectorAll("[data-continue-marker]")).toHaveLength(1)
  })

  it("renders the turn a click appends as a divider while it is on its way", async () => {
    await seed([
      userTurn("turn-0", "write the migration"),
      replyTurn("turn-1", "first half done"),
    ])
    useConversationRuntimeStore
      .getState()
      .actions.appendOptimisticTurn(
        CONVERSATION,
        userTurn("optimistic-1", CONTINUE_PROMPT),
        "optimistic-1"
      )
    const { container } = renderList()

    const markers = container.querySelectorAll("[data-continue-marker]")
    expect(markers).toHaveLength(1)
    expect(
      markers[0].closest("[data-find-key]")?.getAttribute("data-find-key")
    ).toMatch(/optimistic/)
    expect(
      container.querySelectorAll('[data-testid="user-bubble"]')
    ).toHaveLength(1)
  })

  it("keeps a real message that merely says continue as a bubble", async () => {
    await seed([
      userTurn("turn-0", "write the migration"),
      replyTurn("turn-1", "first half done"),
      userTurn("turn-2", "continue, but skip the seed data"),
      replyTurn("turn-3", "ok"),
      userTurn("turn-4", [
        { type: "text", text: CONTINUE_PROMPT },
        { type: "image", data: "aGk=", mime_type: "image/png" },
      ]),
      replyTurn("turn-5", "looked at the screenshot"),
    ])
    const { container } = renderList()

    expect(container.querySelector("[data-continue-marker]")).toBeNull()
    expect(
      within(rowFor(container, "persisted-user-turn-2")).getByTestId(
        "user-bubble"
      )
    ).toHaveTextContent("continue, but skip the seed data")
    expect(
      within(rowFor(container, "persisted-user-turn-4")).getByTestId(
        "user-bubble"
      )
    ).toBeInTheDocument()
  })
})
