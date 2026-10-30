import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { useRef } from "react"
import { act, render, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PANEL_SLIDE_CLEANUP_MS,
  PANEL_SLIDE_MS,
  REDUCED_MOTION_QUERY,
  SLIDE_FREEZE_WIDTH_VAR,
  SLIDE_FROZEN_ATTR,
  freezeSlideRegions,
  releaseSlideFreeze,
  slideHoldStyle,
  usePanelSlideOnToggle,
  useSlideFreeze,
} from "./panel-slide"

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/app/globals.css"),
  "utf8"
)

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = globalsCss.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThan(-1)
  const open = globalsCss.indexOf("{", start)
  return globalsCss.slice(open + 1, globalsCss.indexOf("}", open))
}

function stubReducedMotion(reduced: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query === REDUCED_MOTION_QUERY,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  )
}

function setWidth(el: HTMLElement, width: number) {
  el.getBoundingClientRect = () =>
    ({
      width,
      height: 100,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 100,
    }) as DOMRect
}

describe("usePanelSlideOnToggle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubReducedMotion(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const mount = (open: boolean, ready: boolean) =>
    renderHook(({ open, ready }) => usePanelSlideOnToggle(open, ready), {
      initialProps: { open, ready },
    })

  it("does not animate the first settled value or a hydration", () => {
    const { result, rerender } = mount(false, false)
    expect(result.current).toBe(false)
    // localStorage hydration: becomes ready already open — a baseline, not a toggle.
    rerender({ open: true, ready: true })
    expect(result.current).toBe(false)
  })

  it("animates an explicit toggle, for the length of the slide only", () => {
    const { result, rerender } = mount(true, true)
    expect(result.current).toBe(false)
    rerender({ open: false, ready: true })
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(PANEL_SLIDE_MS))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(PANEL_SLIDE_CLEANUP_MS - PANEL_SLIDE_MS))
    expect(result.current).toBe(false)
  })

  it("re-arms on a toggle mid-slide", () => {
    const { result, rerender } = mount(true, true)
    rerender({ open: false, ready: true })
    act(() => vi.advanceTimersByTime(PANEL_SLIDE_CLEANUP_MS - 50))
    rerender({ open: true, ready: true })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(PANEL_SLIDE_CLEANUP_MS))
    expect(result.current).toBe(false)
  })

  it("does not animate re-renders without a flip (resize-handle drags)", () => {
    const { result, rerender } = mount(true, true)
    for (let i = 0; i < 3; i++) rerender({ open: true, ready: true })
    expect(result.current).toBe(false)
  })

  it("never animates under reduced motion", () => {
    stubReducedMotion(true)
    const { result, rerender } = mount(true, true)
    rerender({ open: false, ready: true })
    expect(result.current).toBe(false)
    rerender({ open: true, ready: true })
    expect(result.current).toBe(false)
  })
})

