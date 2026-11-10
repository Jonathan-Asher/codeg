import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useMemo, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PromptCardResizeHandle } from "@/components/chat/prompt-card-resize-handle"
import enMessages from "@/i18n/messages/en.json"
import {
  clampPromptCardHeight,
  promptCardBodyStyle,
  promptCardHeightKey,
  readPromptCardHeight,
  usePromptCardResize,
  writePromptCardHeight,
  type PromptCardDock,
  type PromptCardEdge,
  type PromptCardKind,
} from "./use-prompt-card-resize"

/**
 * A stand-in for the column a docked card lives in: a frame of fixed height
 * holding the transcript (the part that gives way), the card (its chrome plus
 * its body) and the composer. jsdom lays nothing out, so the heights the hook
 * reads come from here. The body is its content's height unless the card
 * styles it: a height is the height, a max-height caps the content.
 */
const layout = { frame: 800, chrome: 100, composer: 120, content: 200 }

function bodyEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="body"]')
}

function bodyHeight(body: HTMLElement | null): number {
  if (!body) return 0
  const { height, maxHeight } = body.style
  if (height) return parseFloat(height)
  if (maxHeight) return Math.min(layout.content, parseFloat(maxHeight))
  return layout.content
}

function used(): number {
  return layout.chrome + bodyHeight(bodyEl()) + layout.composer
}

function fakeHeight(el: Element, box: "offset" | "client" | "scroll"): number {
  if (!(el instanceof HTMLElement)) return 0
  switch (el.dataset.testid) {
    case "frame":
      return box === "scroll" ? Math.max(layout.frame, used()) : layout.frame
    case "room":
      return Math.max(0, layout.frame - used())
    case "card":
      return layout.chrome + bodyHeight(bodyEl())
    case "body":
      return box === "scroll"
        ? Math.max(layout.content, bodyHeight(el))
        : bodyHeight(el)
    default:
      return 0
  }
}

beforeEach(() => {
  localStorage.clear()
  Object.assign(layout, {
    frame: 800,
    chrome: 100,
    composer: 120,
    content: 200,
  })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return fakeHeight(this, "offset")
    }
  )
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    function (this: Element) {
      return fakeHeight(this, "client")
    }
  )
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    function (this: Element) {
      return fakeHeight(this, "scroll")
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface CardProps {
  dock: PromptCardDock | null
  kind: PromptCardKind
  sizing: "fixed" | "content"
  enabled: boolean
}

function Card({ dock, kind, sizing, enabled }: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const { active, height, bodyRef, handleProps } = usePromptCardResize({
    kind,
    dock,
    cardRef,
    sizing,
    enabled,
  })
  return (
    <div ref={cardRef} data-testid="card">
      {active && <PromptCardResizeHandle {...handleProps} />}
      <div
        ref={bodyRef}
        data-testid="body"
        style={promptCardBodyStyle(height, sizing)}
      />
    </div>
  )
}

function Dock({
  edge = "top",
  docked = true,
  kind = "question",
  sizing = "fixed",
  enabled = true,
}: {
  edge?: PromptCardEdge
  docked?: boolean
  kind?: PromptCardKind
  sizing?: "fixed" | "content"
  enabled?: boolean
}) {
  const roomRef = useRef<HTMLDivElement>(null)
  const dock = useMemo<PromptCardDock>(() => ({ roomRef, edge }), [edge])
  return (
    <div data-testid="frame">
      <div ref={roomRef} data-testid="room" />
      <Card
        dock={docked ? dock : null}
        kind={kind}
        sizing={sizing}
        enabled={enabled}
      />
    </div>
  )
}

function renderDock(props: Parameters<typeof Dock>[0] = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Dock {...props} />
    </NextIntlClientProvider>
  )
}

function handle(): HTMLElement {
  return screen.getByRole("separator")
}

function body(): HTMLElement {
  return screen.getByTestId("body")
}

// jsdom has no `PointerEvent`; a mouse event under the pointer's name, with
// the pointer's id on it, carries everything the handle reads.
function pointer(type: string, clientY: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientY,
  })
  Object.defineProperty(event, "pointerId", { value: 1 })
  fireEvent(handle(), event)
}

const stored = (kind: PromptCardKind = "question") =>
  localStorage.getItem(promptCardHeightKey(kind))

