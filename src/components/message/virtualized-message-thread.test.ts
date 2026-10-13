import { describe, expect, it, vi } from "vitest"

import {
  captureScrollAnchor,
  restoreScrollAnchor,
  shouldShiftForPrepend,
} from "./virtualized-message-thread"

/** A list of rows of the given heights, scrolled to `offset`. */
function fakeHandle(sizes: number[], offset: number) {
  const handle = {
    sizes,
    scrollOffset: offset,
    getItemOffset: (index: number) =>
      handle.sizes.slice(0, index).reduce((sum, size) => sum + size, 0),
    getItemSize: (index: number) => handle.sizes[index] ?? 0,
    findItemIndex: (at: number) => {
      let start = 0
      for (let index = 0; index < handle.sizes.length; index += 1) {
        if (at < start + handle.sizes[index]) return index
        start += handle.sizes[index]
      }
      return handle.sizes.length - 1
    },
    scrollTo: vi.fn((to: number) => {
      handle.scrollOffset = to
    }),
  }
  return handle
}

describe("chat text size scroll anchor", () => {
  it("keeps the same line of a long reply at the top when rows grow", () => {
    // Reading 1500px into a 3000px reply, with two short rows above it.
    const handle = fakeHandle([200, 300, 3000, 400], 500 + 1500)
    const anchor = captureScrollAnchor(handle)
    expect(anchor).toEqual({ index: 2, fraction: 0.5 })

    // 125%: every row a quarter taller.
    handle.sizes = handle.sizes.map((size) => size * 1.25)
    restoreScrollAnchor(handle, anchor!)

    expect(handle.scrollOffset).toBe(625 + 1875)
  })

  it("does not scroll when the target is already in place", () => {
    const handle = fakeHandle([100, 100], 150)
    const anchor = captureScrollAnchor(handle)!
    restoreScrollAnchor(handle, anchor)
    expect(handle.scrollTo).not.toHaveBeenCalled()
  })

  it("anchors the top of the list at the top", () => {
    const handle = fakeHandle([100, 100], 0)
    expect(captureScrollAnchor(handle)).toEqual({ index: 0, fraction: 0 })
  })
})

describe("shouldShiftForPrepend", () => {
  it("shifts when the epoch advances within the same scope", () => {
    expect(
      shouldShiftForPrepend({ scope: 7, epoch: 0 }, { scope: 7, epoch: 1 })
    ).toBe(true)
    expect(
      shouldShiftForPrepend({ scope: 7, epoch: 3 }, { scope: 7, epoch: 4 })
    ).toBe(true)
  })

  it("never shifts on an unchanged epoch (streaming appends, window resets)", () => {
    expect(
      shouldShiftForPrepend({ scope: 7, epoch: 2 }, { scope: 7, epoch: 2 })
    ).toBe(false)
  })

  it("never shifts across a scope switch (another conversation's list)", () => {
    expect(
      shouldShiftForPrepend({ scope: 7, epoch: 0 }, { scope: 8, epoch: 5 })
    ).toBe(false)
    expect(
      shouldShiftForPrepend(
        { scope: undefined, epoch: 0 },
        { scope: 8, epoch: 1 }
      )
    ).toBe(false)
  })
})
