/**
 * Read aloud from the transcript: the "Read last reply" shortcut and reading
 * a reply automatically when its turn settles.
 *
 * Renders the real `MessageListView` over a seeded runtime store, with the
 * speech engine replaced by one that records what it is asked to say. The
 * rest of what it mounts is stubbed as in `message-list-view-fork.test.tsx`.
 */
import type { ComponentProps, ReactNode } from "react"
import { act, fireEvent, render } from "@testing-library/react"
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
  CollapsibleUserMessage: () => <div>prompt</div>,
}))

import { getFolderConversation } from "@/lib/api"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_READ_ALOUD_PREFS,
  resetReadAloudPrefsCacheForTests,
  saveReadAloudPrefs,
} from "@/lib/read-aloud/prefs"
import { installFakeSpeech, type FakeSynth } from "@/lib/read-aloud/testing"
import { MessageListView } from "./message-list-view"

const mockGetFolderConversation = vi.mocked(getFolderConversation)
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

const HISTORY = [
  turn("turn-0", "user", "hi"),
  turn("turn-1", "assistant", "First answer."),
  turn("turn-2", "user", "and then?"),
  turn("turn-3", "assistant", "שלום! The **last** answer.\n\n```\ncode\n```"),
]

const LIVE: LiveMessage = {
  id: "lm-1",
  role: "assistant",
  content: [{ type: "text", text: "Counting done." }],
  startedAt: Date.now(),
}

async function seedHistory(turns = HISTORY) {
  mockGetFolderConversation.mockResolvedValue(detail(turns))
  const actions = useConversationRuntimeStore.getState().actions
  expect(await actions.refetchDetail(CONVERSATION)).toBe(true)
}

type ListProps = Partial<ComponentProps<typeof MessageListView>>

function list(props: ListProps = {}) {
  return (
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

function pressReadLastReply() {
  fireEvent.keyDown(document, {
    key: "l",
    code: "KeyL",
    ctrlKey: true,
    shiftKey: true,
  })
}

let synth: FakeSynth
let uninstall: () => void

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGetFolderConversation.mockReset()
  localStorage.clear()
  resetReadAloudPrefsCacheForTests()
  ;({ synth, uninstall } = installFakeSpeech())
})

afterEach(() => {
  uninstall()
  resetConversationRuntimeStore()
})

describe("MessageListView: read last reply", () => {
  it("reads the newest reply, skipping its code, and stops on a second press", async () => {
    await seedHistory()
    render(list())

    act(() => pressReadLastReply())
    expect(synth.spoken.map((u) => [u.text, u.lang])).toEqual([
      ["שלום!", "he-IL"],
    ])
    act(() => {
      expect(synth.finishAll()).toEqual(["שלום!", "The last answer."])
    })

    act(() => pressReadLastReply())
    expect(synth.current?.text).toBe("שלום!")
    act(() => pressReadLastReply())
    expect(synth.current).toBeNull()
    expect(synth.cancels).toBe(1)
  })

  it("leaves the key alone in a transcript that is not active", async () => {
    await seedHistory()
    render(list({ isActive: false }))
    act(() => pressReadLastReply())
    expect(synth.spoken).toHaveLength(0)
  })

  it("follows a rebound key", async () => {
    localStorage.setItem(
      "settings:shortcuts:v1",
      JSON.stringify({ read_last_reply: "mod+alt+r" })
    )
    await seedHistory()
    render(list())
    act(() => pressReadLastReply())
    expect(synth.spoken).toHaveLength(0)
    act(() => {
      fireEvent.keyDown(document, {
        key: "®",
        code: "KeyR",
        metaKey: true,
        altKey: true,
      })
    })
    expect(synth.spoken).toHaveLength(1)
  })
})

describe("MessageListView: read replies automatically", () => {
  async function runTurn(props: ListProps = {}) {
    await seedHistory([...HISTORY, turn("turn-4", "user", "count")])
    const actions = useConversationRuntimeStore.getState().actions
    actions.setLiveMessage(CONVERSATION, LIVE, true)
    const view = render(list({ connStatus: "prompting", ...props }))
    expect(synth.spoken).toHaveLength(0)
    act(() => {
      actions.completeTurn(CONVERSATION, LIVE)
    })
    view.rerender(list({ connStatus: "connected", ...props }))
    return view
  }

  it("reads the reply when its turn settles, with the setting on", async () => {
    saveReadAloudPrefs({ ...DEFAULT_READ_ALOUD_PREFS, autoRead: true })
    await runTurn()
    expect(synth.spoken.map((u) => u.text)).toEqual(["Counting done."])
  })

  it("stays quiet with the setting off (the default)", async () => {
    await runTurn()
    expect(synth.spoken).toHaveLength(0)
  })

  it("stays quiet in a background tab", async () => {
    saveReadAloudPrefs({ ...DEFAULT_READ_ALOUD_PREFS, autoRead: true })
    await runTurn({ isActive: false })
    expect(synth.spoken).toHaveLength(0)
  })

  it("does not read history when a conversation is opened", async () => {
    saveReadAloudPrefs({ ...DEFAULT_READ_ALOUD_PREFS, autoRead: true })
    await seedHistory()
    render(list())
    expect(synth.spoken).toHaveLength(0)
  })
})
