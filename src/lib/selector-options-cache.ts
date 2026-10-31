"use client"

/**
 * The option LISTS each agent last reported — which modes, models and efforts
 * it offers and what they are called — remembered across restarts, so a
 * brand-new chat can show its selectors (and take picks on them) before its
 * connection is up.
 *
 * Two things are kept per agent type:
 *
 * - `modes` / `configOptions`: the lists exactly as the agent's last session
 *   reported them. They describe the AGENT; their current values belong to
 *   whichever session reported last, so they are only ever a template that a
 *   surface lays its own values over (see `lib/selector-display.ts`). A live
 *   report replaces them.
 * - `newSession`: the values the agent's last brand-new session STARTED with,
 *   for the options the user had not picked — i.e. the agent's own defaults as
 *   they came out. A new chat shows them for an option it has no saved pick
 *   for, which is what that chat will start with, rather than another
 *   session's current value.
 *
 * Persisted in localStorage under one versioned key. The stored value is
 * untrusted input — shared with every codeg build on the machine, kept across
 * downgrades, editable by hand — so it is read through a validator that keeps
 * only well-formed entries, and an unknown version reads as nothing stored.
 * It is kept small: an agent whose lists are too big to be worth storing is
 * remembered for this window only, and the oldest agents go first when the
 * whole record outgrows its budget.
 */

import { useCallback, useSyncExternalStore } from "react"

import type { SelectorValues } from "@/lib/selector-display"
import type {
  SessionConfigOptionInfo,
  SessionConfigSelectGroupInfo,
  SessionConfigSelectOptionInfo,
  SessionModeInfo,
  SessionModeStateInfo,
} from "@/lib/types"

export const SELECTOR_OPTIONS_STORAGE_KEY = "codeg:selector-options"
const STORAGE_VERSION = 1

/** One agent's lists above this size are kept in memory only. */
export const MAX_AGENT_ENTRY_CHARS = 96 * 1024
/** The whole stored record stays under this; the oldest agents go first. */
export const MAX_STORED_CHARS = 256 * 1024
/** At most this many agents are stored. */
export const MAX_STORED_AGENTS = 24

/** What one agent offers, as a template for a surface's own values. */
export interface SelectorTemplate {
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
}

interface AgentEntry {
  /** Frozen, and replaced (never mutated) on change, so it can be returned
   *  as a `useSyncExternalStore` snapshot. */
  template: SelectorTemplate
  /** The serialized lists, to tell a real change from a repeat report. */
  listsJson: string
  newSession: SelectorValues | null
  /** When the entry last changed (epoch ms): the oldest is dropped first. */
  at: number
}

let entries: Map<string, AgentEntry> | null = null
const listeners = new Set<() => void>()
let storageListenerInstalled = false

// ── Validation ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

function readMode(raw: unknown): SessionModeInfo | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null
  const mode: SessionModeInfo = { id: raw.id, name: raw.name }
  const description = optionalText(raw.description)
  if (description !== undefined) mode.description = description
  return mode
}

function readModes(raw: unknown): SessionModeStateInfo | null {
  if (!isRecord(raw)) return null
  if (typeof raw.current_mode_id !== "string") return null
  if (!Array.isArray(raw.available_modes)) return null
  const available = raw.available_modes
    .map(readMode)
    .filter((mode): mode is SessionModeInfo => mode !== null)
  if (available.length === 0) return null
  return { current_mode_id: raw.current_mode_id, available_modes: available }
}

function readSelectChoice(raw: unknown): SessionConfigSelectOptionInfo | null {
  if (!isRecord(raw)) return null
  if (typeof raw.value !== "string" || typeof raw.name !== "string") {
    return null
  }
  const choice: SessionConfigSelectOptionInfo = {
    value: raw.value,
    name: raw.name,
  }
  const description = optionalText(raw.description)
  if (description !== undefined) choice.description = description
  return choice
}

function readSelectChoices(raw: unknown): SessionConfigSelectOptionInfo[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(readSelectChoice)
    .filter((c): c is SessionConfigSelectOptionInfo => c !== null)
}

function readSelectGroup(raw: unknown): SessionConfigSelectGroupInfo | null {
  if (!isRecord(raw)) return null
  if (typeof raw.group !== "string" || typeof raw.name !== "string") {
    return null
  }
  return {
    group: raw.group,
    name: raw.name,
    options: readSelectChoices(raw.options),
  }
}

