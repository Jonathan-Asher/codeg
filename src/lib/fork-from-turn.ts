import {
  acpFork,
  acpForkToNewConversation,
  type ForkToNewConversationResult,
} from "@/lib/api"
import { editableUserMessageText } from "@/lib/edit-message"
import { TurnBusyError } from "@/lib/turn-busy"
import type { AgentType, MessageTurn } from "@/lib/types"
import { isLiveTurnId } from "@/stores/conversation-runtime-store"
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

/** Text compared as a person reads it: runs of whitespace are one space. */
function comparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * The reply answering the `promptOrdinal`-th user turn of a freshly parsed
 * transcript: the LAST non-empty turn before the next user turn (or the end),
 * which is where "fork from here" on that reply forks. The prompt must carry
 * `promptText`, or the count has drifted and nothing is returned rather than
 * the wrong reply. `null` when the prompt or its reply can't be found.
 */
export function resolveReplyInTranscript(
  turns: MessageTurn[],
  promptOrdinal: number,
  promptText: string
): string | null {
  let promptIndex = -1
  let usersSeen = 0
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== "user") continue
    if (usersSeen === promptOrdinal) {
      promptIndex = i
      break
    }
    usersSeen += 1
  }
  if (promptIndex < 0) return null
  if (
    comparableText(editableUserMessageText(turns[promptIndex])) !==
    comparableText(promptText)
  ) {
    return null
  }
  let end = turns.length
  for (let i = promptIndex + 1; i < turns.length; i++) {
    if (turns[i].role === "user") {
      end = i
      break
    }
  }
  for (let i = end - 1; i > promptIndex; i--) {
    if (turns[i].blocks.length === 0) continue
    return turns[i].role === "assistant" ? turns[i].id : null
  }
  return null
}

/**
 * The parser's id of a reply "fork from here" was clicked on while a turn
 * runs — the id the backend resolves the fork point by.
 *
 * A reply this session streamed is named `live-…` until the post-turn reparse
 * gives it the parser's name, and that reparse waits out a turn in flight: a
 * follow-up sent soon after a reply leaves it unnamed for exactly the length
 * of the turn a mid-run fork happens in. So read the transcript afresh — a
 * full parse names every turn — and find the reply there by its prompt's
 * place among the user turns, as an edit does (`resolveEditForkTurnId`).
 *
 * `thread` is the settled turns on screen, in order; `readTranscript` returns
 * a fresh parse starting at the same turn the thread does. A parser id is
 * returned as is. `null` when the reply can't be found; a failed read rejects.
 */
export async function resolveForkFromHereTurnId({
  turnId,
  thread,
  readTranscript,
}: {
  turnId: string
  thread: MessageTurn[]
  readTranscript: () => Promise<MessageTurn[]>
}): Promise<string | null> {
  if (!isLiveTurnId(turnId)) return turnId
  const replyIndex = thread.findIndex((turn) => turn.id === turnId)
  if (replyIndex < 0) return null
  let promptIndex = -1
  let promptOrdinal = -1
  for (let i = 0; i < replyIndex; i++) {
    if (thread[i].role !== "user") continue
    promptIndex = i
    promptOrdinal += 1
  }
  if (promptIndex < 0) return null
  return resolveReplyInTranscript(
    await readTranscript(),
    promptOrdinal,
    editableUserMessageText(thread[promptIndex])
  )
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
