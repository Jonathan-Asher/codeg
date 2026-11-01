import { describe, expect, it, vi } from "vitest"

import { watchTabClosed, type TabsStoreLike } from "./tab-watch"

function tabs(initial: string[]) {
  let rawTabs = initial.map((id) => ({ id }))
  const listeners = new Set<() => void>()
  const store: TabsStoreLike & { set(ids: string[]): void } = {
    getState: () => ({ rawTabs }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(ids) {
      rawTabs = ids.map((id) => ({ id }))
      for (const listener of [...listeners]) listener()
    },
  }
  return store
}

describe("watchTabClosed", () => {
  it("ends Talk when its conversation's tab closes, not for other tabs", () => {
    const store = tabs(["conv-1", "conv-2"])
    const onClosed = vi.fn()
    const stop = watchTabClosed(store, () => "conv-1", onClosed)
    store.set(["conv-1"])
    expect(onClosed).not.toHaveBeenCalled()
    // Moved to another split group: same id, still open.
    store.set(["conv-1", "new-9"])
    expect(onClosed).not.toHaveBeenCalled()
    store.set(["new-9"])
    expect(onClosed).toHaveBeenCalledTimes(1)
    stop()
    store.set([])
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it("does nothing without a Talk", () => {
    const store = tabs(["conv-1"])
    const onClosed = vi.fn()
    watchTabClosed(store, () => null, onClosed)
    store.set([])
    expect(onClosed).not.toHaveBeenCalled()
  })
})
