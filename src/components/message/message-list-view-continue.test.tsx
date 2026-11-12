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
import {
  RESUME_AFTER_RESTART_PROMPT,
  RESUME_BACKGROUND_PROMPT_HEAD,
  RESUME_BACKGROUND_PROMPT_TAIL,
  RESUME_TURN_BACKGROUND_HEADER,
} from "@/lib/auto-resume"
import { LIMIT_CONTINUE_PROMPT } from "@/lib/limit-continue"
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

describe("MessageListView: resumed after restart", () => {
  it("renders the resume prompt read back from the session file as its own divider", async () => {
    await seed([
      userTurn("turn-0", "run the migration in three steps"),
      replyTurn("turn-1", "step one done"),
      userTurn("turn-2", RESUME_AFTER_RESTART_PROMPT),
      replyTurn("turn-3", "steps two and three done"),
    ])
    const { container } = renderList({ onEditUserMessage: vi.fn() })

    const row = rowFor(container, "persisted-user-turn-2")
    expect(row.querySelector("[data-resume-marker]")).toBeInTheDocument()
    expect(within(row).getByText(L.resumedAfterRestart)).toBeInTheDocument()
    expect(
      within(row).getByTitle(L.resumedAfterRestartHint)
    ).toBeInTheDocument()
    // Neither a bubble nor the Continue label, and nothing to edit on it.
    expect(within(row).queryByTestId("user-bubble")).toBeNull()
    expect(within(row).queryByText(L.continued)).toBeNull()
    expect(
      within(row).queryByRole("button", { name: L.editMessage })
    ).toBeNull()
    expect(container.querySelectorAll("[data-resume-marker]")).toHaveLength(1)
  })

  it("renders the prompt as a divider live, as a watching client receives it", async () => {
    await seed([
      userTurn("turn-0", "run the migration in three steps"),
      replyTurn("turn-1", "step one done"),
    ])
    // The backend sent the prompt; a client watching the session gets it as
    // the cross-client user-message echo, not as an optimistic turn of its own.
    useConversationRuntimeStore
      .getState()
      .actions.appendViewerUserTurn(
        CONVERSATION,
        userTurn("auto-resume-1", RESUME_AFTER_RESTART_PROMPT)
      )
    const { container } = renderList({ connStatus: "prompting" })

    const markers = container.querySelectorAll<HTMLElement>(
      "[data-resume-marker]"
    )
    expect(markers).toHaveLength(1)
    expect(
      markers[0].closest("[data-find-key]")?.getAttribute("data-find-key")
    ).not.toMatch(/^persisted-/)
    expect(
      within(markers[0]).getByText(L.resumedAfterRestart)
    ).toBeInTheDocument()
    expect(
      container.querySelectorAll('[data-testid="user-bubble"]')
    ).toHaveLength(1)
  })

  it("keeps a message that merely contains the prompt as a bubble", async () => {
    await seed([
      userTurn("turn-0", `${RESUME_AFTER_RESTART_PROMPT} Also run the tests.`),
      replyTurn("turn-1", "ok"),
    ])
    const { container } = renderList()

    expect(container.querySelector("[data-resume-marker]")).toBeNull()
    expect(
      within(rowFor(container, "persisted-user-turn-0")).getByTestId(
        "user-bubble"
      )
    ).toBeInTheDocument()
  })

  it("labels a resume of stopped background work, and lists that work in its tooltip", async () => {
    const prompt = [
      RESUME_BACKGROUND_PROMPT_HEAD,
      "- sub-agent: Review the parser (started 13:02)",
      "- background shell: sleep 900",
      RESUME_BACKGROUND_PROMPT_TAIL,
    ].join("\n")
    await seed([
      userTurn("turn-0", "audit the repo in the background"),
      replyTurn("turn-1", "launched"),
      userTurn("turn-2", prompt),
      replyTurn("turn-3", "re-launched"),
    ])
    const { container } = renderList()

    const row = rowFor(container, "persisted-user-turn-2")
    const marker = row.querySelector("[data-resume-marker]")
    expect(marker).toBeInTheDocument()
    expect(marker).toHaveAttribute("data-resume-background", "true")
    const label = within(row).getByText(L.resumedAfterRestartBackground)
    expect(within(row).queryByText(L.resumedAfterRestart)).toBeNull()
    // One line per stopped item under the hint (the title keeps the breaks).
    expect(label.getAttribute("title")).toBe(
      [
        L.resumedAfterRestartBackgroundHint,
        "• sub-agent: Review the parser (started 13:02)",
        "• background shell: sleep 900",
      ].join("\n")
    )
    expect(within(row).queryByTestId("user-bubble")).toBeNull()
  })

  it("keeps the plain label for a cut-off turn that also listed its background work", async () => {
    await seed([
      userTurn("turn-0", "build it"),
      replyTurn("turn-1", "building"),
      userTurn(
        "turn-2",
        `${RESUME_AFTER_RESTART_PROMPT}\n\n${RESUME_TURN_BACKGROUND_HEADER}\n- monitor: main run: errors`
      ),
      replyTurn("turn-3", "built"),
    ])
    const { container } = renderList()

    const row = rowFor(container, "persisted-user-turn-2")
    const marker = row.querySelector("[data-resume-marker]")
    expect(marker).toBeInTheDocument()
    expect(marker).not.toHaveAttribute("data-resume-background")
    expect(
      within(row).getByText(L.resumedAfterRestart).getAttribute("title")
    ).toBe(`${L.resumedAfterRestartHint}\n• monitor: main run: errors`)
  })
})

