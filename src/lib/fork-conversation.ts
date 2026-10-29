"use client"

import {
  acpForkConversation,
  type ForkToNewConversationResult,
} from "@/lib/api"
import {
  expectedCapabilities,
  NO_CAPABILITIES,
  rememberCapabilities,
  type AgentCapabilities,
} from "@/lib/agent-capabilities"
import {
  ForkBetweenTurnsOnlyError,
  isForkNeedsIdleRejection,
  openForkedConversationTab,
} from "@/lib/fork-from-turn"
import { isTurnRunning } from "@/lib/session-activity"
import type { AgentType, DbConversationSummary } from "@/lib/types"
import { useForkPlaceholderStore } from "@/stores/fork-placeholder-store"
import { useTabStore } from "@/stores/tab-store"

/**
 * "Fork" on a whole conversation, from the sidebar's right-click menu and the
 * conversation header's ⋯ menu: duplicate it, forked at its latest finished
 * reply, into a NEW conversation (`[Fork] <title>`, same folder, unpinned, not
 * critical, same mode and model) that opens in a new tab. The original keeps
 * its row, tab, pin, critical mark and selectors.
 *
 * It needs no connection: the backend finds the session and the reply from
 * the row and forks in an agent process of its own
 * (`ConnectionManager::fork_conversation_to_new_conversation`), which is what
 * lets it work on the sidebar rows nothing has open.
 */

/** Why "Fork" can't run on a conversation right now. */
export type ConversationForkBlock =
  /** The agent can't fork a conversation at all. */
  | "unsupported"
  /** It has no finished reply to fork yet. */
  | "no_reply"
  /** A turn is running, and the agent forks only between turns. */
  | "turn_running"
  /** A fork of it is already on its way. */
  | "forking"

export type ForkableConversation = Pick<
  DbConversationSummary,
  "id" | "agent_type" | "external_id" | "turn_state" | "status"
>

/** Conversations with a fork on its way, so a second click waits for it. */
const forking = new Set<number>()

export function isForkingConversation(conversationId: number): boolean {
  return forking.has(conversationId)
}

/**
 * Why "Fork" is unavailable on `conversation`, or `null` when it can run.
 * `capabilities` defaults to what the agent last said it can do (see
 * `lib/agent-capabilities`). The backend has the last word: a turn that
 * started meanwhile, or a first reply still being written, is refused there
 * (see {@link forkRefusal}).
 */
export function conversationForkBlock(
  conversation: ForkableConversation,
  capabilities: AgentCapabilities = expectedCapabilities(
    conversation.agent_type
  )
): ConversationForkBlock | null {
  if (!capabilities.supportsFork) return "unsupported"
  // No agent session: nothing was ever answered.
  if (!conversation.external_id) return "no_reply"
  if (forking.has(conversation.id)) return "forking"
  if (isTurnRunning(conversation) && !capabilities.forkWhileRunning) {
    return "turn_running"
  }
  return null
}

/** `err`, a bare string (Tauri) or an error object (web), says `marker`.
 *  Backend refusals are matched by text, as `isForkNeedsIdleRejection` is. */
function rejectionSays(err: unknown, marker: string): boolean {
  if (typeof err === "string") return err.includes(marker)
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string") return message.includes(marker)
  }
  return false
}

// Substrings of the backend's refusals: `AcpError::ForkUnsupported`, and
// `acp::fork::NO_FINISHED_REPLY`.
const FORK_UNSUPPORTED_MARKER = "cannot fork a conversation"
const NO_FINISHED_REPLY_MARKER = "no finished reply to fork"

/**
 * What the backend refused a fork for — the same reasons a disabled "Fork"
 * gives — or `null` for a fork that failed.
 */
export function forkRefusal(
  err: unknown
): Exclude<ConversationForkBlock, "forking"> | null {
  if (err instanceof ForkBetweenTurnsOnlyError || isForkNeedsIdleRejection(err))
    return "turn_running"
  if (rejectionSays(err, FORK_UNSUPPORTED_MARKER)) return "unsupported"
  if (rejectionSays(err, NO_FINISHED_REPLY_MARKER)) return "no_reply"
  return null
}

/** Where the forked conversation's tab opens: beside the conversation's own
 *  tab when it is open, else beside the active tab. */
export function forkTabAnchor(conversationId: number): string | null {
  const { rawTabs, activeTabId } = useTabStore.getState()
  return (
    rawTabs.find((tab) => tab.conversationId === conversationId)?.id ??
    activeTabId
  )
}

/**
 * Fork `conversationId` into a new conversation and open it in a new tab,
 * focused, right after `besideTabId`. A "Forking…" placeholder stands there
 * until it opens. `onNewConversation` runs first (the caller refreshes the
 * conversation list there).
 *
 * Rejects as the API call does; {@link forkRefusal} tells a refusal from a
 * failure. An agent that answers it can't fork is remembered as such, so the
 * menus offer it no more. A failed fork leaves nothing behind.
 */
export async function forkConversation({
  conversationId,
  agentType,
  besideTabId,
  onNewConversation,
}: {
  conversationId: number
  agentType: AgentType
  besideTabId: string | null
  onNewConversation?: (result: ForkToNewConversationResult) => void
}): Promise<ForkToNewConversationResult> {
  forking.add(conversationId)
  const placeholders = useForkPlaceholderStore.getState()
  const placeholderId = placeholders.open(besideTabId)
  try {
    const result = await acpForkConversation(conversationId)
    onNewConversation?.(result)
    openForkedConversationTab(result, agentType, besideTabId)
    return result
  } catch (err) {
    if (forkRefusal(err) === "unsupported") {
      rememberCapabilities(agentType, NO_CAPABILITIES)
    }
    throw err
  } finally {
    // In the same tick as the tab opening: the placeholder turns into it.
    placeholders.close(placeholderId)
    forking.delete(conversationId)
  }
}
