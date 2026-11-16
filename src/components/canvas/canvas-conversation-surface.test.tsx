/**
 * A draft card's agent picker stays usable while the card connects, and
 * `connect()` tears the previous agent's connection down only once the new
 * pick gets past its preflight. Until then — and for good when the pick can't
 * connect at all (not installed) — the connection under the card's key still
 * belongs to the agent the user just left, often already `connected`.
 *
 * These pin what the card shows and does in that state: the composer must not
 * offer the old agent's session as the picked one's (its status, its mode and
 * config chips, its commands), a send must not reach it (it waits in the card's
 * queue instead), and a mode change must not file the old agent's mode list
 * under the new agent's saved preference. The heavy children (shell,
 * transcript, picker) and the lifecycle hook are stubbed; the card's own wiring
 * is real.
 */
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import type { AcpAgentInfo, PromptDraft } from "@/lib/types"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const shell = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}))
vi.mock("@/components/chat/conversation-shell", () => ({
  ConversationShell: (props: Record<string, unknown>) => {
    shell.props = props
    return <>{props.children as React.ReactNode}</>
  },
}))

const picker = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}))
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: (props: Record<string, unknown>) => {
    picker.props = props
    return null
  },
}))

vi.mock("@/components/message/message-list-view", () => ({
  MessageListView: () => null,
}))

const cachedSelectors = vi.hoisted(
  () =>
    new Map<
      string,
      { modes: unknown; configOptions: unknown; availableCommands?: unknown }
    >()
)
vi.mock("@/contexts/acp-connections-context", () => {
  // One identity for the card's whole life, like the real provider's actions:
  // the live-message sink effect depends on it.
  const actions = {
    registerLiveMessageSink: () => () => {},
    answerQuestion: vi.fn(),
    answerPlanApproval: vi.fn(),
    dismissSessionFailures: vi.fn(),
  }
  return {
    useAcpActions: () => actions,
    getCachedSelectors: (agentType: string) =>
      cachedSelectors.get(agentType) ?? null,
  }
})

const lifecycle = vi.hoisted(() => ({
  conn: {} as Record<string, unknown>,
  handleSend: vi.fn(),
  handleSetConfigOption: vi.fn(),
}))
vi.mock("@/hooks/use-connection-lifecycle", () => ({
  useConnectionLifecycle: ({ agentType }: { agentType: string }) => {
    // The hook's display rule: the connection's own selectors while it is
    // bound to the card's agent, else that agent's remembered ones.
    const conn = lifecycle.conn
    const own = conn.agentType == null || conn.agentType === agentType
    const cached = cachedSelectors.get(agentType) ?? null
    return {
      conn,
      displayModes: own ? (conn.modes ?? null) : (cached?.modes ?? null),
      displayConfigOptions: own
        ? (conn.configOptions ?? null)
        : (cached?.configOptions ?? null),
      modeLoading: false,
      configOptionsLoading: false,
      selectorsLoading: false,
      autoConnectError: null,
      handleFocus: vi.fn(),
      handleSend: lifecycle.handleSend,
      handleSetConfigOption: lifecycle.handleSetConfigOption,
      handleCancel: vi.fn(),
      handleRespondPermission: vi.fn(),
      presetsPending: false,
      selectorsAwaitConnection: false,
    }
  },
}))

// The queue's notices and the usage-limit pause read the plan-usage stores;
// neither is what these tests are about.
vi.mock("@/hooks/use-queue-notice", () => ({ useQueueNotice: () => null }))
vi.mock("@/components/conversations/limit-pause", () => ({
  useWaitingLimitPause: () => null,
}))

vi.mock("@/hooks/use-conversation-detail", () => ({
  useConversationDetail: () => ({
    detail: null,
    loading: false,
    error: null,
    acpLoadError: null,
  }),
}))

const registry = vi.hoisted(() => ({ agents: [] as AcpAgentInfo[] }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({
    agents: registry.agents,
    fresh: true,
    refresh: vi.fn(),
  }),
}))

const api = vi.hoisted(() => ({
  acpReportPromptSuggestion: vi.fn(),
  acpStopAsyncTask: vi.fn(),
  createChatConversation: vi.fn(),
  createConversation: vi.fn(),
  createChatDir: vi.fn(),
  submitSessionFeedback: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }))

const prefs = vi.hoisted(() => ({
  getSavedModeId: vi.fn((): string | null => null),
  saveModePreference: vi.fn(),
}))
vi.mock("@/lib/selector-prefs-storage", () => prefs)

