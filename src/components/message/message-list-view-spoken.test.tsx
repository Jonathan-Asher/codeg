/**
 * The mic marker on a user message spoken through the phone's Talk mode:
 * from history (`MessageTurn.spoken`), and on the turn a viewer synthesizes
 * from a live `user_message` before any reload.
 *
 * Renders the real `MessageListView` over a seeded runtime store, with what it
 * mounts around the thread stubbed as in the edit tests.
 */
import type { ReactNode } from "react"
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
  }) => <div>{parts.map((part) => part.text ?? "").join("")}</div>,
}))

import { getFolderConversation } from "@/lib/api"
import { buildUserTurnFromMessageBlocks } from "@/lib/user-message-blocks"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
const SPOKEN = enMessages.Folder.chat.messageList.spokenMessage
const CONVERSATION = 7

function userTurn(id: string, text: string, extra: Partial<MessageTurn> = {}) {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: "2026-11-01T10:00:00.000Z",
    ...extra,
  } satisfies MessageTurn
}

function replyTurn(id: string, text: string) {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: "2026-11-01T10:00:01.000Z",
  } satisfies MessageTurn
}

function detail(turns: MessageTurn[]): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION,
      folder_id: 1,
      agent_type: "open_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "sess-1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-11-01T10:00:00.000Z",
      updated_at: "2026-11-01T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
  }
}

async function seed(turns: MessageTurn[]) {
  mockGetFolderConversation.mockResolvedValue(detail(turns))
  const applied = await useConversationRuntimeStore
    .getState()
    .actions.refetchDetail(CONVERSATION)
  expect(applied).toBe(true)
}

function renderList() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageListView
        conversationId={CONVERSATION}
        agentType="open_code"
        connStatus="connected"
        showMessageNav={false}
      />
    </NextIntlClientProvider>
  )
}

/** The rendered row of the message with this find key. */
function row(container: HTMLElement, findKey: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `[data-find-key="${findKey}"]`
  )
  if (!el) throw new Error(`no row for ${findKey}`)
  return el
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("MessageListView: spoken messages", () => {
  it("marks a spoken message with a mic, and leaves a typed one alone", async () => {
    await seed([
      userTurn("turn-0", "check why the build fails", { spoken: true }),
      replyTurn("turn-1", "on it"),
      userTurn("turn-2", "typed follow-up"),
      replyTurn("turn-3", "done"),
    ])
    const { container } = renderList()

    const spoken = row(container, "persisted-user-turn-0")
    expect(spoken.querySelector("[data-spoken-marker]")).not.toBeNull()
    expect(within(spoken).getByTitle(SPOKEN)).toBeInTheDocument()
    // Named for a screen reader too, not only on hover.
    expect(within(spoken).getByText(SPOKEN)).toHaveClass("sr-only")

    const typed = row(container, "persisted-user-turn-2")
    expect(typed.querySelector("[data-spoken-marker]")).toBeNull()
    expect(container.querySelectorAll("[data-spoken-marker]")).toHaveLength(1)
  })

  it("marks the turn a viewer builds from a spoken user_message", async () => {
    await seed([userTurn("turn-0", "first"), replyTurn("turn-1", "answer")])
    useConversationRuntimeStore
      .getState()
      .actions.appendViewerUserTurn(
        CONVERSATION,
        buildUserTurnFromMessageBlocks(
          "optimistic-9",
          [{ type: "text", text: "stop that for a second" }],
          true
        )
      )
    const { container } = renderList()
    const live = container.querySelector<HTMLElement>(
      '[data-find-key$="optimistic-9"]'
    )
    expect(live).not.toBeNull()
    expect(within(live!).getByText("stop that for a second")).toBeTruthy()
    expect(live!.querySelector("[data-spoken-marker]")).not.toBeNull()
  })
})
