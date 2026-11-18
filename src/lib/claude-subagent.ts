/**
 * Claude Code sub-agents opened as threads of their own (a sub-agent tab):
 * which Agent card can open one, and with what.
 *
 * Claude Code writes every sub-agent's conversation to its own transcript
 * beside the session's (`<session>/subagents/agent-<agentId>.jsonl`), and the
 * backend reads it for the tab (`get_claude_subagent_thread`). The card knows
 * the sub-agent's id once its call has a result — the parser records it as
 * `agent_stats.subagent_id` while the file is on disk, a background launch's
 * marker carries it as its task id, and a live result's text names it — and a
 * call still running has written its file already, which the backend finds by
 * the call itself. A card that knows neither offers nothing: a button that
 * opens an empty tab is worse than none.
 */

import type { SubagentTabTarget } from "@/stores/tab-store"
import type { AgentExecutionStats, AgentType } from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

/** `agentId: a1b2…` as Claude Code ends an Agent call's result (a report's
 *  trailer, a background launch's acknowledgement). */
const AGENT_ID_IN_RESULT = /\bagentId:\s*([A-Za-z0-9_-]{6,64})\b/

/** The sub-agent id an Agent call's result text names, if any. */
export function agentIdFromResultText(
  text: string | null | undefined
): string | null {
  if (!text) return null
  return AGENT_ID_IN_RESULT.exec(text)?.[1] ?? null
}

export interface ClaudeSubagentCard {
  /** The agent whose transcript the card is in. */
  transcriptAgentType: AgentType | null
  /** The conversation (DB row) whose transcript the card is in. */
  parentConversationId: number | null
  toolCallId: string
  state: ToolCallState
  output: string | null | undefined
  /** The parsed result's stats (history): present once the call settled. */
  agentStats: AgentExecutionStats | null
  /** A background launch's task id (its lifecycle marker), if it is one. */
  backgroundTaskId: string | null
  subagentType: string | null
  description: string | null
}

/**
 * What a Claude Code Agent card's "open" opens: its sub-agent's thread, or
 * `null` when there is none to open. Claude Code only — the other agents'
 * sub-agents open the way they always have.
 */
export function claudeSubagentTarget(
  card: ClaudeSubagentCard
): SubagentTabTarget | null {
  if (card.transcriptAgentType !== "claude_code") return null
  if (card.parentConversationId == null || !card.toolCallId) return null
  const target = (agentId: string | null): SubagentTabTarget => ({
    parentConversationId: card.parentConversationId as number,
    toolCallId: card.toolCallId,
    ...(agentId ? { agentId } : {}),
    ...(card.subagentType ? { subagentType: card.subagentType } : {}),
    ...(card.description ? { description: card.description } : {}),
  })
  // Parsed from disk: the parser says whether the file is there.
  if (card.agentStats) {
    return card.agentStats.subagent_id
      ? target(card.agentStats.subagent_id)
      : null
  }
  const agentId =
    card.backgroundTaskId ?? agentIdFromResultText(card.output) ?? null
  if (agentId) return target(agentId)
  // Running: the sub-agent writes its transcript as it starts.
  return card.state === "input-available" ? target(null) : null
}

/** The runtime key a sub-agent tab shows its thread under: negative, so it is
 *  never taken for a conversation row, and stable per tab. */
export function subagentRuntimeId(tabId: string): number {
  const seed = `subagent:${tabId}`
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return -(Math.abs(hash) + 1)
}