describe("slide freeze", () => {
  let frames: FrameRequestCallback[] = []
  const runFrame = () => {
    const due = frames
    frames = []
    due.forEach((cb) => cb(0))
  }

  beforeEach(() => {
    frames = []
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ""
  })

  const byId = (id: string) => document.getElementById(id) as HTMLElement
  const frozenAs = (id: string) => byId(id).getAttribute(SLIDE_FROZEN_ATTR)
  const heldWidth = (id: string) =>
    byId(id).style.getPropertyValue(SLIDE_FREEZE_WIDTH_VAR)

  function mountTabs() {
    document.body.innerHTML = `
      <div id="root">
        <div id="shown" data-slide-freeze="center"></div>
        <div id="bg1" class="conversation-tab-hidden" data-slide-freeze="hold">
          <div id="nested" data-slide-freeze="center"></div>
        </div>
        <div id="bg2" class="conversation-tab-hidden" data-slide-freeze="hold"></div>
        <div id="collapsed" data-slide-freeze="center"></div>
        <div id="plain"></div>
      </div>`
    setWidth(byId("shown"), 812.5)
    setWidth(byId("bg1"), 812.5)
    setWidth(byId("nested"), 812.5)
    setWidth(byId("bg2"), 640)
    setWidth(byId("collapsed"), 0)
    return byId("root")
  }

  it("holds the shown tab centred and the hidden subtrees as they are", () => {
    const frozen = freezeSlideRegions(mountTabs())
    expect(frozen.map((el) => el.id)).toEqual(["shown", "bg1", "bg2"])
    expect(frozenAs("shown")).toBe("center")
    expect(heldWidth("shown")).toBe("812.5px")
    expect(frozenAs("bg1")).toBe("hold")
    expect(frozenAs("bg2")).toBe("hold")
    expect(heldWidth("bg2")).toBe("640px")
    // Held along with its hidden ancestor; nothing to hold without a width.
    expect(frozenAs("nested")).toBeNull()
    expect(frozenAs("collapsed")).toBeNull()
    expect(frozenAs("plain")).toBeNull()
  })

  it("lets the shown tab go at once and the hidden ones one per frame", () => {
    const frozen = freezeSlideRegions(mountTabs())
    releaseSlideFreeze(frozen)
    expect(frozenAs("shown")).toBeNull()
    expect(heldWidth("shown")).toBe("")
    expect(frozenAs("bg1")).toBe("hold")
    expect(frozenAs("bg2")).toBe("hold")
    runFrame()
    expect(frozenAs("bg1")).toBeNull()
    expect(heldWidth("bg1")).toBe("")
    expect(frozenAs("bg2")).toBe("hold")
    runFrame()
    expect(frozenAs("bg2")).toBeNull()
    expect(frames).toHaveLength(0)
  })

  it("lets a hidden subtree that was shown mid-slide go at once", () => {
    const frozen = freezeSlideRegions(mountTabs())
    byId("bg2").classList.remove("conversation-tab-hidden")
    releaseSlideFreeze(frozen)
    expect(frozenAs("bg2")).toBeNull()
    runFrame()
    expect(frozenAs("bg1")).toBeNull()
    expect(frames).toHaveLength(0)
  })

  it("stops the staggered release once a newer slide takes hold", () => {
    const root = mountTabs()
    releaseSlideFreeze(freezeSlideRegions(root))
    const second = freezeSlideRegions(root)
    runFrame()
    // The older release must not let go of what the newer slide holds.
    expect(frozenAs("bg1")).toBe("hold")
    expect(frozenAs("bg2")).toBe("hold")
    releaseSlideFreeze(second)
    runFrame()
    runFrame()
    expect(frozenAs("bg1")).toBeNull()
    expect(frozenAs("bg2")).toBeNull()
  })

  it("reads every width before writing any", () => {
    document.body.innerHTML = `
      <div id="root"><div data-slide-freeze="center"></div><div data-slide-freeze="hold"></div></div>`
    const log: string[] = []
    document
      .querySelectorAll<HTMLElement>("[data-slide-freeze]")
      .forEach((el) => {
        el.getBoundingClientRect = () => {
          log.push("read")
          return { width: 500 } as DOMRect
        }
        const set = el.setAttribute.bind(el)
        el.setAttribute = (name: string, value: string) => {
          log.push("write")
          set(name, value)
        }
      })
    freezeSlideRegions(byId("root"))
    expect(log).toEqual(["read", "read", "write", "write"])
  })

  it("holds for as long as the slide runs (useSlideFreeze)", () => {
    function Shell({ active }: { active: boolean }) {
      const ref = useRef<HTMLDivElement | null>(null)
      useSlideFreeze(ref, active)
      return (
        <div ref={ref}>
          <div
            data-testid="region"
            data-slide-freeze="center"
            ref={(el) => {
              if (el) setWidth(el, 900)
            }}
          />
        </div>
      )
    }
    const { getByTestId, rerender } = render(<Shell active={false} />)
    const region = getByTestId("region")
    expect(region.hasAttribute(SLIDE_FROZEN_ATTR)).toBe(false)
    rerender(<Shell active />)
    expect(region.getAttribute(SLIDE_FROZEN_ATTR)).toBe("center")
    expect(region.style.getPropertyValue(SLIDE_FREEZE_WIDTH_VAR)).toBe("900px")
    // The state at the end of a slide: let go, back to its container's width.
    rerender(<Shell active={false} />)
    expect(region.hasAttribute(SLIDE_FROZEN_ATTR)).toBe(false)
    expect(region.style.getPropertyValue(SLIDE_FREEZE_WIDTH_VAR)).toBe("")
  })
})

describe("slideHoldStyle", () => {
  it("pins the sidebar to the edge that meets the centre column", () => {
    expect(slideHoldStyle("end", 280.4)).toMatchObject({
      position: "absolute",
      top: 0,
      bottom: 0,
      insetInlineEnd: 0,
      width: 280,
      contain: "strict",
    })
    expect(slideHoldStyle("end", 280)).not.toHaveProperty("insetInlineStart")
  })

  it("pins the aux panel to its start edge", () => {
    expect(slideHoldStyle("start", 320)).toMatchObject({
      insetInlineStart: 0,
      width: 320,
    })
  })
})

describe("slide CSS", () => {
  it("holds the shown tab centred, without re-laying it out to take hold", () => {
    const body = ruleBody('[data-slide-frozen="center"]')
    expect(body).toContain("width: var(--slide-freeze-w)")
    expect(body).toContain(
      "margin-inline-start: calc((100% - var(--slide-freeze-w)) / 2)"
    )
    // Taking hold must not change how the region is laid out — that would
    // re-lay out the whole transcript in the slide's first frame.
    expect(body).not.toMatch(/position|contain|transform|will-change/)
  })

  it("holds a hidden subtree only while it is hidden", () => {
    const body = ruleBody('.conversation-tab-hidden[data-slide-frozen="hold"]')
    expect(body).toContain("width: var(--slide-freeze-w)")
    // `absolute inset-0` would otherwise keep sizing it to its container.
    expect(body).toContain("right: auto")
    // Not content-visibility: WebKit re-lays out the whole subtree on every
    // show, which slows tab switches down.
    const declarations = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "")
    expect(declarations).not.toMatch(/content-visibility:\s*hidden/)
  })

  it("keeps the held width from inheriting into the held transcript", () => {
    const body = ruleBody("@property --slide-freeze-w")
    expect(body).toContain("inherits: false")
    expect(body).toContain('syntax: "<length>"')
  })

  it("keeps the transition length in step with PANEL_SLIDE_MS", () => {
    expect(ruleBody(".panel-slide-animating > [data-panel]")).toContain(
      `transition: flex-grow ${PANEL_SLIDE_MS}ms`
    )
  })
})