describe("MessageListView: continued after the usage limit reset", () => {
  it("renders the continuation read back from the session file as its own divider", async () => {
    await seed([
      userTurn("turn-0", "refactor the parser"),
      replyTurn("turn-1", "half done"),
      userTurn("turn-2", LIMIT_CONTINUE_PROMPT),
      replyTurn("turn-3", "the rest is done"),
    ])
    const { container } = renderList({ onEditUserMessage: vi.fn() })

    const row = rowFor(container, "persisted-user-turn-2")
    expect(
      row.querySelector("[data-limit-continue-marker]")
    ).toBeInTheDocument()
    expect(within(row).getByText(L.continuedAfterLimit)).toBeInTheDocument()
    expect(
      within(row).getByTitle(L.continuedAfterLimitHint)
    ).toBeInTheDocument()
    // Not a bubble, not the other dividers, and nothing to edit on it.
    expect(within(row).queryByTestId("user-bubble")).toBeNull()
    expect(within(row).queryByText(L.continued)).toBeNull()
    expect(within(row).queryByText(L.resumedAfterRestart)).toBeNull()
    expect(
      within(row).queryByRole("button", { name: L.editMessage })
    ).toBeNull()
  })

  it("renders the continuation as a divider live, as a watching client receives it", async () => {
    await seed([
      userTurn("turn-0", "refactor the parser"),
      replyTurn("turn-1", "half done"),
    ])
    // The backend sent it with no window open on the session; a client
    // watching gets the cross-client user-message echo.
    useConversationRuntimeStore
      .getState()
      .actions.appendViewerUserTurn(
        CONVERSATION,
        userTurn("limit-continue-1", LIMIT_CONTINUE_PROMPT)
      )
    const { container } = renderList({ connStatus: "prompting" })

    const markers = container.querySelectorAll<HTMLElement>(
      "[data-limit-continue-marker]"
    )
    expect(markers).toHaveLength(1)
    expect(
      within(markers[0]).getByText(L.continuedAfterLimit)
    ).toBeInTheDocument()
    expect(
      container.querySelectorAll('[data-testid="user-bubble"]')
    ).toHaveLength(1)
  })

  it("keeps a message that merely contains the prompt as a bubble", async () => {
    await seed([
      userTurn("turn-0", `${LIMIT_CONTINUE_PROMPT} And add tests.`),
      replyTurn("turn-1", "ok"),
    ])
    const { container } = renderList()

    expect(container.querySelector("[data-limit-continue-marker]")).toBeNull()
    expect(
      within(rowFor(container, "persisted-user-turn-0")).getByTestId(
        "user-bubble"
      )
    ).toBeInTheDocument()
  })
})
