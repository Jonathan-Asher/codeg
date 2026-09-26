"use client"

import { create } from "zustand"
import { TAB_ARRANGE_MODES, type TabArrangeMode } from "@/lib/tab-arrangement"

/** Per-device display preference, like the sidebar's view options. */
const STORAGE_KEY = "workspace:tab-arrange-mode"
/** Runs (folder groups / status bands, by run key) folded to their label. */
const COLLAPSED_KEY = "workspace:tab-arrange-collapsed"

function loadMode(): TabArrangeMode {
  if (typeof window === "undefined") return "manual"
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return (TAB_ARRANGE_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as TabArrangeMode)
      : "manual"
  } catch {
    return "manual"
  }
}

function loadCollapsed(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]")
    return Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : []
  } catch {
    return []
  }
}

interface TabArrangeState {
  mode: TabArrangeMode
  /** Run keys whose tabs are folded away (see `shownTabs`). */
  collapsedRuns: ReadonlySet<string>
  hydrated: boolean
  /** Read the stored choice. Called from an effect (not at module load) so the
   *  first client render matches the prerendered HTML. Idempotent. */
  hydrate: () => void
  setMode: (mode: TabArrangeMode) => void
  toggleRunCollapsed: (runKey: string) => void
}

export const useTabArrangeStore = create<TabArrangeState>((set, get) => ({
  mode: "manual",
  collapsedRuns: new Set(),
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return
    set({
      mode: loadMode(),
      collapsedRuns: new Set(loadCollapsed()),
      hydrated: true,
    })
  },
  setMode: (mode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // Private mode / quota: the choice still applies for this session.
    }
    set({ mode, hydrated: true })
  },
  toggleRunCollapsed: (runKey) => {
    const next = new Set(get().collapsedRuns)
    if (next.has(runKey)) next.delete(runKey)
    else next.add(runKey)
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    } catch {
      // Private mode / quota: the fold still applies for this session.
    }
    set({ collapsedRuns: next })
  },
}))
