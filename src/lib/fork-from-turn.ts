import {
  acpFork,
  acpForkToNewConversation,
  type ForkToNewConversationResult,
} from "@/lib/api"
import { TurnBusyError } from "@/lib/turn-busy"
import type { AgentType } from "@/lib/types"
import { useTabStore } from "@/stores/tab-store"

/**
 * "Fork from here", and where the fork lands.
 *
 * Between turns the fork is IN PLACE: the conversation's own row and
 * connection move to the forked session, and a sibling row keeps the original
 * (`ConnectionManager::fork_session`). That has to wait for a running turn to
 * end — so, for the agents that can, a fork taken while a turn runs goes the
 * way native Claude Code's `--fork-session` does instead: a separate agent
 * process forks the session from its transcript into a NEW conversation,
 * which opens in a new tab, and the running turn carries on untouched
 * (`ConnectionManager::fork_session_to_new_conversation`).
 */

/**
 * Agents whose "Fork from here" works while a turn is running. Mirrors
 * `forks_while_running` in `acp/fork.rs`, which says why only these: their
 * fork must read a transcript another process is still writing, safely.
 */
const FORK_WHILE_RUNNING_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>([
  "claude_code",
])

/** Whether this agent can fork while a turn is running (into a new tab). */
export function supportsForkWhileRunning(agentType: AgentType): boolean {
  return FORK_WHILE_RUNNING_AGENTS.has(agentType)
}

/**
 * The fork could not run because a turn is in flight and this agent only
 * forks between turns. Transient: the same click works once the turn ends.
 */
export class ForkBetweenTurnsOnlyError extends Error {
  constructor() {
    super("this agent can only fork between turns")
    this.name = "ForkBetweenTurnsOnlyError"
  }
}

// Substring of the backend `AcpError::ForkNeedsIdle` Display string — the
// error text on both transports (see `turn-busy.ts` for why it is matched by
// text).
const FORK_NEEDS_IDLE_MARKER = "can only fork between turns"

/** True when `err` is the backend's "this agent can only fork between turns"
 *  refusal, as a bare string (Tauri) or an error object (web). */
export function isForkNeedsIdleRejection(err: unknown): boolean {
  if (typeof err === "string") return err.includes(FORK_NEEDS_IDLE_MARKER)
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string")
      return message.includes(FORK_NEEDS_IDLE_MARKER)
  }
  return false
}

export type ForkFromTurnOutcome =
  /** Forked in place: this conversation now runs on `forkedSessionId`. */
  | { kind: "in_place"; forkedSessionId: string }
  /** Forked into a new conversation; the one on screen is untouched. */
  | { kind: "new_conversation"; result: ForkToNewConversationResult }

/**
 * Fork at `turnId` — in place when no turn runs, into a new conversation when
 * one does (or starts under the click) and the agent can.
 *
 * `turnRunning` is what the surface knows; the backend has the last word. A
 * turn that started before the in-place fork reached it comes back as
 * `TurnBusyError`, and is then forked into a new conversation as if the click
 * had landed mid-turn. Rejects with {@link ForkBetweenTurnsOnlyError} for an
 * agent that has to wait for the turn, and as the API calls do otherwise.
 */
export async function forkFromTurn({
  agentType,
  connectionId,
  conversationId,
  folderId,
  turnId,
  turnRunning,
}: {
  agentType: AgentType
  connectionId: string
  /** The conversation's row, for a connection that has not linked it yet. */
  conversationId: number | null
  folderId: number | null
  /** The reply to fork at (the parser's id). */
  turnId: string
  /** A turn is running on the connection, as far as the surface knows. */
  turnRunning: boolean
}): Promise<ForkFromTurnOutcome> {
  const intoNewConversation = async (): Promise<ForkFromTurnOutcome> => {
    if (!supportsForkWhileRunning(agentType)) {
      throw new ForkBetweenTurnsOnlyError()
    }
    try {
      const result = await acpForkToNewConversation(
        connectionId,
        conversationId,
        turnId
      )
      return { kind: "new_conversation", result }
    } catch (err) {
      if (isForkNeedsIdleRejection(err)) throw new ForkBetweenTurnsOnlyError()
      throw err
    }
  }

  if (turnRunning) return intoNewConversation()
  try {
    const { forkedSessionId } = await acpFork(
      connectionId,
      conversationId,
      folderId,
      turnId
    )
    return { kind: "in_place", forkedSessionId }
  } catch (err) {
    if (err instanceof TurnBusyError) return intoNewConversation()
    throw err
  }
}

/**
 * Open the conversation a mid-turn fork created, in a new pinned tab right
 * after `besideTabId` (the tab it was forked from) when that tab is still
 * open, and focus it. The tab opens the row like any other conversation:
 * it loads the forked transcript and connects to it on its own.
 */
export function openForkedConversationTab(
  result: ForkToNewConversationResult,
  agentType: AgentType,
  besideTabId: string | null
): void {
  const store = useTabStore.getState()
  const beside =
    besideTabId == null
      ? -1
      : store.rawTabs.findIndex((tab) => tab.id === besideTabId)
  store.openTab(
    result.folderId,
    result.conversationId,
    agentType,
    true,
    result.title ?? undefined,
    beside >= 0 ? { index: beside + 1 } : undefined
  )
}
