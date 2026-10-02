/**
 * A notification click asks the session's transcript for its latest message
 * (see `lib/scroll-to-latest-intent`). Renders the real `MessageListView`
 * over a seeded runtime store, with the scroll container stubbed down to the
 * one call that matters: `scrollToBottom`.
 */
import type { ComponentProps, ReactNode } from "react"
import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ scrollToBottom: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getFolderConversation: vi.fn(),
}))
vi.mock("./use-create-task-from-message", () => ({
  useCreateTaskFromMessage: () => () => {},
}))
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom: h.scrollToBottom }),
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
  CollapsibleUserMessage: () => <div>question</div>,
}))

import { getFolderConversation } from "@/lib/api"
import {
  requestScrollToLatest,
  resetScrollToLatestIntents,
  takeScrollToLatest,
} from "@/lib/scroll-to-latest-intent"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
const CONVERSATION = 7

const HISTORY: MessageTurn[] = [
  {
    id: "turn-0",
    role: "user",
    blocks: [{ type: "text", text: "question" }],
    timestamp: "2026-10-02T10:00:00.000Z",
  },
  {
    id: "turn-1",
    role: "assistant",
    blocks: [{ type: "text", text: "answer" }],
    timestamp: "2026-10-02T10:00:01.000Z",
  },
]

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
      created_at: "2026-10-02T10:00:00.000Z",
      updated_at: "2026-10-02T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
  }
}

/** Load the history into the store the way a detail fetch would. */
async function seed() {
  mockGetFolderConversation.mockResolvedValue(detail(HISTORY))
  await act(async () => {
    await useConversationRuntimeStore
      .getState()
      .actions.refetchDetail(CONVERSATION)
  })
}

type ListProps = Partial<ComponentProps<typeof MessageListView>>

function renderList(props: ListProps = {}) {
  const element = (next: ListProps) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageListView
        conversationId={CONVERSATION}
        agentType="claude_code"
        connStatus="connected"
        showMessageNav={false}
        {...props}
        {...next}
      />
    </NextIntlClientProvider>
  )
  const view = render(element({}))
  return { update: (next: ListProps) => view.rerender(element(next)) }
}

beforeEach(() => {
  resetConversationRuntimeStore()
  resetScrollToLatestIntents()
  mockGetFolderConversation.mockReset()
  h.scrollToBottom.mockClear()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("MessageListView: latest message on a notification click", () => {
  it("jumps an open transcript, scrolled anywhere, to its latest message", async () => {
    await seed()
    renderList()
    expect(h.scrollToBottom).not.toHaveBeenCalled()

    act(() => requestScrollToLatest([CONVERSATION]))
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")
  })

  it("waits for history that arrives after the tab opened", async () => {
    // The click reopened the tab: active at once, transcript still loading.
    requestScrollToLatest([CONVERSATION])
    const { update } = renderList({ detailLoading: true })
    expect(h.scrollToBottom).not.toHaveBeenCalled()

    await seed()
    // Rows are in, the fetch has not settled yet: still waiting.
    expect(h.scrollToBottom).not.toHaveBeenCalled()

    update({ detailLoading: false })
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")
    expect(takeScrollToLatest([CONVERSATION])).toBe(false)
  })

  it("is answered by the active transcript only", async () => {
    await seed()
    requestScrollToLatest([CONVERSATION])
    const { update } = renderList({ isActive: false })
    expect(h.scrollToBottom).not.toHaveBeenCalled()

    update({ isActive: true })
    expect(h.scrollToBottom).toHaveBeenCalledWith("instant")
  })

  it("leaves a plain tab switch at the position it had", async () => {
    await seed()
    const { update } = renderList({ isActive: false })
    update({ isActive: true })
    update({ isActive: false })
    update({ isActive: true })
    expect(h.scrollToBottom).not.toHaveBeenCalled()
  })
})