function readConfigOption(raw: unknown): SessionConfigOptionInfo | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null
  const kind = raw.kind
  if (!isRecord(kind)) return null
  let parsedKind: SessionConfigOptionInfo["kind"]
  if (kind.type === "select") {
    if (typeof kind.current_value !== "string") return null
    const options = readSelectChoices(kind.options)
    const groups = Array.isArray(kind.groups)
      ? kind.groups
          .map(readSelectGroup)
          .filter((g): g is SessionConfigSelectGroupInfo => g !== null)
      : []
    if (options.length === 0 && groups.every((g) => g.options.length === 0)) {
      return null
    }
    parsedKind = {
      type: "select",
      current_value: kind.current_value,
      options,
      groups,
    }
  } else if (kind.type === "boolean") {
    if (typeof kind.current_value !== "boolean") return null
    parsedKind = { type: "boolean", current_value: kind.current_value }
  } else {
    return null
  }
  const option: SessionConfigOptionInfo = {
    id: raw.id,
    name: raw.name,
    kind: parsedKind,
  }
  const description = optionalText(raw.description)
  if (description !== undefined) option.description = description
  const category = optionalText(raw.category)
  if (category !== undefined) option.category = category
  const recommended = optionalText(raw.recommended_value)
  if (recommended !== undefined) option.recommended_value = recommended
  return option
}

function readConfigOptions(raw: unknown): SessionConfigOptionInfo[] | null {
  if (!Array.isArray(raw)) return null
  return raw
    .map(readConfigOption)
    .filter((o): o is SessionConfigOptionInfo => o !== null)
}

function readValues(raw: unknown): SelectorValues | null {
  if (!isRecord(raw)) return null
  const modeId = typeof raw.modeId === "string" ? raw.modeId : null
  let configValues: Record<string, string> | null = null
  if (isRecord(raw.configValues)) {
    for (const [id, value] of Object.entries(raw.configValues)) {
      if (typeof value !== "string") continue
      configValues ??= {}
      configValues[id] = value
    }
  }
  if (!modeId && !configValues) return null
  return { modeId, configValues }
}

// ── Entries ──

function freezeTemplate(template: SelectorTemplate): SelectorTemplate {
  return Object.freeze({
    modes: template.modes,
    configOptions: template.configOptions,
  })
}

function makeEntry(
  template: SelectorTemplate,
  newSession: SelectorValues | null,
  at: number
): AgentEntry {
  return {
    template: freezeTemplate(template),
    listsJson: JSON.stringify([template.modes, template.configOptions]),
    newSession,
    at,
  }
}

function readEntry(raw: unknown): AgentEntry | null {
  if (!isRecord(raw)) return null
  const modes = readModes(raw.modes)
  const configOptions = readConfigOptions(raw.configOptions)
  const newSession = readValues(raw.newSession)
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0
  return makeEntry({ modes, configOptions }, newSession, at)
}

/** Every well-formed agent entry of a stored record; nothing for any other
 *  shape or version. A `Map`, so an agent named `__proto__` stays data. */
function readStored(raw: string | null): Map<string, AgentEntry> {
  const out = new Map<string, AgentEntry>()
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!isRecord(parsed) || parsed.v !== STORAGE_VERSION) return out
  if (!isRecord(parsed.agents)) return out
  for (const [agentType, value] of Object.entries(parsed.agents)) {
    const entry = readEntry(value)
    if (entry) out.set(agentType, entry)
  }
  return out
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(SELECTOR_OPTIONS_STORAGE_KEY)
  } catch {
    return null
  }
}

function load(): Map<string, AgentEntry> {
  if (entries) return entries
  if (typeof window === "undefined") {
    // Not cached: the module outlives a server render, and an empty map cached
    // here would make the first client read skip localStorage.
    return new Map()
  }
  entries = readStored(readStorage())
  return entries
}

function serializeEntry(entry: AgentEntry): string {
  return JSON.stringify({
    modes: entry.template.modes,
    configOptions: entry.template.configOptions,
    ...(entry.newSession ? { newSession: entry.newSession } : {}),
    at: entry.at,
  })
}

/** The record to store: newest agents first, each one only if it fits. */
function buildStoredRecord(all: Map<string, AgentEntry>): string {
  const ordered = [...all.entries()].sort((a, b) => b[1].at - a[1].at)
  const parts: string[] = []
  let size = 0
  for (const [agentType, entry] of ordered) {
    if (parts.length >= MAX_STORED_AGENTS) break
    const json = serializeEntry(entry)
    if (json.length > MAX_AGENT_ENTRY_CHARS) continue
    const part = `${JSON.stringify(agentType)}:${json}`
    if (size + part.length > MAX_STORED_CHARS) continue
    parts.push(part)
    size += part.length + 1
  }
  return `{"v":${STORAGE_VERSION},"agents":{${parts.join(",")}}}`
}

function notify() {
  for (const listener of listeners) listener()
}

function persist(next: Map<string, AgentEntry>) {
  entries = next
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(
        SELECTOR_OPTIONS_STORAGE_KEY,
        buildStoredRecord(next)
      )
    } catch {
      /* quota / private mode — the in-memory copy still serves this window */
    }
  }
  notify()
}

function update(
  agentType: string,
  change: (existing: AgentEntry | undefined) => AgentEntry | null
) {
  const all = load()
  const existing = all.get(agentType)
  const next = change(existing)
  if (!next || next === existing) return
  const copy = new Map(all)
  copy.set(agentType, next)
  persist(copy)
}

