import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AUX_CLOSED_FULL_WATCH_MS,
  AuxPanelShownProvider,
  useAuxPanelShown,
  useAuxPanelWatchMode,
} from "./aux-panel-watch"

/** The hook under an AuxPanelShownProvider whose `shown` the test drives. */
function renderWatch(initial: { shown: boolean; root: string | null }) {
  let props = initial
  const view = renderHook(() => useAuxPanelWatchMode(props.root), {
    wrapper: ({ children }) => (
      <AuxPanelShownProvider shown={props.shown}>
        {children}
      </AuxPanelShownProvider>
    ),
  })
  return {
    mode: () => view.result.current,
    set(next: Partial<typeof initial>) {
      props = { ...props, ...next }
      view.rerender()
    },
  }
}

describe("useAuxPanelShown", () => {
  it("reads as shown outside an aux panel", () => {
    const { result } = renderHook(() => useAuxPanelShown())
    expect(result.current).toBe(true)
  })
})

describe("useAuxPanelWatchMode", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("watches in full outside an aux panel", () => {
    const { result } = renderHook(() => useAuxPanelWatchMode("/repo"))
    expect(result.current).toBe("full")
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS * 2))
    expect(result.current).toBe("full")
  })

  it("watches in full while the panel is shown", () => {
    const watch = renderWatch({ shown: true, root: "/repo" })
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS * 2))
    expect(watch.mode()).toBe("full")
  })

  it("keeps full for the grace window after a close, then steps down", () => {
    const watch = renderWatch({ shown: true, root: "/repo" })
    watch.set({ shown: false })
    expect(watch.mode()).toBe("full")
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS - 1))
    expect(watch.mode()).toBe("full")
    act(() => vi.advanceTimersByTime(1))
    expect(watch.mode()).toBe("paths")
  })

  it("steps back up as soon as the panel is shown again", () => {
    const watch = renderWatch({ shown: true, root: "/repo" })
    watch.set({ shown: false })
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS))
    expect(watch.mode()).toBe("paths")
    watch.set({ shown: true })
    expect(watch.mode()).toBe("full")
  })

  it("gives every close its own grace window", () => {
    const watch = renderWatch({ shown: true, root: "/repo" })
    watch.set({ shown: false })
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS))
    watch.set({ shown: true })
    // Closed again: not stepped down by the earlier window.
    watch.set({ shown: false })
    expect(watch.mode()).toBe("full")
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS))
    expect(watch.mode()).toBe("paths")
  })

  it("does not step down across a quick reopen", () => {
    const watch = renderWatch({ shown: true, root: "/repo" })
    watch.set({ shown: false })
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS / 2))
    watch.set({ shown: true })
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS))
    expect(watch.mode()).toBe("full")
  })

  it("watches a folder switched to while closed in full until its own grace ends", () => {
    const watch = renderWatch({ shown: true, root: "/a" })
    watch.set({ shown: false })
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS))
    expect(watch.mode()).toBe("paths")
    // A folder it has not scanned yet gets its first full snapshot.
    watch.set({ root: "/b" })
    expect(watch.mode()).toBe("full")
    act(() => vi.advanceTimersByTime(AUX_CLOSED_FULL_WATCH_MS))
    expect(watch.mode()).toBe("paths")
  })
})