import { CanvasConversationSurface } from "@/components/canvas/canvas-conversation-surface"
import { resetOutboxStoresForTests } from "@/hooks/use-message-queue"
import { notify } from "@/lib/notify"
import {
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CLAUDE_MODES = {
  current_mode_id: "default",
  available_modes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
}
const CLAUDE_CONFIG = [
  {
    id: "model",
    name: "Model",
    type: "select",
    current_value: "sonnet",
    options: [{ value: "sonnet", name: "Sonnet" }],
  },
]
const CODEX_MODES = {
  current_mode_id: "auto",
  available_modes: [{ id: "auto", name: "Auto" }],
}
const CODEX_CONFIG = [
  {
    id: "model",
    name: "Model",
    type: "select",
    current_value: "gpt-5.5",
    options: [
      { value: "gpt-5.5", name: "GPT-5.5" },
      { value: "gpt-5.4", name: "GPT-5.4" },
    ],
  },
]

function agent(
  agentType: string,
  installedVersion: string | null
): AcpAgentInfo {
  return {
    agent_type: agentType,
    enabled: true,
    available: true,
    installed_version: installedVersion,
    is_acp_adapter: false,
  } as unknown as AcpAgentInfo
}

function connection(agentType: string, status: string) {
  return {
    connectionId: `${agentType}-conn`,
    agentType,
    status,
    connectedWorkingDir: "/tmp/proj",
    sessionId: `${agentType}-session`,
    modes: agentType === "claude_code" ? CLAUDE_MODES : null,
    configOptions: agentType === "claude_code" ? CLAUDE_CONFIG : null,
    availableCommands:
      agentType === "claude_code" ? [{ name: "review", description: "" }] : [],
  }
}

function renderDraftCard() {
  return render(
    <CanvasConversationSurface
      contextKey="canvas-draft-1"
      conversationId={null}
      agentType="codex"
      onAgentTypeChange={vi.fn()}
      draftTarget={{ kind: "folder", folderId: 7, workingDir: "/tmp/proj" }}
      isActive
    />
  )
}

const draft: PromptDraft = {
  blocks: [{ type: "text", text: "hello" }],
  displayText: "hello",
}

describe("a draft card whose connection still belongs to the previous agent", () => {
  beforeEach(() => {
    shell.props = null
    picker.props = null
    cachedSelectors.clear()
    registry.agents = [agent("claude_code", "1.0.0"), agent("codex", "2.0.0")]
    lifecycle.handleSend.mockReset()
    api.createConversation.mockReset()
    api.createChatConversation.mockReset()
    prefs.saveModePreference.mockReset()
    resetOutboxStoresForTests()
    localStorage.clear()
  })
  afterEach(() => cleanup())

  it("keeps the picker usable while the draft is still connecting", () => {
    lifecycle.conn = connection("codex", "connecting")
    renderDraftCard()
    expect(picker.props).not.toBeNull()
    expect(picker.props?.disabled).toBeFalsy()
  })

  it("shows the picked agent's own session once it is the one connected", () => {
    lifecycle.conn = { ...connection("codex", "connected"), modes: CODEX_MODES }
    renderDraftCard()
    expect(shell.props?.status).toBe("connected")
    expect(shell.props?.modes).toEqual(CODEX_MODES.available_modes)
  })

  it("presents the switch as still connecting, with the picked agent's chips", () => {
    // Codex is installed, so its connect is on its way and will replace this.
    cachedSelectors.set("codex", {
      modes: CODEX_MODES,
      configOptions: CODEX_CONFIG,
    })
    lifecycle.conn = connection("claude_code", "connected")
    renderDraftCard()

    expect(shell.props?.status).toBe("connecting")
    expect(shell.props?.modes).toEqual(CODEX_MODES.available_modes)
    // Codex's own list, not Claude's. An edit to it is kept off Claude's
    // connection by the lifecycle hook (use-connection-lifecycle.agent-switch).
    expect(shell.props?.configOptions).toEqual(CODEX_CONFIG)
    expect(shell.props?.onConfigOptionChange).toBe(
      lifecycle.handleSetConfigOption
    )
    expect(shell.props?.selectedModeId).toBe("auto")
    expect(shell.props?.availableCommands).toEqual([])
  })

  it("reads as disconnected when the picked agent is not installed", () => {
    // The preflight refused Codex before tearing Claude's connection down, so
    // that connection stays here, live, for as long as Codex is selected.
    registry.agents = [agent("claude_code", "1.0.0"), agent("codex", null)]
    lifecycle.conn = connection("claude_code", "connected")
    renderDraftCard()
    expect(shell.props?.status).toBe("disconnected")
  })

  it("does not send to the previous agent or file a conversation for it", async () => {
    registry.agents = [agent("claude_code", "1.0.0"), agent("codex", null)]
    lifecycle.conn = connection("claude_code", "connected")
    renderDraftCard()

    const onSend = shell.props?.onSend as (draft: PromptDraft) => void
    await act(async () => {
      onSend(draft)
    })

    expect(api.createConversation).not.toHaveBeenCalled()
    expect(api.createChatConversation).not.toHaveBeenCalled()
    expect(lifecycle.handleSend).not.toHaveBeenCalled()
    // Kept for the picked agent: it waits in the card's queue.
    expect(shell.props?.queue).toHaveLength(1)
  })

  it("does not save the previous agent's modes as the picked agent's preference", () => {
    lifecycle.conn = connection("claude_code", "connected")
    renderDraftCard()

    const onModeChange = shell.props?.onModeChange as (id: string) => void
    act(() => onModeChange("plan"))

    expect(prefs.saveModePreference).not.toHaveBeenCalled()
  })

  it("still sends once the connection is the picked agent's", async () => {
    api.createConversation.mockResolvedValue(42)
    lifecycle.conn = connection("codex", "connected")
    renderDraftCard()

    const onSend = shell.props?.onSend as (draft: PromptDraft) => void
    await act(async () => {
      onSend(draft)
    })

    expect(api.createConversation).toHaveBeenCalledWith(7, "codex", "hello")
    expect(lifecycle.handleSend).toHaveBeenCalledTimes(1)
  })
})

// A card queues what cannot go out yet, but a send can still meet a turn the
// card hadn't heard of yet — one started from another surface, or its
// `prompting` still on the way — and the backend turns it away. The composer
// had already cleared itself for it, so the message must come back where the
// user sees it, waiting in the card's queue, never simply gone (#991).
describe("a send the running turn turns away", () => {
  beforeEach(() => {
    shell.props = null
    registry.agents = [agent("codex", "2.0.0")]
    lifecycle.conn = connection("codex", "connected")
    lifecycle.handleSend.mockReset()
    api.createConversation.mockReset()
    vi.mocked(notify).mockReset()
    resetConversationRuntimeStore()
    resetOutboxStoresForTests()
    localStorage.clear()
  })
  afterEach(() => cleanup())

  type SendOpts = {
    onTurnInProgress?: () => void
    onSendFailed?: (error: unknown) => void
  }

  /** The backend's verdict on the send, as the lifecycle hook reports it. */
  function sendEndsIn(outcome: "turn-in-progress" | "error") {
    lifecycle.handleSend.mockImplementation(
      (_draft: PromptDraft, _modeId: unknown, opts: SendOpts) => {
        if (outcome === "turn-in-progress") opts.onTurnInProgress?.()
        else opts.onSendFailed?.(new Error("payload too large"))
      }
    )
  }

  function renderPinnedCard() {
    return render(
      <CanvasConversationSurface
        contextKey="canvas-node-1"
        conversationId={5}
        agentType="codex"
        isActive
      />
    )
  }

  async function send(message: PromptDraft) {
    const onSend = shell.props?.onSend as (draft: PromptDraft) => void
    await act(async () => {
      onSend(message)
    })
  }

  const queued = () => (shell.props?.queue ?? []) as QueuedMessage[]

  it("puts the message in the card's queue", async () => {
    sendEndsIn("turn-in-progress")
    renderPinnedCard()
    const message: PromptDraft = {
      blocks: [{ type: "text", text: "12" }],
      displayText: "12",
    }

    await send(message)

    // Out of the transcript, since it was never delivered, without leaving the
    // session pinned to a persist that will never come...
    expect(getTimelineTurns(5)).toHaveLength(0)
    expect(
      useConversationRuntimeStore.getState().byConversationId.get(5)?.syncState
    ).toBe("idle")
    // ...and waiting in the queue, whole, to go once the turn is over.
    expect(queued()).toHaveLength(1)
    expect(queued()[0].draft).toEqual(message)
    expect(queued()[0].failure).toBeUndefined()
  })

  it("keeps a second message behind the first", async () => {
    sendEndsIn("turn-in-progress")
    renderPinnedCard()
    const first: PromptDraft = {
      blocks: [{ type: "text", text: "first" }],
      displayText: "first",
    }
    const second: PromptDraft = {
      blocks: [{ type: "text", text: "second" }],
      displayText: "second",
    }

    await send(first)
    await send(second)

    // The second joins the end of the line rather than overtaking the first.
    expect(lifecycle.handleSend).toHaveBeenCalledTimes(1)
    expect(queued().map((item) => item.draft.displayText)).toEqual([
      "first",
      "second",
    ])
  })

  it("queues a draft card's first message the same way", async () => {
    sendEndsIn("turn-in-progress")
    api.createConversation.mockResolvedValue(42)
    renderDraftCard()

    await send(draft)

    expect(lifecycle.handleSend).toHaveBeenCalledTimes(1)
    expect(queued()).toHaveLength(1)
    expect(queued()[0].draft).toEqual(draft)
  })

  it("keeps any other failed send at the front as not sent", async () => {
    sendEndsIn("error")
    renderPinnedCard()

    await send(draft)

    expect(getTimelineTurns(5)).toHaveLength(0)
    expect(queued()).toHaveLength(1)
    expect(queued()[0].failure).toBeDefined()
    expect(notify).not.toHaveBeenCalled()
  })
})
