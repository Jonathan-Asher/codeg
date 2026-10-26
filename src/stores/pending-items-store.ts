"use client"

import { create } from "zustand"
import { listPendingItems } from "@/lib/api"
import type { PendingItem, PendingItemsSnapshot } from "@/lib/types"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

/**
 * Everything waiting on the user, as the backend lists it
 * (`src-tauri/src/pending`): loaded on start and after every reconnect, then
 * replaced by each `app://pending-items` event (which carries the whole list).
 * A snapshot request is dropped if an event lands while it is in flight: its
 * answer predates the event.
 */

interface PendingItemsState {
  items: PendingItem[]
  count: number
  applySnapshot: (snapshot: PendingItemsSnapshot) => void
  reset: () => void
}

export const usePendingItemsStore = create<PendingItemsState>((set) => ({
  items: [],
  count: 0,
  applySnapshot: (snapshot) =>
    set({ items: snapshot.items, count: snapshot.count }),
  reset: () => set({ items: [], count: 0 }),
}))

let generation = 0

/** Load the list. Resolves either way: a server that predates it leaves the
 *  list empty. Resolves to the snapshot applied, or `null` when none was. */
export async function refreshPendingItems(): Promise<PendingItemsSnapshot | null> {
  const mine = ++generation
  try {
    const snapshot = await listPendingItems()
    if (mine !== generation) return null
    usePendingItemsStore.getState().applySnapshot(snapshot)
    return snapshot
  } catch {
    // Older server (no such command) or a transient failure — keep what we have.
    return null
  }
}

/** Apply a live event's list. */
export function applyLivePendingItems(snapshot: PendingItemsSnapshot): void {
  generation++
  usePendingItemsStore.getState().applySnapshot(snapshot)
}

registerBackendScopedStoreReset(() => {
  generation++
  usePendingItemsStore.getState().reset()
})
