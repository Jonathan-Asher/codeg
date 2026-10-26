"use client"

/**
 * What each agent's adapter last said it can do with a session, remembered so
 * a conversation can offer its actions before its own connection is up.
 *
 * Fork from here and Edit message both hang on the adapter's answer to
 * `initialize` (`fork_supported`, see `acp::fork::fork_capabilities`), and a
 * fresh connection starts out knowing nothing — so opening a session used to
 * show neither until the agent had spawned and resumed it, two or three
 * seconds later. The last answer any session of the agent gave is almost
 * always the next one's, so the transcript shows the buttons from the first
 * frame and the connection's own answer replaces this one when it comes in
 * (see `ConversationDetailPanel`). An action taken in between waits for that
 * answer (`lib/pending-actions`), and one it rules out is dropped with a
 * notice.
 *
 * Keyed by agent type only: the adapter version the answer came from is known
 * to the backend (`agent_info.version`) but is not sent to this client. A
 * change across an upgrade is reconciled like any other mismatch.
 *
 * Persisted in localStorage so a reload, or the next launch, starts from the
 * last answer rather than from the built-in default. The stored value is
 * untrusted input (shared with every codeg instance on the machine, and kept
 * across downgrades): anything but booleans in the expected fields reads as
 * nothing remembered.
 */

import { useCallback, useSyncExternalStore } from "react"

import type { AgentType } from "@/lib/types"

const STORAGE_KEY = "codeg:agent-capabilities"

/** The session capabilities that decide which actions a conversation offers. */
export interface AgentCapabilities {
  /** The adapter implements `session/fork` (Fork from here). */
  supportsFork: boolean
  /** It forks exactly at a named reply or refuses (Edit message). */
  forkStrictPoint: boolean
  /** It forks into a new conversation while a turn runs. */
  forkWhileRunning: boolean
}

/** Nothing known: no fork, no edit. */
export const NO_CAPABILITIES: AgentCapabilities = Object.freeze({
  supportsFork: false,
  forkStrictPoint: false,
  forkWhileRunning: false,
})

/**
 * What codeg knows of an agent before any session of it has answered: the
 * adapters codeg ships against for these agents all implement `session/fork`.
 * Mirrors `ForkCapabilities::built_in` in `acp/fork.rs` for the strict point
 * and the fork while running; an agent not listed waits for its connection, as
 * it always has.
 */
const BUILT_IN: ReadonlyMap<string, AgentCapabilities> = new Map<
  string,
  AgentCapabilities
>([
  [
    "claude_code",
    { supportsFork: true, forkStrictPoint: true, forkWhileRunning: true },
  ],
  [
    "codex",
    { supportsFork: true, forkStrictPoint: true, forkWhileRunning: false },
  ],
  [
    "deepseek",
    { supportsFork: true, forkStrictPoint: true, forkWhileRunning: false },
  ],
])

/** The built-in expectation for an agent no session has answered for yet. */
export function builtInCapabilities(agentType: AgentType): AgentCapabilities {
  return BUILT_IN.get(agentType) ?? NO_CAPABILITIES
}

let remembered: Map<string, AgentCapabilities> | null = null
const listeners = new Set<() => void>()

function isCapabilities(value: unknown): value is AgentCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.supportsFork === "boolean" &&
    typeof record.forkStrictPoint === "boolean" &&
    typeof record.forkWhileRunning === "boolean"
  )
}

/** Keep only well-formed `{agent: capabilities}` entries. A `Map` rather than
 *  a plain object, so an agent literally named `__proto__` stays data. */
function normalize(raw: unknown): Map<string, AgentCapabilities> {
  const out = new Map<string, AgentCapabilities>()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [agentType, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!isCapabilities(value)) continue
    out.set(
      agentType,
      Object.freeze({
        supportsFork: value.supportsFork,
        forkStrictPoint: value.forkStrictPoint,
        forkWhileRunning: value.forkWhileRunning,
      })
    )
  }
  return out
}

function load(): Map<string, AgentCapabilities> {
  if (remembered) return remembered
  if (typeof window === "undefined") {
    // Not cached: the module outlives a server render, and an empty map
    // cached here would make the first client read skip localStorage.
    return new Map()
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    remembered = raw ? normalize(JSON.parse(raw)) : new Map()
  } catch {
    remembered = new Map()
  }
  return remembered
}

function persist(all: Map<string, AgentCapabilities>) {
  remembered = all
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(all)))
    } catch {
      /* quota / private mode — the in-memory map still serves this window */
    }
  }
  for (const listener of listeners) listener()
}

/** Whether two capability sets say the same thing. */
export function sameCapabilities(
  a: AgentCapabilities,
  b: AgentCapabilities
): boolean {
  return (
    a.supportsFork === b.supportsFork &&
    a.forkStrictPoint === b.forkStrictPoint &&
    a.forkWhileRunning === b.forkWhileRunning
  )
}

/** The last answer a session of this agent gave, or `null` when none has. */
export function getRememberedCapabilities(
  agentType: AgentType
): AgentCapabilities | null {
  return load().get(agentType) ?? null
}

/**
 * What to offer for this agent before its connection has answered: the last
 * answer remembered for it, else the built-in expectation. Stable references,
 * so it can be read as a `useSyncExternalStore` snapshot.
 */
export function expectedCapabilities(agentType: AgentType): AgentCapabilities {
  return getRememberedCapabilities(agentType) ?? builtInCapabilities(agentType)
}

/**
 * Record what a connection of this agent just said it can do. Returns whether
 * that changed what was remembered; the common case (every reconnect says the
 * same thing) neither writes nor notifies.
 */
export function rememberCapabilities(
  agentType: AgentType,
  capabilities: AgentCapabilities
): boolean {
  const all = load()
  const existing = all.get(agentType)
  if (existing && sameCapabilities(existing, capabilities)) return false
  const next = new Map(all)
  next.set(
    agentType,
    Object.freeze({
      supportsFork: capabilities.supportsFork,
      forkStrictPoint: capabilities.forkStrictPoint,
      forkWhileRunning: capabilities.forkWhileRunning,
    })
  )
  persist(next)
  return true
}

export function subscribeCapabilities(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget the in-memory copy, so the next read goes to storage. */
export function resetCapabilitiesCacheForTests(): void {
  remembered = null
}

/** {@link expectedCapabilities}, following later answers of any session. */
export function useExpectedCapabilities(
  agentType: AgentType
): AgentCapabilities {
  const getSnapshot = useCallback(
    () => expectedCapabilities(agentType),
    [agentType]
  )
  return useSyncExternalStore(subscribeCapabilities, getSnapshot, () =>
    builtInCapabilities(agentType)
  )
}
