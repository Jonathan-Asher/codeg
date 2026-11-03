/**
 * The output-limit notice: when the session's last turn ended because the
 * model ran out of output tokens (stop reason `max_tokens`), the reply at the
 * end of the thread says so, with a Continue that asks the agent to keep
 * going — and nothing of it shows anywhere else, or while a turn runs.
 *
 * Renders the real `MessageListView` over a seeded runtime store; what it
 * mounts around the thread is stubbed, as in the Continue suite.
 */
import type { ComponentProps, ReactNode } from "react"
import { fireEvent, render, within } from "@testing-library/react"
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
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
const L = enMessages.Folder.chat.messageList
const CONVERSATION = 9

function turn(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    blocks: [{ type: "text", text }],
    timestamp: "2026-11-03T10:00:00.000Z",
  } satisfies MessageTurn
}

function detail(turns: MessageTurn[]): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION,
      folder_id: 1,
      agent_type: "pi",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "sess-1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-11-03T10:00:00.000Z",
      updated_at: "2026-11-03T10:00:00.000Z",
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

type ListProps = Partial<ComponentProps<typeof MessageListView>>

function renderList(props: ListProps = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageListView
        conversationId={CONVERSATION}
        agentType="pi"
        connStatus="connected"
        showMessageNav={false}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

function notices(container: HTMLElement) {
  return container.querySelectorAll("[data-output-limit-notice]")
}

const CUT_OFF_THREAD = [
  turn("turn-0", "user", "plan the migration"),
  turn("turn-1", "assistant", "First, the schema. Then"),
]

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("MessageListView: output-limit notice", () => {
  it("says the reply hit the output limit under the last reply, and Continue asks the agent to go on", async () => {
    await seed(CUT_OFF_THREAD)
    const onContinue = vi.fn()
    const { container } = renderList({ onContinueAfterOutputLimit: onContinue })

    expect(notices(container)).toHaveLength(1)
    const row = container.querySelector<HTMLElement>(
      '[data-find-key="persisted-assistant-turn-1"]'
    )
    expect(row).not.toBeNull()
    const notice = within(row!).getByRole("status")
    expect(notice).toHaveTextContent(L.outputLimitReached)

    const button = within(notice).getByRole("button", {
      name: L.outputLimitContinue,
    })
    expect(button).toHaveAttribute("title", L.outputLimitContinueHint)
    fireEvent.click(button)
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it("shows nothing when the last turn ended any other way", async () => {
    await seed(CUT_OFF_THREAD)
    const { container } = renderList()
    expect(notices(container)).toHaveLength(0)
  })

  it("hides while the next turn runs or once something is queued", async () => {
    await seed(CUT_OFF_THREAD)
    const onContinue = vi.fn()
    const { container, rerender } = renderList({
      onContinueAfterOutputLimit: onContinue,
      connStatus: "prompting",
    })
    expect(notices(container)).toHaveLength(0)

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageListView
          conversationId={CONVERSATION}
          agentType="pi"
          connStatus="connected"
          showMessageNav={false}
          onContinueAfterOutputLimit={onContinue}
          hasQueuedMessages
        />
      </NextIntlClientProvider>
    )
    expect(notices(container)).toHaveLength(0)
  })

  it("only ever sits under the reply at the end of the thread", async () => {
    await seed([
      turn("turn-0", "user", "plan the migration"),
      turn("turn-1", "assistant", "First, the schema. Then"),
      turn("turn-2", "user", "and the rollback?"),
    ])
    const { container } = renderList({ onContinueAfterOutputLimit: vi.fn() })
    expect(notices(container)).toHaveLength(0)
  })
})
