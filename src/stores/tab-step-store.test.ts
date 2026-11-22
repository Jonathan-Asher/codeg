import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TAB_STEP_SETTLE_MS, createTabStepper } from "./tab-step-store"

/** A frame takes this long to come round and be painted. */
const FRAME_MS = 16

function setup() {
  const open = new Set(["a", "b", "c", "d", "e", "f", "g", "h"])
  const activated: string[] = []
  const previews: (string | null)[] = []
  // How long each switch keeps the page busy (a slow machine's).
  let switchCost = 0
  const stepper = createTabStepper({
    activate: (tabId) => {
      activated.push(tabId)
      if (switchCost) vi.setSystemTime(Date.now() + switchCost)
    },
    hasTab: (tabId) => open.has(tabId),
    setPreview: (tabId) => previews.push(tabId),
    now: () => Date.now(),
    afterPaint: (fn) => {
      const handle = setTimeout(fn, FRAME_MS)
      return () => clearTimeout(handle)
    },
    // The work a switch queues is done by the time the next press arrives.
    afterWork: (fn) => fn(),
  })
  return {
    stepper,
    open,
    activated,
    previews,
    highlighted: () => stepper.previewTabId(),
    setSwitchCost: (ms: number) => {
      switchCost = ms
    },
  }
}

/** Press through `tabs`, `gap` ms apart, from the current time. */
function run(
  stepper: { step: (id: string) => void },
  tabs: string[],
  gap: number
) {
  tabs.forEach((tabId, index) => {
    if (index > 0) vi.advanceTimersByTime(gap)
    stepper.step(tabId)
  })
}

describe("tab stepping", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("highlights a single press at once and switches once that is painted", () => {
    const s = setup()
    s.stepper.step("b")
    expect(s.highlighted()).toBe("b")
    expect(s.activated).toEqual([])
    vi.advanceTimersByTime(FRAME_MS)
    expect(s.activated).toEqual(["b"])
    expect(s.highlighted()).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual(["b"])
  })

  it("in a fast run moves the highlight on every press and switches to none of the tabs it passes", () => {
    const s = setup()
    const highlights: (string | null)[] = []
    ;["b", "c", "d", "e", "f", "g"].forEach((tabId, index) => {
      if (index > 0) vi.advanceTimersByTime(80)
      s.stepper.step(tabId)
      highlights.push(s.highlighted())
    })
    expect(highlights).toEqual(["b", "c", "d", "e", "f", "g"])
    // The first press could not know a run would follow: it switched as a
    // lone press does. Every later one only moved the highlight.
    expect(s.activated).toEqual(["b"])
    vi.advanceTimersByTime(TAB_STEP_SETTLE_MS - 1)
    expect(s.activated).toEqual(["b"])
    vi.advanceTimersByTime(1)
    expect(s.activated).toEqual(["b", "g"])
    expect(s.highlighted()).toBeNull()
  })

  it("never switches to the first tab of a run that comes faster than a frame", () => {
    const s = setup()
    run(s.stepper, ["b", "c", "d"], 5)
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual(["d"])
  })

  it("publishes each step once, and clears the highlight with the switch", () => {
    const s = setup()
    run(s.stepper, ["b", "c", "d"], 60)
    vi.advanceTimersByTime(TAB_STEP_SETTLE_MS)
    expect(s.previews).toEqual(["b", null, "c", "d", null])
  })

  it("keeps a run going while every gap stays under the settle time", () => {
    const s = setup()
    s.stepper.step("b")
    vi.advanceTimersByTime(FRAME_MS)
    run(s.stepper, ["c", "d", "e"], TAB_STEP_SETTLE_MS - 10)
    expect(s.activated).toEqual(["b"])
    vi.advanceTimersByTime(TAB_STEP_SETTLE_MS)
    expect(s.activated).toEqual(["b", "e"])
  })

  it("treats a press after a longer pause as a new single press", () => {
    const s = setup()
    s.stepper.step("b")
    vi.advanceTimersByTime(FRAME_MS + TAB_STEP_SETTLE_MS)
    s.stepper.step("c")
    vi.advanceTimersByTime(FRAME_MS)
    expect(s.activated).toEqual(["b", "c"])
  })

  it("counts a press the busy page handled late as part of the run", () => {
    const s = setup()
    // The first switch keeps a slow machine busy longer than the settle time;
    // the press that queued up behind it is handled right after.
    s.setSwitchCost(TAB_STEP_SETTLE_MS + 60)
    s.stepper.step("b")
    vi.advanceTimersByTime(FRAME_MS)
    s.setSwitchCost(0)
    s.stepper.step("c")
    vi.advanceTimersByTime(FRAME_MS)
    expect(s.activated).toEqual(["b"])
    expect(s.highlighted()).toBe("c")
  })

  it("times a press from when its key went down, not when it was handled", () => {
    const s = setup()
    s.stepper.step("b", Date.now())
    vi.advanceTimersByTime(FRAME_MS)
    expect(s.activated).toEqual(["b"])
    // Pressed 80 ms after the first, then held up 300 ms more by work the
    // switch left for later (its effects).
    const pressedAt = Date.now() + 80 - FRAME_MS
    vi.setSystemTime(Date.now() + 380)
    s.stepper.step("c", pressedAt)
    vi.advanceTimersByTime(FRAME_MS)
    expect(s.activated).toEqual(["b"])
    expect(s.highlighted()).toBe("c")
  })

  it("ignores a key time that is not on its clock", () => {
    const s = setup()
    s.stepper.step("b")
    vi.advanceTimersByTime(FRAME_MS + TAB_STEP_SETTLE_MS)
    // A time from the future, or from long ago, is not trusted.
    s.stepper.step("c", Date.now() + 1000)
    vi.advanceTimersByTime(FRAME_MS + TAB_STEP_SETTLE_MS)
    s.stepper.step("d", Date.now() - 60_000)
    vi.advanceTimersByTime(FRAME_MS)
    expect(s.activated).toEqual(["b", "c", "d"])
  })

  it("switches at once when the run is ended early", () => {
    const s = setup()
    run(s.stepper, ["b", "c", "d"], 80)
    s.stepper.settle()
    expect(s.activated).toEqual(["b", "d"])
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual(["b", "d"])
  })

  it("switches in a task of its own when asked to settle soon", () => {
    const s = setup()
    run(s.stepper, ["b", "c", "d"], 80)
    s.stepper.settleSoon()
    expect(s.activated).toEqual(["b"])
    vi.advanceTimersByTime(0)
    expect(s.activated).toEqual(["b", "d"])
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual(["b", "d"])
  })

  it("does nothing when asked to settle with no step pending", () => {
    const s = setup()
    s.stepper.settle()
    s.stepper.settleSoon()
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual([])
    expect(s.previews).toEqual([])
  })

  it("drops a cancelled run without switching", () => {
    const s = setup()
    run(s.stepper, ["b", "c", "d"], 80)
    s.stepper.cancel()
    expect(s.highlighted()).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual(["b"])
  })

  it("drops a single press cancelled before its frame", () => {
    const s = setup()
    s.stepper.step("b")
    s.stepper.cancel()
    vi.advanceTimersByTime(1000)
    expect(s.activated).toEqual([])
  })

  it("does not switch to a tab that closed during the run", () => {
    const s = setup()
    run(s.stepper, ["b", "c", "d"], 80)
    s.open.delete("d")
    vi.advanceTimersByTime(TAB_STEP_SETTLE_MS)
    expect(s.activated).toEqual(["b"])
    expect(s.highlighted()).toBeNull()
  })
})
