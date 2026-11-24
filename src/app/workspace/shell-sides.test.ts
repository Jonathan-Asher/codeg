import { describe, expect, it } from "vitest"
import {
  MIN_CENTER_WIDTH_PX,
  auxContentWidthFor,
  resolveShellSides,
  shellPanelsWidthFor,
  type ShellSidesInput,
} from "./shell-sides"

const base: ShellSidesInput = {
  sidebarOpen: true,
  sidebarWidth: 300,
  sidebarMinWidth: 200,
  sidebarMaxWidth: 600,
  auxOpen: false,
  auxWidth: 360,
  auxMinWidth: 200,
  auxMaxWidth: 900,
  shellWidth: 1600,
}

describe("shellPanelsWidthFor", () => {
  it("takes a pixel per open divider out of the container", () => {
    expect(shellPanelsWidthFor(1600, false, false)).toBe(1600)
    expect(shellPanelsWidthFor(1600, true, false)).toBe(1599)
    expect(shellPanelsWidthFor(1600, true, true)).toBe(1598)
  })

  it("is 0 until the container is measured", () => {
    expect(shellPanelsWidthFor(0, true, true)).toBe(0)
  })
})

describe("resolveShellSides", () => {
  it("gives each open column its requested width when there is room", () => {
    const sides = resolveShellSides({ ...base, auxOpen: true })
    expect(sides.left).toBe(300)
    expect(sides.right).toBe(360)
    expect(sides.totalWidth).toBe(1598)
  })

  it("gives a closed column no width", () => {
    expect(resolveShellSides(base).right).toBe(0)
    expect(resolveShellSides({ ...base, sidebarOpen: false }).left).toBe(0)
  })

  it("scales both sides down together to keep the centre's minimum", () => {
    const sides = resolveShellSides({
      ...base,
      auxOpen: true,
      shellWidth: 1000,
    })
    expect(sides.left + sides.right).toBeCloseTo(
      sides.totalWidth - MIN_CENTER_WIDTH_PX
    )
    expect(sides.left / sides.right).toBeCloseTo(300 / 360)
  })
})

// A closed aux panel keeps its content mounted, laid out at this width; it has
// to be exactly what the column opens at, or the open re-lays it all out.
describe("auxContentWidthFor", () => {
  const openRight = (input: ShellSidesInput) =>
    resolveShellSides({ ...input, auxOpen: true }).right

  it("is the width the aux column opens at, in a roomy window", () => {
    expect(auxContentWidthFor(base)).toBe(360)
    expect(auxContentWidthFor(base)).toBe(openRight(base))
  })

  it("follows the squeeze a narrow window puts on the column once open", () => {
    const narrow = { ...base, shellWidth: 1000 }
    expect(auxContentWidthFor(narrow)).toBeLessThan(360)
    expect(auxContentWidthFor(narrow)).toBe(openRight(narrow))
  })

  it("counts the divider the open column brings", () => {
    // Squeezed, the sides share what the dividers leave: the closed layout
    // has one divider, the open one two, and the held width is the open one's.
    const tight = { ...base, shellWidth: 900 }
    const closedTotal = resolveShellSides(tight).totalWidth
    const openTotal = resolveShellSides({ ...tight, auxOpen: true }).totalWidth
    expect(openTotal).toBe(closedTotal - 1)
    expect(auxContentWidthFor(tight)).toBe(openRight(tight))
  })

  it("keeps the column's minimum however narrow the window", () => {
    expect(auxContentWidthFor({ ...base, shellWidth: 500 })).toBe(200)
  })
})
