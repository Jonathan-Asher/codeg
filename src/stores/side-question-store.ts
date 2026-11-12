import { create } from "zustand"

import type { SideQuestionRecord } from "@/lib/types"

/**
 * The side-question panel of each conversation (see `lib/side-question`):
 * whether it is open, the exchanges it steps through, and which one is on
 * screen. Keyed by a scope — the conversation's id once it has one — so the
 * panel and a question still on its way survive the tab being hidden or
 * remounted. Local to this window: the exchanges themselves live on the
 * backend.
 */

export type SideQuestionStatus = "pending" | "answered" | "failed"

export interface SideQuestionEntry {
  /** Stable key: the stored exchange's id, or a local one while it is on its
   *  way. */
  key: string
  question: string
  status: SideQuestionStatus
  /** The exchange as the backend answered it (`null` until it did). */
  record: SideQuestionRecord | null
  /** Why it failed, in words the user can read. */
  error: string | null
}

export interface SideQuestionPanelState {
  open: boolean
  /** Oldest first. */
  entries: SideQuestionEntry[]
  /** The entry on screen. */
  index: number
  /** The stored exchanges were fetched for this scope. */
  historyLoaded: boolean
}

export const EMPTY_SIDE_QUESTION_PANEL: SideQuestionPanelState = {
  open: false,
  entries: [],
  index: 0,
  historyLoaded: false,
}

interface SideQuestionStore {
  panels: Record<string, SideQuestionPanelState>
  /** Show the panel, on the newest exchange. */
  open: (scope: string) => void
  close: (scope: string) => void
  /** Move to another exchange (clamped). */
  show: (scope: string, index: number) => void
  /** A question on its way: added last, shown, the panel opened. */
  addPending: (scope: string, key: string, question: string) => void
  /** Settle a question on its way: answered with its record, or failed. */
  settle: (
    scope: string,
    key: string,
    outcome:
      | { status: "answered"; record: SideQuestionRecord }
      | { status: "failed"; error: string }
  ) => void
  /** Put a pending or failed entry back on its way (Retry). */
  retry: (scope: string, key: string) => void
  /** The stored exchanges, fetched once: they go before anything asked since
   *  the panel opened, without repeating one already here. */
  loadHistory: (scope: string, records: SideQuestionRecord[]) => void
  /** Forget everything but the questions still on their way. */
  clear: (scope: string) => void
}

const recordKey = (record: SideQuestionRecord, fallback: string) =>
  record.id != null ? `sq-${record.id}` : fallback

function update(
  panels: Record<string, SideQuestionPanelState>,
  scope: string,
  change: (panel: SideQuestionPanelState) => SideQuestionPanelState
): Record<string, SideQuestionPanelState> {
  const current = panels[scope] ?? EMPTY_SIDE_QUESTION_PANEL
  const next = change(current)
  return next === current ? panels : { ...panels, [scope]: next }
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1)

export const useSideQuestionStore = create<SideQuestionStore>()((set) => ({
  panels: {},
  open: (scope) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => ({
        ...panel,
        open: true,
        index: Math.max(panel.entries.length - 1, 0),
      })),
    })),
  close: (scope) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) =>
        panel.open ? { ...panel, open: false } : panel
      ),
    })),
  show: (scope, index) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => {
        const clamped = clampIndex(index, panel.entries.length)
        return clamped === panel.index ? panel : { ...panel, index: clamped }
      }),
    })),
  addPending: (scope, key, question) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => {
        const entries = [
          ...panel.entries,
          {
            key,
            question,
            status: "pending" as const,
            record: null,
            error: null,
          },
        ]
        return { ...panel, open: true, entries, index: entries.length - 1 }
      }),
    })),
  settle: (scope, key, outcome) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => {
        const at = panel.entries.findIndex((entry) => entry.key === key)
        if (at < 0) return panel
        // The stored exchanges, fetched while this one was on its way, may
        // already hold it: keep that one and drop the stand-in.
        const storedId =
          outcome.status === "answered" ? outcome.record.id : null
        const twin =
          storedId == null
            ? -1
            : panel.entries.findIndex(
                (entry, i) => i !== at && entry.record?.id === storedId
              )
        if (twin >= 0) {
          const entries = panel.entries.filter((_, i) => i !== at)
          const shown = panel.index === at ? twin : panel.index
          return {
            ...panel,
            entries,
            index: clampIndex(shown > at ? shown - 1 : shown, entries.length),
          }
        }
        const entries = panel.entries.slice()
        entries[at] =
          outcome.status === "answered"
            ? {
                ...entries[at],
                status: "answered",
                record: outcome.record,
                error: null,
              }
            : { ...entries[at], status: "failed", error: outcome.error }
        return { ...panel, entries }
      }),
    })),
  retry: (scope, key) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => {
        const at = panel.entries.findIndex((entry) => entry.key === key)
        if (at < 0) return panel
        const entries = panel.entries.slice()
        entries[at] = { ...entries[at], status: "pending", error: null }
        return { ...panel, entries, index: at }
      }),
    })),
  loadHistory: (scope, records) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => {
        const known = new Set(
          panel.entries
            .map((entry) => entry.record?.id)
            .filter((id): id is number => id != null)
        )
        const stored: SideQuestionEntry[] = records
          .filter((record) => record.id == null || !known.has(record.id))
          .map((record, i) => ({
            key: recordKey(record, `stored-${i}`),
            question: record.question,
            status: "answered",
            record,
            error: null,
          }))
        const entries = [...stored, ...panel.entries]
        return {
          ...panel,
          historyLoaded: true,
          entries,
          // Keep the same exchange on screen (it moved by what went before
          // it); an empty panel shows the newest stored one.
          index:
            panel.entries.length > 0
              ? panel.index + stored.length
              : Math.max(entries.length - 1, 0),
        }
      }),
    })),
  clear: (scope) =>
    set((state) => ({
      panels: update(state.panels, scope, (panel) => {
        const entries = panel.entries.filter(
          (entry) => entry.status === "pending"
        )
        return {
          ...panel,
          entries,
          index: Math.max(entries.length - 1, 0),
        }
      }),
    })),
}))
