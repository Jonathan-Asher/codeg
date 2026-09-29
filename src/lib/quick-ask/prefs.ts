"use client"

/**
 * What the Quick Ask window remembers between questions: the target (new
 * session in a folder, an existing session, or a private question), the agent,
 * and that agent's model/effort picks.
 *
 * Kept apart from `codeg:selector-prefs` on purpose. Those are the per-agent
 * picks every new conversation in the workspace starts from; Quick Ask runs a
 * fast, cheap model by default and must never change them (nor be changed by
 * them).
 *
 * Folder and session memory is per backend (`local` / `remote:<id>`): ids are
 * only meaningful on the server they came from.
 */

import type { AgentType } from "@/lib/types"

export const QUICK_ASK_PREFS_KEY = "codeg:quick-ask:v1"

export type QuickAskTargetKind = "new" | "existing" | "private"

export const QUICK_ASK_TARGETS: readonly QuickAskTargetKind[] = [
  "new",
  "existing",
  "private",
] as const

export interface QuickAskPrefs {
  target: QuickAskTargetKind
  agent: AgentType
  /** Quick Ask's own model/effort picks, per agent. */
  configValues: Record<string, Record<string, string>>
  /** Last folder used for "new session", per backend. */
  folderByBackend: Record<string, number>
  /** Last session used for "existing session", per backend. */
  sessionByBackend: Record<string, number>
}

export const DEFAULT_QUICK_ASK_AGENT: AgentType = "claude_code"

/**
 * Fast and cheap by default. The values are the ids Claude Code's ACP adapter
 * advertises; a value the agent does not offer is skipped at connect time.
 */
export const DEFAULT_QUICK_ASK_CONFIG: Record<
  string,
  Record<string, string>
> = {
  claude_code: { model: "haiku", effort: "low" },
}

export function defaultQuickAskPrefs(): QuickAskPrefs {
  return {
    target: "new",
    agent: DEFAULT_QUICK_ASK_AGENT,
    configValues: {},
    folderByBackend: {},
    sessionByBackend: {},
  }
}

function isTarget(value: unknown): value is QuickAskTargetKind {
  return (
    typeof value === "string" &&
    (QUICK_ASK_TARGETS as readonly string[]).includes(value)
  )
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw
  }
  return out
}

function configRecord(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== "object") return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [agent, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const values: Record<string, string> = {}
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") values[id] = v
    }
    out[agent] = values
  }
  return out
}

/** Read the saved prefs, repairing anything malformed back to defaults. */
export function readQuickAskPrefs(): QuickAskPrefs {
  const defaults = defaultQuickAskPrefs()
  if (typeof window === "undefined") return defaults
  try {
    const raw = window.localStorage.getItem(QUICK_ASK_PREFS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      target: isTarget(parsed.target) ? parsed.target : defaults.target,
      agent:
        typeof parsed.agent === "string" && parsed.agent.length > 0
          ? parsed.agent
          : defaults.agent,
      configValues: configRecord(parsed.configValues),
      folderByBackend: numberRecord(parsed.folderByBackend),
      sessionByBackend: numberRecord(parsed.sessionByBackend),
    }
  } catch {
    return defaults
  }
}

export function writeQuickAskPrefs(prefs: QuickAskPrefs): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(QUICK_ASK_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage full or unavailable: the choice just isn't remembered */
  }
}

/** Apply `change` to the saved prefs and persist the result. */
export function updateQuickAskPrefs(
  change: (prefs: QuickAskPrefs) => QuickAskPrefs
): QuickAskPrefs {
  const next = change(readQuickAskPrefs())
  writeQuickAskPrefs(next)
  return next
}

/** Storage key for the backend a window is bound to. */
export function backendKey(remoteConnectionId: number | null): string {
  return remoteConnectionId == null ? "local" : `remote:${remoteConnectionId}`
}

/**
 * The model/effort picks Quick Ask connects `agent` with: the user's Quick Ask
 * picks for that agent, over the built-in fast defaults.
 */
export function quickAskConfigValues(
  prefs: QuickAskPrefs,
  agent: AgentType
): Record<string, string> {
  return {
    ...(DEFAULT_QUICK_ASK_CONFIG[agent] ?? {}),
    ...(prefs.configValues[agent] ?? {}),
  }
}

export function withConfigValue(
  prefs: QuickAskPrefs,
  agent: AgentType,
  configId: string,
  valueId: string
): QuickAskPrefs {
  return {
    ...prefs,
    configValues: {
      ...prefs.configValues,
      [agent]: { ...(prefs.configValues[agent] ?? {}), [configId]: valueId },
    },
  }
}

// ─── The workspace's active folder ─────────────────────────────────────────
//
// The workspace window publishes its active folder here so a Quick Ask that
// has never picked a folder on this backend starts in the one the user is
// looking at. Windows of one app share an origin, hence localStorage.

const ACTIVE_FOLDER_PREFIX = "codeg:quick-ask:active-folder:"

export function publishActiveFolder(
  remoteConnectionId: number | null,
  folderId: number | null
): void {
  if (typeof window === "undefined") return
  const key = ACTIVE_FOLDER_PREFIX + backendKey(remoteConnectionId)
  try {
    if (folderId == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(folderId))
  } catch {
    /* ignore */
  }
}

export function readActiveFolder(
  remoteConnectionId: number | null
): number | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(
      ACTIVE_FOLDER_PREFIX + backendKey(remoteConnectionId)
    )
    const id = raw == null ? NaN : Number(raw)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}

/**
 * The folder "new session" starts in: the last one Quick Ask used on this
 * backend, else the workspace's active folder, else the first one available.
 * Only folders that still exist count.
 */
export function pickDefaultFolder(
  availableIds: readonly number[],
  lastUsed: number | undefined,
  active: number | null
): number | null {
  if (lastUsed != null && availableIds.includes(lastUsed)) return lastUsed
  if (active != null && availableIds.includes(active)) return active
  return availableIds[0] ?? null
}
