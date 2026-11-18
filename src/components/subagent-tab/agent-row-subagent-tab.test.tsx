import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { AgentType } from "@/lib/types"
import { ContentPartsRenderer } from "@/components/message/content-parts-renderer"
import { TranscriptAgentTypeProvider } from "@/components/message/transcript-agent-context"
import { TranscriptConversationProvider } from "@/components/message/transcript-conversation-context"
import { resetTabStore, useTabStore } from "@/stores/tab-store"

/**
 * A Claude Code Agent card opens its sub-agent's thread in a tab — only for
 * Claude Code, and only when the thread is known or expected to be on disk.
 */

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

const STORE: ConnectionStoreApi = {
  getConnection: () => undefined,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeKey: () => () => {},
  subscribeActiveKey: () => () => {},
}
const DELEGATION: DelegationContextValue = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: () => undefined,
  bindingsForParent: () => [],
}

const openSubagentTab = vi.fn(() => "sub-tab")

beforeEach(() => {
  resetTabStore()
  openSubagentTab.mockClear()
  useTabStore.setState({ openSubagentTab })
})

afterEach(() => {
  resetTabStore()
})

function renderCard(
  part: ToolCallPart,
  { agent = "claude_code", conversationId = 7 } = {} as {
    agent?: AgentType
    conversationId?: number | null
  }
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <TranscriptAgentTypeProvider value={agent}>
            <TranscriptConversationProvider value={conversationId}>
              <ContentPartsRenderer parts={[part]} role="assistant" />
            </TranscriptConversationProvider>
          </TranscriptAgentTypeProvider>
        </StaticDelegationProvider>
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

const INPUT = JSON.stringify({
  subagent_type: "Explore",
  description: "Find the bug",
  prompt: "Look in src/",
})

function agentCall(
  state: ToolCallPart["state"],
  extra: Partial<ToolCallPart> = {}
): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "toolu_01Agent",
    toolName: "agent",
    input: INPUT,
    state,
    ...extra,
  }
}

const openButton = () =>
  screen.queryByRole("button", {
    name: enMessages.Folder.chat.delegation.openDetail,
  })

describe("a Claude Code Agent card's thread tab", () => {
  it("opens the sub-agent the parser found on disk", () => {
    renderCard(
      agentCall("output-available", {
        output: "It is in main.rs.",
        agentStats: {
          agent_type: "Explore",
          status: "completed",
          subagent_id: "a1b2c3d4e5f6",
        },
      })
    )
    fireEvent.click(openButton()!)
    expect(openSubagentTab).toHaveBeenCalledWith({
      parentConversationId: 7,
      toolCallId: "toolu_01Agent",
      agentId: "a1b2c3d4e5f6",
      subagentType: "Explore",
      description: "Find the bug",
    })
  })

  it("offers nothing when the parsed card names no file on disk", () => {
    renderCard(
      agentCall("output-available", {
        output: "It is in main.rs.",
        agentStats: { agent_type: "Explore", status: "completed" },
      })
    )
    expect(openButton()).not.toBeInTheDocument()
  })

  it("opens a running call's sub-agent, found by the call", () => {
    renderCard(agentCall("input-available"))
    fireEvent.click(openButton()!)
    expect(openSubagentTab).toHaveBeenCalledWith(
      expect.objectContaining({
        parentConversationId: 7,
        toolCallId: "toolu_01Agent",
      })
    )
    const [first] = openSubagentTab.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ]
    expect(first.agentId).toBeUndefined()
  })

  it("reads the id a live result names", () => {
    renderCard(
      agentCall("output-available", {
        output:
          "It is in main.rs.\nagentId: a9f8e7d6c5b4 (use SendMessage with to: 'a9f8e7d6c5b4' to continue this agent)",
      })
    )
    fireEvent.click(openButton()!)
    expect(openSubagentTab).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "a9f8e7d6c5b4" })
    )
  })

  it("is Claude Code only: another agent's card keeps its own behaviour", () => {
    renderCard(
      agentCall("output-available", {
        output: "It is in main.rs.\nagentId: a9f8e7d6c5b4",
        agentStats: { status: "completed", subagent_id: "a1b2c3d4e5f6" },
      }),
      { agent: "codex" }
    )
    expect(openButton()).not.toBeInTheDocument()
    expect(openSubagentTab).not.toHaveBeenCalled()
  })

  it("needs the session it belongs to", () => {
    renderCard(agentCall("input-available"), { conversationId: null })
    expect(openButton()).not.toBeInTheDocument()
  })

  it("is not offered while the call's arguments still stream", () => {
    renderCard(agentCall("input-streaming"))
    expect(openButton()).not.toBeInTheDocument()
  })
})
