"use client"

import { create } from "zustand"
import { listConversationBackground } from "@/lib/api"
import type {
  ConversationBackground,
  ConversationBackgroundChange,
  ConversationBackgroundEntry,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

/**
 * What every live session is doing in the background — background tasks
 * still running, the agent working on a turn codeg didn't send, a turn held
 * open only for background work — keyed by conversation id. The persisted
 * `turn_state` reads all three as "not running", so the sidebar consults this
 * for every row, open in a tab here or not.
 *
 * Kept in sync exactly like the attention store:
 * - the `list_conversation_background` snapshot, loaded on start, after every
 *   transport reconnect (events fired while the socket was down are lost),
 *   and shortly after every live event — it is authoritative;
 * - the `conversation://background` events, applied at once so the row
 *   changes without waiting for that re-read.
 *
 * A snapshot request is invalidated by any event that lands while it is in
 * flight: its answer predates the event and would roll the row back.
 */

interface ConversationBackgroundState {
  byConversationId: Map<number, ConversationBackground>
  applySnapshot: (entries: ConversationBackgroundEntry[]) => void
  applyChange: (change: ConversationBackgroundChange) => void
  reset: () => void
}

/** Whether two values would render the same. Cheap structural check — the
 *  values are small — so a re-announced identical value doesn't re-render
 *  every subscribed row. */
function sameBackground(
  a: ConversationBackground | undefined,
  b: ConversationBackground | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export const useConversationBackgroundStore =
  create<ConversationBackgroundState>((set) => ({
    byConversationId: new Map(),
    applySnapshot: (entries) =>
      set((state) => {
        const next = new Map<number, ConversationBackground>()
        for (const entry of entries) {
          if (entry?.background) {
            // Reuse the stored object when nothing changed, so rows whose
            // value is unchanged keep their selector result.
            const current = state.byConversationId.get(entry.conversation_id)
            next.set(
              entry.conversation_id,
              sameBackground(current, entry.background)
                ? (current as ConversationBackground)
                : entry.background
            )
          }
        }
        return { byConversationId: next }
      }),
    applyChange: (change) =>
      set((state) => {
        const current = state.byConversationId.get(change.id)
        const incoming = change.background ?? undefined
        if (sameBackground(current, incoming)) return state
        const next = new Map(state.byConversationId)
        if (incoming) next.set(change.id, incoming)
        else next.delete(change.id)
        return { byConversationId: next }
      }),
    reset: () => set({ byConversationId: new Map() }),
  }))

/** The live background activity of `conversationId`, if any. */
export function useConversationBackground(
  conversationId: number | null | undefined
): ConversationBackground | undefined {
  return useConversationBackgroundStore((s) =>
    conversationId == null ? undefined : s.byConversationId.get(conversationId)
  )
}

// ── Sync ────────────────────────────────────────────────────────────────────

/** Coalesces a burst of events (several tasks settling together) into one
 *  snapshot read. */
const REFRESH_DEBOUNCE_MS = 250

let snapshotGeneration = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** Load the authoritative snapshot. Resolves either way: a server that
 *  predates the command just leaves the store empty, which reads exactly as
 *  before. */
export async function refreshConversationBackground(): Promise<void> {
  const generation = ++snapshotGeneration
  try {
    const entries = await listConversationBackground()
    if (generation !== snapshotGeneration) return
    useConversationBackgroundStore
      .getState()
      .applySnapshot(Array.isArray(entries) ? entries : [])
  } catch {
    // Older server (no such command) or a transient failure — keep what we have.
  }
}

/** Apply a live event now, and re-read the snapshot shortly after. */
export function applyLiveBackgroundChange(
  change: ConversationBackgroundChange
): void {
  if (typeof change?.id !== "number") return
  // Any snapshot already in flight was taken before this event.
  snapshotGeneration++
  useConversationBackgroundStore.getState().applyChange(change)
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshConversationBackground()
  }, REFRESH_DEBOUNCE_MS)
}

registerBackendScopedStoreReset(() => {
  snapshotGeneration++
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  useConversationBackgroundStore.getState().reset()
})

/** Test seam. @internal */
export function __resetConversationBackgroundForTests(): void {
  snapshotGeneration = 0
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
  useConversationBackgroundStore.getState().reset()
}