/** Another window wrote the record: take its agents, keep ours it lacks (an
 *  agent too big to store lives only in the window that saw it). */
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== SELECTOR_OPTIONS_STORAGE_KEY) return
  if (!entries) {
    notify()
    return
  }
  const stored = readStored(event.key === null ? null : event.newValue)
  const merged = new Map(stored)
  for (const [agentType, entry] of entries) {
    if (!merged.has(agentType)) merged.set(agentType, entry)
  }
  for (const [agentType, entry] of merged) {
    const mine = entries.get(agentType)
    // Unchanged entries keep their identity, so nothing re-renders for them.
    if (
      mine &&
      mine.listsJson === entry.listsJson &&
      JSON.stringify(mine.newSession) === JSON.stringify(entry.newSession)
    ) {
      merged.set(agentType, mine)
    }
  }
  entries = merged
  notify()
}

// ── Read ──

/** The lists this agent's last session reported, or `null` when no session of
 *  it has yet. Stable reference while unchanged. */
export function getSelectorTemplate(
  agentType: string
): SelectorTemplate | null {
  return load().get(agentType)?.template ?? null
}

/** What this agent's last brand-new session started with, for the options the
 *  user had not picked, or `null` when no new session has been seen. */
export function getNewSessionValues(agentType: string): SelectorValues | null {
  return load().get(agentType)?.newSession ?? null
}

export function subscribeSelectorOptions(listener: () => void): () => void {
  listeners.add(listener)
  if (!storageListenerInstalled && typeof window !== "undefined") {
    storageListenerInstalled = true
    window.addEventListener("storage", onStorage)
  }
  return () => {
    listeners.delete(listener)
  }
}

/** {@link getSelectorTemplate}, following later reports. */
export function useSelectorTemplate(
  agentType: string
): SelectorTemplate | null {
  const getSnapshot = useCallback(
    () => getSelectorTemplate(agentType),
    [agentType]
  )
  return useSyncExternalStore(subscribeSelectorOptions, getSnapshot, () => null)
}

/** {@link getNewSessionValues}, following later new sessions. */
export function useNewSessionValues(agentType: string): SelectorValues | null {
  const getSnapshot = useCallback(
    () => getNewSessionValues(agentType),
    [agentType]
  )
  return useSyncExternalStore(subscribeSelectorOptions, getSnapshot, () => null)
}

// ── Write ──

function withLists(
  existing: AgentEntry | undefined,
  template: SelectorTemplate
): AgentEntry | null {
  const listsJson = JSON.stringify([template.modes, template.configOptions])
  if (existing && existing.listsJson === listsJson) return null
  return makeEntry(template, existing?.newSession ?? null, Date.now())
}

/** A session of this agent reported its modes. */
export function rememberSelectorModes(
  agentType: string,
  modes: SessionModeStateInfo | null
) {
  update(agentType, (existing) =>
    withLists(existing, {
      modes,
      configOptions: existing?.template.configOptions ?? null,
    })
  )
}

/** A session of this agent reported its config options. */
export function rememberSelectorConfigOptions(
  agentType: string,
  configOptions: SessionConfigOptionInfo[] | null
) {
  update(agentType, (existing) =>
    withLists(existing, {
      modes: existing?.template.modes ?? null,
      configOptions,
    })
  )
}

/**
 * A session of this agent finished setting up with these lists: they replace
 * whatever was remembered, so a selector the agent stopped offering goes too.
 * A session that reported no selectors at all only records that the agent has
 * none when nothing is known yet — it says nothing about the lists another
 * session saw.
 */
export function rememberSelectorTemplate(
  agentType: string,
  template: SelectorTemplate
) {
  update(agentType, (existing) => {
    const reportedNone =
      template.modes === null && template.configOptions === null
    if (reportedNone && existing) return null
    return withLists(existing, template)
  })
}

/** What a brand-new session of this agent started with, for the options the
 *  user had not picked. Merged over what was known: an option this session did
 *  not describe keeps its earlier value. Only alongside the agent's lists —
 *  values with no list to show them in mean nothing. */
export function rememberNewSessionValues(
  agentType: string,
  values: SelectorValues
) {
  update(agentType, (existing) => {
    if (!existing) return null
    const previous = existing.newSession
    const configValues = { ...previous?.configValues, ...values.configValues }
    const next: SelectorValues = {
      modeId: values.modeId ?? previous?.modeId ?? null,
      configValues: Object.keys(configValues).length > 0 ? configValues : null,
    }
    if (!next.modeId && !next.configValues) return null
    if (JSON.stringify(next) === JSON.stringify(previous)) return null
    return { ...existing, newSession: next, at: Date.now() }
  })
}

/** Test seam: forget the in-memory copy, so the next read goes to storage. */
export function resetSelectorOptionsCacheForTests(): void {
  entries = null
}
