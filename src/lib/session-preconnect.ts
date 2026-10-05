/**
 * Pre-connect on intent: when the user rests on a session (hovers its sidebar
 * row, or a keyboard selection settles on it), start opening it in the
 * background so the agent is up by the time they look.
 *
 * The backend does the real work (`acp_preconnect`): it spawns a parked
 * connection the next connect for that session shares through its dedup, caps
 * how many speculative opens run at once, never lets one queue ahead of a real
 * open, and leaves an unused one to the normal idle sweep. This module only
 * decides WHEN to ask: after the intent has lasted `delayMs`, at most
 * `maxConcurrent` requests in flight, and not again for a target it asked
 * about recently.
 */

import { acpPreconnect } from "@/lib/api"
import type { AgentType } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

export interface PreconnectTarget {
  agentType: AgentType
  /** Exactly the working directory the session's tab will connect with. */
  workingDir: string
  /** The agent session to resume (the conversation's `external_id`). */
  sessionId: string
}

export interface PreconnectSchedulerOptions {
  /** How long an intent must last before anything starts. */
  delayMs?: number
  /** Requests allowed in flight at once; later intents are dropped. */
  maxConcurrent?: number
  /** A target asked about this recently is not asked about again. */
  cooldownMs?: number
  run: (target: PreconnectTarget) => Promise<unknown>
  now?: () => number
}

export interface PreconnectScheduler {
  /** The user is heading for `target`. Replaces any intent still pending. */
  intend(target: PreconnectTarget): void
  /** The intent ended before it fired (pointer left the row). Without a
   *  target, drops whatever is pending. Never cancels a request in flight. */
  withdraw(target?: PreconnectTarget): void
  /** Drop the pending intent and forget everything. */
  dispose(): void
}

export const PRECONNECT_DELAY_MS = 300
export const PRECONNECT_MAX_CONCURRENT = 1
export const PRECONNECT_COOLDOWN_MS = 60_000

export function preconnectKey(target: PreconnectTarget): string {
  return `${target.agentType}\u0000${target.workingDir}\u0000${target.sessionId}`
}

export function createPreconnectScheduler({
  delayMs = PRECONNECT_DELAY_MS,
  maxConcurrent = PRECONNECT_MAX_CONCURRENT,
  cooldownMs = PRECONNECT_COOLDOWN_MS,
  run,
  now = () => Date.now(),
}: PreconnectSchedulerOptions): PreconnectScheduler {
  let pending: { key: string; timer: ReturnType<typeof setTimeout> } | null =
    null
  const inFlight = new Set<string>()
  const askedAt = new Map<string, number>()

  const clearPending = () => {
    if (pending) clearTimeout(pending.timer)
    pending = null
  }

  const recentlyAsked = (key: string): boolean => {
    const at = askedAt.get(key)
    if (at === undefined) return false
    if (now() - at < cooldownMs) return true
    askedAt.delete(key)
    return false
  }

  const fire = (key: string, target: PreconnectTarget) => {
    pending = null
    if (inFlight.has(key) || recentlyAsked(key)) return
    // Best effort: a speculative open that cannot start now is simply
    // skipped, never queued behind another.
    if (inFlight.size >= maxConcurrent) return
    inFlight.add(key)
    askedAt.set(key, now())
    void run(target)
      .catch(() => {
        // Speculation only: the real open reports its own failures.
      })
      .finally(() => {
        inFlight.delete(key)
      })
  }

  return {
    intend(target) {
      const key = preconnectKey(target)
      if (pending?.key === key) return
      clearPending()
      if (inFlight.has(key) || recentlyAsked(key)) return
      pending = {
        key,
        timer: setTimeout(() => fire(key, target), delayMs),
      }
    },
    withdraw(target) {
      if (!pending) return
      if (target && pending.key !== preconnectKey(target)) return
      clearPending()
    },
    dispose() {
      clearPending()
      inFlight.clear()
      askedAt.clear()
    },
  }
}

/**
 * The target a sidebar conversation pre-connects to, or `null` when it has
 * nothing to resume or its tab's working directory cannot be known up front.
 * Mirrors what the conversation's tab connects with
 * (`conversation-detail-panel`): `sessionId` is the row's `external_id`
 * (never for cline), and `workingDir` is its folder's path. Chat-mode folders
 * are skipped: their tabs connect from a per-tab directory.
 */
export function preconnectTargetFor(
  conversation: {
    agent_type: AgentType
    external_id: string | null
    folder_id: number
  },
  folders: ReadonlyArray<{ id: number; path: string; kind?: string }>
): PreconnectTarget | null {
  const sessionId = conversation.external_id
  if (!sessionId) return null
  if (conversation.agent_type === "cline") return null
  const folder = folders.find((f) => f.id === conversation.folder_id)
  if (!folder || !folder.path || folder.kind === "chat") return null
  return {
    agentType: conversation.agent_type,
    workingDir: folder.path,
    sessionId,
  }
}

let shared: PreconnectScheduler | null = null

function sharedScheduler(): PreconnectScheduler {
  shared ??= createPreconnectScheduler({
    run: (target) =>
      acpPreconnect(target.agentType, target.workingDir, target.sessionId),
  })
  return shared
}

/**
 * Pre-connect hook for any "the user is about to open this session" signal:
 * a sidebar row hovered, a keyboard selection that moved onto a session. Safe
 * to call on every move — it is debounced, capped and deduplicated here and
 * again on the backend.
 */
export function requestSessionPreconnect(target: PreconnectTarget): void {
  sharedScheduler().intend(target)
}

/** The intent ended before it fired (pointer left, selection moved on). */
export function cancelSessionPreconnect(target?: PreconnectTarget): void {
  shared?.withdraw(target)
}

type PreconnectableConversation = Parameters<typeof preconnectTargetFor>[0]

function conversationTarget(
  conversation: PreconnectableConversation
): PreconnectTarget | null {
  return preconnectTargetFor(
    conversation,
    useAppWorkspaceStore.getState().allFolders
  )
}

/**
 * `requestSessionPreconnect` for a sidebar conversation row: resolves the
 * target the row's tab would connect with, and does nothing for a row that
 * has none. What a selection change (keyboard navigation) should call.
 */
export function preconnectConversation(
  conversation: PreconnectableConversation
): void {
  const target = conversationTarget(conversation)
  if (target) requestSessionPreconnect(target)
}

/** The intent for this conversation ended before it fired. */
export function cancelConversationPreconnect(
  conversation: PreconnectableConversation
): void {
  const target = conversationTarget(conversation)
  if (target) cancelSessionPreconnect(target)
}
