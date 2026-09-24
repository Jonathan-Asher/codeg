"use client"

import { create } from "zustand"
import { listConversationAttention } from "@/lib/api"
import type {
  AttentionKind,
  ConversationAttentionChange,
  ConversationAttentionEntry,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

/**
 * Which sidebar rows are waiting on the user — a parked permission, a blocking
 * question, a plan awaiting approval — keyed by the VISIBLE (top-level)
 * conversation id.
 *
 * Two inputs, one truth:
 * - the `list_conversation_attention` snapshot, loaded on start, after every
 *   transport reconnect (events fired while the socket was down are lost), and
 *   shortly after every live event — it is authoritative, and it is the only
 *   input that knows which row a delegation sub-agent belongs to;
 * - the `conversation://attention` events themselves, applied optimistically
 *   so the row lights up without waiting for that re-read.
 *
 * A snapshot request is invalidated by any event that lands while it is in
 * flight: its answer predates the event and would roll the row back.
 */

const PRECEDENCE: Record<AttentionKind, number> = {
  permission: 3,
  question: 2,
  plan_approval: 1,
}

/** The kind a row shows when several things wait under it. */
export function strongerAttention(
  current: AttentionKind | undefined,
  next: AttentionKind
): AttentionKind {
  return current !== undefined && PRECEDENCE[current] >= PRECEDENCE[next]
    ? current
    : next
}

/** Fold snapshot rows onto the rows the sidebar shows. */
export function attentionByRoot(
  entries: ConversationAttentionEntry[]
): Map<number, AttentionKind> {
  const map = new Map<number, AttentionKind>()
  for (const e of entries) {
    map.set(
      e.root_conversation_id,
      strongerAttention(map.get(e.root_conversation_id), e.kind)
    )
  }
  return map
}

interface ConversationAttentionState {
  byConversationId: Map<number, AttentionKind>
  applySnapshot: (entries: ConversationAttentionEntry[]) => void
  applyChange: (change: ConversationAttentionChange) => void
  reset: () => void
}

export const useConversationAttentionStore = create<ConversationAttentionState>(
  (set) => ({
    byConversationId: new Map(),
    applySnapshot: (entries) =>
      set({ byConversationId: attentionByRoot(entries) }),
    applyChange: (change) =>
      set((state) => {
        const current = state.byConversationId.get(change.id)
        if ((change.kind ?? undefined) === current) return state
        const next = new Map(state.byConversationId)
        if (change.kind == null) next.delete(change.id)
        else next.set(change.id, change.kind)
        return { byConversationId: next }
      }),
    reset: () => set({ byConversationId: new Map() }),
  })
)

/** What the row for `conversationId` is waiting on, if anything. */
export function useConversationAttention(
  conversationId: number
): AttentionKind | undefined {
  return useConversationAttentionStore((s) =>
    s.byConversationId.get(conversationId)
  )
}

// ── Sync ────────────────────────────────────────────────────────────────────

/** Coalesces a burst of events (a queued permission chain, a fan-out of
 *  sub-agents) into one snapshot read. */
const REFRESH_DEBOUNCE_MS = 250

let snapshotGeneration = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** Load the authoritative snapshot. Resolves either way: a server that
 *  predates the command just leaves the indicator event-driven. */
export async function refreshConversationAttention(): Promise<void> {
  const generation = ++snapshotGeneration
  try {
    const entries = await listConversationAttention()
    if (generation !== snapshotGeneration) return
    useConversationAttentionStore.getState().applySnapshot(entries)
  } catch {
    // Older server (no such command) or a transient failure — keep what we have.
  }
}

/** Apply a live event now, and re-read the snapshot shortly after. */
export function applyLiveAttentionChange(
  change: ConversationAttentionChange
): void {
  // Any snapshot already in flight was taken before this event.
  snapshotGeneration++
  useConversationAttentionStore.getState().applyChange(change)
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshConversationAttention()
  }, REFRESH_DEBOUNCE_MS)
}

registerBackendScopedStoreReset(() => {
  snapshotGeneration++
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  useConversationAttentionStore.getState().reset()
})

/** Test seam. @internal */
export function __resetConversationAttentionForTests(): void {
  snapshotGeneration = 0
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = null
  useConversationAttentionStore.getState().reset()
}