describe("prompt card height storage", () => {
  it("reads only a positive number, rounded", () => {
    const key = promptCardHeightKey("plan")
    expect(key).toBe("workspace:prompt-card-height:plan")
    for (const raw of ["abc", "0", "-40", "", "Infinity"]) {
      localStorage.setItem(key, raw)
      expect(readPromptCardHeight("plan"), raw).toBeNull()
    }
    localStorage.setItem(key, "301.6")
    expect(readPromptCardHeight("plan")).toBe(302)
  })

  it("writes whole pixels and clears with null", () => {
    writePromptCardHeight("permission", 250.4)
    expect(stored("permission")).toBe("250")
    writePromptCardHeight("permission", null)
    expect(stored("permission")).toBeNull()
  })

  it("clamps into the range, the minimum winning a range that is upside down", () => {
    expect(clampPromptCardHeight(50, 128, 500)).toBe(128)
    expect(clampPromptCardHeight(900, 128, 500)).toBe(500)
    expect(clampPromptCardHeight(300.4, 128, 500)).toBe(300)
    expect(clampPromptCardHeight(300, 128, 100)).toBe(128)
  })
})

describe("usePromptCardResize", () => {
  it("keeps the automatic height while nothing is stored", () => {
    renderDock()
    expect(body().style.height).toBe("")
    const separator = handle()
    expect(separator).toHaveAttribute("aria-orientation", "horizontal")
    expect(separator).toHaveAccessibleName("Resize question")
    expect(separator).toHaveAttribute(
      "title",
      "Drag to resize · double-click to reset"
    )
    expect(separator).toHaveAttribute("tabindex", "0")
    // The body as it is, two option rows at the least, and what fits: the
    // frame less the card's chrome, the composer and the transcript's strip.
    expect(separator).toHaveAttribute("aria-valuenow", "200")
    expect(separator).toHaveAttribute("aria-valuemin", "128")
    expect(separator).toHaveAttribute("aria-valuemax", "532")
  })

  it("is not there without a dock, or where the card has nothing to resize", () => {
    localStorage.setItem(promptCardHeightKey("question"), "300")
    const { unmount } = renderDock({ docked: false })
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(body().style.height).toBe("")
    unmount()
    renderDock({ enabled: false })
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(body().style.height).toBe("")
  })

  it("opens at the remembered height, clamped to what fits", () => {
    localStorage.setItem(promptCardHeightKey("question"), "300")
    const { unmount } = renderDock()
    expect(body().style.height).toBe("300px")
    unmount()
    localStorage.setItem(promptCardHeightKey("question"), "2000")
    renderDock()
    expect(body().style.height).toBe("532px")
    // Clamping is for the screen only: the choice itself stands.
    expect(stored()).toBe("2000")
  })

  it("never grows past the viewport cap", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600)
    localStorage.setItem(promptCardHeightKey("question"), "2000")
    renderDock()
    // 88% of the viewport less the card's chrome.
    expect(body().style.height).toBe("428px")
  })

  it("clamps a remembered height to a smaller window, and lets it back out", () => {
    localStorage.setItem(promptCardHeightKey("question"), "400")
    renderDock()
    expect(body().style.height).toBe("400px")
    layout.frame = 600
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    // The composer stays on screen and the transcript keeps its strip.
    expect(body().style.height).toBe("332px")
    layout.frame = 800
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(body().style.height).toBe("400px")
  })

  it("follows the pointer and stores the height on release", async () => {
    renderDock()
    pointer("pointerdown", 500)
    pointer("pointermove", 400)
    await waitFor(() => expect(body().style.height).toBe("300px"))
    expect(handle()).toHaveAttribute("data-dragging")
    // Not written mid-drag.
    expect(stored()).toBeNull()
    pointer("pointerup", 400)
    expect(stored()).toBe("300")
    expect(body().style.height).toBe("300px")
    expect(handle()).not.toHaveAttribute("data-dragging")
  })

  it("goes shorter dragged down, never below the minimum", async () => {
    localStorage.setItem(promptCardHeightKey("question"), "300")
    renderDock()
    pointer("pointerdown", 500)
    pointer("pointermove", 560)
    await waitFor(() => expect(body().style.height).toBe("240px"))
    pointer("pointermove", 900)
    await waitFor(() => expect(body().style.height).toBe("128px"))
    pointer("pointerup", 900)
    expect(stored()).toBe("128")
  })

  it("does not move for a click or the first half of a double-click", () => {
    renderDock()
    pointer("pointerdown", 500)
    pointer("pointermove", 501)
    pointer("pointerup", 501)
    expect(stored()).toBeNull()
    expect(body().style.height).toBe("")
  })

  it("lets go of the page once the drag ends", () => {
    renderDock()
    pointer("pointerdown", 500)
    expect(document.body.style.userSelect).toBe("none")
    expect(document.body.style.cursor).toBe("row-resize")
    pointer("pointerup", 500)
    expect(document.body.style.userSelect).toBe("")
    expect(document.body.style.cursor).toBe("")
  })

  it("goes back to the automatic height on a double-click", () => {
    localStorage.setItem(promptCardHeightKey("question"), "300")
    renderDock()
    expect(body().style.height).toBe("300px")
    fireEvent.doubleClick(handle())
    expect(stored()).toBeNull()
    expect(body().style.height).toBe("")
  })

  it("steps with the arrow keys, further with Shift, and to either end with Home and End", () => {
    renderDock()
    const separator = handle()
    separator.focus()
    fireEvent.keyDown(separator, { key: "ArrowUp" })
    expect(stored()).toBe("224")
    fireEvent.keyDown(separator, { key: "ArrowUp", shiftKey: true })
    expect(stored()).toBe("320")
    fireEvent.keyDown(separator, { key: "ArrowDown" })
    expect(stored()).toBe("296")
    expect(body().style.height).toBe("296px")
    expect(separator).toHaveAttribute("aria-valuenow", "296")
    fireEvent.keyDown(separator, { key: "Home" })
    expect(stored()).toBe("128")
    fireEvent.keyDown(separator, { key: "End" })
    expect(stored()).toBe("532")
    expect(separator).toHaveFocus()
  })

  it("leaves a key with a modifier alone", () => {
    renderDock()
    fireEvent.keyDown(handle(), { key: "ArrowUp", metaKey: true })
    fireEvent.keyDown(handle(), { key: "ArrowUp", altKey: true })
    expect(stored()).toBeNull()
  })

  it("keeps a body already below the minimum where it is rather than jumping", () => {
    layout.content = 100
    renderDock()
    fireEvent.keyDown(handle(), { key: "ArrowDown" })
    expect(stored()).toBeNull()
    fireEvent.keyDown(handle(), { key: "ArrowUp" })
    expect(stored()).toBe("124")
  })

  it("grows a body from its bottom edge in the drawer", async () => {
    renderDock({ edge: "bottom" })
    pointer("pointerdown", 500)
    pointer("pointermove", 600)
    await waitFor(() => expect(body().style.height).toBe("300px"))
    pointer("pointerup", 600)
    expect(stored()).toBe("300")
    fireEvent.keyDown(handle(), { key: "ArrowDown" })
    expect(stored()).toBe("324")
    fireEvent.keyDown(handle(), { key: "ArrowUp" })
    expect(stored()).toBe("300")
  })

  it("follows a height another card of the kind stored, and no other kind", () => {
    renderDock()
    act(() => writePromptCardHeight("question", 280))
    expect(body().style.height).toBe("280px")
    act(() => writePromptCardHeight("plan", 400))
    expect(body().style.height).toBe("280px")
    act(() => writePromptCardHeight("question", null))
    expect(body().style.height).toBe("")
  })

  describe("a body that follows its content", () => {
    it("takes the height as a cap", () => {
      localStorage.setItem(promptCardHeightKey("plan"), "300")
      renderDock({ kind: "plan", sizing: "content" })
      expect(body().style.maxHeight).toBe("300px")
      expect(body().style.height).toBe("")
      expect(handle()).toHaveAccessibleName("Resize plan")
      // Shorter than its cap, it reads as its content's height.
      expect(handle()).toHaveAttribute("aria-valuenow", "200")
    })

    it("shrinks at once, but grows only while it has more to show", async () => {
      renderDock({ kind: "permission", sizing: "content" })
      // All 200px of it are showing: taller would only add empty space, and
      // storing it would cap the next, longer request at this one's size.
      fireEvent.keyDown(handle(), { key: "ArrowUp" })
      pointer("pointerdown", 500)
      pointer("pointermove", 400)
      pointer("pointerup", 400)
      expect(stored("permission")).toBeNull()
      expect(body().style.maxHeight).toBe("")

      fireEvent.keyDown(handle(), { key: "ArrowDown" })
      expect(stored("permission")).toBe("176")
      expect(body().style.maxHeight).toBe("176px")

      // Now it hides part of its content, so it can grow again.
      pointer("pointerdown", 500)
      pointer("pointermove", 450)
      await waitFor(() => expect(body().style.maxHeight).toBe("226px"))
      pointer("pointerup", 450)
      expect(stored("permission")).toBe("226")
    })
  })
})
