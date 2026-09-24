import { describe, expect, it } from "vitest"
import { reorderedPinIds } from "./use-pinned-pointer-reorder"

describe("reorderedPinIds", () => {
  const ids = [10, 20, 30, 40]

  it("moves a row up to the drop slot", () => {
    // drop before the first row
    expect(reorderedPinIds(ids, 30, 0)).toEqual([30, 10, 20, 40])
  })

  it("moves a row down: the slot index counts the row being moved", () => {
    // dropping 10 into slot 3 (between 30 and 40) lands it after 30
    expect(reorderedPinIds(ids, 10, 3)).toEqual([20, 30, 10, 40])
    // slot past the end
    expect(reorderedPinIds(ids, 10, 4)).toEqual([20, 30, 40, 10])
  })

  it("reports no change for a drop on its own slot", () => {
    expect(reorderedPinIds(ids, 20, 1)).toBeNull()
    expect(reorderedPinIds(ids, 20, 2)).toBeNull()
  })

  it("ignores an id that is not pinned", () => {
    expect(reorderedPinIds(ids, 99, 0)).toBeNull()
  })
})
