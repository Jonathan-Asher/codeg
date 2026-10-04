/**
 * "Fork from here" in the transcript while a turn is running: which replies
 * can still be forked, and what the reply being written says instead.
 *
 * Renders the real `MessageListView` — with the real per-reply footer and
 * live stats bar, which carry the fork buttons — over a seeded runtime store.
 * The rest of what it mounts (virtualizer, overlays, rendered markdown) is
 * stubbed as in `message-list-view-edit.test.tsx`.
 */
import type { ComponentProps, ReactNode } from "react"
import { render, screen, within } from "@testing-library/react"
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
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
const L = enMessages.Folder.chat.messageList
const LIVE = enMessages.Folder.chat.liveTurnStats
const CONVERSATION = 7

function turn(
  id: string,
  role: "user" | "assistant",
  text: string
): MessageTurn {
  return {
    id,
    role,
    blocks: [{ type: "text", text }],
    timestamp: "2026-10-04T10:00:00.000Z",
    usage: { input_tokens: 10, output_tokens: 20 },
    duration_ms: 1200,
  } as MessageTurn
}

function detail(turns: MessageTurn[]): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "sess-1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-10-04T10:00:00.000Z",
      updated_at: "2026-10-04T10:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
  }
}

/** Two finished exchanges, then the prompt of the turn that is running. */
const HISTORY = [
  turn("turn-0", "user", "hi"),
  turn("turn-1", "assistant", "hello"),
  turn("turn-2", "user", "list the files"),
  turn("turn-3", "assistant", "a.txt b.txt"),
  turn("turn-4", "user", "count slowly to 30"),
]

/** Load `turns`, then put the running reply on screen as it streams. */
async function seedRunning() {
  mockGetFolderConversation.mockResolvedValue(detail(HISTORY))
  const actions = useConversationRuntimeStore.getState().actions
  expect(await actions.refetchDetail(CONVERSATION)).toBe(true)
  actions.setLiveMessage(
    CONVERSATION,
    {
      id: "lm-1",
      role: "assistant",
      content: [{ type: "text", text: "1, 2, 3" }],
      startedAt: Date.now(),
    },
    true
  )
}

type ListProps = Partial<ComponentProps<typeof MessageListView>>

function renderList(props: ListProps = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageListView
        conversationId={CONVERSATION}
        agentType="claude_code"
        connStatus="prompting"
        showMessageNav={false}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

/** The fork button in the footer of the reply with this id. */
function replyForkButton(container: HTMLElement, turnId: string) {
  const row = container.querySelector<HTMLElement>(
    `[data-find-key="persisted-assistant-${turnId}"]`
  )
  if (!row) throw new Error(`no row for ${turnId}`)
  return within(row).getByRole("button", { name: L.forkFromHere })
}

/** The fork button on the live stats bar under the reply being written. */
function liveForkButton() {
  const buttons = screen.queryAllByRole("button", { name: L.forkFromHere })
  return (
    buttons.find(
      (b) => !b.closest('[data-find-key^="persisted-assistant-"]')
    ) ?? null
  )
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("MessageListView: fork from here while a turn runs", () => {
  it("keeps every finished reply forkable on an agent that forks mid-run", async () => {
    await seedRunning()
    const onForkFromTurn = vi.fn()
    const { container } = renderList({
      onForkFromTurn,
      forkWhileRunning: true,
    })
    for (const id of ["turn-1", "turn-3"]) {
      expect(replyForkButton(container, id)).not.toHaveAttribute(
        "aria-disabled"
      )
    }
    await userEvent.click(replyForkButton(container, "turn-1"))
    expect(onForkFromTurn).toHaveBeenCalledWith("turn-1")
  })

  it("greys out the reply being written, and says why", async () => {
    await seedRunning()
    const onForkFromTurn = vi.fn()
    renderList({ onForkFromTurn, forkWhileRunning: true })
    // The running reply has no footer until it settles; its button lives on
    // the live stats bar, disabled.
    const live = liveForkButton()
    expect(live).not.toBeNull()
    expect(live).toHaveAttribute("aria-disabled", "true")
    // Hover before the click: a press closes a Radix tooltip until the
    // pointer leaves.
    await userEvent.hover(live!)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      LIVE.forkInFlight
    )
    await userEvent.click(live!)
    expect(onForkFromTurn).not.toHaveBeenCalled()
  })

  it("greys out every reply on an agent that forks only between turns", async () => {
    await seedRunning()
    const onForkFromTurn = vi.fn()
    const { container } = renderList({
      agentType: "codex",
      onForkFromTurn,
      forkWhileRunning: false,
    })
    const button = replyForkButton(container, "turn-1")
    expect(button).toHaveAttribute("aria-disabled", "true")
    await userEvent.hover(button)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(L.forkBusy)
    await userEvent.click(button)
    expect(onForkFromTurn).not.toHaveBeenCalled()
    // Nothing on the live bar either: the turn as a whole is the reason.
    expect(liveForkButton()).toBeNull()
  })

  it("offers no fork on the live bar where the surface can't fork at all", async () => {
    await seedRunning()
    renderList({ forkWhileRunning: true })
    expect(liveForkButton()).toBeNull()
  })

  it("keeps a reply this session streamed forkable while the turn runs", async () => {
    // Still named `live-…` (the reparse that names it waits for the turn to
    // end): the host names it from a fresh read before forking, so the button
    // must not grey out as "not ready" — and it hands over that live id.
    mockGetFolderConversation.mockResolvedValue(
      detail([
        turn("turn-0", "user", "hi"),
        turn("live-3-lm-1", "assistant", "hello"),
        turn("turn-2", "user", "count slowly to 30"),
      ])
    )
    const actions = useConversationRuntimeStore.getState().actions
    expect(await actions.refetchDetail(CONVERSATION)).toBe(true)
    const onForkFromTurn = vi.fn()
    const { container } = renderList({
      onForkFromTurn,
      forkWhileRunning: true,
    })
    const button = replyForkButton(container, "live-3-lm-1")
    expect(button).not.toHaveAttribute("aria-disabled")
    await userEvent.click(button)
    expect(onForkFromTurn).toHaveBeenCalledWith("live-3-lm-1")
  })

  it("forks as before between turns", async () => {
    mockGetFolderConversation.mockResolvedValue(
      detail([...HISTORY, turn("turn-5", "assistant", "1 … 30")])
    )
    expect(
      await useConversationRuntimeStore
        .getState()
        .actions.refetchDetail(CONVERSATION)
    ).toBe(true)
    const onForkFromTurn = vi.fn()
    const { container } = renderList({
      connStatus: "connected",
      onForkFromTurn,
      forkWhileRunning: true,
    })
    await userEvent.click(replyForkButton(container, "turn-5"))
    expect(onForkFromTurn).toHaveBeenCalledWith("turn-5")
    expect(liveForkButton()).toBeNull()
  })
})
